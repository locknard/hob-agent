import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const BRIDGE_CONFIG = JSON.stringify([{
  bridgeId: "ha-main",
  adapterType: "home-assistant",
  config: {
    baseUrl: "http://homeassistant.local:8123",
    authenticationPrincipal: "household-owner",
  },
  credentialRefs: { "access-token": "env:HOB_HA_TOKEN" },
}]);

function validEnvironment(dataDirectory: string, homeDirectory: string): Record<string, string | undefined> {
  return {
    HOB_DATA_DIR: dataDirectory,
    HOB_BRIDGES: BRIDGE_CONFIG,
    HOB_HOME_DIR: homeDirectory,
    HOB_MIGRATION_BRIDGE_ID: "ha-main",
  };
}

test("provides a read-only migration preflight with an explicit configuration-only scope", async () => {
  const preflight = await import("./home-migration-preflight.js").catch(() => undefined);
  assert.ok(preflight, "the migration preflight CLI must exist");
  if (preflight === undefined) return;
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-preflight-ready-"));
  const dataDirectory = join(directory, "data");
  const homeDirectory = join(directory, "home");
  const fs = await import("node:fs");
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(homeDirectory);
  const environment = validEnvironment(dataDirectory, homeDirectory);
  Object.defineProperty(environment, "HOB_HA_TOKEN", {
    enumerable: true,
    get() {
      throw new Error("the preflight must not read credentials");
    },
  });
  try {
    const result = preflight.preflightHomeMigrationEnvironment(environment);
    assert.deepEqual(result, {
      schemaVersion: "1",
      outcome: "ready",
      exitCode: 0,
      scope: "configuration_only",
      configuredBridgeCount: 1,
      selectedBridgeConfigured: true,
      checks: [
        { name: "data_directory", status: "passed" },
        { name: "bridge_configuration", status: "passed" },
        { name: "household_directory", status: "passed" },
        { name: "migration_bridge", status: "passed" },
      ],
      issues: [],
      runtimeStarted: false,
      credentialsRead: false,
      remoteWritesPerformed: false,
      localWritesPerformed: false,
      realCutoverVerified: false,
      nextAction: "assess_migration",
    });
    const serialized = JSON.stringify(result);
    for (const secret of ["HOB_HA_TOKEN", "homeassistant.local", "household-owner", dataDirectory, homeDirectory]) {
      assert.equal(serialized.includes(secret), false, `preflight leaked ${secret}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports each missing operator variable with a stable exit code and direct repair", async () => {
  const preflight = await import("./home-migration-preflight.js");
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-preflight-missing-"));
  const dataDirectory = join(directory, "data");
  const homeDirectory = join(directory, "home");
  const environment = validEnvironment(dataDirectory, homeDirectory);
  const fs = await import("node:fs");
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(homeDirectory);
  try {
    for (const variable of ["HOB_DATA_DIR", "HOB_BRIDGES", "HOB_HOME_DIR", "HOB_MIGRATION_BRIDGE_ID"] as const) {
      const result = preflight.preflightHomeMigrationEnvironment({ ...environment, [variable]: undefined });
      assert.equal(result.outcome, "needs_attention");
      assert.equal(result.exitCode, 2);
      const issue = result.issues.find((item: { readonly variable: string }) => item.variable === variable);
      assert.equal(issue?.code, "missing");
      assert.match(issue?.repair ?? "", new RegExp(variable));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("classifies invalid configuration and unavailable directories without echoing input", async () => {
  const preflight = await import("./home-migration-preflight.js");
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-preflight-invalid-"));
  const dataDirectory = join(directory, "data");
  const homeDirectory = join(directory, "home");
  const environment = validEnvironment(dataDirectory, homeDirectory);
  const fs = await import("node:fs");
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(homeDirectory);
  try {
    const invalidJson = preflight.preflightHomeMigrationEnvironment({ ...environment, HOB_BRIDGES: "secret-invalid-bridge-config" });
    assert.equal(invalidJson.exitCode, 3);
    assert.equal(invalidJson.issues[0]?.variable, "HOB_BRIDGES");
    assert.equal(invalidJson.issues[0]?.code, "invalid");
    assert.equal(JSON.stringify(invalidJson).includes("secret-invalid-bridge-config"), false);

    const invalidHome = preflight.preflightHomeMigrationEnvironment({ ...environment, HOB_HOME_DIR: "relative/home" });
    assert.equal(invalidHome.exitCode, 3);
    assert.equal(invalidHome.issues.some((item: { readonly variable: string; readonly code: string }) =>
      item.variable === "HOB_HOME_DIR" && item.code === "invalid"), true);

    const invalidData = preflight.preflightHomeMigrationEnvironment({ ...environment, HOB_DATA_DIR: "relative/data" });
    assert.equal(invalidData.exitCode, 3);
    assert.equal(invalidData.issues.some((item: { readonly variable: string; readonly code: string }) =>
      item.variable === "HOB_DATA_DIR" && item.code === "invalid"), true);

    const dataFile = join(directory, "data-file");
    const homeFile = join(directory, "home-file");
    writeFileSync(dataFile, "private");
    writeFileSync(homeFile, "private");
    const unavailableData = preflight.preflightHomeMigrationEnvironment({ ...environment, HOB_DATA_DIR: dataFile });
    assert.equal(unavailableData.exitCode, 4);
    assert.equal(unavailableData.issues.some((item: { readonly variable: string; readonly code: string }) =>
      item.variable === "HOB_DATA_DIR" && item.code === "unavailable"), true);
    const unavailableHome = preflight.preflightHomeMigrationEnvironment({ ...environment, HOB_HOME_DIR: homeFile });
    assert.equal(unavailableHome.exitCode, 4);
    assert.equal(unavailableHome.issues.some((item: { readonly variable: string; readonly code: string }) =>
      item.variable === "HOB_HOME_DIR" && item.code === "unavailable"), true);
    assert.equal(statSync(dataFile).size, 7);
    assert.equal(statSync(homeFile).size, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires the selected migration bridge to exist without inferring one", async () => {
  const preflight = await import("./home-migration-preflight.js");
  const directory = mkdtempSync(join(tmpdir(), "hob-migration-preflight-bridge-"));
  const dataDirectory = join(directory, "data");
  const homeDirectory = join(directory, "home");
  const fs = await import("node:fs");
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(homeDirectory);
  try {
    const result = preflight.preflightHomeMigrationEnvironment({
      ...validEnvironment(dataDirectory, homeDirectory),
      HOB_MIGRATION_BRIDGE_ID: "not-configured",
    });
    assert.equal(result.outcome, "needs_attention");
    assert.equal(result.exitCode, 5);
    assert.equal(result.selectedBridgeConfigured, false);
    assert.equal(result.issues.some((item: { readonly variable: string; readonly code: string }) =>
      item.variable === "HOB_MIGRATION_BRIDGE_ID" && item.code === "not_configured"), true);
    assert.equal(JSON.stringify(result).includes("not-configured"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
