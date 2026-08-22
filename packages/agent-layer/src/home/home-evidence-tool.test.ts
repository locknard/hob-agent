import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./home-evidence-tool.js";

test("registers a bounded read-only evidence tool over the neutral HomeWorld seam", async () => {
  let registered: ToolDefinition | undefined;
  let received: unknown;
  const homeWorld = {
    marker: "bound",
    queryRecentEvidence(input: unknown) {
      assert.equal(this.marker, "bound");
      received = input;
      return {
        requestedSince: "2026-08-19T02:00:00.000Z",
        requestedUntil: "2026-08-19T04:00:00.000Z",
        events: [{
          hwId: "hw-1",
          hwCapabilityId: "hc-1",
          semanticKind: "light",
          value: "off",
          observedAt: "2026-08-19T03:00:00.000Z",
          sourceTsQuality: "platform",
          origin: "observed",
          provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
        }],
        coverage: [{
          bridgeId: "bridge-a",
          epochId: "epoch-a",
          baselineSeq: 4,
          baselineAt: "2026-08-19T00:00:00.000Z",
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
  assert.equal(registered?.name, "get_home_evidence");
  const value = await registered!.execute({
    hwCapabilityIds: ["hc-1"],
    lookbackHours: 2,
    limit: 20,
  }, {} as never);

  assert.deepEqual(received, {
    hwCapabilityIds: ["hc-1"],
    lookbackHours: 2,
    limit: 20,
  });
  assert.deepEqual(value, homeWorld.queryRecentEvidence({}));
  assert.equal(JSON.stringify(value).includes("nativeId"), false);
});
