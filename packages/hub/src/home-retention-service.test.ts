import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";

import type { Envelope } from "./bridge/bridge-ingest-types.js";
import type {
  IngestJournal,
  IngestJournalRetentionPolicy,
  IngestJournalRetentionResult,
} from "./world/ingest-journal.js";
import { SqliteIngestJournal } from "./world/ingest-journal.js";
import { HomeProposalService } from "./home-proposal-service.js";
import { HomeRetentionService } from "./home-retention-service.js";
import type { CreateProposalInput } from "./proposal-store.js";

type RetentionReference = {
  readonly referenceId: string;
  readonly bridgeId: string;
  readonly epochId: string;
  readonly seq: number;
};

class StubWorld extends Service {
  readonly journals = new Map<string, IngestJournal>();

  constructor(ctx: Context) {
    super(ctx, "homeWorld");
  }

  journal(bridgeId: string): IngestJournal | undefined {
    return this.journals.get(bridgeId);
  }

  bridgeIds(): readonly string[] {
    return [...this.journals.keys()].sort();
  }
}

class StubProposals extends Service {
  refs: readonly RetentionReference[] = [];
  readonly calls: Array<{ bridgeId: string; limit: number }> = [];

  constructor(ctx: Context) {
    super(ctx, "homeProposals");
  }

  withRetentionEvidence<T>(
    bridgeId: string,
    limit: number,
    operation: (refs: readonly RetentionReference[]) => T,
  ): T {
    this.calls.push({ bridgeId, limit });
    return operation(this.refs);
  }
}

function result(policy: IngestJournalRetentionPolicy): IngestJournalRetentionResult {
  return {
    policyId: policy.policyId,
    bridgeId: policy.bridgeId,
    evidenceWindowStart: "2026-08-13T00:00:00.000Z",
    candidateCount: 0,
    deletedEventCount: 0,
    skippedRecoveryCount: 0,
    skippedHistoryGapCount: 0,
    skippedProposalEvidenceCount: policy.proposalEvidence?.length ?? 0,
    skippedEvidenceWindowCount: 0,
    bytesDeleted: 0,
    partialCoverage: false,
  };
}

function fakeJournal(applied: IngestJournalRetentionPolicy[]): IngestJournal {
  return {
    applyRetention(policy) {
      applied.push(policy);
      return result(policy);
    },
} as unknown as IngestJournal;
}

function metadataJournal(options: {
  readonly capacity: { readonly usedBytes: number; readonly maxBytes: number; readonly remainingBytes: number };
  readonly coverage: { readonly bridgeId: string; readonly coverageFloor?: string; readonly retainedRecordCount: number; readonly partial: boolean; readonly openHistoryGapCount: number };
  readonly audits: readonly { readonly policyId: string; readonly bridgeId: string; readonly appliedAt: string; readonly requestedBy: string; readonly reason: string; readonly evidenceWindowStart: string; readonly candidateCount: number; readonly deletedEventCount: number; readonly skippedRecoveryCount: number; readonly skippedHistoryGapCount: number; readonly skippedProposalEvidenceCount: number; readonly skippedEvidenceWindowCount: number; readonly bytesDeleted: number; readonly coverageFloor?: string; readonly partialCoverage: boolean }[];
}): IngestJournal {
  return {
    capacity: () => options.capacity,
    coverage: () => options.coverage,
    latestRetentionAudit: () => options.audits.at(-1),
    retentionAudits: () => { throw new Error("full retention audit history must not be enumerated"); },
    records: () => { throw new Error("records must not be queried for retention status"); },
  } as unknown as IngestJournal;
}

async function serviceWith(
  refs: readonly RetentionReference[] = [],
  journal = fakeJournal([]),
): Promise<{ ctx: Context; world: StubWorld; proposals: StubProposals; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  const world = ctx.homeWorld as unknown as StubWorld;
  const proposals = ctx.homeProposals as unknown as StubProposals;
  proposals.refs = refs;
  world.journals.set("bridge-a", journal);
  const fiber = await ctx.plugin(HomeRetentionService, {
    now: () => "2026-08-20T00:00:00.000Z",
  });
  return { ctx, world, proposals, fiber };
}

