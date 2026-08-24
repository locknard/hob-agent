import { createHash } from "node:crypto";

import { Context, Service } from "@deepseek-ai/cordis";
import type { BridgeActionTarget, ForeignRuleMigrationResult } from "@hob/bridge-contract";

import {
  createForeignRuleArtifactCandidate,
  type ForeignRuleArtifactCandidateResult,
} from "../artifact/foreign-rule-artifact-candidate.js";
import {
  HomeAutomationMigrationService,
  type HomeAutomationMigrationCreateResult,
  type HomeAutomationMigrationRunOptions,
} from "./home-automation-migration-service.js";
import {
  SqliteHomeAutomationMigrationStore,
  type SqliteHomeAutomationMigrationStoreOptions,
} from "./home-automation-migration-store.js";
import {
  HomeAutomationMigrationTranslator,
  type HomeAutomationMigrationWorldPort,
} from "./home-automation-migration-world-translator.js";
import type {
  HomeAutomationMigrationAssessment,
  HomeAutomationMigrationCloseReason,
} from "./home-automation-migration.js";
import type {
  HomeWorldForeignRuleCatalog,
  HomeWorldForeignRuleMigrationResult,
} from "../world/home-world-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAutomationMigrations: HomeAutomationMigrationRuntimeService;
  }
}

export type HomeAutomationMigrationRuntimeAssessmentFailureReason =
  | "invalid_input"
  | "catalog_unavailable"
  | "idempotency_conflict";

/**
 * A closed assessment result. The failure branch carries only a fixed reason;
 * bridge errors, native rule bodies, and provider payloads never cross this
 * runtime boundary.
 */
export type HomeAutomationMigrationRuntimeAssessmentResult =
  | HomeAutomationMigrationCreateResult
  | {
    readonly outcome: "needs_attention";
    readonly reason: HomeAutomationMigrationRuntimeAssessmentFailureReason;
  };

export type HomeAutomationMigrationRuntimeCandidateReason =
  | "assessment_not_eligible"
  | "stale_source"
  | "translation_unavailable"
  | "unsupported"
  | "invalid_input"
  | "resolver_failed"
  | "unbound_target"
  | "multiple_targets"
  | "invalid_title"
  | "artifact_invalid";

export type HomeAutomationMigrationRuntimeCandidateResult =
  | Extract<ForeignRuleArtifactCandidateResult, { readonly status: "candidate" }>
  | {
    readonly status: "needs_attention";
    readonly reason: HomeAutomationMigrationRuntimeCandidateReason;
  };

export interface HomeAutomationMigrationRuntimeServiceOptions extends SqliteHomeAutomationMigrationStoreOptions {
  readonly clock?: () => string;
  readonly migrationIdFactory?: () => string;
  readonly idempotencyKeyFactory?: () => string;
}

export interface HomeAutomationMigrationRuntimeAssessOptions {
  readonly signal?: AbortSignal;
}

export interface HomeAutomationMigrationRuntimeCandidateInput {
  readonly migrationId: string;
  readonly ruleRef: string;
}

/**
 * Cordis product owner for read-only foreign-rule assessments and candidates.
 * It owns the SQLite store and closes it with the mounted service. It never
 * persists an Artifact and never sends a bridge command.
 */
export class HomeAutomationMigrationRuntimeService extends Service {
  readonly path: string;

  private readonly world: HomeWorldMigrationPort;
  private readonly migration: HomeAutomationMigrationService;
  private closed = false;

