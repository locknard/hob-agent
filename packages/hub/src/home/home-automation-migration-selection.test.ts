import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HomeAutomationMigrationSelectionFacade,
  type HomeAutomationMigrationSelectionClaim,
  type HomeAutomationMigrationSelectionIssue,
  type HomeAutomationMigrationSelectionPrincipal,
} from "./home-automation-migration-selection.js";
import {
  InMemoryHomeAutomationMigrationStore,
  SqliteHomeAutomationMigrationStore,
} from "./home-automation-migration-store.js";

const now = "2026-08-24T08:00:00.000Z";
const migrationId = "1".repeat(32);
const fingerprint = `sha256:${"a".repeat(64)}`;
const principal: HomeAutomationMigrationSelectionPrincipal = {
  principalId: "member-1",
  role: "adult_member",
  privateDeviceBinding: "verified",
};

function assessedStore(): InMemoryHomeAutomationMigrationStore {
  const store = new InMemoryHomeAutomationMigrationStore();
  store.discover({
    migrationId,
    idempotencyKey: "2".repeat(32),
    inputDigest: `sha256:${"b".repeat(64)}`,
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    analysisMode: "trusted_neutral",
    rules: [{
      ruleRef: "rule-1",
      name: "晚间灯光",
      enabled: true,
      updatedAt: now,
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "reversible",
      sourceFingerprint: fingerprint,
      disposition: "eligible",
      workflow: { status: "assessed", sourceFingerprint: fingerprint, assessedAt: now },
    }],
    createdAt: now,
  });
  assert.equal(store.assess({
    migrationId,
    status: "assessed",
    assessedAt: now,
    rules: [{
      ruleRef: "rule-1",
      name: "晚间灯光",
      enabled: true,
      updatedAt: now,
      triggerClass: "state",
      conditionClass: "flat_and",
      actionClass: "reversible",
      sourceFingerprint: fingerprint,
      disposition: "eligible",
      workflow: { status: "assessed", sourceFingerprint: fingerprint, assessedAt: now },
    }],
  }), true);
  return store;
}

test("selection facade issues a safe selectable projection without internal identity fields", () => {
  const facade = new HomeAutomationMigrationSelectionFacade({
    store: assessedStore(),
    clock: () => now,
    generation: "generation-1",
    tokenFactory: () => "c".repeat(32),
    prepareRule: async () => ({ status: "prepared", proposalId: "proposal-1" }),
  });

  const projection = facade.list(principal);
  assert.deepEqual(projection, [{
    name: "晚间灯光",
    status: "selectable",
    token: "c".repeat(32),
  }]);
  assert.equal("ruleRef" in projection[0]!, false);
  assert.equal("migrationId" in projection[0]!, false);
  assert.equal("tokenDigest" in projection[0]!, false);
});

test("migration store durably issues, reads, and CAS-claims a selection without raw token", () => {
  const store = assessedStore();
  const issue: HomeAutomationMigrationSelectionIssue = {
    selectionId: "d".repeat(32),
    migrationId,
    ruleRef: "rule-1",
    principal,
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    sourceFingerprint: fingerprint,
    tokenDigest: `sha256:${"e".repeat(64)}`,
    generation: "generation-1",
    issuedAt: now,
    expiresAt: "2026-08-24T08:05:00.000Z",
  };
  const issued = store.issueSelection(issue);
  assert.equal(issued.outcome, "created");
  assert.equal(issued.selection.status, "issued");
  assert.equal("token" in issued.selection, false);

  const read = store.getSelection(issue.selectionId);
  assert.equal(read?.tokenDigest, issue.tokenDigest);
  assert.equal(read?.principal.principalId, principal.principalId);

  const claimed: HomeAutomationMigrationSelectionClaim = store.claimSelection({
    selectionId: issue.selectionId,
    tokenDigest: issue.tokenDigest,
    principal,
    generation: issue.generation,
    now,
  });
  assert.equal(claimed.outcome, "claimed");
  assert.equal(claimed.selection.status, "processing");
  assert.equal(claimed.selection.revision, 2);

  const replay = store.claimSelection({
    selectionId: issue.selectionId,
    tokenDigest: issue.tokenDigest,
    principal,
    generation: issue.generation,
    now,
  });
  assert.equal(replay.outcome, "replay");
  assert.equal(replay.selection.status, "processing");

  const wrongPrincipal = store.claimSelection({
    selectionId: issue.selectionId,
    tokenDigest: issue.tokenDigest,
    principal: { ...principal, principalId: "member-2" },
    generation: issue.generation,
    now,
  });
  assert.equal(wrongPrincipal.outcome, "forbidden");
});