const reference: RetentionReference = {
  referenceId: "proposal-1:1:0",
  bridgeId: "bridge-a",
  epochId: "epoch-a",
  seq: 7,
};

const request = {
  bridgeId: "bridge-a",
  requestedBy: "household-owner",
  reason: "bounded evidence maintenance",
};

function appendOld(journal: SqliteIngestJournal, seq: number): void {
  const envelope: Envelope = {
    epochId: "epoch-a",
    seq,
    event: {
      kind: "state",
      state: {
        nativeId: `native-${seq}`,
        nativeInstanceId: "main",
        attrs: { state: "observed" },
        time: { sourceTsQuality: "none" },
        origin: "observed",
      },
    },
  };
  journal.appendAtomic({
    bridgeId: "bridge-a",
    receivedAt: "2026-08-01T00:00:00.000Z",
    envelope,
  });
}

function durableProposal(): CreateProposalInput {
  return {
    kind: "household-insight",
    title: "Proposal text must stay inside the durable source",
    summary: "This text is intentionally not part of retention evidence.",
    idempotencyKey: "retention-evidence:v1",
    provenance: { producer: "retention-test" },
    evidence: {
      references: [
        {
          bridgeId: "bridge-a",
          observedAt: "2026-08-01T00:00:00.000Z",
          source: "post-baseline-event",
          epochId: "epoch-a",
          seq: 1,
        },
        {
          bridgeId: "bridge-b",
          observedAt: "2026-08-01T00:00:00.000Z",
          source: "post-baseline-event",
          epochId: "epoch-b",
          seq: 4,
        },
      ],
      watermarks: [
        { bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 2, freshness: "fresh", gapCount: 0 },
        { bridgeId: "bridge-b", epochId: "epoch-b", lastSeq: 4, freshness: "fresh", gapCount: 0 },
      ],
      temporal: {
        requestedSince: "2026-08-01T00:00:00.000Z",
        requestedUntil: "2026-08-20T00:00:00.000Z",
        truncated: false,
        coverage: [
          {
            bridgeId: "bridge-a",
            epochId: "epoch-a",
            baselineSeq: 0,
            baselineAt: "2026-08-01T00:00:00.000Z",
            status: "complete",
            reasons: [],
          },
          {
            bridgeId: "bridge-b",
            epochId: "epoch-b",
            baselineSeq: 0,
            baselineAt: "2026-08-01T00:00:00.000Z",
            status: "complete",
            reasons: [],
          },
        ],
      },
    },
    conflictCheck: { status: "checked", existingAutomationCount: 0, matches: [] },
    dryRun: { status: "not_run", summary: "No execution simulation was run." },
    risk: { level: "low", reasons: [], requiresHumanApproval: true },
    intent: {
      type: "household-insight",
      description: "Retain evidence for review.",
      rollback: "Reject the proposal.",
    },
  };
}

