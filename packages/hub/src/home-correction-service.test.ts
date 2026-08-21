import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  HomeCorrectionService,
  InMemoryHomeCorrectionStore,
  type HomeCorrectionProposalPort,
} from "./home-correction-service.js";
import { HomeProposalService } from "./home-proposal-service.js";

const adult = {
  principalId: "adult-1",
  role: "adult_member" as const,
  present: true,
  device: { kind: "private" as const, boundPrincipalId: "adult-1" },
};

const completedAdvice = {
  get(id: string) {
    if (id === "advice-1") return { status: "completed" as const };
    if (id === "advice-running") return { status: "running" as const };
    return undefined;
  },
};

class StubProposalOwner extends Service {
  readonly calls: unknown[] = [];

  constructor(ctx: Context) { super(ctx, "homeProposals"); }

  async createDraftGoverned(input: unknown) {
    this.calls.push(input);
    return {
      kind: "created" as const,
      proposal: { id: "proposal-1" },
    };
  }
}

class DraftOnlyProposalOwner extends Service {
  readonly calls: unknown[] = [];

  constructor(ctx: Context) { super(ctx, "homeProposals"); }

  createDraftGoverned(input: unknown) {
    this.calls.push(input);
    return Promise.resolve({
      kind: "created" as const,
      proposal: {
        id: "proposal-draft",
        evidence: {
          watermarks: [{ bridgeId: "bridge-a", freshness: "stale", gapCount: 4 }],
        },
      },
    });
  }
}

class ProposalWorld extends Service {
  bridgeConnectionState: "ready" | "degraded" = "ready";
  bridgeHistoryGapCount = 0;

  constructor(ctx: Context) { super(ctx, "homeWorld"); }

  snapshot() {
    return {
      generatedAt: "2026-08-22T10:00:00.000Z",
      spaces: [],
      bridges: { "bridge-a": { diagnostics: { historyGapCount: this.bridgeHistoryGapCount } } },
      bridgeWatermarks: [{ bridgeId: "bridge-a", epochId: "epoch-a", lastSeq: 42 }],
      diagnostics: [{ bridgeId: "bridge-a", connectionState: this.bridgeConnectionState, historyGapCount: this.bridgeHistoryGapCount }],
      devices: [],
    };
  }

  async foreignRuleCatalog() { return []; }
}

function options(directory: string, store = new InMemoryHomeCorrectionStore()) {
  return {
    store,
    householdDirectory: directory,
    advice: completedAdvice,
    now: () => "2026-08-22T10:00:00.000Z",
  };
}

test("writes a household fact to a bounded marked workspace section and replays the same idempotency key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const store = new InMemoryHomeCorrectionStore();
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, options(directory, store));

  const first = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_fact",
    correction: "客厅窗帘朝南，下午阳光会直射。",
    idempotencyKey: "turn-advice-1-correction-1",
  });
  const replay = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_fact",
    correction: "客厅窗帘朝南，下午阳光会直射。",
    idempotencyKey: "turn-advice-1-correction-1",
  });

  assert.equal(first.status, "updated");
  assert.equal(first.destination, "MEMORY.md#household-facts");
  assert.deepEqual(replay, first);
  await assert.rejects(() => ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_fact",
    correction: "幂等键不能承载另一条纠正。",
    idempotencyKey: "turn-advice-1-correction-1",
  }), (error: unknown) => (error as { code?: string }).code === "conflict");
  const memory = readFileSync(join(directory, "MEMORY.md"), "utf8");
  assert.match(memory, /hob-corrections:household-facts/);
  assert.match(memory, /客厅窗帘朝南，下午阳光会直射/);
  assert.equal((memory.match(/客厅窗帘朝南/g) ?? []).length, 1);
  assert.equal(readdirSync(directory).some((name) => name.includes(".hob-")), false);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("writes a household preference to SOUL.md and preserves the actor/advice audit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const store = new InMemoryHomeCorrectionStore();
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, options(directory, store));

  const result = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_preference",
    correction: "卧室晚上十点后保持安静。",
    idempotencyKey: "turn-advice-1-correction-2",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.destination, "SOUL.md#household-preferences");
  assert.deepEqual(ctx.homeCorrection.listAudit(), [{
    id: result.correctionId,
    adviceId: "advice-1",
    actorId: "adult-1",
    correctionType: "household_preference",
    correction: "卧室晚上十点后保持安静。",
    idempotencyKey: "turn-advice-1-correction-2",
    outcome: "updated",
    destination: "SOUL.md#household-preferences",
    createdAt: "2026-08-22T10:00:00.000Z",
  }]);
  assert.match(readFileSync(join(directory, "SOUL.md"), "utf8"), /卧室晚上十点后保持安静/);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("routes future behavior through the existing proposal owner and changes no workspace file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const ctx = new Context();
  const proposalFiber = await ctx.plugin(StubProposalOwner);
  const proposalOwner = ctx.get("homeProposals") as unknown as StubProposalOwner;
  const fiber = await ctx.plugin(HomeCorrectionService, {
    ...options(directory),
    proposalOwner: proposalOwner as unknown as HomeCorrectionProposalPort,
  });

  const result = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "future_behavior",
    correction: "以后窗帘开合先考虑室内照度，再给出建议。",
    idempotencyKey: "turn-advice-1-correction-3",
  });

  assert.equal(result.status, "proposal_created");
  assert.equal(result.proposalId, "proposal-1");
  assert.equal(result.proposalCount, 1);
  assert.equal(readdirSync(directory).length, 0);
  assert.equal((proposalOwner.calls[0] as { intent: { description: string } }).intent.description, "以后窗帘开合先考虑室内照度，再给出建议。");

  await fiber.dispose();
  await proposalFiber.dispose();
  await ctx.fiber.dispose();
});

