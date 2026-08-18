import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const agentSourceRoot = join(repositoryRoot, "packages", "agent-layer", "src");
const hubSourceRoot = join(repositoryRoot, "packages", "hub", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
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
  const hubFiles = sourceFiles(hubSourceRoot);

  assert.deepEqual(
    violations(agentFiles, /home[ -]?assistant|homeassistant|entity_id|\bHASS\b/i),
    [],
    "agent-layer production source must not depend on an ecosystem vocabulary",
  );

  const adapterImport = /\b(?:from|import)\s*(?:\(\s*)?["'][^"']*(?:home-assistant|homeassistant|home-assistant-service)[^"']*["']/i;
  const allowedProductBundle = join(hubSourceRoot, "bridge-bundle.ts");
  const hubCoreFiles = hubFiles.filter((file) => file !== allowedProductBundle
    && !file.endsWith("home-assistant-bridge.ts"));
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
      /HomeAssistantService|HomeAssistantBridge|home-assistant(?:-service|-bridge)?|HOB_HA_URL|HOB_HA_TOKEN|HOME_ASSISTANT/i,
    ),
    [],
    "composition roots must expose catalog/world seams rather than an ecosystem service identity",
  );

  const removedEntries = [
    join(repositoryRoot, "contracts", "bridge-contract-v0.ts"),
    join(hubSourceRoot, "home-assistant-service.ts"),
    join(hubSourceRoot, "home-assistant-service.test.ts"),
  ].filter(existsSync).map((path) => relative(repositoryRoot, path));
  assert.deepEqual(removedEntries, [], "deprecated contract and HomeAssistantService entries must stay deleted");

  const packageFiles = [
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "packages", "hub", "package.json"),
    join(repositoryRoot, "packages", "agent-layer", "package.json"),
  ];
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
});