test("builds a deterministic policy from durable refs and rejects caller-supplied refs", async () => {
  const applied: IngestJournalRetentionPolicy[] = [];
  const journal = fakeJournal(applied);
  const { ctx, proposals, fiber } = await serviceWith([reference], journal);
  try {
    assert.throws(() => ctx.homeRetention.retain({
      ...request,
      proposalEvidence: [{ ...reference, seq: 999 }],
    } as never), /Invalid retention request/);
    assert.throws(() => ctx.homeRetention.retain({
      ...request,
      requestedAt: "2099-01-01T00:00:00.000Z",
    } as never), (error: unknown) => (
      error instanceof Error && error.message === "Invalid retention request"
    ));

    ctx.homeRetention.retain(request);
    ctx.homeRetention.retain(request);
    assert.equal(applied.length, 2);
    assert.equal(applied[0]?.policyId, applied[1]?.policyId);
    assert.deepEqual(applied[0]?.proposalEvidence, [reference]);
    assert.equal(applied[0]?.proposalEvidence?.[0]?.seq, 7);
    assert.deepEqual(proposals.calls, [
      { bridgeId: "bridge-a", limit: 1_000 },
      { bridgeId: "bridge-a", limit: 1_000 },
    ]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("previews through the durable proposal snapshot without invoking retention apply", async () => {
  const previewed: IngestJournalRetentionPolicy[] = [];
  const applied: IngestJournalRetentionPolicy[] = [];
  const journal = {
    previewRetention(policy: IngestJournalRetentionPolicy) {
      previewed.push(policy);
      return result(policy);
    },
    applyRetention(policy: IngestJournalRetentionPolicy) {
      applied.push(policy);
      return result(policy);
    },
  } as unknown as IngestJournal;
  const { ctx, proposals, fiber } = await serviceWith([reference], journal);
  try {
    const preview = (ctx.homeRetention as unknown as {
      preview(input: typeof request): IngestJournalRetentionResult;
    }).preview(request);
    assert.equal(preview.skippedProposalEvidenceCount, 1);
    assert.equal(previewed.length, 1);
    assert.deepEqual(previewed[0]?.proposalEvidence, [reference]);
    assert.deepEqual(applied, []);
    assert.deepEqual(proposals.calls, [{ bridgeId: "bridge-a", limit: 1_000 }]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("allows an empty durable evidence snapshot without inventing refs", async () => {
  const applied: IngestJournalRetentionPolicy[] = [];
  const { ctx, fiber } = await serviceWith([], fakeJournal(applied));
  try {
    ctx.homeRetention.retain(request);
    assert.deepEqual(applied[0]?.proposalEvidence, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects a retention window shorter than the evidence floor before reading proposals", async () => {
  const { ctx, proposals, fiber } = await serviceWith([]);
  try {
    assert.throws(() => ctx.homeRetention.retain({
      ...request,
      evidenceWindowMs: 1,
    }), /Invalid retention request/);
    assert.deepEqual(proposals.calls, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("fails closed for cross-bridge evidence and never invokes the journal", async () => {
  const applied: IngestJournalRetentionPolicy[] = [];
  const { ctx, fiber } = await serviceWith([{
    ...reference,
    bridgeId: "bridge-b",
  }], fakeJournal(applied));
  try {
    assert.throws(() => ctx.homeRetention.retain(request), /crosses bridges/);
    assert.deepEqual(applied, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("classifies malformed durable evidence as an evidence failure", async () => {
  const { ctx, fiber } = await serviceWith([{
    ...reference,
    referenceId: "r".repeat(201),
  }]);
  try {
    assert.throws(() => ctx.homeRetention.retain(request), (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "invalid_proposal_evidence"
    ));
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("fails closed when durable evidence exceeds the bounded reference limit", async () => {
  const refs = Array.from({ length: 1_001 }, (_, index) => ({
    ...reference,
    referenceId: `proposal-${index}:1:0`,
    seq: index,
  }));
  const applied: IngestJournalRetentionPolicy[] = [];
  const { ctx, fiber } = await serviceWith(refs, fakeJournal(applied));
  try {
    assert.throws(() => ctx.homeRetention.retain(request), /bounded/);
    assert.deepEqual(applied, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("redacts durable source and journal failures", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  const world = ctx.homeWorld as unknown as StubWorld;
  const proposals = ctx.homeProposals as unknown as StubProposals;
  world.journals.set("bridge-a", fakeJournal([]));
  proposals.withRetentionEvidence = () => {
    throw new Error("proposal title and household secret must not escape");
  };
  const fiber = await ctx.plugin(HomeRetentionService, {
    now: () => "2026-08-20T00:00:00.000Z",
  });
  try {
    assert.throws(() => ctx.homeRetention.retain(request), (error: unknown) => (
      error instanceof Error
      && error.message === "Durable proposal evidence is unavailable"
      && !error.message.includes("household secret")
    ));
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("redacts a journal failure after the durable evidence snapshot", async () => {
  const journal = {
    applyRetention() {
      throw new Error("sqlite detail must not escape");
    },
  } as unknown as IngestJournal;
  const { ctx, fiber } = await serviceWith([reference], journal);
  try {
    assert.throws(() => ctx.homeRetention.retain(request), (error: unknown) => (
      error instanceof Error
      && error.message === "Retention journal operation failed"
      && !error.message.includes("sqlite detail")
    ));
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("collects only exact durable refs for the current bridge without returning proposal text", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  const journal = new SqliteIngestJournal(":memory:");
  appendOld(journal, 1);
  appendOld(journal, 2);
  journal.markConsistent("bridge-a", { epochId: "epoch-a", lastSeq: 2 });
  journal.markConsistent("bridge-a", { epochId: "epoch-current", lastSeq: 0 });
  const world = ctx.homeWorld as unknown as StubWorld;
  world.journals.set("bridge-a", journal);
  await ctx.plugin(HomeProposalService, {
    path: ":memory:",
    now: () => "2026-08-20T00:00:00.000Z",
    id: () => "durable-proposal",
  });
  const proposal = ctx.homeProposals.create(durableProposal());
  const references = ctx.homeProposals.withRetentionEvidence("bridge-a", 1_000, (items) => items);
  assert.equal(references.length, 1);
  assert.equal(references[0]?.bridgeId, "bridge-a");
  assert.equal(references[0]?.epochId, "epoch-a");
  assert.equal(references[0]?.seq, 1);
  assert.equal("title" in (references[0] as object), false);
  assert.match(references[0]?.referenceId ?? "", new RegExp(`^${proposal.id}:1:0$`));

  const fiber = await ctx.plugin(HomeRetentionService, {
    now: () => "2026-08-20T00:00:00.000Z",
  });
  try {
    const retained = ctx.homeRetention.retain(request);
    assert.equal(retained.skippedProposalEvidenceCount, 1);
    assert.deepEqual(journal.records("bridge-a").map((record) => record.envelope.seq), [1]);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
    journal.close();
  }
});

test("concurrent deterministic operations leave one durable retention audit", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  const journal = new SqliteIngestJournal(":memory:");
  appendOld(journal, 1);
  const world = ctx.homeWorld as unknown as StubWorld;
  world.journals.set("bridge-a", journal);
  await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const fiber = await ctx.plugin(HomeRetentionService, {
    now: () => "2026-08-20T00:00:00.000Z",
  });
  try {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => ctx.homeRetention.retain(request)),
      Promise.resolve().then(() => ctx.homeRetention.retain(request)),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
    assert.equal(journal.retentionAudits("bridge-a").length, 1);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
    journal.close();
  }
});

test("projects only retention capacity, coverage, and the latest audit metadata", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  const world = ctx.homeWorld as unknown as StubWorld;
  const latestAudit = {
    policyId: "internal-policy-must-not-escape",
    bridgeId: "bridge-a",
    appliedAt: "2026-08-20T08:00:00.000Z",
    requestedBy: "owner",
    reason: "maintenance",
    evidenceWindowStart: "2026-08-13T00:00:00.000Z",
    candidateCount: 4,
    deletedEventCount: 2,
    skippedRecoveryCount: 1,
    skippedHistoryGapCount: 0,
    skippedProposalEvidenceCount: 1,
    skippedEvidenceWindowCount: 0,
    bytesDeleted: 123,
    coverageFloor: "2026-08-13T00:00:00.000Z",
    partialCoverage: false,
  };
  world.journals.set("bridge-a", metadataJournal({
    capacity: { usedBytes: 300, maxBytes: 1_000, remainingBytes: 700 },
    coverage: {
      bridgeId: "bridge-a",
      coverageFloor: "2026-08-13T00:00:00.000Z",
      retainedRecordCount: 4,
      partial: false,
      openHistoryGapCount: 0,
    },
    audits: [{ ...latestAudit, policyId: "older-policy", appliedAt: "2026-08-19T08:00:00.000Z" }, latestAudit],
  }));
  world.journals.set("bridge-b", metadataJournal({
    capacity: { usedBytes: 500, maxBytes: 1_000, remainingBytes: 500 },
    coverage: {
      bridgeId: "bridge-b",
      coverageFloor: "2026-08-10T00:00:00.000Z",
      retainedRecordCount: 2,
      partial: true,
      openHistoryGapCount: 1,
    },
    audits: [],
  }));
  const fiber = await ctx.plugin(HomeRetentionService);
  try {
    const status = ctx.homeRetention.status();
    assert.equal(status.status, "attention");
    assert.deepEqual(status.capacity, { usedBytes: 800, maxBytes: 2_000, remainingBytes: 1_200 });
    assert.deepEqual(status.bridges.map((bridge) => bridge.bridgeId), ["bridge-a", "bridge-b"]);
    assert.deepEqual(status.bridges[0]?.coverage, {
      status: "complete",
      coverageFloor: "2026-08-13T00:00:00.000Z",
    });
    assert.deepEqual(status.bridges[0]?.lastRetention, {
      appliedAt: "2026-08-20T08:00:00.000Z",
      result: "complete",
      bytesDeleted: 123,
    });
    assert.deepEqual(status.bridges[1]?.coverage, {
      status: "degraded",
      coverageFloor: "2026-08-10T00:00:00.000Z",
    });
    assert.equal(status.bridges[1]?.lastRetention, undefined);
    assert.equal(JSON.stringify(status).includes("internal-policy-must-not-escape"), false);
    assert.equal(JSON.stringify(status).includes("maintenance"), false);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("warns at 90 percent capacity while keeping 89 percent ready", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  const world = ctx.homeWorld as unknown as StubWorld;
  for (const [bridgeId, usedBytes] of [["bridge-89", 890], ["bridge-90", 900]] as const) {
    world.journals.set(bridgeId, metadataJournal({
      capacity: { usedBytes, maxBytes: 1_000, remainingBytes: 1_000 - usedBytes },
      coverage: { bridgeId, retainedRecordCount: 0, partial: false, openHistoryGapCount: 0 },
      audits: [],
    }));
  }
  const fiber = await ctx.plugin(HomeRetentionService);
  try {
    const status = ctx.homeRetention.status();
    assert.equal(status.bridges.find((bridge) => bridge.bridgeId === "bridge-89")?.status, "ready");
    assert.equal(status.bridges.find((bridge) => bridge.bridgeId === "bridge-90")?.status, "attention");
    assert.equal(status.status, "attention");
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("fails closed when journal capacity maxBytes is zero or invalid", async () => {
  const ctx = new Context();
  await ctx.plugin(StubWorld);
  await ctx.plugin(StubProposals);
  const world = ctx.homeWorld as unknown as StubWorld;
  for (const [bridgeId, maxBytes] of [["bridge-zero", 0], ["bridge-invalid", Number.NaN]] as const) {
    world.journals.set(bridgeId, metadataJournal({
      capacity: { usedBytes: 0, maxBytes, remainingBytes: 0 },
      coverage: { bridgeId, retainedRecordCount: 0, partial: false, openHistoryGapCount: 0 },
      audits: [],
    }));
  }
  const fiber = await ctx.plugin(HomeRetentionService);
  try {
    const status = ctx.homeRetention.status();
    for (const bridge of status.bridges) {
      assert.equal(bridge.status, "unavailable");
      assert.equal(bridge.capacity, undefined);
      assert.equal(bridge.coverage.status, "unavailable");
    }
    assert.equal(status.status, "attention");
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
