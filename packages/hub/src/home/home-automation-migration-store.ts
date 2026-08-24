import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateSqliteFiles } from "../sqlite-private-files.js";
import {
  HOME_AUTOMATION_MIGRATION_LIMITS,
  HomeAutomationMigrationIdempotencyConflictError,
  type HomeAutomationMigrationAssessment,
  type HomeAutomationMigrationAssessmentTransition,
  type HomeAutomationMigrationCloseCommand,
  type HomeAutomationMigrationDiscovery,
  type HomeAutomationMigrationRuleAssessment,
  type HomeAutomationMigrationRuleWorkflow,
  type HomeAutomationMigrationRuleWorkflowFailureReason,
  type HomeAutomationMigrationRuleWorkflowStatus,
  type HomeAutomationMigrationRuleWorkflowTransition,
  type HomeAutomationMigrationStatus,
} from "./home-automation-migration.js";
import {
  cloneSelection,
  validateSelectionClaim,
  validateSelectionCompletion,
  validateSelectionInvalidation,
  validateSelectionIssue,
  validateSelectionRecord,
  type HomeAutomationMigrationSelectionClaim,
  type HomeAutomationMigrationSelectionClaimInput,
  type HomeAutomationMigrationSelectionCompletion,
  type HomeAutomationMigrationSelectionInvalidation,
  type HomeAutomationMigrationSelectionIssue,
  type HomeAutomationMigrationSelectionIssueResult,
  type HomeAutomationMigrationSelectionFailureReason,
  type HomeAutomationMigrationSelectionPrincipal,
  type HomeAutomationMigrationSelectionRecord,
  type HomeAutomationMigrationSelectionRecordStatus,
  type HomeAutomationMigrationSelectionStorePort,
} from "./home-automation-migration-selection.js";

export interface HomeAutomationMigrationStore extends HomeAutomationMigrationSelectionStorePort {
  discover(input: HomeAutomationMigrationDiscovery): HomeAutomationMigrationStoreBeginResult;
  assess(input: HomeAutomationMigrationAssessmentTransition): boolean;
  transitionRuleWorkflow(input: HomeAutomationMigrationRuleWorkflowTransition): boolean;
  get(migrationId: string): HomeAutomationMigrationAssessment | undefined;
  list(): readonly HomeAutomationMigrationAssessment[];
  replay(input: { readonly idempotencyKey: string; readonly inputDigest: string }): HomeAutomationMigrationAssessment | undefined;
  recover(): readonly HomeAutomationMigrationAssessment[];
  closeAssessment(input: HomeAutomationMigrationCloseCommand): boolean;
  close(): void;
}

export interface HomeAutomationMigrationStoreBeginResult {
  readonly outcome: "created" | "existing";
  readonly assessment: HomeAutomationMigrationAssessment;
}

/** Deterministic store for service and domain tests. */
export class InMemoryHomeAutomationMigrationStore implements HomeAutomationMigrationStore {
  private readonly records = new Map<string, HomeAutomationMigrationAssessment>();
  private readonly selections = new Map<string, HomeAutomationMigrationSelectionRecord>();
  private closed = false;

  discover(input: HomeAutomationMigrationDiscovery): HomeAutomationMigrationStoreBeginResult {
    this.assertOpen();
    validateDiscovery(input);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.inputDigest !== input.inputDigest) throw new HomeAutomationMigrationIdempotencyConflictError();
      return { outcome: "existing", assessment: cloneAssessment(existing) };
    }
    if (this.records.has(input.migrationId)) throw new Error("Migration id already exists");
    const assessment: HomeAutomationMigrationAssessment = {
      migrationId: input.migrationId,
      idempotencyKey: input.idempotencyKey,
      inputDigest: input.inputDigest,
      sourceBridgeId: input.sourceBridgeId,
      sourceEpochId: input.sourceEpochId,
      sourceLastSeq: input.sourceLastSeq,
      analysisMode: input.analysisMode,
      rules: cloneRules(input.rules),
      status: "discovered",
      createdAt: input.createdAt,
    };
    this.records.set(assessment.migrationId, assessment);
    return { outcome: "created", assessment: cloneAssessment(assessment) };
  }

  assess(input: HomeAutomationMigrationAssessmentTransition): boolean {
    this.assertOpen();
    validateTransition(input);
    const current = this.records.get(input.migrationId);
    if (current === undefined || (current.status !== "discovered" && current.status !== "needs_attention")) return false;
    assertStableRuleMetadata(current.rules, input.rules);
    assertAssessmentWorkflowTransition(current.rules, input.rules);
    if (Date.parse(input.assessedAt) < Date.parse(current.assessedAt ?? current.createdAt)) {
      throw new TypeError("Migration assessment time precedes previous assessment");
    }
    this.records.set(current.migrationId, {
      ...current,
      rules: cloneRules(input.rules),
      status: input.status,
      assessedAt: input.assessedAt,
    });
    return true;
  }

  transitionRuleWorkflow(input: HomeAutomationMigrationRuleWorkflowTransition): boolean {
    this.assertOpen();
    validateWorkflowTransition(input);
    const current = this.records.get(input.migrationId);
    if (current === undefined || current.status !== "assessed") return false;
    const ruleIndex = current.rules.findIndex((rule) => rule.ruleRef === input.ruleRef);
    if (ruleIndex < 0) return false;
    const currentRule = current.rules[ruleIndex]!;
    if (currentRule.disposition !== "eligible" || currentRule.workflow === undefined
      || currentRule.workflow.status !== input.from) return false;
    const nextWorkflow = buildWorkflowTransition(currentRule.workflow, input);
    const rules = current.rules.map((rule, index) => index === ruleIndex ? { ...rule, workflow: nextWorkflow } : { ...rule });
    this.records.set(current.migrationId, { ...current, rules });
    return true;
  }

  issueSelection(input: HomeAutomationMigrationSelectionIssue): HomeAutomationMigrationSelectionIssueResult {
    this.assertOpen();
    validateSelectionIssue(input);
    const assessment = this.records.get(input.migrationId);
    assertSelectionSource(assessment, input);
    const existing = [...this.selections.values()].find((record) => selectionIssueMatches(record, input)
      && record.status !== "expired" && record.status !== "invalidated");
    if (existing !== undefined) return { outcome: "existing", selection: cloneSelection(existing) };
    if (this.selections.has(input.selectionId)) throw new Error("Migration selection id already exists");
    if ([...this.selections.values()].some((record) => record.tokenDigest === input.tokenDigest)) {
      throw new Error("Migration selection token digest already exists");
    }
    const selection: HomeAutomationMigrationSelectionRecord = {
      selectionId: input.selectionId,
      migrationId: input.migrationId,
      ruleRef: input.ruleRef,
      principal: { ...input.principal },
      sourceBridgeId: input.sourceBridgeId,
      sourceEpochId: input.sourceEpochId,
      sourceLastSeq: input.sourceLastSeq,
      sourceFingerprint: input.sourceFingerprint,
      tokenDigest: input.tokenDigest,
      generation: input.generation,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      status: "issued",
      revision: 1,
    };
    validateSelectionRecord(selection);
    this.selections.set(selection.selectionId, selection);
    return { outcome: "created", selection: cloneSelection(selection) };
  }

  getSelection(selectionId: string): HomeAutomationMigrationSelectionRecord | undefined {
    this.assertOpen();
    if (!isSelectionIdForStore(selectionId)) throw new TypeError("Invalid home automation migration selection id");
    const record = this.selections.get(selectionId);
    return record === undefined ? undefined : cloneSelection(record);
  }

  listSelections(input: {
    readonly migrationId?: string;
    readonly principalId?: string;
    readonly generation?: string;
    readonly status?: HomeAutomationMigrationSelectionRecordStatus;
  } = {}): readonly HomeAutomationMigrationSelectionRecord[] {
    this.assertOpen();
    validateSelectionListQuery(input);
    return [...this.selections.values()]
      .filter((record) => (input.migrationId === undefined || record.migrationId === input.migrationId)
        && (input.principalId === undefined || record.principal.principalId === input.principalId)
        && (input.generation === undefined || record.generation === input.generation)
        && (input.status === undefined || record.status === input.status))
      .sort(compareSelection)
      .map(cloneSelection);
  }

  claimSelection(input: HomeAutomationMigrationSelectionClaimInput): HomeAutomationMigrationSelectionClaim {
    this.assertOpen();
    validateSelectionClaim(input);
    const current = this.selections.get(input.selectionId);
    if (current === undefined) return { outcome: "missing" };
    if (current.tokenDigest !== input.tokenDigest || !sameSelectionPrincipal(current, input.principal)) {
      return { outcome: "forbidden", selection: cloneSelection(current) };
    }
    if (current.generation !== input.generation) return { outcome: "invalidated", selection: cloneSelection(current) };
    const assessment = this.records.get(current.migrationId);
    if (!selectionSourceMatchesRecord(assessment, current)) {
      if (current.status === "issued" || current.status === "processing") {
        const invalidated = transitionSelection(current, {
          status: "invalidated",
          revision: current.revision + 1,
          completedAt: input.now,
          failureReason: "source_drift",
        });
        this.selections.set(current.selectionId, invalidated);
        return { outcome: "invalidated", selection: cloneSelection(invalidated) };
      }
      return { outcome: "invalidated", selection: cloneSelection(current) };
    }
    if (current.status === "issued" && Date.parse(input.now) >= Date.parse(current.expiresAt)) {
      const expired = transitionSelection(current, {
        status: "expired",
        revision: current.revision + 1,
        completedAt: input.now,
        failureReason: "expired",
      });
      this.selections.set(current.selectionId, expired);
      return { outcome: "expired", selection: cloneSelection(expired) };
    }
    if (current.status === "issued") {
      const processing = transitionSelection(current, { status: "processing", revision: current.revision + 1 });
      this.selections.set(current.selectionId, processing);
      return { outcome: "claimed", selection: cloneSelection(processing) };
    }
    if (current.status === "processing" || current.status === "prepared" || current.status === "unavailable") {
      return { outcome: "replay", selection: cloneSelection(current) };
    }
    return { outcome: current.status, selection: cloneSelection(current) };
  }

  completeSelection(input: HomeAutomationMigrationSelectionCompletion): boolean {
    this.assertOpen();
    validateSelectionCompletion(input);
    const current = this.selections.get(input.selectionId);
    if (current === undefined || current.status !== "processing" || current.revision !== input.expectedRevision
      || current.generation !== input.generation || !sameSelectionPrincipal(current, input.principal)) return false;
    const next = transitionSelection(current, {
      status: input.status,
      revision: current.revision + 1,
      completedAt: input.completedAt,
      ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
      ...(input.proposalRevision === undefined ? {} : { proposalRevision: input.proposalRevision }),
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    });
    this.selections.set(current.selectionId, next);
    return true;
  }

  invalidateSelection(input: HomeAutomationMigrationSelectionInvalidation): boolean {
    this.assertOpen();
    validateSelectionInvalidation(input);
    const current = this.selections.get(input.selectionId);
    if (current === undefined || current.generation !== input.generation || current.status !== "issued") return false;
    this.selections.set(current.selectionId, transitionSelection(current, {
      status: "invalidated",
      revision: current.revision + 1,
      completedAt: input.now,
      failureReason: input.reason,
    }));
    return true;
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    this.assertOpen();
    validateId(migrationId, "migration id");
    const record = this.records.get(migrationId);
    return record === undefined ? undefined : cloneAssessment(record);
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    this.assertOpen();
    return [...this.records.values()]
      .sort(compareAssessment)
      .map(cloneAssessment);
  }

  replay(input: { readonly idempotencyKey: string; readonly inputDigest: string }): HomeAutomationMigrationAssessment | undefined {
    this.assertOpen();
    validateIdempotencyKey(input?.idempotencyKey);
    validateDigest(input?.inputDigest);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing === undefined) return undefined;
    if (existing.inputDigest !== input.inputDigest) throw new HomeAutomationMigrationIdempotencyConflictError();
    return cloneAssessment(existing);
  }

  recover(): readonly HomeAutomationMigrationAssessment[] {
    this.assertOpen();
    return [...this.records.values()]
      .filter((record) => record.status === "discovered" || record.status === "needs_attention")
      .sort(compareAssessment)
      .map(cloneAssessment);
  }

  closeAssessment(input: HomeAutomationMigrationCloseCommand): boolean {
    this.assertOpen();
    validateClose(input);
    const current = this.records.get(input.migrationId);
    if (current === undefined || current.status === "closed") return false;
    if (Date.parse(input.closedAt) < Date.parse(current.createdAt)) {
      throw new TypeError("Migration close time precedes discovery");
    }
    this.records.set(current.migrationId, {
      ...current,
      status: "closed",
      closedAt: input.closedAt,
      closedFrom: current.status,
      closeReason: input.reason,
    });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  private findByIdempotencyKey(idempotencyKey: string): HomeAutomationMigrationAssessment | undefined {
    return [...this.records.values()].find((record) => record.idempotencyKey === idempotencyKey);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Home automation migration store is closed");
  }
}

