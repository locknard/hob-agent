import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./home-history-tool.js";

function contextFor(homeWorld: Record<string, unknown>): {
  readonly ctx: Context;
  getRegistered(): ToolDefinition;
} {
  let registered: ToolDefinition | undefined;
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  return {
    ctx,
    getRegistered: () => {
      assert.notEqual(registered, undefined);
      return registered!;
    },
  };
}

test("registers get_home_history and projects only imported scalar history", async () => {
  let received: unknown;
  let receivedSignal: AbortSignal | undefined;
  const homeWorld = {
    marker: "bound",
    async queryImportedHistory(input: unknown, signal?: AbortSignal) {
      assert.equal(this.marker, "bound");
      assert.equal(signal?.aborted ?? false, false);
      received = input;
      receivedSignal = signal;
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          semanticKind: "light",
          value: "on",
          observedAt: "2026-08-24T11:59:59.000Z",
          sourceTs: "2026-08-24T11:59:59.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
          bridgeId: "bridge-secret",
          nativeId: "native-secret",
          importId: "import-secret",
          historySeq: 12,
          liveCut: { epochId: "epoch-secret", lastSeq: 20 },
          provider: "home-assistant",
        }],
        coverage: {
          status: "partial",
          reasons: ["retention_floor_unknown", "query_truncated"],
        },
        truncated: true,
      };
    },
  };
  const { getRegistered } = contextFor(homeWorld);
  const registered = getRegistered();
  assert.equal(registered.name, "get_home_history");

  const controller = new AbortController();
  const value = await registered.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
    limit: 20,
  }, { signal: controller.signal } as never);

  assert.deepEqual(received, {
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
    limit: 20,
  });
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(value, {
    requestedSince: "2026-08-24T00:00:00.000Z",
    requestedUntil: "2026-08-25T00:00:00.000Z",
    events: [{
      hwId: "hw-light",
      hwCapabilityId: "hc-light",
      semanticKind: "light",
      value: "on",
      observedAt: "2026-08-24T11:59:59.000Z",
      sourceTs: "2026-08-24T11:59:59.000Z",
      sourceTsQuality: "platform",
      origin: "imported",
    }],
    coverage: {
      status: "partial",
      reasons: ["retention_floor_unknown", "query_truncated"],
    },
    truncated: true,
  });
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "bridgeId", "nativeId", "importId", "historySeq", "liveCut", "provider", "epoch-secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("fails closed when the imported-history port returns malformed provenance or coverage", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: { state: "on" },
          observedAt: "2026-08-24T12:00:00.000Z",
          sourceTsQuality: "device",
          origin: "observed",
        }],
        coverage: { status: "complete", reasons: ["provider_private_reason"] },
        truncated: "false",
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("fails closed when history provenance is not a platform timestamp exact match", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: "on",
          observedAt: "2026-08-24T12:00:00.000Z",
          sourceTs: "2026-08-24T11:59:59.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "partial", reasons: ["retention_floor_unknown"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("rejects non-UTC history timestamps instead of trusting Date.parse", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T08:00:00.000+08:00",
        requestedUntil: "2026-08-25T08:00:00.000+08:00",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: "on",
          observedAt: "2026-08-24T12:00:00.000+08:00",
          sourceTs: "2026-08-24T12:00:00.000+08:00",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "partial", reasons: ["retention_floor_unknown"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("fails closed when an imported event is outside the returned request range", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-24T01:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: "on",
          observedAt: "2026-08-24T02:00:00.000Z",
          sourceTs: "2026-08-24T02:00:00.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "partial", reasons: ["retention_floor_unknown"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("fails closed when an unavailable page contains imported events", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: "on",
          observedAt: "2026-08-24T12:00:00.000Z",
          sourceTs: "2026-08-24T12:00:00.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "unavailable", reasons: ["history_unavailable"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("fails closed when a returned event widens the requested capability selection", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-24T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-other",
          hwCapabilityId: "hc-other",
          value: "on",
          observedAt: "2026-08-24T12:00:00.000Z",
          sourceTs: "2026-08-24T12:00:00.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "partial", reasons: ["retention_floor_unknown"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("fails closed when the returned range exceeds the requested lookback", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryImportedHistory() {
      return {
        requestedSince: "2026-08-20T00:00:00.000Z",
        requestedUntil: "2026-08-25T00:00:00.000Z",
        events: [{
          hwId: "hw-light",
          hwCapabilityId: "hc-light",
          value: "on",
          observedAt: "2026-08-24T12:00:00.000Z",
          sourceTs: "2026-08-24T12:00:00.000Z",
          sourceTsQuality: "platform",
          origin: "imported",
        }],
        coverage: { status: "partial", reasons: ["retention_floor_unknown"] },
        truncated: false,
      };
    },
  };
  const ctx = {
    homeWorld,
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;
  apply(ctx);
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});

test("returns unavailable without leaking an exception when HomeWorld history is unavailable", async () => {
  const { getRegistered } = contextFor({
    queryImportedHistory() {
      throw new Error("native provider detail");
    },
  });
  const value = await getRegistered().execute({
    hwCapabilityIds: ["hc-light"],
    lookbackHours: 24,
  }, {} as never);
  assert.deepEqual(value, {
    coverage: { status: "unavailable", reasons: ["history_unavailable"] },
    events: [],
    truncated: false,
  });
});
