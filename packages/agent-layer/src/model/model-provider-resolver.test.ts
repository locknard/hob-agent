import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import {
  HOME_ACTIVE_MODEL,
  HOME_ACTIVE_PROVIDER_ROUTE,
  ModelProviderResolver,
  type ModelProviderGeneration,
} from "./model-provider-resolver.js";

interface Generated {
  readonly id: string;
  disposed: number;
}

function candidate(id: string) {
  return { provider: "deepseek" as const, model: id };
}

function createResolver(generated: Generated[]) {
  const ctx = new Context();
  return {
    ctx,
    resolver: new ModelProviderResolver(ctx, {
      createGeneration: async (selected): Promise<ModelProviderGeneration> => {
        if (selected.model === "broken") throw new Error("candidate failed");
        const generation: Generated = { id: selected.model, disposed: 0 };
        generated.push(generation);
        return {
          provider: selected.provider,
          model: selected.model,
          runtime: {
            resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
            stream: async function* (): AsyncIterable<StreamChunk> {
              yield { type: "text-delta", index: 0, text: generation.id };
            },
          },
          dispose: async () => { generation.disposed += 1; },
        };
      },
    }),
  };
}

async function activateCandidate(
  resolver: ModelProviderResolver,
  selected: ReturnType<typeof candidate>,
) {
  return resolver.activate(await resolver.prepare(selected));
}

function bindTurnDriver(ctx: Context, resolver: ModelProviderResolver) {
  const session = {};
  const agent = {
    id: "resolver-turn-test",
    ctx: ctx.extend(),
    session,
  } as unknown as Agent;
  resolver.bindAgent(agent);
  return {
    async open(turn: number, signal = new AbortController().signal): Promise<AbortSignal> {
      ctx.emit("session/event", session as never, {
        type: "turn/start",
        data: { turn },
      } as never);
      await agentEvents(ctx, agent).waterfall("agent/pre-step", {
        messages: [],
        turn,
        step: 1,
        signal,
      }, () => Promise.resolve({ kind: "enter", messages: [] }));
      return signal;
    },
    close(turn: number): void {
      ctx.emit("session/event", session as never, {
        type: "turn/end",
        data: { turn, reason: { kind: "completed" } },
      } as never);
    },
  };
}

test("switches new turn leases immediately while the prior generation drains after its final release", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const turns = bindTurnDriver(ctx, resolver);
  const firstSignal = await turns.open(1);

  const prepared = await resolver.prepare(candidate("generation-two"));
  const transition = resolver.activate(prepared);
  const nextSignal = await turns.open(2);
  let drained = false;
  void transition.drained.then(() => { drained = true; });

  const chunks = await Array.fromAsync(resolver.adapter.stream({ signal: firstSignal } as GenerateOptions));
  assert.deepEqual(chunks, [{ type: "text-delta", index: 0, text: "generation-one" }]);
  const nextChunks = await Array.fromAsync(resolver.adapter.stream({ signal: nextSignal } as GenerateOptions));
  assert.deepEqual(nextChunks, [{ type: "text-delta", index: 0, text: "generation-two" }]);
  assert.equal(generated[0]?.disposed, 0);
  assert.deepEqual(resolver.status(), { state: "ready" });
  await Promise.resolve();
  assert.equal(drained, false);

  turns.close(2);
  assert.equal(generated[0]?.disposed, 0);
  turns.close(1);
  await transition.drained;
  assert.equal(drained, true);
  assert.equal(generated[0]?.disposed, 1);

  await resolver.dispose();
  assert.equal(generated[1]?.disposed, 1);
  await ctx.fiber.dispose();
});