test("submits a draft-only correction and leaves degraded evidence to the proposal owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const ctx = new Context();
  const proposalFiber = await ctx.plugin(DraftOnlyProposalOwner);
  const proposalOwner = ctx.get("homeProposals") as unknown as DraftOnlyProposalOwner;
  const fiber = await ctx.plugin(HomeCorrectionService, {
    ...options(directory),
    proposalOwner: proposalOwner as unknown as HomeCorrectionProposalPort,
  });

  const result = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "future_behavior",
    correction: "以后窗帘开合先考虑室内照度，再给出建议。",
    idempotencyKey: "turn-draft-only",
  });

  assert.equal(result.status, "proposal_created");
  assert.equal(result.proposalId, "proposal-draft");
  const draft = proposalOwner.calls[0] as Record<string, unknown>;
  assert.deepEqual(draft.selectedHwIds, []);
  assert.equal("evidence" in draft, false);
  assert.equal("conflictCheck" in draft, false);
  assert.equal("spaceCoverage" in draft, false);
  assert.deepEqual((result as { proposalCount: number }).proposalCount, 1);

  await fiber.dispose();
  await proposalFiber.dispose();
  await ctx.fiber.dispose();
});

test("creates a real persistent HomeProposalService envelope for future behavior", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const ctx = new Context();
  const worldFiber = await ctx.plugin(ProposalWorld);
  const proposalWorld = ctx.homeWorld as unknown as ProposalWorld;
  proposalWorld.bridgeConnectionState = "degraded";
  proposalWorld.bridgeHistoryGapCount = 4;
  const proposalsFiber = await ctx.plugin(HomeProposalService, { path: ":memory:" });
  const fiber = await ctx.plugin(HomeCorrectionService, {
    ...options(directory),
  });
  const result = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "future_behavior",
    correction: "以后先询问我是否要延长窗帘的试运行时间。",
    idempotencyKey: "turn-real-proposal",
  });
  assert.equal(result.status, "proposal_created");
  assert.equal(result.proposalCount, 1);
  const proposal = ctx.homeProposals.get(result.proposalId);
  assert.equal(proposal?.status, "pending_review");
  assert.equal(proposal?.kind, "household-insight");
  assert.equal(proposal?.artifactCandidate, undefined);
  assert.equal(proposal?.conflictCheck.status, "checked");
  assert.deepEqual(proposal?.evidence.watermarks, [{
    bridgeId: "bridge-a",
    epochId: "epoch-a",
    lastSeq: 42,
    freshness: "stale",
    gapCount: 4,
  }]);
  assert.deepEqual(proposal?.spaceCoverage, {
    selectedDevices: 0,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 0,
    devicesWithMultipleSpaces: 0,
  });

  await fiber.dispose();
  await proposalsFiber.dispose();
  await worldFiber.dispose();
  await ctx.fiber.dispose();
});

