import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const agentSourceRoot = join(repositoryRoot, "packages", "agent-layer", "src");
const inboxSourceRoot = join(repositoryRoot, "packages", "inbox-web", "src");
const hubSourceRoot = join(repositoryRoot, "packages", "hub", "src");

function sourceFiles(directory: string, includeTests = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, includeTests);
    return entry.isFile() && path.endsWith(".ts") && (includeTests || !path.endsWith(".test.ts")) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function violations(files: readonly string[], pattern: RegExp, stripComments = true): string[] {
  return files.flatMap((file) => {
    const source = stripComments ? withoutComments(readFileSync(file, "utf8")) : readFileSync(file, "utf8");
    return pattern.test(source) ? [relative(repositoryRoot, file)] : [];
  });
}

test("architecture guards keep the agent and neutral hub boundaries closed", () => {
  const agentFiles = sourceFiles(agentSourceRoot);
  const inboxFiles = sourceFiles(inboxSourceRoot);
  const hubFiles = sourceFiles(hubSourceRoot);
  const hubFilesWithTests = sourceFiles(hubSourceRoot, true);

  assert.deepEqual(
    violations(agentFiles, /home[ -]?assistant|homeassistant|entity_id|\bHASS\b/i),
    [],
    "agent-layer production source must not depend on an ecosystem vocabulary",
  );

  const adapterImport = /\b(?:from|import)\s*(?:\(\s*)?["'][^"']*(?:home-assistant|homeassistant|xiaomi-home)[^"']*["']/i;
  const allowedProductBundle = join(hubSourceRoot, "bridge-bundle.ts");
  const hubCoreFiles = hubFiles.filter((file) => file !== allowedProductBundle
    && !file.endsWith("home-assistant-bridge.ts")
    && !file.endsWith("xiaomi-home-bridge.ts"));
  assert.deepEqual(
    violations(hubCoreFiles, adapterImport, false),
    [],
    "hub core may reach a concrete adapter only through the product bundle",
  );

  // The index owns the denylist of native keys as its input boundary; its
  // neutral tables still store only canonical records and projected values.
  const neutralHomeWorldFiles = hubFiles.filter((file) => !file.endsWith("home-assistant-bridge.ts")
    && !file.endsWith("world-model-index.ts"));
  const rawHomeAssistantShape = /\b(?:entity_id|new_state|old_state|last_changed|last_updated|service_data|event_type|ha_version|auth_required)\b/;
  assert.deepEqual(
    violations([...neutralHomeWorldFiles, ...agentFiles], rawHomeAssistantShape),
    [],
    "neutral homeWorld and agent source must not carry raw Home Assistant shape",
  );

  const compositionRootFiles = [
    "main.ts",
    "process-entry.ts",
    "home-agent-runtime.ts",
    "home-world-service.ts",
    "launch-config.ts",
  ].map((name) => join(hubSourceRoot, name));
  assert.deepEqual(
    violations(
      compositionRootFiles,
      /HomeAssistantService|HomeAssistantBridge|home-assistant(?:-service|-bridge)?|XiaomiHome|xiaomi-home|HOB_HA_URL|HOB_HA_TOKEN|HOME_ASSISTANT/i,
    ),
    [],
    "composition roots must expose catalog/world seams rather than an ecosystem service identity",
  );

  const removedEntries = [
    join(repositoryRoot, "contracts", "bridge-contract-v0.ts"),
    join(repositoryRoot, "contracts", "bridge-contract-v6.ts"),
    join(hubSourceRoot, "home-assistant-service.ts"),
    join(hubSourceRoot, "home-assistant-service.test.ts"),
    join(hubSourceRoot, "home-inbox.ts"),
    join(hubSourceRoot, "home-inbox.test.ts"),
  ].filter(existsSync).map((path) => relative(repositoryRoot, path));
  assert.deepEqual(removedEntries, [], "superseded contracts, ecosystem services, and the second runtime entry must stay deleted");

  const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  assert.equal(rootPackage.scripts?.["inbox:home"], undefined, "the product exposes one runtime entry");

  const hubPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages", "hub", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(hubPackage.dependencies?.["@hob/bridge-contract"], "workspace:*", "Hub must declare its neutral contract dependency");
  assert.deepEqual(
    violations(hubFilesWithTests, /(?:from|import\s*\()["'][^"']*(?:\.\.\/)+contracts\//, false),
    [],
    "Hub production and test source must consume the bridge contract through its package entry point",
  );

  const contractIndex = readFileSync(join(repositoryRoot, "contracts", "index.ts"), "utf8");
  for (const moduleName of [
    "bridge-contract",
    "bridge-adapter-conformance",
    "bridge-actions",
    "bridge-foreign-rules",
    "bridge-org-hints",
  ]) {
    assert.match(contractIndex, new RegExp(`export \\* from "\\./${moduleName}\\.js";`), `${moduleName} must be exported from the public contract entry`);
  }
  const contractPackage = JSON.parse(readFileSync(join(repositoryRoot, "contracts", "package.json"), "utf8")) as { version?: string };
  const contractReadme = readFileSync(join(repositoryRoot, "contracts", "README.md"), "utf8");
  assert.equal(contractPackage.version, "6.5.0", "the contract package version must match the frozen v6.5 surface");
  assert.match(contractReadme, /^# Neutral bridge contract \(v6\.5\)$/m);

  const packageFiles = ["package.json", "packages/hub/package.json", "packages/agent-layer/package.json", "packages/inbox-web/package.json", "contracts/package.json"]
    .map((path) => join(repositoryRoot, path));
  const dependencyNames = packageFiles.flatMap((path) => {
    const packageJson = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    return Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.optionalDependencies,
      ...packageJson.peerDependencies,
    });
  });
  assert.deepEqual(
    dependencyNames.filter((name) => /(?:sqlite3|better-sqlite3|postgres|^pg$|redis|mongodb|home-assistant|homeassistant)/i.test(name)),
    [],
    "Phase 0 packages must not add ecosystem/database service dependencies",
  );

  assert.deepEqual(
    violations([...agentFiles, ...inboxFiles], /(?:from|import\s*\()["'][^"']*@hob-agent\/hub(?:\/[^"']*)?["']/),
    [],
    "agent and Inbox layers must not depend back on Hub implementation modules",
  );
});