test("settles a replacement transition after an idle prior generation disposes", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const transition = resolver.activate(await resolver.prepare(candidate("generation-two")));

  await transition.drained;
  assert.equal(transition.priorGeneration, 1);
  assert.equal(generated[0]?.disposed, 1);

  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("fails closed while degraded and preserves a working generation when a replacement fails", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);

  assert.throws(() => resolver.acquire(), /degraded/i);
  await activateCandidate(resolver, candidate("generation-one"));
  await assert.rejects(resolver.prepare(candidate("broken")), /candidate failed/);
  assert.deepEqual(resolver.status(), { state: "ready" });

  const turns = bindTurnDriver(ctx, resolver);
  const signal = await turns.open(1);
  const chunks = await Array.fromAsync(resolver.adapter.stream({ signal } as GenerateOptions));
  assert.deepEqual(chunks, [{ type: "text-delta", index: 0, text: "generation-one" }]);
  turns.close(1);
  await resolver.degrade();
  assert.deepEqual(resolver.status(), { state: "degraded" });
  assert.throws(() => resolver.acquire(), /degraded/i);

  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("rejects an unready child route and disposes it without replacing the active generation", async () => {
  const ctx = new Context();
  let unreadyDisposed = 0;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (selected) => ({
      provider: selected.provider,
      model: selected.model,
      runtime: {
        resolveModelInfo: async (provider, model) => {
          if (model === "unready") throw new Error("route unavailable");
          return { provider, id: model, name: model };
        },
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "text-delta", index: 0, text: selected.model };
        },
      },
      dispose: async () => {
        if (selected.model === "unready") unreadyDisposed += 1;
      },
    }),
  });
  await activateCandidate(resolver, candidate("generation-one"));

  await assert.rejects(resolver.prepare(candidate("unready")), /route unavailable/);
  assert.equal(unreadyDisposed, 1);
  const turns = bindTurnDriver(ctx, resolver);
  const signal = await turns.open(1);
  const chunks = await Array.fromAsync(resolver.adapter.stream({ signal } as GenerateOptions));
  assert.deepEqual(chunks, [{ type: "text-delta", index: 0, text: "generation-one" }]);
  turns.close(1);

  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("keeps active routing unchanged while a prepared candidate is discarded", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const prepared = await resolver.prepare(candidate("generation-two"));

  await resolver.discard(prepared);
  assert.equal(generated[1]?.disposed, 1);
  const turns = bindTurnDriver(ctx, resolver);
  const signal = await turns.open(1);
  const chunks = await Array.fromAsync(resolver.adapter.stream({ signal } as GenerateOptions));
  assert.deepEqual(chunks, [{ type: "text-delta", index: 0, text: "generation-one" }]);
  turns.close(1);

  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("consumes a prepared candidate once during a synchronous activation", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const prepared = await resolver.prepare(candidate("generation-two"));

  const transition = resolver.activate(prepared);
  assert.equal(transition.priorGeneration, 1);
  assert.throws(() => resolver.activate(prepared), /consumed/i);

  const turns = bindTurnDriver(ctx, resolver);
  const signal = await turns.open(1);
  const chunks = await Array.fromAsync(resolver.adapter.stream({ signal } as GenerateOptions));
  assert.deepEqual(chunks, [{ type: "text-delta", index: 0, text: "generation-two" }]);
  turns.close(1);
  await transition.drained;

  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("waits for every retired generation when shutdown begins during an activity lease", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const turns = bindTurnDriver(ctx, resolver);
  await turns.open(1);
  const transition = resolver.activate(await resolver.prepare(candidate("generation-two")));

  let shutdownComplete = false;
  const shutdown = resolver.dispose().then(() => { shutdownComplete = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownComplete, false);
  assert.equal(generated[0]?.disposed, 0);
  assert.equal(generated[1]?.disposed, 1);

  turns.close(1);
  await transition.drained;
  await shutdown;
  assert.equal(generated[0]?.disposed, 1);
  await ctx.fiber.dispose();
});

test("virtualizes exact child model metadata on the turn signal without leaking its route", async () => {
  const ctx = new Context();
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (): Promise<ModelProviderGeneration> => ({
      provider: "physical-provider",
      model: "physical-model",
      runtime: {
        resolveModelInfo: async (provider, model) => ({
          provider,
          id: model,
          name: "Physical model",
          context: { contextWindow: 32_768 },
          defaultMaxTokens: 2_048,
          reasoning: { efforts: [{ id: "low" as never, name: "Low" }] },
          inputModalities: ["text", "image"],
        }),
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      dispose: async () => {},
    }),
  });
  await activateCandidate(resolver, candidate("generation-one"));
  const turns = bindTurnDriver(ctx, resolver);
  const signal = await turns.open(1);

  const resolved = await resolver.adapter.resolveModel(
    HOME_ACTIVE_PROVIDER_ROUTE,
    HOME_ACTIVE_MODEL,
    signal,
  );

  assert.deepEqual(resolved, {
    provider: HOME_ACTIVE_PROVIDER_ROUTE,
    id: HOME_ACTIVE_MODEL,
    name: HOME_ACTIVE_MODEL,
    context: { contextWindow: 32_768 },
    defaultMaxTokens: 2_048,
    reasoning: { efforts: [{ id: "low", name: "Low" }] },
    inputModalities: ["text", "image"],
  });
  turns.close(1);
  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("requires a turn signal when more than one open turn could own a root request", async () => {
  const generated: Generated[] = [];
  const { ctx, resolver } = createResolver(generated);
  await activateCandidate(resolver, candidate("generation-one"));
  const turns = bindTurnDriver(ctx, resolver);
  await turns.open(1);
  await turns.open(2);

  await assert.rejects(
    resolver.adapter.resolveModel(HOME_ACTIVE_PROVIDER_ROUTE, HOME_ACTIVE_MODEL),
    /turn lease is unavailable/i,
  );
  await assert.rejects(
    Array.fromAsync(resolver.adapter.stream({} as GenerateOptions)),
    /turn lease is unavailable/i,
  );

  turns.close(2);
  turns.close(1);
  await resolver.dispose();
  await ctx.fiber.dispose();
});

test("disposes a candidate that completes after resolver shutdown begins", async () => {
  const ctx = new Context();
  let completeCreation!: (generation: ModelProviderGeneration) => void;
  let disposed = 0;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: () => new Promise<ModelProviderGeneration>((resolve) => { completeCreation = resolve; }),
  });

  const pending = resolver.prepare(candidate("late-generation"));
  const shutdown = resolver.dispose();
  completeCreation({
    provider: "deepseek",
    model: "late-generation",
    runtime: {
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
      stream: async function* (): AsyncIterable<StreamChunk> {
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
    dispose: async () => { disposed += 1; },
  });

  await assert.rejects(pending, /disposed/i);
  await shutdown;
  assert.equal(disposed, 1);
  await ctx.fiber.dispose();
});

test("cancels a caller-owned preparation and disposes its late child", async () => {
  const ctx = new Context();
  let creationSignal: AbortSignal | undefined;
  let disposed = 0;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (_candidate, signal): Promise<ModelProviderGeneration> => {
      creationSignal = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return {
        provider: "deepseek",
        model: "cancelled-generation",
        runtime: {
          resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
          stream: async function* (): AsyncIterable<StreamChunk> {
            yield { type: "finish", reason: { kind: "stop" } };
          },
        },
        dispose: async () => { disposed += 1; },
      };
    },
  });
  const caller = new AbortController();
  const pending = resolver.prepare(candidate("cancelled-generation"), caller.signal);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.ok(creationSignal);
  caller.abort(new Error("candidate cancelled"));

  const deadline = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("preparation ignored caller cancellation")), 25);
  });
  try {
    await assert.rejects(Promise.race([pending, deadline]), /cancelled/i);
    assert.equal(disposed, 1);
  } finally {
    await resolver.dispose().catch(() => undefined);
    await pending.catch(() => undefined);
    await ctx.fiber.dispose();
  }
});

test("cancels caller-owned route verification and disposes its mounted child", async () => {
  const ctx = new Context();
  let disposed = 0;
  let verificationSignal: AbortSignal | undefined;
  const resolver = new ModelProviderResolver(ctx, {
    createGeneration: async (): Promise<ModelProviderGeneration> => ({
      provider: "deepseek",
      model: "verification-generation",
      runtime: {
        resolveModelInfo: async (provider, model, signal) => {
          verificationSignal = signal;
          await new Promise<void>((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
          return { provider, id: model, name: model };
        },
        stream: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      dispose: async () => { disposed += 1; },
    }),
  });
  const caller = new AbortController();
  const pending = resolver.prepare(candidate("verification-generation"), caller.signal);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.ok(verificationSignal);
  caller.abort();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(disposed, 1);
  await resolver.dispose();
  await ctx.fiber.dispose();
});
