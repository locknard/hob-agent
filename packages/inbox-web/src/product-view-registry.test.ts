import assert from "node:assert/strict";
import test from "node:test";

import { ProductViewRegistry } from "./product-view-registry.js";

const life = { id: "builtin.life", label: "生活视图", renderContent: () => "life" };
const control = { id: "builtin.control", label: "控制视图", renderContent: () => "control" };

test("resolves registered providers and reports deterministic fallback", () => {
  const registry = new ProductViewRegistry([life, control], life.id);

  assert.equal(registry.resolve(control.id).provider, control);
  assert.deepEqual(registry.resolve("plugin.missing"), {
    provider: life,
    recoveredFrom: "plugin.missing",
  });
  assert.deepEqual(registry.choices(), [
    { id: life.id, label: life.label },
    { id: control.id, label: control.label },
  ]);
});

test("rejects ambiguous or invalid provider registration", () => {
  assert.throws(() => new ProductViewRegistry([life, life], life.id), /Duplicate product view provider/);
  assert.throws(() => new ProductViewRegistry([{ ...life, id: "Invalid View" }], "Invalid View"), /id is invalid/);
  assert.throws(() => new ProductViewRegistry([life], control.id), /fallback provider is missing/);
});
