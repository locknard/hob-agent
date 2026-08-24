import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSecretRef,
  isSecretRef,
  parseSecretRef,
  readOnlySecretRefAvailability,
  type SecretRef,
} from "./secret-ref.js";

test("parses and formats the three Phase 0 canonical SecretRef forms", () => {
  const env = parseSecretRef("env:OPENAI_API_KEY");
  const keychain = parseSecretRef("keychain:hob-agent/gpt:primary");
  const vault = parseSecretRef("vault:hob-agent/gpt:primary");

  assert.deepEqual(env, { source: "env", id: "OPENAI_API_KEY" });
  assert.deepEqual(keychain, { source: "keychain", id: "hob-agent/gpt:primary" });
  assert.deepEqual(vault, { source: "vault", id: "hob-agent/gpt:primary" });
  assert.equal(formatSecretRef(env), "env:OPENAI_API_KEY");
  assert.equal(formatSecretRef(keychain), "keychain:hob-agent/gpt:primary");
  assert.equal(formatSecretRef(vault), "vault:hob-agent/gpt:primary");
  assert.equal(isSecretRef(env), true);
  assert.equal(isSecretRef(keychain), true);
  assert.equal(isSecretRef(vault), true);
});

test("rejects non-canonical refs, paths, whitespace, newlines, and unknown sources", () => {
  for (const value of [
    "env:openai_api_key",
    "env:OPENAI_API_KEY/other",
    "env:OPENAI_API_KEY ",
    "env:OPENAI\nAPI_KEY",
    "env:../OPENAI_API_KEY",
    "keychain:hob-agent",
    "keychain:../gpt:primary",
    "keychain:hob-agent/gpt primary",
    "vault:default:OPENAI_API_KEY",
    "env:default:OPENAI_API_KEY",
  ]) {
    assert.throws(() => parseSecretRef(value), /Invalid SecretRef/);
  }

  assert.equal(isSecretRef({ source: "env", id: "OPENAI_API_KEY", extra: true }), false);
  assert.equal(isSecretRef({ source: "vault", id: "OPENAI_API_KEY" }), false);
  assert.throws(
    () => formatSecretRef({ source: "env", id: "OPENAI_API_KEY/other" } as SecretRef),
    /Invalid SecretRef/,
  );
});

test("reports available, missing, and blocked env refs without returning the value", () => {
  const options = {
    env: { PRESENT: "secret-value", EMPTY: "", BLANK: "   ", OTHER: "unrelated" },
    envAllowlist: ["PRESENT", "EMPTY", "BLANK"],
  } as const;

  assert.deepEqual(readOnlySecretRefAvailability("env:PRESENT", options), {
    status: "available",
    ref: { source: "env", id: "PRESENT" },
  });
  assert.deepEqual(readOnlySecretRefAvailability("env:EMPTY", options), {
    status: "missing",
    ref: { source: "env", id: "EMPTY" },
  });
  assert.deepEqual(readOnlySecretRefAvailability("env:BLANK", options), {
    status: "missing",
    ref: { source: "env", id: "BLANK" },
  });
  assert.deepEqual(readOnlySecretRefAvailability("env:OTHER", options), {
    status: "blocked",
    reason: "not-allowlisted",
    ref: { source: "env", id: "OTHER" },
  });
  assert.equal(JSON.stringify(readOnlySecretRefAvailability("env:PRESENT", options)).includes("secret-value"), false);
});

test("keychain availability is passive and never invokes a reader or prompt", () => {
  let reads = 0;
  const result = readOnlySecretRefAvailability("keychain:hob-agent/gpt:primary", {
    env: {},
    envAllowlist: [],
    readKeychain: async () => {
      reads += 1;
      return "secret-value";
    },
  });

  assert.deepEqual(result, {
    status: "unknown",
    reason: "configured",
    ref: { source: "keychain", id: "hob-agent/gpt:primary" },
  });
  assert.equal(reads, 0);
});

test("vault availability is passive and reports only configured metadata", () => {
  assert.deepEqual(readOnlySecretRefAvailability("vault:hob-agent/gpt:primary", {
    env: {},
    envAllowlist: [],
  }), {
    status: "unknown",
    reason: "configured",
    ref: { source: "vault", id: "hob-agent/gpt:primary" },
  });
});

test("invalid refs are blocked by availability without exposing input values", () => {
  const result = readOnlySecretRefAvailability("vault:secret-value", {
    env: {},
    envAllowlist: [],
  });
  assert.deepEqual(result, { status: "blocked", reason: "invalid-ref" });
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});