  constructor(ctx: Context, options: HomeAutomationMigrationRuntimeServiceOptions) {
    super(ctx, "homeAutomationMigrations");

    const path = readPath(options);
    const world = readHomeWorld(ctx);
    this.path = path;
    this.world = world;
    const store = new SqliteHomeAutomationMigrationStore({ path });
    const translator = new HomeAutomationMigrationTranslator(world);
    this.migration = new HomeAutomationMigrationService({
      store,
      translator,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.migrationIdFactory === undefined ? {} : { migrationIdFactory: options.migrationIdFactory }),
      ...(options.idempotencyKeyFactory === undefined ? {} : { idempotencyKeyFactory: options.idempotencyKeyFactory }),
    });
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.close(), "home-automation-migrations.close");
  }

  async assessBridgeCatalog(
    bridgeId: string,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeAssessmentResult> {
    try {
      if (!isBoundedId(bridgeId) || !isRuntimeOptions(options)) {
        return assessmentFailure("invalid_input");
      }
      const catalogs = await this.world.foreignRuleCatalog();
      const catalog = selectExactAvailableCatalog(catalogs, bridgeId);
      if (catalog === undefined) return assessmentFailure("catalog_unavailable");

      const idempotencyKey = deterministicCutIdempotencyKey(
        catalog.bridgeId,
        catalog.epochId!,
        catalog.lastSeq!,
      );
      const input = { catalog, idempotencyKey } as const;
      const runOptions: HomeAutomationMigrationRunOptions = options.signal === undefined
        ? {}
        : { signal: options.signal };
      try {
        return await this.migration.create(input, runOptions);
      } catch (error) {
        return assessmentFailure(isIdempotencyConflict(error) ? "idempotency_conflict" : "catalog_unavailable");
      }
    } catch {
      return assessmentFailure("catalog_unavailable");
    }
  }

  get(migrationId: string): HomeAutomationMigrationAssessment | undefined {
    try {
      return isBoundedId(migrationId) ? this.migration.get(migrationId) : undefined;
    } catch {
      return undefined;
    }
  }

  list(): readonly HomeAutomationMigrationAssessment[] {
    try {
      return this.migration.list();
    } catch {
      return [];
    }
  }

  async retry(
    input: { readonly migrationId: string },
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationAssessment | undefined> {
    try {
      if (!isExactObject(input, ["migrationId"]) || !isBoundedId(input.migrationId) || !isRuntimeOptions(options)) {
        return undefined;
      }
      return await this.migration.retry(
        { migrationId: input.migrationId },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      return undefined;
    }
  }

  closeAssessment(input: {
    readonly migrationId: string;
    readonly reason: HomeAutomationMigrationCloseReason;
  }): HomeAutomationMigrationAssessment | undefined {
    try {
      if (!isExactObject(input, ["migrationId", "reason"])
        || !isBoundedId(input.migrationId)
        || !isCloseReason(input.reason)) return undefined;
      return this.migration.closeAssessment({ migrationId: input.migrationId, reason: input.reason });
    } catch {
      return undefined;
    }
  }

  async createArtifactCandidate(
    input: HomeAutomationMigrationRuntimeCandidateInput,
    options: HomeAutomationMigrationRuntimeAssessOptions = {},
  ): Promise<HomeAutomationMigrationRuntimeCandidateResult> {
    try {
      const parsedInput = readCandidateInput(input);
      if (parsedInput === undefined || !isRuntimeOptions(options)) {
        return candidateFailure("invalid_input");
      }

      const assessment = this.migration.get(parsedInput.migrationId);
      if (assessment === undefined || assessment.status !== "assessed") {
        return candidateFailure("assessment_not_eligible");
      }
      const matches = assessment.rules.filter((rule) => rule.ruleRef === parsedInput.ruleRef);
      if (matches.length !== 1 || matches[0]?.disposition !== "eligible") {
        return candidateFailure("assessment_not_eligible");
      }

      const translated = await this.world.translateForeignRule({
        bridgeId: assessment.sourceBridgeId,
        epochId: assessment.sourceEpochId,
        lastSeq: assessment.sourceLastSeq,
        ruleRef: parsedInput.ruleRef,
        signal: options.signal ?? new AbortController().signal,
      });
      const mapped = mapTranslationResult(translated);
      if (mapped.status !== "translated") return candidateFailure(mapped.reason);
      if (mapped.value.ruleRef !== parsedInput.ruleRef) return candidateFailure("stale_source");
      const expectedFingerprint = matches[0]?.sourceFingerprint;
      if (expectedFingerprint === undefined || mapped.value.sourceFingerprint !== expectedFingerprint) {
        return candidateFailure("stale_source");
      }

      const candidate = createForeignRuleArtifactCandidate(
        mapped.value,
        (binding) => this.world.resolveBridgeActionTargetForBinding(binding),
      );
      return candidate as HomeAutomationMigrationRuntimeCandidateResult;
    } catch {
      return candidateFailure("translation_unavailable");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.migration.close();
  }
}

interface HomeWorldMigrationPort extends HomeAutomationMigrationWorldPort {
  foreignRuleCatalog(): Promise<readonly HomeWorldForeignRuleCatalog[]>;
  resolveBridgeActionTargetForBinding(input: unknown): BridgeActionTarget | undefined;
}

function readHomeWorld(ctx: Context): HomeWorldMigrationPort {
  try {
    const world = ctx.get("homeWorld") as unknown as HomeWorldMigrationPort | undefined;
    if (world === undefined
      || typeof world.foreignRuleCatalog !== "function"
      || typeof world.translateForeignRule !== "function"
      || typeof world.resolveBridgeActionTargetForBinding !== "function") {
      throw new Error("HomeWorld migration port is unavailable");
    }
    return world;
  } catch {
    throw new Error("HomeWorld migration port is unavailable");
  }
}

function readPath(options: unknown): string {
  try {
    if (!isRecord(options)
      || Object.keys(options).some((key) => !["path", "clock", "migrationIdFactory", "idempotencyKeyFactory"].includes(key))) {
      throw new TypeError("home automation migration path is required");
    }
    if (typeof options.path !== "string" || options.path.length === 0 || options.path.trim() !== options.path) {
      throw new TypeError("home automation migration path is invalid");
    }
    for (const key of ["clock", "migrationIdFactory", "idempotencyKeyFactory"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "function") {
        throw new TypeError("home automation migration option is invalid");
      }
    }
    return options.path;
  } catch {
    throw new TypeError("home automation migration path is invalid");
  }
}

function selectExactAvailableCatalog(
  catalogs: readonly HomeWorldForeignRuleCatalog[],
  bridgeId: string,
): HomeWorldForeignRuleCatalog | undefined {
  if (!Array.isArray(catalogs)) return undefined;
  const matches = catalogs.filter((catalog) => {
    try {
      return isRecord(catalog) && catalog.bridgeId === bridgeId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  return isExactAvailableCatalog(match) ? match : undefined;
}

function isExactAvailableCatalog(value: unknown): value is HomeWorldForeignRuleCatalog {
  if (!isRecord(value) || value.status !== "available") return false;
  return isBoundedId(value.bridgeId)
    && isBoundedId(value.epochId)
    && isPositiveSafeInteger(value.lastSeq)
    && Array.isArray(value.rules);
}

function deterministicCutIdempotencyKey(bridgeId: string, epochId: string, lastSeq: number): string {
  return createHash("sha256")
    .update(`${bridgeId}\u0000${epochId}\u0000${lastSeq}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function mapTranslationResult(
  value: unknown,
): { readonly status: "translated"; readonly value: Extract<ForeignRuleMigrationResult, { readonly status: "translated" }> }
  | { readonly status: "needs_attention"; readonly reason: Exclude<HomeAutomationMigrationRuntimeCandidateReason, "assessment_not_eligible" | "invalid_input" | "resolver_failed" | "unbound_target" | "multiple_targets" | "invalid_title" | "artifact_invalid"> } {
  try {
    if (!isRecord(value) || value.status === "stale_source") {
      return { status: "needs_attention", reason: value !== null && isRecord(value) && value.status === "stale_source" ? "stale_source" : "translation_unavailable" };
    }
    if (value.status === "unsupported") return { status: "needs_attention", reason: "unsupported" };
    const parsed = value as HomeWorldForeignRuleMigrationResult;
    if (parsed.status !== "translated") return { status: "needs_attention", reason: "translation_unavailable" };
    return { status: "translated", value: parsed as Extract<ForeignRuleMigrationResult, { readonly status: "translated" }> };
  } catch {
    return { status: "needs_attention", reason: "translation_unavailable" };
  }
}

function assessmentFailure(reason: HomeAutomationMigrationRuntimeAssessmentFailureReason): HomeAutomationMigrationRuntimeAssessmentResult {
  return Object.freeze({ outcome: "needs_attention" as const, reason });
}

function candidateFailure(reason: HomeAutomationMigrationRuntimeCandidateReason): HomeAutomationMigrationRuntimeCandidateResult {
  return Object.freeze({ status: "needs_attention" as const, reason });
}

function isRuntimeOptions(value: unknown): value is HomeAutomationMigrationRuntimeAssessOptions {
  try {
    return isRecord(value)
      && Object.keys(value).every((key) => key === "signal")
      && (value.signal === undefined || isAbortSignalLike(value.signal));
  } catch {
    return false;
  }
}

function isCloseReason(value: unknown): value is HomeAutomationMigrationCloseReason {
  return value === "household_closed" || value === "superseded" || value === "stale_source";
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  try {
    return isRecord(value)
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "HomeAutomationMigrationIdempotencyConflictError";
}

function readCandidateInput(value: unknown): HomeAutomationMigrationRuntimeCandidateInput | undefined {
  try {
    if (!isExactObject(value, ["migrationId", "ruleRef"])) return undefined;
    const migrationId = value.migrationId;
    const ruleRef = value.ruleRef;
    return isBoundedId(migrationId) && isBoundedId(ruleRef)
      ? { migrationId, ruleRef }
      : undefined;
  } catch {
    return undefined;
  }
}