test("fails closed for an unclassified correction, a non-completed turn, missing workspace, and unauthorized actor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, options(directory));

  await assert.rejects(() => ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "other" as never,
    correction: "这条输入不能选择一个隐含分类。",
    idempotencyKey: "turn-invalid",
  }), (error: unknown) => (error as { code?: string }).code === "invalid_type");
  await assert.rejects(() => ctx.homeCorrection.submit({
    adviceId: "advice-running",
    actor: adult,
    correctionType: "household_fact",
    correction: "运行中的对话不能提交纠正。",
    idempotencyKey: "turn-running",
  }), (error: unknown) => (error as { code?: string }).code === "not_completed");
  await assert.rejects(() => ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: { ...adult, role: "child" },
    correctionType: "household_fact",
    correction: "孩子设备不能修改家庭知识。",
    idempotencyKey: "turn-child",
  }), (error: unknown) => (error as { code?: string }).code === "permission_denied");

  const noDirectoryContext = new Context();
  const noDirectoryFiber = await noDirectoryContext.plugin(HomeCorrectionService, {
    ...options(directory),
    householdDirectory: join(directory, "missing"),
  });
  await assert.rejects(() => noDirectoryContext.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_fact",
    correction: "家庭目录缺失时保持失败关闭。",
    idempotencyKey: "turn-no-directory",
  }), (error: unknown) => (error as { code?: string }).code === "workspace_unavailable");

  await noDirectoryFiber.dispose();
  await noDirectoryContext.fiber.dispose();
  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("uses a durable file store with private permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const dbPath = join(directory, "onboarding.sqlite");
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, {
    path: dbPath,
    householdDirectory: directory,
    advice: completedAdvice,
    now: () => "2026-08-22T10:00:00.000Z",
  });
  const result = await ctx.homeCorrection.submit({
    adviceId: "advice-1",
    actor: adult,
    correctionType: "household_fact",
    correction: "持久化记录保留纠正审计。",
    idempotencyKey: "durable-correction",
  });
  assert.equal(result.status, "updated");
  assert.equal(statSync(dbPath).mode & 0o077, 0);
  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("creates a future-behavior proposal without requiring a household knowledge directory", async () => {
  const inputs: unknown[] = [];
  const proposalOwner: HomeCorrectionProposalPort = {
    async createDraftGoverned(input) {
      inputs.push(input);
      return { kind: "created", proposal: { id: "proposal-no-workspace" } as never };
    },
  };
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, {
    store: new InMemoryHomeCorrectionStore(),
    advice: completedAdvice,
    proposalOwner,
    now: () => "2026-08-22T10:00:00.000Z",
  });
  try {
    const result = await ctx.homeCorrection.submit({
      adviceId: "advice-1",
      actor: adult,
      correctionType: "future_behavior",
      correction: "每天日落后再决定是否关闭客厅窗帘。",
      idempotencyKey: "future-without-workspace",
    });
    assert.equal(result.status, "proposal_created");
    assert.equal(inputs.length, 1);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("coalesces concurrent future-behavior corrections and rejects a conflicting in-flight command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-correction-"));
  const calls: unknown[] = [];
  let release!: () => void;
  let started!: () => void;
  const ownerStarted = new Promise<void>((resolve) => { started = resolve; });
  const ownerRelease = new Promise<void>((resolve) => { release = resolve; });
  const proposalOwner: HomeCorrectionProposalPort = {
    async createDraftGoverned(input) {
      calls.push(input);
      started();
      await ownerRelease;
      return { kind: "created", proposal: { id: "proposal-concurrent" } as never };
    },
  };
  const ctx = new Context();
  const fiber = await ctx.plugin(HomeCorrectionService, {
    ...options(directory),
    proposalOwner,
  });
  const command = {
    adviceId: "advice-1",
    actor: adult,
    correctionType: "future_behavior" as const,
    correction: "以后先询问我是否要延长窗帘的试运行时间。",
    idempotencyKey: "turn-concurrent-correction",
  };
  try {
    const first = ctx.homeCorrection.submit(command);
    await ownerStarted;
    const second = ctx.homeCorrection.submit(command);
    const conflict = ctx.homeCorrection.submit({ ...command, correction: "同一个幂等键不能代表另一条纠正。" });
    release();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    await assert.rejects(
      () => conflict,
      (error: unknown) => (error as { code?: string }).code === "conflict",
    );
    assert.equal(firstResult.status, "fulfilled");
    assert.equal(secondResult.status, "fulfilled");
    assert.deepEqual(secondResult.value, firstResult.value);
    assert.equal(calls.length, 1);
    assert.equal(ctx.homeCorrection.listAudit().length, 1);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