test("facade completion is idempotent, rejects wrong principal, and never issues for an unbound viewer", async () => {
  const store = assessedStore();
  let calls = 0;
  const facade = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => now,
    generation: "generation-2",
    tokenFactory: () => "f".repeat(32),
    prepareRule: async () => {
      calls += 1;
      return { status: "prepared", proposalId: "proposal-2" };
    },
  });
  const issued = facade.list(principal)[0]!;
  assert.equal(issued.status, "selectable");
  assert.equal(store.listSelections().length, 1);
  assert.equal((await facade.submitSelection(issued.token!, principal)).status, "prepared");
  assert.equal(calls, 1);
  assert.deepEqual(await facade.submitSelection(issued.token!, principal), {
    name: "晚间灯光",
    status: "prepared",
    proposalId: "proposal-2",
  });
  assert.equal(calls, 1);
  assert.deepEqual(await facade.submitSelection(issued.token!, { ...principal, principalId: "member-2" }), {
    name: "Unavailable",
    status: "unavailable",
  });

  const viewer = new HomeAutomationMigrationSelectionFacade({
    store: assessedStore(),
    clock: () => now,
    generation: "generation-viewer",
    tokenFactory: () => "a".repeat(32),
    prepareRule: async () => ({ status: "prepared", proposalId: "never" }),
  });
  const safeReadOnly = viewer.list({ ...principal, privateDeviceBinding: "unverified" });
  assert.deepEqual(safeReadOnly, [{ name: "晚间灯光", status: "selectable" }]);
  assert.equal((viewer as unknown as { store: { listSelections(): readonly unknown[] } }).store.listSelections().length, 0);
});