export interface SqliteHomeAutomationMigrationStoreOptions {
  readonly path: string;
}

/** Private SQLite persistence for metadata-only migration assessments. */
export class SqliteHomeAutomationMigrationStore implements HomeAutomationMigrationStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: SqliteHomeAutomationMigrationStoreOptions | string) {
    const path = typeof options === "string" ? options : options?.path;
    if (typeof path !== "string" || path.length === 0) throw new TypeError("home automation migration store path is required");
    this.path = path;
    if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.ensureSchema();
    this.ensurePrivateFiles();
  }

  discover(input: HomeAutomationMigrationDiscovery): HomeAutomationMigrationStoreBeginResult {
    this.assertOpen();
    validateDiscovery(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.inputDigest !== input.inputDigest) throw new HomeAutomationMigrationIdempotencyConflictError();
        this.db.exec("COMMIT");
        return { outcome: "existing", assessment: existing };
      }
      const idCollision = this.db.prepare("SELECT migration_id FROM home_automation_migrations WHERE migration_id = ?")
        .get(input.migrationId) as Row | undefined;
      if (idCollision !== undefined) throw new Error("Migration id already exists");
      const rulesJson = serializeRules(input.rules);
      this.db.prepare(`INSERT INTO home_automation_migrations
        (migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id, source_last_seq,
         analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, NULL, NULL, NULL, NULL)`)
        .run(
          input.migrationId,
          input.idempotencyKey,
          input.inputDigest,
          input.sourceBridgeId,
          input.sourceEpochId,
          input.sourceLastSeq,
          input.analysisMode,
          rulesJson,
          input.createdAt,
        );
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return { outcome: "created", assessment: {
        migrationId: input.migrationId,
        idempotencyKey: input.idempotencyKey,
        inputDigest: input.inputDigest,
        sourceBridgeId: input.sourceBridgeId,
        sourceEpochId: input.sourceEpochId,
        sourceLastSeq: input.sourceLastSeq,
        analysisMode: input.analysisMode,
        rules: cloneRules(input.rules),
        status: "discovered",
        createdAt: input.createdAt,
      } };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  assess(input: HomeAutomationMigrationAssessmentTransition): boolean {
    this.assertOpen();
    validateTransition(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
          source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
        FROM home_automation_migrations WHERE migration_id = ?`).get(input.migrationId) as Row | undefined;
      if (row === undefined) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const current = fromRow(row);
      if (current.status !== "discovered" && current.status !== "needs_attention") {
        this.db.exec("ROLLBACK");
        return false;
      }
      assertStableRuleMetadata(current.rules, input.rules);
      assertAssessmentWorkflowTransition(current.rules, input.rules);
      if (Date.parse(input.assessedAt) < Date.parse(current.assessedAt ?? current.createdAt)) throw new TypeError("Migration assessment time precedes previous assessment");
      const result = this.db.prepare(`UPDATE home_automation_migrations
        SET rules_json = ?, status = ?, assessed_at = ? WHERE migration_id = ? AND status = ?`)
        .run(serializeRules(input.rules), input.status, input.assessedAt, input.migrationId, current.status);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  transitionRuleWorkflow(input: HomeAutomationMigrationRuleWorkflowTransition): boolean {
    this.assertOpen();
    validateWorkflowTransition(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
          source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
        FROM home_automation_migrations WHERE migration_id = ?`).get(input.migrationId) as Row | undefined;
      if (row === undefined || typeof row.rules_json !== "string") {
        this.db.exec("ROLLBACK");
        return false;
      }
      const current = fromRow(row);
      if (current.status !== "assessed") {
        this.db.exec("ROLLBACK");
        return false;
      }
      const ruleIndex = current.rules.findIndex((rule) => rule.ruleRef === input.ruleRef);
      if (ruleIndex < 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const currentRule = current.rules[ruleIndex]!;
      if (currentRule.disposition !== "eligible" || currentRule.workflow === undefined
        || currentRule.workflow.status !== input.from) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const nextWorkflow = buildWorkflowTransition(currentRule.workflow, input);
      const nextRules = current.rules.map((rule, index) => index === ruleIndex ? { ...rule, workflow: nextWorkflow } : { ...rule });
      const result = this.db.prepare(`UPDATE home_automation_migrations
        SET rules_json = ? WHERE migration_id = ? AND rules_json = ?`)
        .run(serializeRules(nextRules), input.migrationId, row.rules_json);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  issueSelection(input: HomeAutomationMigrationSelectionIssue): HomeAutomationMigrationSelectionIssueResult {
    this.assertOpen();
    validateSelectionIssue(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const assessment = this.readAssessment(input.migrationId);
      assertSelectionSource(assessment, input);
      const existingRow = this.db.prepare(`SELECT ${selectionColumns()}
        FROM home_automation_migration_selections
        WHERE migration_id = ? AND rule_ref = ? AND principal_id = ? AND principal_role = ?
          AND private_device_binding = ? AND source_bridge_id = ? AND source_epoch_id = ?
          AND source_last_seq = ? AND source_fingerprint = ? AND generation = ?
          AND status NOT IN ('expired', 'invalidated')
        ORDER BY revision DESC LIMIT 1`)
        .get(input.migrationId, input.ruleRef, input.principal.principalId, input.principal.role,
          input.principal.privateDeviceBinding, input.sourceBridgeId, input.sourceEpochId, input.sourceLastSeq,
          input.sourceFingerprint, input.generation) as Row | undefined;
      if (existingRow !== undefined) {
        const existing = selectionFromRow(existingRow);
        this.db.exec("COMMIT");
        return { outcome: "existing", selection: existing };
      }
      const idCollision = this.db.prepare("SELECT selection_id FROM home_automation_migration_selections WHERE selection_id = ?")
        .get(input.selectionId) as Row | undefined;
      if (idCollision !== undefined) throw new Error("Migration selection id already exists");
      const digestCollision = this.db.prepare("SELECT selection_id FROM home_automation_migration_selections WHERE token_digest = ?")
        .get(input.tokenDigest) as Row | undefined;
      if (digestCollision !== undefined) throw new Error("Migration selection token digest already exists");
      this.db.prepare(`INSERT INTO home_automation_migration_selections
        (selection_id, migration_id, rule_ref, principal_id, principal_role, private_device_binding,
         source_bridge_id, source_epoch_id, source_last_seq, source_fingerprint, token_digest, generation,
         issued_at, expires_at, status, revision, proposal_id, proposal_revision, failure_reason, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', 1, NULL, NULL, NULL, NULL)`)
        .run(input.selectionId, input.migrationId, input.ruleRef, input.principal.principalId, input.principal.role,
          input.principal.privateDeviceBinding, input.sourceBridgeId, input.sourceEpochId, input.sourceLastSeq,
          input.sourceFingerprint, input.tokenDigest, input.generation, input.issuedAt, input.expiresAt);
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      const selection = validateSelectionRecord({
        selectionId: input.selectionId,
        migrationId: input.migrationId,
        ruleRef: input.ruleRef,
        principal: { ...input.principal },
        sourceBridgeId: input.sourceBridgeId,
        sourceEpochId: input.sourceEpochId,
        sourceLastSeq: input.sourceLastSeq,
        sourceFingerprint: input.sourceFingerprint,
        tokenDigest: input.tokenDigest,
        generation: input.generation,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        status: "issued",
        revision: 1,
      });
      return { outcome: "created", selection };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  getSelection(selectionId: string): HomeAutomationMigrationSelectionRecord | undefined {
    this.assertOpen();
    if (!isSelectionIdForStore(selectionId)) throw new TypeError("Invalid home automation migration selection id");
    const row = this.db.prepare(`SELECT ${selectionColumns()}
      FROM home_automation_migration_selections WHERE selection_id = ?`).get(selectionId) as Row | undefined;
    return row === undefined ? undefined : selectionFromRow(row);
  }

  listSelections(input: {
    readonly migrationId?: string;
    readonly principalId?: string;
    readonly generation?: string;
    readonly status?: HomeAutomationMigrationSelectionRecordStatus;
  } = {}): readonly HomeAutomationMigrationSelectionRecord[] {
    this.assertOpen();
    validateSelectionListQuery(input);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (input.migrationId !== undefined) { clauses.push("migration_id = ?"); params.push(input.migrationId); }
    if (input.principalId !== undefined) { clauses.push("principal_id = ?"); params.push(input.principalId); }
    if (input.generation !== undefined) { clauses.push("generation = ?"); params.push(input.generation); }
    if (input.status !== undefined) { clauses.push("status = ?"); params.push(input.status); }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.prepare(`SELECT ${selectionColumns()} FROM home_automation_migration_selections${where}
      ORDER BY issued_at ASC, selection_id ASC`).all(...params) as Row[];
    return rows.map(selectionFromRow).map(cloneSelection);
  }

  claimSelection(input: HomeAutomationMigrationSelectionClaimInput): HomeAutomationMigrationSelectionClaim {
    this.assertOpen();
    validateSelectionClaim(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT ${selectionColumns()}
        FROM home_automation_migration_selections WHERE selection_id = ?`).get(input.selectionId) as Row | undefined;
      if (row === undefined) {
        this.db.exec("ROLLBACK");
        return { outcome: "missing" };
      }
      const current = selectionFromRow(row);
      if (current.tokenDigest !== input.tokenDigest || !sameSelectionPrincipal(current, input.principal)) {
        this.db.exec("ROLLBACK");
        return { outcome: "forbidden", selection: current };
      }
      if (current.generation !== input.generation) {
        this.db.exec("ROLLBACK");
        return { outcome: "invalidated", selection: current };
      }
      const assessment = this.readAssessment(current.migrationId);
      if (!selectionSourceMatchesRecord(assessment, current)) {
        if (current.status === "issued" || current.status === "processing") {
          const invalidated = this.casSelectionUpdate(current, {
            status: "invalidated", revision: current.revision + 1, completedAt: input.now, failureReason: "source_drift",
          }, "issued,processing");
          if (invalidated === undefined) {
            this.db.exec("ROLLBACK");
            return { outcome: "replay", selection: current };
          }
          this.db.exec("COMMIT");
          this.ensurePrivateFiles();
          return { outcome: "invalidated", selection: invalidated };
        }
        this.db.exec("ROLLBACK");
        return { outcome: "invalidated", selection: current };
      }
      if (current.status === "issued" && Date.parse(input.now) >= Date.parse(current.expiresAt)) {
        const expired = this.casSelectionUpdate(current, {
          status: "expired", revision: current.revision + 1, completedAt: input.now, failureReason: "expired",
        }, "issued");
        if (expired === undefined) {
          this.db.exec("ROLLBACK");
          return { outcome: "replay", selection: current };
        }
        this.db.exec("COMMIT");
        this.ensurePrivateFiles();
        return { outcome: "expired", selection: expired };
      }
      if (current.status === "issued") {
        const processing = this.casSelectionUpdate(current, { status: "processing", revision: current.revision + 1 }, "issued");
        if (processing === undefined) {
          this.db.exec("ROLLBACK");
          return { outcome: "replay", selection: current };
        }
        this.db.exec("COMMIT");
        this.ensurePrivateFiles();
        return { outcome: "claimed", selection: processing };
      }
      this.db.exec("ROLLBACK");
      if (current.status === "processing" || current.status === "prepared" || current.status === "unavailable") {
        return { outcome: "replay", selection: current };
      }
      return { outcome: current.status, selection: current };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  completeSelection(input: HomeAutomationMigrationSelectionCompletion): boolean {
    this.assertOpen();
    validateSelectionCompletion(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db.prepare(`SELECT ${selectionColumns()}
        FROM home_automation_migration_selections WHERE selection_id = ?`).get(input.selectionId) as Row | undefined;
      if (currentRow === undefined) { this.db.exec("ROLLBACK"); return false; }
      const current = selectionFromRow(currentRow);
      if (current.status !== "processing" || current.revision !== input.expectedRevision
        || current.generation !== input.generation || !sameSelectionPrincipal(current, input.principal)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const result = this.db.prepare(`UPDATE home_automation_migration_selections
        SET status = ?, revision = ?, proposal_id = ?, proposal_revision = ?, failure_reason = ?, completed_at = ?
        WHERE selection_id = ? AND status = 'processing' AND revision = ? AND generation = ?
          AND principal_id = ? AND principal_role = ? AND private_device_binding = ?`)
        .run(input.status, current.revision + 1, input.proposalId ?? null, input.proposalRevision ?? null,
          input.failureReason ?? null, input.completedAt, input.selectionId, input.expectedRevision,
          input.generation, input.principal.principalId, input.principal.role, input.principal.privateDeviceBinding);
      if (Number(result.changes) !== 1) { this.db.exec("ROLLBACK"); return false; }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  invalidateSelection(input: HomeAutomationMigrationSelectionInvalidation): boolean {
    this.assertOpen();
    validateSelectionInvalidation(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentRow = this.db.prepare(`SELECT ${selectionColumns()}
        FROM home_automation_migration_selections WHERE selection_id = ?`).get(input.selectionId) as Row | undefined;
      if (currentRow === undefined) { this.db.exec("ROLLBACK"); return false; }
      const current = selectionFromRow(currentRow);
      if (current.generation !== input.generation || current.status !== "issued") { this.db.exec("ROLLBACK"); return false; }
      const result = this.db.prepare(`UPDATE home_automation_migration_selections
        SET status = 'invalidated', revision = ?, failure_reason = ?, completed_at = ?
        WHERE selection_id = ? AND status = 'issued' AND revision = ? AND generation = ?`)
        .run(current.revision + 1, input.reason, input.now, input.selectionId, current.revision, input.generation);
      if (Number(result.changes) !== 1) { this.db.exec("ROLLBACK"); return false; }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    this.assertOpen();
    validateId(migrationId, "migration id");
    const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
        source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
      FROM home_automation_migrations WHERE migration_id = ?`).get(migrationId) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
        source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
      FROM home_automation_migrations ORDER BY created_at ASC, migration_id ASC`).all() as Row[];
    return rows.map(fromRow);
  }

  replay(input: { readonly idempotencyKey: string; readonly inputDigest: string }): HomeAutomationMigrationAssessment | undefined {
    this.assertOpen();
    validateIdempotencyKey(input?.idempotencyKey);
    validateDigest(input?.inputDigest);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing === undefined) return undefined;
    if (existing.inputDigest !== input.inputDigest) throw new HomeAutomationMigrationIdempotencyConflictError();
    return existing;
  }

  recover(): readonly HomeAutomationMigrationAssessment[] {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
        source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
      FROM home_automation_migrations WHERE status IN ('discovered', 'needs_attention') ORDER BY created_at ASC, migration_id ASC`).all() as Row[];
    return rows.map(fromRow);
  }

  closeAssessment(input: HomeAutomationMigrationCloseCommand): boolean {
    this.assertOpen();
    validateClose(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
          source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
        FROM home_automation_migrations WHERE migration_id = ?`).get(input.migrationId) as Row | undefined;
      if (row === undefined) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const current = fromRow(row);
      if (current.status === "closed") {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (Date.parse(input.closedAt) < Date.parse(current.createdAt)) throw new TypeError("Migration close time precedes discovery");
      const result = this.db.prepare(`UPDATE home_automation_migrations
        SET status = 'closed', closed_at = ?, closed_from = ?, close_reason = ?
        WHERE migration_id = ? AND status <> 'closed'`)
        .run(input.closedAt, current.status, input.reason, input.migrationId);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      this.ensurePrivateFiles();
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private findByIdempotencyKey(idempotencyKey: string): HomeAutomationMigrationAssessment | undefined {
    const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
        source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
      FROM home_automation_migrations WHERE idempotency_key = ?`).get(idempotencyKey) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  private readAssessment(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    const row = this.db.prepare(`SELECT migration_id, idempotency_key, input_digest, source_bridge_id, source_epoch_id,
        source_last_seq, analysis_mode, rules_json, status, created_at, assessed_at, closed_at, closed_from, close_reason
      FROM home_automation_migrations WHERE migration_id = ?`).get(migrationId) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  private casSelectionUpdate(
    current: HomeAutomationMigrationSelectionRecord,
    next: {
      readonly status: HomeAutomationMigrationSelectionRecordStatus;
      readonly revision: number;
      readonly proposalId?: string;
      readonly proposalRevision?: number;
      readonly failureReason?: string;
      readonly completedAt?: string;
    },
    expectedStatuses: string,
  ): HomeAutomationMigrationSelectionRecord | undefined {
    const statuses = expectedStatuses.split(",").map((value) => `'${value}'`).join(",");
    const result = this.db.prepare(`UPDATE home_automation_migration_selections
      SET status = ?, revision = ?, proposal_id = ?, proposal_revision = ?, failure_reason = ?, completed_at = ?
      WHERE selection_id = ? AND status IN (${statuses}) AND revision = ? AND generation = ?`)
      .run(next.status, next.revision, next.proposalId ?? null, next.proposalRevision ?? null,
        next.failureReason ?? null, next.completedAt ?? null, current.selectionId, current.revision, current.generation);
    if (Number(result.changes) !== 1) return undefined;
    const row = this.db.prepare(`SELECT ${selectionColumns()}
      FROM home_automation_migration_selections WHERE selection_id = ?`).get(current.selectionId) as Row | undefined;
    if (row === undefined) throw new Error("Migration selection disappeared after CAS");
    return selectionFromRow(row);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS home_automation_migrations (
        migration_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        input_digest TEXT NOT NULL,
        source_bridge_id TEXT NOT NULL,
        source_epoch_id TEXT NOT NULL,
        source_last_seq INTEGER NOT NULL,
        analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('metadata_only', 'trusted_neutral')),
        rules_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('discovered', 'assessed', 'needs_attention', 'closed')),
        created_at TEXT NOT NULL,
        assessed_at TEXT,
        closed_at TEXT,
        closed_from TEXT,
        close_reason TEXT,
        CHECK ((status = 'discovered' AND assessed_at IS NULL AND closed_at IS NULL AND closed_from IS NULL AND close_reason IS NULL)
          OR (status IN ('assessed', 'needs_attention')
            AND assessed_at IS NOT NULL AND closed_at IS NULL AND closed_from IS NULL AND close_reason IS NULL)
          OR (status = 'closed' AND closed_at IS NOT NULL AND closed_from IS NOT NULL AND close_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_automation_migrations_status
        ON home_automation_migrations (status, created_at ASC, migration_id ASC);
      CREATE TABLE IF NOT EXISTS home_automation_migration_selections (
        selection_id TEXT PRIMARY KEY,
        migration_id TEXT NOT NULL,
        rule_ref TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_role TEXT NOT NULL,
        private_device_binding TEXT NOT NULL,
        source_bridge_id TEXT NOT NULL,
        source_epoch_id TEXT NOT NULL,
        source_last_seq INTEGER NOT NULL,
        source_fingerprint TEXT NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        generation TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('issued', 'processing', 'prepared', 'unavailable', 'expired', 'invalidated')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        proposal_id TEXT,
        proposal_revision INTEGER,
        failure_reason TEXT,
        completed_at TEXT,
        FOREIGN KEY (migration_id) REFERENCES home_automation_migrations (migration_id),
        CHECK (principal_role IN ('admin', 'adult_member', 'member', 'child', 'guest')),
        CHECK (private_device_binding = 'verified'),
        CHECK (source_last_seq > 0),
        CHECK (length(selection_id) BETWEEN 32 AND 128),
        CHECK (length(token_digest) = 71 AND substr(token_digest, 1, 7) = 'sha256:'),
        CHECK (length(source_fingerprint) = 71 AND substr(source_fingerprint, 1, 7) = 'sha256:'),
        CHECK (length(generation) BETWEEN 1 AND 128),
        CHECK (length(rule_ref) BETWEEN 1 AND 200),
        CHECK ((status IN ('issued', 'processing') AND proposal_id IS NULL AND proposal_revision IS NULL
          AND failure_reason IS NULL AND completed_at IS NULL)
          OR (status = 'prepared' AND proposal_id IS NOT NULL AND failure_reason IS NULL AND completed_at IS NOT NULL)
          OR (status IN ('unavailable', 'expired', 'invalidated') AND proposal_id IS NULL
            AND proposal_revision IS NULL AND failure_reason IS NOT NULL AND completed_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS home_automation_migration_selections_idempotency
        ON home_automation_migration_selections
          (migration_id, rule_ref, principal_id, principal_role, private_device_binding,
           source_bridge_id, source_epoch_id, source_last_seq, source_fingerprint, generation, status);
      CREATE INDEX IF NOT EXISTS home_automation_migration_selections_status
        ON home_automation_migration_selections (status, issued_at ASC, selection_id ASC);
    `);
  }

  private rollback(): void {
    try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Home automation migration store is closed");
  }

  private ensurePrivateFiles(): void {
    ensurePrivateSqliteFiles(this.path);
  }
}

type Row = Record<string, unknown>;

function selectionColumns(): string {
  return `selection_id, migration_id, rule_ref, principal_id, principal_role, private_device_binding,
    source_bridge_id, source_epoch_id, source_last_seq, source_fingerprint, token_digest, generation,
    issued_at, expires_at, status, revision, proposal_id, proposal_revision, failure_reason, completed_at`;
}

function selectionFromRow(row: Row): HomeAutomationMigrationSelectionRecord {
  const value = {
    selectionId: row.selection_id,
    migrationId: row.migration_id,
    ruleRef: row.rule_ref,
    principal: {
      principalId: row.principal_id,
      role: row.principal_role,
      privateDeviceBinding: row.private_device_binding,
    },
    sourceBridgeId: row.source_bridge_id,
    sourceEpochId: row.source_epoch_id,
    sourceLastSeq: row.source_last_seq,
    sourceFingerprint: row.source_fingerprint,
    tokenDigest: row.token_digest,
    generation: row.generation,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    status: row.status,
    revision: row.revision,
    ...(row.proposal_id === null || row.proposal_id === undefined ? {} : { proposalId: row.proposal_id }),
    ...(row.proposal_revision === null || row.proposal_revision === undefined ? {} : { proposalRevision: row.proposal_revision }),
    ...(row.failure_reason === null || row.failure_reason === undefined ? {} : { failureReason: row.failure_reason }),
    ...(row.completed_at === null || row.completed_at === undefined ? {} : { completedAt: row.completed_at }),
  };
  try {
    return validateSelectionRecord(value);
  } catch {
    throw new Error("Stored home automation migration selection is corrupt");
  }
}

function assertSelectionSource(
  assessment: HomeAutomationMigrationAssessment | undefined,
  input: HomeAutomationMigrationSelectionIssue,
): void {
  if (assessment === undefined || assessment.status !== "assessed") throw new Error("Migration selection source is unavailable");
  const rule = assessment.rules.find((item) => item.ruleRef === input.ruleRef);
  if (rule === undefined || rule.disposition !== "eligible" || rule.workflow?.status !== "assessed"
    || rule.sourceFingerprint !== input.sourceFingerprint
    || assessment.sourceBridgeId !== input.sourceBridgeId
    || assessment.sourceEpochId !== input.sourceEpochId
    || assessment.sourceLastSeq !== input.sourceLastSeq) {
    throw new Error("Migration selection source is stale or ineligible");
  }
}

function selectionSourceMatchesRecord(
  assessment: HomeAutomationMigrationAssessment | undefined,
  record: HomeAutomationMigrationSelectionRecord,
): boolean {
  if (assessment === undefined || assessment.status !== "assessed") return false;
  const rule = assessment.rules.find((item) => item.ruleRef === record.ruleRef);
  return rule !== undefined
    && rule.disposition === "eligible"
    && rule.workflow?.status === "assessed"
    && rule.sourceFingerprint === record.sourceFingerprint
    && assessment.sourceBridgeId === record.sourceBridgeId
    && assessment.sourceEpochId === record.sourceEpochId
    && assessment.sourceLastSeq === record.sourceLastSeq;
}

function selectionIssueMatches(
  record: HomeAutomationMigrationSelectionRecord,
  input: HomeAutomationMigrationSelectionIssue,
): boolean {
  return record.migrationId === input.migrationId
    && record.ruleRef === input.ruleRef
    && sameSelectionPrincipal(record, input.principal)
    && record.sourceBridgeId === input.sourceBridgeId
    && record.sourceEpochId === input.sourceEpochId
    && record.sourceLastSeq === input.sourceLastSeq
    && record.sourceFingerprint === input.sourceFingerprint
    && record.generation === input.generation;
}

function sameSelectionPrincipal(
  record: HomeAutomationMigrationSelectionRecord,
  principal: HomeAutomationMigrationSelectionPrincipal,
): boolean {
  return record.principal.principalId === principal.principalId
    && record.principal.role === principal.role
    && record.principal.privateDeviceBinding === principal.privateDeviceBinding;
}

function transitionSelection(
  current: HomeAutomationMigrationSelectionRecord,
  patch: {
    readonly status: HomeAutomationMigrationSelectionRecordStatus;
    readonly revision: number;
    readonly proposalId?: string;
    readonly proposalRevision?: number;
    readonly failureReason?: HomeAutomationMigrationSelectionFailureReason;
    readonly completedAt?: string;
  },
): HomeAutomationMigrationSelectionRecord {
  const next: HomeAutomationMigrationSelectionRecord = {
    ...current,
    status: patch.status,
    revision: patch.revision,
    ...(patch.proposalId === undefined ? {} : { proposalId: patch.proposalId }),
    ...(patch.proposalRevision === undefined ? {} : { proposalRevision: patch.proposalRevision }),
    ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
    ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
  };
  if (patch.status !== "prepared") {
    delete (next as { proposalId?: string }).proposalId;
    delete (next as { proposalRevision?: number }).proposalRevision;
  }
  if (patch.status === "issued" || patch.status === "processing") {
    delete (next as { failureReason?: HomeAutomationMigrationSelectionFailureReason }).failureReason;
    delete (next as { completedAt?: string }).completedAt;
  }
  validateSelectionRecord(next);
  return next;
}

function compareSelection(left: HomeAutomationMigrationSelectionRecord, right: HomeAutomationMigrationSelectionRecord): number {
  const issued = left.issuedAt.localeCompare(right.issuedAt);
  return issued !== 0 ? issued : left.selectionId.localeCompare(right.selectionId);
}

function isSelectionIdForStore(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32,128}$/u.test(value);
}

function isMigrationIdForStore(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function validateSelectionListQuery(value: unknown): asserts value is {
  readonly migrationId?: string;
  readonly principalId?: string;
  readonly generation?: string;
  readonly status?: HomeAutomationMigrationSelectionRecordStatus;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Home automation migration selection query is invalid");
  const input = value as {
    readonly migrationId?: unknown;
    readonly principalId?: unknown;
    readonly generation?: unknown;
    readonly status?: unknown;
  };
  if (input.migrationId !== undefined && !isMigrationIdForStore(input.migrationId)) throw new TypeError("Invalid home automation migration id");
  if (input.principalId !== undefined && !isBoundedSelectionQueryText(input.principalId, 200)) throw new TypeError("Invalid home automation migration principal id");
  if (input.generation !== undefined && !isBoundedSelectionQueryText(input.generation, 128)) throw new TypeError("Invalid home automation migration generation");
  if (input.status !== undefined && input.status !== "issued" && input.status !== "processing"
    && input.status !== "prepared" && input.status !== "unavailable" && input.status !== "expired" && input.status !== "invalidated") {
    throw new TypeError("Invalid home automation migration selection status");
  }
}

function isBoundedSelectionQueryText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000\r\n]/u.test(value);
}

function fromRow(row: Row): HomeAutomationMigrationAssessment {
  const migrationId = row.migration_id;
  const idempotencyKey = row.idempotency_key;
  const inputDigest = row.input_digest;
  const sourceBridgeId = row.source_bridge_id;
  const sourceEpochId = row.source_epoch_id;
  const sourceLastSeq = row.source_last_seq;
  const analysisMode = row.analysis_mode;
  const status = row.status;
  const createdAt = row.created_at;
  if (!isMigrationId(migrationId) || !isIdempotencyKey(idempotencyKey) || !isDigest(inputDigest)
    || !isBoundedText(sourceBridgeId, HOME_AUTOMATION_MIGRATION_LIMITS.maxBridgeIdLength)
    || !isBoundedText(sourceEpochId, HOME_AUTOMATION_MIGRATION_LIMITS.maxEpochIdLength)
    || !isPositiveSafeInteger(sourceLastSeq) || !isAnalysisMode(analysisMode)
    || !isStatus(status) || !isIsoTimestamp(createdAt) || typeof row.rules_json !== "string") {
    throw new Error("Stored home automation migration is corrupt");
  }
  let parsedRules: unknown;
  try { parsedRules = JSON.parse(row.rules_json); } catch { throw new Error("Stored home automation migration is corrupt"); }
  let rules: HomeAutomationMigrationRuleAssessment[];
  try {
    rules = validateRules(parsedRules);
  } catch {
    throw new Error("Stored home automation migration is corrupt");
  }
  if (Buffer.byteLength(row.rules_json, "utf8") > HOME_AUTOMATION_MIGRATION_LIMITS.maxInputBytes) {
    throw new Error("Stored home automation migration is corrupt");
  }
  const assessedAt = row.assessed_at;
  const closedAt = row.closed_at;
  const closedFrom = row.closed_from;
  const closeReason = row.close_reason;
  if (status === "discovered") {
    if (assessedAt !== null || closedAt !== null || closedFrom !== null || closeReason !== null) throw new Error("Stored home automation migration is corrupt");
    return { migrationId, idempotencyKey, inputDigest, sourceBridgeId, sourceEpochId, sourceLastSeq, analysisMode, rules, status, createdAt };
  }
  if (status === "closed") {
    if (!isIsoTimestamp(closedAt) || !isClosedFrom(closedFrom) || !isCloseReason(closeReason)
      || Date.parse(closedAt) < Date.parse(createdAt) || assessedAt !== null && !isIsoTimestamp(assessedAt)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    if (closedFrom !== "discovered") assertStoredAggregateStatus(closedFrom, rules);
    return {
      migrationId, idempotencyKey, inputDigest, sourceBridgeId, sourceEpochId, sourceLastSeq, analysisMode, rules, status, createdAt,
      ...(assessedAt === null ? {} : { assessedAt }), closedAt, closedFrom, closeReason,
    };
  }
  if (!isIsoTimestamp(assessedAt) || Date.parse(assessedAt) < Date.parse(createdAt)
    || closedAt !== null || closedFrom !== null || closeReason !== null) {
    throw new Error("Stored home automation migration is corrupt");
  }
  assertStoredAggregateStatus(status, rules);
  return { migrationId, idempotencyKey, inputDigest, sourceBridgeId, sourceEpochId, sourceLastSeq, analysisMode, rules, status, createdAt, assessedAt };
}

function assertStoredAggregateStatus(
  status: Exclude<HomeAutomationMigrationStatus, "discovered" | "closed">,
  rules: readonly HomeAutomationMigrationRuleAssessment[],
): void {
  const hasNeedsAttention = rules.length === 0 || rules.some((rule) => rule.disposition === "needs_attention");
  if ((status === "needs_attention") !== hasNeedsAttention) throw new Error("Stored home automation migration is corrupt");
}

function validateDiscovery(input: HomeAutomationMigrationDiscovery): void {
  if (!input || !isMigrationId(input.migrationId) || !isIdempotencyKey(input.idempotencyKey) || !isDigest(input.inputDigest)
    || !isBoundedText(input.sourceBridgeId, HOME_AUTOMATION_MIGRATION_LIMITS.maxBridgeIdLength)
    || !isBoundedText(input.sourceEpochId, HOME_AUTOMATION_MIGRATION_LIMITS.maxEpochIdLength)
    || !isPositiveSafeInteger(input.sourceLastSeq) || !isAnalysisMode(input.analysisMode)
    || !isIsoTimestamp(input.createdAt)) {
    throw new TypeError("Home automation migration discovery is invalid");
  }
  validateRules(input.rules);
}

function validateTransition(input: HomeAutomationMigrationAssessmentTransition): void {
  if (!input || !isMigrationId(input.migrationId) || !isTransitionStatus(input.status) || !isIsoTimestamp(input.assessedAt)) {
    throw new TypeError("Home automation migration assessment transition is invalid");
  }
  validateRules(input.rules);
  assertStoredAggregateStatus(input.status, input.rules);
}

function assertAssessmentWorkflowTransition(
  before: readonly HomeAutomationMigrationRuleAssessment[],
  after: readonly HomeAutomationMigrationRuleAssessment[],
): void {
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index]!;
    const next = after[index]!;
    if (previous.workflow === undefined) {
      if (next.workflow !== undefined && next.workflow.status !== "assessed") {
        throw new Error("Migration assessment workflow must start at assessed");
      }
      continue;
    }
    if (next.workflow === undefined) continue;
    if (!workflowEqual(previous.workflow, next.workflow)) {
      throw new Error("Migration assessment cannot mutate a rule workflow");
    }
  }
}

function workflowEqual(left: HomeAutomationMigrationRuleWorkflow, right: HomeAutomationMigrationRuleWorkflow): boolean {
  const keys: readonly (keyof HomeAutomationMigrationRuleWorkflow)[] = [
    "status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash",
    "artifactId", "artifactRevision", "artifactContentHash", "translatedAt", "compileResultId", "dryRunResultId",
    "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor",
    "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt",
    "rollbackOperationId", "rollbackActor", "rollbackStartedAt", "restoredAt", "failedAt", "failureReason",
  ];
  return keys.every((key) => left[key] === right[key]);
}

function validateWorkflowTransition(input: HomeAutomationMigrationRuleWorkflowTransition): void {
  const allowedKeys = [
    "migrationId", "ruleRef", "from", "to", "transitionedAt", "proposalId", "candidateProposalRevision",
    "candidateContentHash", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "failureReason",
    "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled",
    "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "rollbackOperationId", "rollbackActor",
  ] as const;
  if (!isRecord(input) || !hasOnlyKeys(input, allowedKeys)
    || !isMigrationId(input.migrationId)
    || !isBoundedText(input.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
    || !isWorkflowStatus(input.from) || !isWorkflowTarget(input.to)
    || !isIsoTimestamp(input.transitionedAt)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.proposalId !== undefined && !isBoundedText(input.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.candidateProposalRevision !== undefined && !isPositiveSafeInteger(input.candidateProposalRevision)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.reviewProposalRevision !== undefined && !isPositiveSafeInteger(input.reviewProposalRevision)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.candidateContentHash !== undefined && !isDigest(input.candidateContentHash)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.artifactId !== undefined && !isBoundedText(input.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.artifactRevision !== undefined && !isPositiveSafeInteger(input.artifactRevision)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.artifactContentHash !== undefined && !isDigest(input.artifactContentHash)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.compileResultId !== undefined && !isDigest(input.compileResultId)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.dryRunResultId !== undefined && !isDigest(input.dryRunResultId)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.approvedProposalRevision !== undefined && !isPositiveSafeInteger(input.approvedProposalRevision)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.switchOperationId !== undefined && !is128BitHex(input.switchOperationId)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.switchActor !== undefined && !isBoundedText(input.switchActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.sourceWasEnabled !== undefined && input.sourceWasEnabled !== true) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.deploymentId !== undefined && !isBoundedText(input.deploymentId, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentIdLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.deploymentTarget !== undefined && !isBoundedText(input.deploymentTarget, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentTargetLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.deploymentConfigFingerprint !== undefined && !isDigest(input.deploymentConfigFingerprint)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.rollbackOperationId !== undefined && !is128BitHex(input.rollbackOperationId)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.rollbackActor !== undefined && !isBoundedText(input.rollbackActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.failureReason !== undefined && !isWorkflowFailureReason(input.failureReason)) {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
  if (input.to === "translated") {
    if ((input.from !== "assessed" && input.from !== "needs_attention") || input.proposalId === undefined
      || input.candidateProposalRevision === undefined || input.candidateContentHash === undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.failureReason !== undefined || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined
      || input.switchActor !== undefined || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined
      || input.deploymentTarget !== undefined || input.deploymentConfigFingerprint !== undefined || input.rollbackOperationId !== undefined
      || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "simulated") {
    if ((input.from !== "translated" && input.from !== "needs_attention") || input.artifactId === undefined
      || input.artifactRevision === undefined || input.artifactContentHash === undefined
      || input.compileResultId === undefined || input.dryRunResultId === undefined
      || input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.reviewProposalRevision !== undefined || input.failureReason !== undefined || input.approvedProposalRevision !== undefined
      || input.switchOperationId !== undefined || input.switchActor !== undefined || input.sourceWasEnabled !== undefined
      || input.deploymentId !== undefined || input.deploymentTarget !== undefined || input.deploymentConfigFingerprint !== undefined
      || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "ready") {
    if (input.from !== "simulated" || input.reviewProposalRevision === undefined || input.proposalId !== undefined || input.candidateProposalRevision !== undefined
      || input.candidateContentHash !== undefined || input.artifactId !== undefined || input.artifactRevision !== undefined
      || input.artifactContentHash !== undefined || input.compileResultId !== undefined
      || input.dryRunResultId !== undefined || input.failureReason !== undefined || input.approvedProposalRevision !== undefined
      || input.switchOperationId !== undefined || input.switchActor !== undefined || input.sourceWasEnabled !== undefined
      || input.deploymentId !== undefined || input.deploymentTarget !== undefined || input.deploymentConfigFingerprint !== undefined
      || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "switching") {
    if ((input.from !== "ready" && input.from !== "needs_attention") || input.switchOperationId === undefined
      || input.switchActor === undefined
      || input.from === "ready" && (input.approvedProposalRevision === undefined || input.sourceWasEnabled !== true)
      || input.from === "needs_attention" && (input.approvedProposalRevision !== undefined || input.sourceWasEnabled !== undefined)
      || input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.deploymentId !== undefined || input.deploymentTarget !== undefined || input.deploymentConfigFingerprint !== undefined
      || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined || input.failureReason !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "verified") {
    if (input.from !== "switching" || input.deploymentId === undefined || input.deploymentTarget === undefined
      || input.deploymentConfigFingerprint === undefined || input.proposalId !== undefined || input.candidateProposalRevision !== undefined
      || input.candidateContentHash !== undefined || input.artifactId !== undefined || input.artifactRevision !== undefined
      || input.artifactContentHash !== undefined || input.compileResultId !== undefined || input.dryRunResultId !== undefined
      || input.reviewProposalRevision !== undefined || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined
      || input.switchActor !== undefined || input.sourceWasEnabled !== undefined || input.rollbackOperationId !== undefined
      || input.rollbackActor !== undefined || input.failureReason !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "rolling_back") {
    if ((input.from !== "verified" && input.from !== "needs_attention") || input.rollbackOperationId === undefined || input.rollbackActor === undefined
      || input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined || input.switchActor !== undefined
      || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined || input.deploymentTarget !== undefined
      || input.deploymentConfigFingerprint !== undefined || input.failureReason !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.to === "restored") {
    if (input.from !== "rolling_back" || input.proposalId !== undefined || input.candidateProposalRevision !== undefined
      || input.candidateContentHash !== undefined || input.artifactId !== undefined || input.artifactRevision !== undefined
      || input.artifactContentHash !== undefined || input.compileResultId !== undefined || input.dryRunResultId !== undefined
      || input.reviewProposalRevision !== undefined || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined
      || input.switchActor !== undefined || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined
      || input.deploymentTarget !== undefined || input.deploymentConfigFingerprint !== undefined || input.rollbackOperationId !== undefined
      || input.rollbackActor !== undefined || input.failureReason !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.from === "translated") {
    if (input.failureReason !== "compile_failed" && input.failureReason !== "compile_unavailable") {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
    if (input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined || input.switchActor !== undefined
      || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined || input.deploymentTarget !== undefined
      || input.deploymentConfigFingerprint !== undefined || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.from === "simulated") {
    if (input.failureReason !== "simulation_failed" && input.failureReason !== "simulation_unavailable") {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
    if (input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined || input.switchActor !== undefined
      || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined || input.deploymentTarget !== undefined
      || input.deploymentConfigFingerprint !== undefined || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else if (input.from === "ready" || input.from === "switching" || input.from === "verified" || input.from === "rolling_back") {
    if (!isAllowedWorkflowFailurePair(input.from, input.failureReason)
      || input.proposalId !== undefined || input.candidateProposalRevision !== undefined || input.candidateContentHash !== undefined
      || input.artifactId !== undefined || input.artifactRevision !== undefined || input.artifactContentHash !== undefined
      || input.compileResultId !== undefined || input.dryRunResultId !== undefined || input.reviewProposalRevision !== undefined
      || input.approvedProposalRevision !== undefined || input.switchOperationId !== undefined || input.switchActor !== undefined
      || input.sourceWasEnabled !== undefined || input.deploymentId !== undefined || input.deploymentTarget !== undefined
      || input.deploymentConfigFingerprint !== undefined || input.rollbackOperationId !== undefined || input.rollbackActor !== undefined) {
      throw new TypeError("Home automation migration rule workflow transition is invalid");
    }
  } else {
    throw new TypeError("Home automation migration rule workflow transition is invalid");
  }
}

function buildWorkflowTransition(
  current: HomeAutomationMigrationRuleWorkflow,
  input: HomeAutomationMigrationRuleWorkflowTransition,
): HomeAutomationMigrationRuleWorkflow {
  const currentTime = workflowLastTimestamp(current);
  if (Date.parse(input.transitionedAt) < Date.parse(currentTime)) {
    throw new TypeError("Migration workflow time precedes previous transition");
  }
  if (input.to === "translated") {
    if (input.from === "needs_attention"
      && current.failureReason !== "compile_failed" && current.failureReason !== "compile_unavailable") {
      throw new TypeError("Migration workflow recovery stage does not match failure reason");
    }
    return {
      status: "translated",
      sourceFingerprint: current.sourceFingerprint,
      assessedAt: current.assessedAt,
      proposalId: input.proposalId!,
      candidateProposalRevision: input.candidateProposalRevision!,
      candidateContentHash: input.candidateContentHash!,
      translatedAt: input.transitionedAt,
    };
  }
  if (input.to === "simulated") {
    if (input.from === "needs_attention"
      && current.failureReason !== "simulation_failed" && current.failureReason !== "simulation_unavailable") {
      throw new TypeError("Migration workflow recovery stage does not match failure reason");
    }
    return {
      status: "simulated",
      sourceFingerprint: current.sourceFingerprint,
      assessedAt: current.assessedAt,
      proposalId: current.proposalId!,
      candidateProposalRevision: current.candidateProposalRevision!,
      candidateContentHash: current.candidateContentHash!,
      translatedAt: current.translatedAt!,
      artifactId: input.artifactId!,
      artifactRevision: input.artifactRevision!,
      artifactContentHash: input.artifactContentHash!,
      compileResultId: input.compileResultId!,
      dryRunResultId: input.dryRunResultId!,
      simulatedAt: input.transitionedAt,
    };
  }
  if (input.to === "ready") {
    if (current.candidateProposalRevision! >= Number.MAX_SAFE_INTEGER
      || input.reviewProposalRevision !== current.candidateProposalRevision! + 1) {
      throw new TypeError("Migration workflow review revision must immediately follow the candidate revision");
    }
    return {
      status: "ready",
      sourceFingerprint: current.sourceFingerprint,
      assessedAt: current.assessedAt,
      proposalId: current.proposalId!,
      candidateProposalRevision: current.candidateProposalRevision!,
      candidateContentHash: current.candidateContentHash!,
      translatedAt: current.translatedAt!,
      artifactId: current.artifactId!,
      artifactRevision: current.artifactRevision!,
      artifactContentHash: current.artifactContentHash!,
      compileResultId: current.compileResultId!,
      dryRunResultId: current.dryRunResultId!,
      simulatedAt: current.simulatedAt!,
      readyAt: input.transitionedAt,
      reviewProposalRevision: input.reviewProposalRevision!,
    };
  }
  if (input.to === "switching") {
    if (input.from === "ready") {
      if (current.reviewProposalRevision! >= Number.MAX_SAFE_INTEGER
        || input.approvedProposalRevision !== current.reviewProposalRevision! + 1) {
        throw new TypeError("Migration workflow approved proposal revision must immediately follow the review revision");
      }
    } else if (input.from === "needs_attention"
      && current.failureReason !== "switch_failed" && current.failureReason !== "switch_unknown"
      && current.failureReason !== "verification_failed") {
      throw new TypeError("Migration workflow switch recovery requires a switch failure");
    } else if (current.approvedProposalRevision === undefined || current.switchOperationId === undefined
      || current.switchActor === undefined || current.sourceWasEnabled !== true || current.switchStartedAt === undefined
      || input.switchOperationId === current.switchOperationId) {
      throw new TypeError("Migration workflow switch recovery requires complete switching evidence");
    }
    const withoutFailure = clearWorkflowFailure(current);
    return {
      ...withoutFailure,
      status: "switching",
      ...(input.from === "ready" ? { approvedProposalRevision: input.approvedProposalRevision! } : {}),
      switchOperationId: input.switchOperationId!,
      switchActor: input.switchActor!,
      sourceWasEnabled: true,
      switchStartedAt: input.transitionedAt,
    };
  }
  if (input.to === "verified") {
    return {
      ...current,
      status: "verified",
      deploymentId: input.deploymentId!,
      deploymentTarget: input.deploymentTarget!,
      deploymentConfigFingerprint: input.deploymentConfigFingerprint!,
      verifiedAt: input.transitionedAt,
    };
  }
  if (input.to === "rolling_back") {
    if (input.from === "needs_attention") {
      const canResumeFromVerification = current.failureReason === "verification_failed"
        && current.deploymentId !== undefined && current.deploymentTarget !== undefined
        && current.deploymentConfigFingerprint !== undefined && current.verifiedAt !== undefined
        && current.rollbackOperationId === undefined && current.rollbackActor === undefined && current.rollbackStartedAt === undefined;
      const canResumeExistingRollback = (current.failureReason === "rollback_failed" || current.failureReason === "rollback_unknown")
        && current.deploymentId !== undefined && current.deploymentTarget !== undefined
        && current.deploymentConfigFingerprint !== undefined && current.verifiedAt !== undefined
        && current.rollbackOperationId !== undefined && current.rollbackActor !== undefined && current.rollbackStartedAt !== undefined;
      if (!canResumeFromVerification && !canResumeExistingRollback) {
        throw new TypeError("Migration workflow rollback recovery requires verified or rollback evidence");
      }
      if (canResumeExistingRollback && input.rollbackOperationId === current.rollbackOperationId) {
        throw new TypeError("Migration workflow rollback recovery requires a new operation id");
      }
    }
    const withoutFailure = clearWorkflowFailure(current);
    return {
      ...withoutFailure,
      status: "rolling_back",
      rollbackOperationId: input.rollbackOperationId!,
      rollbackActor: input.rollbackActor!,
      rollbackStartedAt: input.transitionedAt,
    };
  }
  if (input.to === "restored") {
    return {
      ...current,
      status: "restored",
      restoredAt: input.transitionedAt,
    };
  }
  return {
    ...current,
    status: "needs_attention",
    failedAt: input.transitionedAt,
    failureReason: input.failureReason!,
  };
}

function clearWorkflowFailure(value: HomeAutomationMigrationRuleWorkflow): HomeAutomationMigrationRuleWorkflow {
  const next = { ...value };
  delete next.failedAt;
  delete next.failureReason;
  return next;
}

function workflowLastTimestamp(value: HomeAutomationMigrationRuleWorkflow): string {
  return value.failedAt ?? value.restoredAt ?? value.rollbackStartedAt ?? value.verifiedAt
    ?? value.switchStartedAt ?? value.readyAt ?? value.simulatedAt ?? value.translatedAt ?? value.assessedAt;
}

function validateClose(input: HomeAutomationMigrationCloseCommand): void {
  if (!input || !isMigrationId(input.migrationId) || !isIsoTimestamp(input.closedAt) || !isCloseReason(input.reason)) {
    throw new TypeError("Home automation migration close command is invalid");
  }
}

function validateRules(value: unknown): HomeAutomationMigrationRuleAssessment[] {
  if (!Array.isArray(value) || value.length > HOME_AUTOMATION_MIGRATION_LIMITS.maxRules) {
    throw new Error("Home automation migration rules exceed the bound");
  }
  const refs = new Set<string>();
  const rules = value.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["ruleRef", "name", "enabled", "updatedAt", "triggerClass", "conditionClass", "actionClass", "sourceFingerprint", "disposition", "reason", "workflow"])
      || !isBoundedText(item.ruleRef, HOME_AUTOMATION_MIGRATION_LIMITS.maxRuleRefLength)
      || refs.has(item.ruleRef)
      || !isRuleClass(item.triggerClass) || !isConditionClass(item.conditionClass) || !isRuleClass(item.actionClass)
      || !isDisposition(item.disposition)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    refs.add(item.ruleRef);
    if (item.name !== undefined && !isBoundedText(item.name, HOME_AUTOMATION_MIGRATION_LIMITS.maxNameLength)) throw new Error("Stored home automation migration is corrupt");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error("Stored home automation migration is corrupt");
    if (item.updatedAt !== undefined && !isIsoTimestamp(item.updatedAt)) throw new Error("Stored home automation migration is corrupt");
    if (item.sourceFingerprint !== undefined && !isSourceFingerprint(item.sourceFingerprint)) throw new Error("Stored home automation migration is corrupt");
    if (item.reason !== undefined && !isRuleReason(item.reason)) throw new Error("Stored home automation migration is corrupt");
    const workflow = item.workflow === undefined ? undefined : validateWorkflow(item.workflow, item.sourceFingerprint);
    if (item.disposition === "eligible" && item.reason !== undefined) throw new Error("Stored home automation migration is corrupt");
    if (item.disposition !== "eligible" && item.reason === undefined) throw new Error("Stored home automation migration is corrupt");
    if (!isRuleAssessmentSemantics(item, workflow)) throw new Error("Stored home automation migration is corrupt");
    return {
      ruleRef: item.ruleRef,
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
      ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
      triggerClass: item.triggerClass,
      conditionClass: item.conditionClass,
      actionClass: item.actionClass,
      ...(item.sourceFingerprint === undefined ? {} : { sourceFingerprint: item.sourceFingerprint }),
      disposition: item.disposition,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      ...(workflow === undefined ? {} : { workflow }),
    } satisfies HomeAutomationMigrationRuleAssessment;
  });
  return rules;
}

function serializeRules(rules: readonly HomeAutomationMigrationRuleAssessment[]): string {
  const normalized = validateRules(rules);
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > HOME_AUTOMATION_MIGRATION_LIMITS.maxInputBytes) {
    throw new TypeError("Home automation migration rules exceed the byte bound");
  }
  return encoded;
}

function validateWorkflow(value: unknown, parentSourceFingerprint: unknown): HomeAutomationMigrationRuleWorkflow {
  if (!isRecord(value) || !isSourceFingerprint(parentSourceFingerprint)
    || !isSourceFingerprint(value.sourceFingerprint) || value.sourceFingerprint !== parentSourceFingerprint
    || !isWorkflowStatus(value.status) || !isIsoTimestamp(value.assessedAt)) {
    throw new Error("Stored home automation migration is corrupt");
  }
  const base = {
    sourceFingerprint: value.sourceFingerprint,
    assessedAt: value.assessedAt,
  };
  if (value.status === "assessed") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt"])) throw new Error("Stored home automation migration is corrupt");
    return { status: "assessed", ...base };
  }
  if (value.status === "translated") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt"])
      || !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
      || !isPositiveSafeInteger(value.candidateProposalRevision) || !isDigest(value.candidateContentHash)
      || !isIsoTimestamp(value.translatedAt) || Date.parse(value.translatedAt) < Date.parse(value.assessedAt)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "translated", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
    };
  }
  if (value.status === "simulated") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt"])
      || !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
      || !isPositiveSafeInteger(value.candidateProposalRevision) || !isDigest(value.candidateContentHash)
      || !isIsoTimestamp(value.translatedAt) || !isBoundedText(value.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)
      || !isPositiveSafeInteger(value.artifactRevision) || !isDigest(value.artifactContentHash)
      || !isDigest(value.compileResultId) || !isDigest(value.dryRunResultId)
      || !isIsoTimestamp(value.simulatedAt)
      || Date.parse(value.translatedAt) < Date.parse(value.assessedAt)
      || Date.parse(value.simulatedAt) < Date.parse(value.translatedAt)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "simulated", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
    };
  }
  if (value.status === "ready") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision"])
      || !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
      || !isPositiveSafeInteger(value.candidateProposalRevision) || !isDigest(value.candidateContentHash)
      || !isIsoTimestamp(value.translatedAt) || !isBoundedText(value.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)
      || !isPositiveSafeInteger(value.artifactRevision) || !isDigest(value.artifactContentHash)
      || !isDigest(value.compileResultId) || !isDigest(value.dryRunResultId)
      || !isIsoTimestamp(value.simulatedAt) || !isIsoTimestamp(value.readyAt)
      || !isPositiveSafeInteger(value.reviewProposalRevision)
      || value.candidateProposalRevision >= Number.MAX_SAFE_INTEGER
      || value.reviewProposalRevision !== value.candidateProposalRevision + 1
      || Date.parse(value.translatedAt) < Date.parse(value.assessedAt)
      || Date.parse(value.simulatedAt) < Date.parse(value.translatedAt)
      || Date.parse(value.readyAt) < Date.parse(value.simulatedAt)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "ready", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId,
      simulatedAt: value.simulatedAt, readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
    };
  }
  if (value.status === "switching") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt"])
      || !isSwitchingWorkflowFields(value)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "switching", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
      readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
      approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
      switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
    };
  }
  if (value.status === "verified") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt"])
      || !isVerifiedWorkflowFields(value)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "verified", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
      readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
      approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
      switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
      deploymentId: value.deploymentId, deploymentTarget: value.deploymentTarget,
      deploymentConfigFingerprint: value.deploymentConfigFingerprint, verifiedAt: value.verifiedAt,
    };
  }
  if (value.status === "rolling_back") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt", "rollbackOperationId", "rollbackActor", "rollbackStartedAt"])
      || !isRollingBackWorkflowFields(value)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "rolling_back", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
      readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
      approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
      switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
      deploymentId: value.deploymentId, deploymentTarget: value.deploymentTarget,
      deploymentConfigFingerprint: value.deploymentConfigFingerprint, verifiedAt: value.verifiedAt,
      rollbackOperationId: value.rollbackOperationId, rollbackActor: value.rollbackActor,
      rollbackStartedAt: value.rollbackStartedAt,
    };
  }
  if (value.status === "restored") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt", "rollbackOperationId", "rollbackActor", "rollbackStartedAt", "restoredAt"])
      || !isRestoredWorkflowFields(value)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "restored", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
      compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
      readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
      approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
      switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
      deploymentId: value.deploymentId, deploymentTarget: value.deploymentTarget,
      deploymentConfigFingerprint: value.deploymentConfigFingerprint, verifiedAt: value.verifiedAt,
      rollbackOperationId: value.rollbackOperationId, rollbackActor: value.rollbackActor,
      rollbackStartedAt: value.rollbackStartedAt, restoredAt: value.restoredAt,
    };
  }
  const failureReason = value.failureReason;
  if (!isWorkflowFailureReason(failureReason) || !isIsoTimestamp(value.failedAt)) {
    throw new Error("Stored home automation migration is corrupt");
  }
  if (failureReason === "compile_failed" || failureReason === "compile_unavailable") {
    if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "failedAt", "failureReason"])
      || !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
      || !isPositiveSafeInteger(value.candidateProposalRevision) || !isDigest(value.candidateContentHash)
      || !isIsoTimestamp(value.translatedAt)
      || Date.parse(value.translatedAt) < Date.parse(value.assessedAt)
      || Date.parse(value.failedAt) < Date.parse(value.translatedAt)) {
      throw new Error("Stored home automation migration is corrupt");
    }
    return {
      status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
      candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
      failedAt: value.failedAt as string, failureReason,
    };
  }
  if (failureReason === "source_stale" || failureReason === "switch_unknown") {
    if (hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "failedAt", "failureReason"])
      && isReadyWorkflowFields(value) && Date.parse(value.failedAt as string) >= Date.parse(value.readyAt as string)) {
      return {
        status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
        candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
        artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
        compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
        readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
        failedAt: value.failedAt as string, failureReason,
      };
    }
  }
  if (failureReason === "switch_failed" || failureReason === "switch_unknown" || failureReason === "verification_failed") {
    if (hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "failedAt", "failureReason"])
      && isSwitchingWorkflowFields(value) && Date.parse(value.failedAt as string) >= Date.parse(value.switchStartedAt as string)) {
      return {
        status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
        candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
        artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
        compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
        readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
        approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
        switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
        failedAt: value.failedAt as string, failureReason,
      };
    }
  }
  if (failureReason === "verification_failed") {
    if (hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt", "failedAt", "failureReason"])
      && isVerifiedWorkflowFields(value) && Date.parse(value.failedAt as string) >= Date.parse(value.verifiedAt as string)) {
      return {
        status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
        candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
        artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
        compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
        readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
        approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
        switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
        deploymentId: value.deploymentId, deploymentTarget: value.deploymentTarget,
        deploymentConfigFingerprint: value.deploymentConfigFingerprint, verifiedAt: value.verifiedAt,
        failedAt: value.failedAt as string, failureReason,
      };
    }
  }
  if (failureReason === "rollback_failed" || failureReason === "rollback_unknown") {
    if (hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "readyAt", "reviewProposalRevision", "approvedProposalRevision", "switchOperationId", "switchActor", "sourceWasEnabled", "switchStartedAt", "deploymentId", "deploymentTarget", "deploymentConfigFingerprint", "verifiedAt", "rollbackOperationId", "rollbackActor", "rollbackStartedAt", "failedAt", "failureReason"])
      && isRollingBackWorkflowFields(value) && Date.parse(value.failedAt as string) >= Date.parse(value.rollbackStartedAt as string)) {
      return {
        status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
        candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
        artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
        compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId, simulatedAt: value.simulatedAt,
        readyAt: value.readyAt, reviewProposalRevision: value.reviewProposalRevision,
        approvedProposalRevision: value.approvedProposalRevision, switchOperationId: value.switchOperationId,
        switchActor: value.switchActor, sourceWasEnabled: true, switchStartedAt: value.switchStartedAt,
        deploymentId: value.deploymentId, deploymentTarget: value.deploymentTarget,
        deploymentConfigFingerprint: value.deploymentConfigFingerprint, verifiedAt: value.verifiedAt,
        rollbackOperationId: value.rollbackOperationId, rollbackActor: value.rollbackActor,
        rollbackStartedAt: value.rollbackStartedAt, failedAt: value.failedAt as string, failureReason,
      };
    }
  }
  if (!hasExactKeys(value, ["status", "sourceFingerprint", "assessedAt", "proposalId", "candidateProposalRevision", "candidateContentHash", "translatedAt", "artifactId", "artifactRevision", "artifactContentHash", "compileResultId", "dryRunResultId", "simulatedAt", "failedAt", "failureReason"])
    || !isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
    || !isPositiveSafeInteger(value.candidateProposalRevision) || !isDigest(value.candidateContentHash)
    || !isIsoTimestamp(value.translatedAt) || !isBoundedText(value.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)
    || !isPositiveSafeInteger(value.artifactRevision) || !isDigest(value.artifactContentHash)
    || !isDigest(value.compileResultId) || !isDigest(value.dryRunResultId)
    || !isIsoTimestamp(value.simulatedAt)
    || Date.parse(value.translatedAt) < Date.parse(value.assessedAt)
    || Date.parse(value.simulatedAt) < Date.parse(value.translatedAt)
    || Date.parse(value.failedAt) < Date.parse(value.simulatedAt)) {
    throw new Error("Stored home automation migration is corrupt");
  }
  return {
    status: "needs_attention", ...base, proposalId: value.proposalId, candidateProposalRevision: value.candidateProposalRevision,
    candidateContentHash: value.candidateContentHash, translatedAt: value.translatedAt,
    artifactId: value.artifactId, artifactRevision: value.artifactRevision, artifactContentHash: value.artifactContentHash,
    compileResultId: value.compileResultId, dryRunResultId: value.dryRunResultId,
    simulatedAt: value.simulatedAt, failedAt: value.failedAt as string, failureReason,
  };
}

interface ReadyWorkflowFields {
  readonly proposalId: string;
  readonly candidateProposalRevision: number;
  readonly candidateContentHash: string;
  readonly translatedAt: string;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly artifactContentHash: string;
  readonly compileResultId: string;
  readonly dryRunResultId: string;
  readonly simulatedAt: string;
  readonly readyAt: string;
  readonly reviewProposalRevision: number;
}

interface SwitchingWorkflowFields extends ReadyWorkflowFields {
  readonly approvedProposalRevision: number;
  readonly switchOperationId: string;
  readonly switchActor: string;
  readonly sourceWasEnabled: true;
  readonly switchStartedAt: string;
}

interface VerifiedWorkflowFields extends SwitchingWorkflowFields {
  readonly deploymentId: string;
  readonly deploymentTarget: string;
  readonly deploymentConfigFingerprint: string;
  readonly verifiedAt: string;
}

interface RollingBackWorkflowFields extends VerifiedWorkflowFields {
  readonly rollbackOperationId: string;
  readonly rollbackActor: string;
  readonly rollbackStartedAt: string;
}

interface RestoredWorkflowFields extends RollingBackWorkflowFields {
  readonly restoredAt: string;
}

function isReadyWorkflowFields(value: Record<string, unknown>): value is Record<string, unknown> & ReadyWorkflowFields {
  return isBoundedText(value.proposalId, HOME_AUTOMATION_MIGRATION_LIMITS.maxProposalIdLength)
    && isPositiveSafeInteger(value.candidateProposalRevision) && value.candidateProposalRevision < Number.MAX_SAFE_INTEGER
    && isDigest(value.candidateContentHash) && isIsoTimestamp(value.translatedAt)
    && isBoundedText(value.artifactId, HOME_AUTOMATION_MIGRATION_LIMITS.maxArtifactIdLength)
    && isPositiveSafeInteger(value.artifactRevision) && isDigest(value.artifactContentHash)
    && isDigest(value.compileResultId) && isDigest(value.dryRunResultId)
    && isIsoTimestamp(value.simulatedAt) && isIsoTimestamp(value.readyAt)
    && isPositiveSafeInteger(value.reviewProposalRevision)
    && value.reviewProposalRevision === value.candidateProposalRevision + 1
    && Date.parse(value.translatedAt) >= Date.parse(value.assessedAt as string)
    && Date.parse(value.simulatedAt) >= Date.parse(value.translatedAt)
    && Date.parse(value.readyAt) >= Date.parse(value.simulatedAt);
}

function isSwitchingWorkflowFields(value: Record<string, unknown>): value is Record<string, unknown> & SwitchingWorkflowFields {
  return isReadyWorkflowFields(value)
    && isPositiveSafeInteger(value.approvedProposalRevision)
    && value.reviewProposalRevision < Number.MAX_SAFE_INTEGER
    && value.approvedProposalRevision === value.reviewProposalRevision + 1
    && is128BitHex(value.switchOperationId)
    && isBoundedText(value.switchActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength)
    && value.sourceWasEnabled === true
    && isIsoTimestamp(value.switchStartedAt)
    && Date.parse(value.switchStartedAt) >= Date.parse(value.readyAt as string);
}

function isVerifiedWorkflowFields(value: Record<string, unknown>): value is Record<string, unknown> & VerifiedWorkflowFields {
  return isSwitchingWorkflowFields(value)
    && isBoundedText(value.deploymentId, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentIdLength)
    && isBoundedText(value.deploymentTarget, HOME_AUTOMATION_MIGRATION_LIMITS.maxDeploymentTargetLength)
    && isDigest(value.deploymentConfigFingerprint)
    && isIsoTimestamp(value.verifiedAt)
    && Date.parse(value.verifiedAt) >= Date.parse(value.switchStartedAt as string);
}

function isRollingBackWorkflowFields(value: Record<string, unknown>): value is Record<string, unknown> & RollingBackWorkflowFields {
  return isVerifiedWorkflowFields(value)
    && is128BitHex(value.rollbackOperationId)
    && isBoundedText(value.rollbackActor, HOME_AUTOMATION_MIGRATION_LIMITS.maxOperationActorLength)
    && isIsoTimestamp(value.rollbackStartedAt)
    && Date.parse(value.rollbackStartedAt) >= Date.parse(value.verifiedAt as string);
}

function isRestoredWorkflowFields(value: Record<string, unknown>): value is Record<string, unknown> & RestoredWorkflowFields {
  return isRollingBackWorkflowFields(value)
    && isIsoTimestamp(value.restoredAt)
    && Date.parse(value.restoredAt) >= Date.parse(value.rollbackStartedAt as string);
}

function assertStableRuleMetadata(
  before: readonly HomeAutomationMigrationRuleAssessment[],
  after: readonly HomeAutomationMigrationRuleAssessment[],
): void {
  if (before.length !== after.length) throw new TypeError("Migration assessment rule count changed");
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index]!;
    const right = after[index]!;
    if (left.ruleRef !== right.ruleRef || left.name !== right.name || left.enabled !== right.enabled || left.updatedAt !== right.updatedAt) {
      throw new TypeError("Migration assessment rule metadata changed");
    }
  }
}

function cloneAssessment(value: HomeAutomationMigrationAssessment): HomeAutomationMigrationAssessment {
  return {
    ...value,
    rules: cloneRules(value.rules),
  };
}

function cloneRules(rules: readonly HomeAutomationMigrationRuleAssessment[]): HomeAutomationMigrationRuleAssessment[] {
  return rules.map((rule) => ({
    ...rule,
    ...(rule.workflow === undefined ? {} : { workflow: { ...rule.workflow } }),
  }));
}

function compareAssessment(left: HomeAutomationMigrationAssessment, right: HomeAutomationMigrationAssessment): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  return created !== 0 ? created : left.migrationId.localeCompare(right.migrationId);
}

function validateId(value: unknown, label: string): string {
  if (!isMigrationId(value)) throw new TypeError(`Invalid home automation migration ${label}`);
  return value;
}

function validateIdempotencyKey(value: unknown): string {
  if (!isIdempotencyKey(value)) throw new TypeError("Invalid home automation migration idempotency key");
  return value;
}

function validateDigest(value: unknown): string {
  if (!isDigest(value)) throw new TypeError("Invalid home automation migration input digest");
  return value;
}

function isMigrationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return isMigrationId(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isAnalysisMode(value: unknown): value is "metadata_only" | "trusted_neutral" {
  return value === "metadata_only" || value === "trusted_neutral";
}

function isStatus(value: unknown): value is HomeAutomationMigrationStatus {
  return value === "discovered" || value === "assessed" || value === "needs_attention" || value === "closed";
}

function isTransitionStatus(value: unknown): value is Exclude<HomeAutomationMigrationStatus, "discovered" | "closed"> {
  return value === "assessed" || value === "needs_attention";
}

function isClosedFrom(value: unknown): value is Exclude<HomeAutomationMigrationStatus, "closed"> {
  return value === "discovered" || value === "assessed" || value === "needs_attention";
}

function isCloseReason(value: unknown): value is "household_closed" | "superseded" | "stale_source" {
  return value === "household_closed" || value === "superseded" || value === "stale_source";
}

function isRuleClass(value: unknown): value is HomeAutomationMigrationRuleAssessment["triggerClass"] {
  return value === "state" || value === "time" || value === "reversible" || value === "metadata_only" || value === "unsupported" || value === "unknown";
}

function isDisposition(value: unknown): value is HomeAutomationMigrationRuleAssessment["disposition"] {
  return value === "eligible" || value === "metadata_only" || value === "unsupported" || value === "needs_attention";
}

function isRuleReason(value: unknown): value is NonNullable<HomeAutomationMigrationRuleAssessment["reason"]> {
  return value === "translation_unavailable" || value === "unsupported_trigger" || value === "unsupported_condition"
    || value === "unsupported_action" || value === "analysis_incomplete";
}

function isRuleAssessmentSemantics(value: Record<string, unknown>, workflow: HomeAutomationMigrationRuleWorkflow | undefined): boolean {
  if (value.disposition === "eligible") {
    return (value.triggerClass === "state" || value.triggerClass === "time")
      && value.conditionClass === "flat_and" && value.actionClass === "reversible"
      && isSourceFingerprint(value.sourceFingerprint) && workflow !== undefined;
  }
  if (value.disposition === "metadata_only") {
    return value.triggerClass === "metadata_only" && value.conditionClass === "metadata_only"
      && value.actionClass === "metadata_only" && value.sourceFingerprint === undefined
      && value.reason === "translation_unavailable" && workflow === undefined;
  }
  if (value.disposition === "unsupported") {
    if (value.sourceFingerprint !== undefined || workflow !== undefined) return false;
    if (value.reason === "unsupported_trigger") {
      return value.triggerClass === "unsupported"
        && (value.conditionClass === "flat_and" || value.conditionClass === "unsupported")
        && (value.actionClass === "reversible" || value.actionClass === "unsupported");
    }
    if (value.reason === "unsupported_condition") {
      return (value.triggerClass === "state" || value.triggerClass === "time")
        && value.conditionClass === "unsupported"
        && (value.actionClass === "reversible" || value.actionClass === "unsupported");
    }
    return value.reason === "unsupported_action"
      && (value.triggerClass === "state" || value.triggerClass === "time")
      && value.conditionClass === "flat_and"
      && value.actionClass === "unsupported";
  }
  return value.disposition === "needs_attention"
    && value.reason === "analysis_incomplete"
    && value.sourceFingerprint === undefined
    && workflow === undefined
    && (value.triggerClass === "unknown" || value.conditionClass === "unknown" || value.actionClass === "unknown");
}

function isWorkflowStatus(value: unknown): value is HomeAutomationMigrationRuleWorkflowStatus {
  return value === "assessed" || value === "translated" || value === "simulated" || value === "ready"
    || value === "switching" || value === "verified" || value === "rolling_back" || value === "restored"
    || value === "needs_attention";
}

function isWorkflowTarget(value: unknown): value is Exclude<HomeAutomationMigrationRuleWorkflowStatus, "assessed"> {
  return value === "translated" || value === "simulated" || value === "ready" || value === "switching"
    || value === "verified" || value === "rolling_back" || value === "restored" || value === "needs_attention";
}

function isWorkflowFailureReason(value: unknown): value is HomeAutomationMigrationRuleWorkflowFailureReason {
  return value === "compile_failed" || value === "compile_unavailable"
    || value === "simulation_failed" || value === "simulation_unavailable"
    || value === "source_stale" || value === "switch_failed" || value === "switch_unknown"
    || value === "verification_failed" || value === "rollback_failed" || value === "rollback_unknown";
}

function isAllowedWorkflowFailurePair(from: unknown, reason: unknown): boolean {
  if (from === "translated") return reason === "compile_failed" || reason === "compile_unavailable";
  if (from === "simulated") return reason === "simulation_failed" || reason === "simulation_unavailable";
  if (from === "ready") return reason === "source_stale" || reason === "switch_unknown";
  if (from === "switching") return reason === "switch_failed" || reason === "switch_unknown" || reason === "verification_failed";
  if (from === "verified") return reason === "verification_failed";
  if (from === "rolling_back") return reason === "rollback_failed" || reason === "rollback_unknown";
  return false;
}

function is128BitHex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function isConditionClass(value: unknown): value is HomeAutomationMigrationRuleAssessment["conditionClass"] {
  return value === "flat_and" || value === "metadata_only" || value === "unsupported" || value === "unknown";
}

function isSourceFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001F\u007F]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && value.trim() === value
    && value.includes("T") && !/[\u0000-\u001F\u007F]/u.test(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key) => allowed.includes(key));
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
  } catch {
    return false;
  }
}

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}
