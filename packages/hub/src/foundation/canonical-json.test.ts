import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalJsonError,
  MAX_CANONICAL_ARRAY_LENGTH,
  canonicalHubJson,
} from "./canonical-json.js";

test("canonicalizes Hub identity objects while retaining semantic array order", () => {
  const first = canonicalHubJson({ z: 1, nested: { b: true, a: "x" }, list: ["b", "a"] });
  const reordered = canonicalHubJson({ list: ["b", "a"], nested: { a: "x", b: true }, z: 1 });

  assert.equal(first, reordered);
  assert.notEqual(first, canonicalHubJson({ z: 1, nested: { b: true, a: "x" }, list: ["a", "b"] }));
});

test("rejects authority-shaped identity inputs that carry routing or secret fields", () => {
  assert.throws(
    () => canonicalHubJson({ capabilityId: "capability-1", token: "opaque" }),
    (error: unknown) => error instanceof CanonicalJsonError && error.code === "invalid_input",
  );
});

test("bounds identity input resources before serialization", () => {
  assert.throws(
    () => canonicalHubJson(Array.from({ length: MAX_CANONICAL_ARRAY_LENGTH + 1 }, () => "x")),
    (error: unknown) => error instanceof CanonicalJsonError && error.code === "resource_exhausted",
  );
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalHubJson(cyclic),
    (error: unknown) => error instanceof CanonicalJsonError && error.code === "invalid_input",
  );
});
