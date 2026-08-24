import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply } from "./home-causality-tool.js";

test("registers a bounded causality lookup and projects only household-safe fields", async () => {
  let registered: ToolDefinition | undefined;
  let received: unknown;
  const homeWorld = {
    marker: "bound",
    queryCausality(input: unknown) {
      assert.equal(this.marker, "bound");
      received = input;
      return {
        status: "complete",
        hwCapabilityId: "hc-1",
        provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
        attribution: "foreign_rule",
        hwId: "hw-1",
        nativeId: "native-secret",
        principalRef: "member-secret",
        ruleRef: "ha-rule-secret",
        artifactId: "artifact-secret",
        reasons: [],
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
  assert.equal(registered?.name, "get_home_causality");
  const value = await registered!.execute({
    hwCapabilityId: "hc-1",
    provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
  }, {} as never);

  assert.deepEqual(received, {
    hwCapabilityId: "hc-1",
    provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
  });
  assert.deepEqual(value, {
    status: "complete",
    attribution: "external-rule",
    reasons: [],
  });
  const serialized = JSON.stringify(value);
  for (const forbidden of ["principalRef", "ruleRef", "artifactId", "nativeId", "ha-rule-secret", "member-secret"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("keeps partial or unknown causality explicit without guessing from raw fields", async () => {
  let registered: ToolDefinition | undefined;
  const homeWorld = {
    queryCausality() {
      return {
        status: "partial",
        attribution: "user",
        reasons: ["state_value_unknown"],
        sourceFingerprint: "fingerprint-secret",
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
  const partial = await registered!.execute({
    hwCapabilityId: "hc-1",
    provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
  }, {} as never);
  assert.deepEqual(partial, {
    status: "partial",
    attribution: "member",
    reasons: ["source_unresolved"],
  });

  homeWorld.queryCausality = () => ({
    status: "unknown",
    attribution: "provider-private-kind",
    reasons: ["provider-private-reason"],
  });
  const unknown = await registered!.execute({
    hwCapabilityId: "hc-1",
    provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
  }, {} as never);
  assert.deepEqual(unknown, {
    status: "unknown",
    attribution: "unknown",
    reasons: ["causality_unknown"],
  });
});

test("preserves the closed World coverage reasons instead of collapsing them to a generic unknown", async () => {
  let registered: ToolDefinition | undefined;
  const results = [
    { status: "unknown", reasons: ["missing_consistent_baseline"] },
    { status: "partial", attribution: "physical", reasons: ["bridge_not_ready", "history_gap"] },
    { status: "unavailable", reasons: ["causality_unavailable"] },
  ];
  const ctx = {
    homeWorld: { queryCausality: () => results.shift() },
    tools: {
      register(definition: ToolDefinition): () => void {
        registered = definition;
        return () => undefined;
      },
    },
  } as unknown as Context;

  apply(ctx);
  const args = {
    hwCapabilityId: "hc-1",
    provenance: { bridgeId: "bridge-a", epochId: "epoch-a", seq: 5 },
  };
  assert.deepEqual(await registered!.execute(args, {} as never), {
    status: "unknown",
    attribution: "unknown",
    reasons: ["missing_consistent_baseline"],
  });
  assert.deepEqual(await registered!.execute(args, {} as never), {
    status: "partial",
    attribution: "physical",
    reasons: ["bridge_not_ready", "history_gap"],
  });
  assert.deepEqual(await registered!.execute(args, {} as never), {
    status: "unavailable",
    reasons: ["causality_unavailable"],
  });
});