test("SQLite selection audit survives reopen and stores only digest, while a second writer replays CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-migration-selection-"));
  const path = join(directory, "migrations.sqlite");
  try {
    const first = new SqliteHomeAutomationMigrationStore({ path });
    const issue: HomeAutomationMigrationSelectionIssue = {
      selectionId: "1".repeat(32),
      migrationId,
      ruleRef: "rule-1",
      principal,
      sourceBridgeId: "bridge-ha",
      sourceEpochId: "epoch-1",
      sourceLastSeq: 12,
      sourceFingerprint: fingerprint,
      tokenDigest: `sha256:${"9".repeat(64)}`,
      generation: "generation-sqlite",
      issuedAt: now,
      expiresAt: "2026-08-24T08:05:00.000Z",
    };
    first.discover({
      migrationId,
      idempotencyKey: "4".repeat(32),
      inputDigest: `sha256:${"5".repeat(64)}`,
      sourceBridgeId: "bridge-ha",
      sourceEpochId: "epoch-1",
      sourceLastSeq: 12,
      analysisMode: "trusted_neutral",
      rules: [{
        ruleRef: "rule-1", name: "晚间灯光", enabled: true, updatedAt: now,
        triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible",
        sourceFingerprint: fingerprint, disposition: "eligible",
        workflow: { status: "assessed", sourceFingerprint: fingerprint, assessedAt: now },
      }],
      createdAt: now,
    });
    assert.equal(first.assess({
      migrationId,
      status: "assessed",
      assessedAt: now,
      rules: [{
        ruleRef: "rule-1", name: "晚间灯光", enabled: true, updatedAt: now,
        triggerClass: "state", conditionClass: "flat_and", actionClass: "reversible",
        sourceFingerprint: fingerprint, disposition: "eligible",
        workflow: { status: "assessed", sourceFingerprint: fingerprint, assessedAt: now },
      }],
    }), true);
    assert.equal(first.issueSelection(issue).outcome, "created");
    const contender = new SqliteHomeAutomationMigrationStore({ path });
    assert.equal(contender.claimSelection({
      selectionId: issue.selectionId,
      tokenDigest: issue.tokenDigest,
      principal,
      generation: issue.generation,
      now,
    }).outcome, "claimed");
    assert.equal(first.claimSelection({
      selectionId: issue.selectionId,
      tokenDigest: issue.tokenDigest,
      principal,
      generation: issue.generation,
      now,
    }).outcome, "replay");
    contender.close();
    first.close();

    const reopened = new SqliteHomeAutomationMigrationStore({ path });
    const persisted = reopened.getSelection(issue.selectionId);
    assert.equal(persisted?.tokenDigest, issue.tokenDigest);
    assert.equal("token" in (persisted ?? {}), false);
    reopened.close();

    const raw = new DatabaseSync(path);
    const columns = raw.prepare("PRAGMA table_info(home_automation_migration_selections)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "token"), false);
    raw.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired selection is terminal and source drift never invokes preparation", async () => {
  const store = assessedStore();
  let nowValue = now;
  let calls = 0;
  const facade = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => nowValue,
    generation: "generation-expiry",
    tokenFactory: () => "b".repeat(32),
    ttlMs: 1_000,
    prepareRule: async () => {
      calls += 1;
      return { status: "prepared", proposalId: "not-called" };
    },
  });
  const token = facade.list(principal)[0]!.token!;
  nowValue = "2026-08-24T08:00:02.000Z";
  assert.deepEqual(await facade.submitSelection(token, principal), { name: "Unavailable", status: "unavailable" });
  assert.equal(calls, 0);
});

test("a prepared selection token is unavailable after its expiry while the durable projection remains prepared", async () => {
  const store = assessedStore();
  let nowValue = now;
  const facade = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => nowValue,
    generation: "generation-prepared-expiry",
    tokenFactory: () => "9".repeat(32),
    ttlMs: 1_000,
    prepareRule: async () => ({ status: "prepared", proposalId: "proposal-expiry" }),
  });
  const token = facade.list(principal)[0]!.token!;
  assert.deepEqual(await facade.submitSelection(token, principal), {
    name: "晚间灯光",
    status: "prepared",
    proposalId: "proposal-expiry",
  });
  nowValue = "2026-08-24T08:00:02.000Z";
  assert.deepEqual(await facade.submitSelection(token, principal), { name: "Unavailable", status: "unavailable" });
  assert.deepEqual(facade.list(principal), [{
    name: "晚间灯光",
    status: "prepared",
    proposalId: "proposal-expiry",
  }]);
});

test("workflow/source drift invalidates an issued token before preparation", async () => {
  const store = assessedStore();
  let calls = 0;
  const facade = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => now,
    generation: "generation-drift",
    tokenFactory: () => "8".repeat(32),
    prepareRule: async () => {
      calls += 1;
      return { status: "prepared", proposalId: "must-not-run" };
    },
  });
  const token = facade.list(principal)[0]!.token!;
  assert.equal(store.transitionRuleWorkflow({
    migrationId,
    ruleRef: "rule-1",
    from: "assessed",
    to: "translated",
    transitionedAt: now,
    proposalId: "other-proposal",
    candidateProposalRevision: 1,
    candidateContentHash: `sha256:${"6".repeat(64)}`,
  }), true);
  assert.deepEqual(await facade.submitSelection(token, principal), { name: "Unavailable", status: "unavailable" });
  assert.equal(calls, 0);
  assert.equal(store.listSelections()[0]?.status, "invalidated");
});

