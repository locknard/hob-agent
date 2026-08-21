import assert from "node:assert/strict";
import test from "node:test";

import { ProductViewRegistry } from "./product-view-registry.js";

const life = {
  id: "builtin.life",
  label: "生活视图",
  preferences: [{
    key: "overviewFocus",
    label: "首页信息",
    description: "选择首页展示的信息量。",
    defaultValue: "focused",
    choices: [
      { value: "focused", label: "只看重点" },
      { value: "expanded", label: "展示更多" },
    ],
  }],
  renderContent: () => "life",
};
const control = { id: "builtin.control", label: "控制视图", renderContent: () => "control" };

test("resolves registered providers and reports deterministic fallback", () => {
  const registry = new ProductViewRegistry([life, control], life.id);

  assert.equal(registry.resolve(control.id).provider.id, control.id);
  assert.equal(registry.resolve(control.id).provider.label, control.label);
  assert.deepEqual(registry.resolve("plugin.missing"), {
    provider: registry.resolve(life.id).provider,
    recoveredFrom: "plugin.missing",
  });
  assert.deepEqual(registry.choices(), [
    { id: life.id, label: life.label },
    { id: control.id, label: control.label },
  ]);
  assert.deepEqual(registry.resolve(life.id).provider.preferences, life.preferences);
});

test("rejects ambiguous or invalid provider registration", () => {
  assert.throws(() => new ProductViewRegistry([life, life], life.id), /Duplicate product view provider/);
  assert.throws(() => new ProductViewRegistry([{ ...life, id: "Invalid View" }], "Invalid View"), /id is invalid/);
  assert.throws(() => new ProductViewRegistry([life], control.id), /fallback provider is missing/);
  assert.throws(() => new ProductViewRegistry([{ ...life, preferences: [{ ...life.preferences[0]!, key: "Invalid key" }] }], life.id), /preference key is invalid/);
  assert.throws(() => new ProductViewRegistry([{ ...life, preferences: [{ ...life.preferences[0]!, defaultValue: "missing" }] }], life.id), /default choice is missing/);
  assert.throws(() => new ProductViewRegistry([{ ...life, preferences: [{ ...life.preferences[0]!, choices: [life.preferences[0]!.choices[0]!] }] }], life.id), /requires 2 to 8 choices/);
});

test("snapshots provider declarations at the Host registration boundary", () => {
  const mutable = {
    id: "plugin.mutable",
    label: "可变视图",
    preferences: [{
      key: "density",
      label: "信息密度",
      description: "选择信息密度。",
      defaultValue: "calm",
      choices: [
        { value: "calm", label: "从容" },
        { value: "dense", label: "密集" },
      ],
    }],
    renderContent: () => "mutable",
  };
  const registry = new ProductViewRegistry([life, mutable], life.id);

  mutable.label = "注册后改名";
  mutable.preferences[0]!.label = "注册后改写";
  mutable.preferences[0]!.choices[0]!.label = "注册后替换";
  mutable.preferences.push({ ...mutable.preferences[0]!, key: "second" });

  const registered = registry.resolve(mutable.id).provider;
  assert.equal(registered.label, "可变视图");
  assert.equal(registered.preferences?.length, 1);
  assert.equal(registered.preferences?.[0]?.label, "信息密度");
  assert.equal(registered.preferences?.[0]?.choices[0]?.label, "从容");
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered.preferences), true);
  assert.equal(Object.isFrozen(registered.preferences?.[0]?.choices), true);
});
