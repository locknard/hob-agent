import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./dsh-home-activity-tool.js";

test("registers a metadata-only activity discovery tool over neutral HomeWorld", async () => {
  let registered: ToolDefinition | undefined;
  let received: unknown;
  const homeWorld = {
    queryRecentActivity(input: unknown) {
      received = input;
      return {
        requestedSince: "2026-08-18T04:00:00.000Z",
        requestedUntil: "2026-08-19T04:00:00.000Z",
        devices: [{
          hwId: "hw-1",
          eventCount: 7,
          latestObservedAt: "2026-08-19T03:00:00.000Z",
          semanticKinds: ["light"],
        }],
        coverage: [{
          bridgeId: "bridge-a",
          epochId: "epoch-a",
          baselineSeq: 4,
          baselineAt: "2026-08-18T04:00:00.000Z",
          status: "complete",
          reasons: [],
        }],
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
  assert.equal(registered?.name, "get_home_activity");
  const value = await registered!.execute({ lookbackHours: 24, limit: 20 }, {} as never);
  assert.deepEqual(received, { lookbackHours: 24, limit: 20 });
  assert.deepEqual(value, homeWorld.queryRecentActivity({}));
  assert.equal(JSON.stringify(value).includes("state"), false);
  assert.equal(JSON.stringify(value).includes("nativeId"), false);
});