test("restart recovery invalidates old issued tokens but lookup-links old processing without creating", async () => {
  const store = assessedStore();
  const oldIssued = store.issueSelection({
    selectionId: "7".repeat(32),
    migrationId,
    ruleRef: "rule-1",
    principal,
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    sourceFingerprint: fingerprint,
    tokenDigest: `sha256:${"1".repeat(64)}`,
    generation: "old-generation",
    issuedAt: now,
    expiresAt: "2026-08-24T08:05:00.000Z",
  });
  const processingIssue = store.issueSelection({
    selectionId: "6".repeat(32),
    migrationId,
    ruleRef: "rule-1",
    principal: { ...principal, principalId: "member-2" },
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    sourceFingerprint: fingerprint,
    tokenDigest: `sha256:${"2".repeat(64)}`,
    generation: "old-generation",
    issuedAt: now,
    expiresAt: "2026-08-24T08:05:00.000Z",
  });
  assert.equal(store.claimSelection({
    selectionId: processingIssue.selection.selectionId,
    tokenDigest: processingIssue.selection.tokenDigest,
    principal: { ...principal, principalId: "member-2" },
    generation: "old-generation",
    now,
  }).outcome, "claimed");
  let createCalls = 0;
  let lookupCalls = 0;
  const restarted = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => now,
    generation: "new-generation",
    prepareRule: async () => {
      createCalls += 1;
      return { status: "prepared", proposalId: "must-not-create" };
    },
    lookupPreparedRule: async () => {
      lookupCalls += 1;
      return { status: "prepared", proposalId: "existing-proposal" };
    },
  });
  await restarted.recover();
  assert.equal(createCalls, 0);
  assert.equal(lookupCalls, 1);
  assert.equal(store.getSelection(oldIssued.selection.selectionId)?.status, "invalidated");
  assert.equal(store.getSelection(processingIssue.selection.selectionId)?.status, "prepared");
});

test("digest mismatch and an issue race never bind a fresh raw token to an existing audit", async () => {
  const store = assessedStore();
  const existing = store.issueSelection({
    selectionId: "3".repeat(32),
    migrationId,
    ruleRef: "rule-1",
    principal,
    sourceBridgeId: "bridge-ha",
    sourceEpochId: "epoch-1",
    sourceLastSeq: 12,
    sourceFingerprint: fingerprint,
    tokenDigest: `sha256:${"4".repeat(64)}`,
    generation: "generation-race",
    issuedAt: now,
    expiresAt: "2026-08-24T08:05:00.000Z",
  });
  const originalIssue = store.issueSelection.bind(store);
  store.issueSelection = (() => ({ outcome: "existing", selection: existing.selection })) as typeof store.issueSelection;
  const facade = new HomeAutomationMigrationSelectionFacade({
    store,
    clock: () => now,
    generation: "generation-race",
    tokenFactory: () => "5".repeat(32),
    prepareRule: async () => ({ status: "prepared", proposalId: "must-not-run" }),
  });
  assert.deepEqual(facade.list(principal), [{ name: "晚间灯光", status: "unavailable" }]);
  store.issueSelection = originalIssue;

  const fresh = new HomeAutomationMigrationSelectionFacade({
    store: assessedStore(),
    clock: () => now,
    generation: "generation-forged",
    tokenFactory: () => "6".repeat(32),
    prepareRule: async () => ({ status: "prepared", proposalId: "must-not-run" }),
  });
  const token = fresh.list(principal)[0]!.token!;
  (fresh as unknown as { tokenCache: Map<string, { selectionId: string; digest: string }> }).tokenCache.set(token, {
    selectionId: (fresh as unknown as { tokenCache: Map<string, { selectionId: string; digest: string }> }).tokenCache.get(token)!.selectionId,
    digest: `sha256:${"7".repeat(64)}`,
  });
  assert.deepEqual(await fresh.submitSelection(token, principal), { name: "Unavailable", status: "unavailable" });
});
