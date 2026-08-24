import assert from "node:assert/strict";
import test from "node:test";

import {
  CAUSALITY_EXTENSION,
  causalityCauseSchema,
  causalityPayloadSchema,
} from "./bridge-causality.js";

test("defines the bounded causality extension and accepts only neutral cause references", () => {
  assert.deepEqual(CAUSALITY_EXTENSION, { id: "causality", version: "1.0.0" });
  assert.deepEqual(causalityPayloadSchema.parse({
    refSeq: 7,
    cause: { kind: "user", principalRef: "principal:abc123" },
  }), {
    refSeq: 7,
    cause: { kind: "user", principalRef: "principal:abc123" },
  });
  assert.deepEqual(causalityPayloadSchema.parse({
    refSeq: 8,
    cause: { kind: "unknown" },
  }), {
    refSeq: 8,
    cause: { kind: "unknown" },
  });
  assert.equal(causalityCauseSchema.safeParse({ kind: "physical" }).success, true);
  assert.equal(causalityCauseSchema.safeParse({ kind: "foreign_rule", ruleRef: "ha-rule:opaque" }).success, true);
  assert.equal(causalityCauseSchema.safeParse({ kind: "hob_artifact", artifactId: "artifact:opaque" }).success, true);
});

test("rejects native fields, unbounded references, invalid seq, and unknown cause variants", () => {
  assert.equal(causalityPayloadSchema.safeParse({
    refSeq: 0,
    cause: { kind: "unknown" },
  }).success, false);
  assert.equal(causalityPayloadSchema.safeParse({
    refSeq: 1,
    cause: { kind: "user", principalRef: "user_id-from-home-assistant" },
    context: { user_id: "native-context" },
  }).success, false);
  assert.equal(causalityCauseSchema.safeParse({
    kind: "foreign_rule",
    ruleRef: "x".repeat(257),
  }).success, false);
  assert.equal(causalityCauseSchema.safeParse({
    kind: "foreign_rule",
    ruleRef: "light.kitchen",
  }).success, false);
  assert.equal(causalityCauseSchema.safeParse({ kind: "automation" }).success, false);
  assert.equal(causalityCauseSchema.safeParse({ kind: "unknown", evidence: "limited" }).success, false);
});
