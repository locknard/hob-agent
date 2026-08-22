import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface WorkspacePackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: string | Readonly<Record<string, unknown>>;
  readonly name: string;
}

interface WorkspacePackageBoundary {
  readonly directory: string;
  readonly manifest: WorkspacePackageManifest;
}

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

function importSpecifiers(source: string): string[] {
  return [...withoutComments(source).matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu)]
    .map((match) => match[1]);
}

function workspacePackage(directory: string): WorkspacePackageBoundary {
  return {
    directory,
    manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as WorkspacePackageManifest,
  };
}

function exportedSubpath(manifest: WorkspacePackageManifest, specifier: string): boolean {
  const subpath = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
  return typeof manifest.exports === "string"
    ? subpath === "."
    : manifest.exports !== undefined && Object.hasOwn(manifest.exports, subpath);
}

function packageExportRoots(boundary: WorkspacePackageBoundary): string[] {
  const entries = typeof boundary.manifest.exports === "string"
    ? [boundary.manifest.exports]
    : Object.values(boundary.manifest.exports ?? {}).filter((value): value is string => typeof value === "string");
  return entries.map((entry) => resolve(boundary.directory, entry));
}

function unreachableProductionFiles(directory: string, roots: readonly string[]): string[] {
  const productionFiles = new Set(sourceFiles(directory));
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || reached.has(file) || !productionFiles.has(file)) continue;
    reached.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
      if (productionFiles.has(target)) pending.push(target);
    }
  }
  return [...productionFiles]
    .filter((file) => !reached.has(file))
    .map((file) => relative(repositoryRoot, file))
    .sort();
}

test("workspace boundary parser recognizes every TypeScript import form", () => {
  const source = `
    import "@hob/bridge-contract";
    import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";
    export { ProposalInboxService } from "@hob-agent/inbox-web/service";
    const module = await import("@hob-agent/inbox-web/http");
  `;
  assert.deepEqual(importSpecifiers(source), [
    "@hob/bridge-contract",
    "@hob-agent/agent-layer/agent-loop-trace",
    "@hob-agent/inbox-web/service",
    "@hob-agent/inbox-web/http",
  ]);
});

test("architecture guards keep the agent and neutral hub boundaries closed", () => {
  const agentFiles = sourceFiles(agentSourceRoot);
  const inboxFiles = sourceFiles(inboxSourceRoot);
  const hubFiles = sourceFiles(hubSourceRoot);
  const hubFilesWithTests = sourceFiles(hubSourceRoot, true);
  const artifactFiles = sourceFiles(join(hubSourceRoot, "artifact"));
  const authorityFiles = sourceFiles(join(hubSourceRoot, "authority"));
  const bridgeFiles = sourceFiles(join(hubSourceRoot, "bridge"));
  const worldFiles = sourceFiles(join(hubSourceRoot, "world"));
  const workspacePackages = [
    workspacePackage(join(repositoryRoot, "contracts")),
    workspacePackage(join(repositoryRoot, "packages", "agent-layer")),
    workspacePackage(join(repositoryRoot, "packages", "hub")),
    workspacePackage(join(repositoryRoot, "packages", "inbox-web")),
  ];
  const workspaceImportViolations: string[] = [];
  for (const owner of workspacePackages) {
    for (const file of sourceFiles(owner.directory, true)) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) {
          const resolvedImport = resolve(dirname(file), specifier);
          const target = workspacePackages.find((candidate) => candidate !== owner
            && (resolvedImport === candidate.directory || resolvedImport.startsWith(`${candidate.directory}/`)));
          if (target !== undefined) {
            workspaceImportViolations.push(`${relative(repositoryRoot, file)} reaches ${target.manifest.name} by relative path`);
          }
          continue;
        }
        const target = workspacePackages.find((candidate) => specifier === candidate.manifest.name
          || specifier.startsWith(`${candidate.manifest.name}/`));
        if (target === undefined || target === owner) continue;
        const declared = owner.manifest.dependencies?.[target.manifest.name]
          ?? owner.manifest.devDependencies?.[target.manifest.name];
        if (declared === undefined) {
          workspaceImportViolations.push(`${relative(repositoryRoot, file)} requires undeclared ${target.manifest.name}`);
        } else if (!exportedSubpath(target.manifest, specifier)) {
          workspaceImportViolations.push(`${relative(repositoryRoot, file)} reaches private ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(
    workspaceImportViolations,
    [],
    "workspace imports use declared dependencies and published package entry points",
  );

  const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts?: Readonly<Record<string, string>>;
  };
  const hubEntryRoots = [join(hubSourceRoot, "main.ts")];
  for (const command of Object.values(rootPackage.scripts ?? {})) {
    const match = /^tsx (packages\/hub\/src\/\S+\.ts)$/u.exec(command);
    if (match !== null) hubEntryRoots.push(join(repositoryRoot, match[1]));
  }
  const contractsPackage = workspacePackages.find((item) => item.manifest.name === "@hob/bridge-contract")!;
  const inboxPackage = workspacePackages.find((item) => item.manifest.name === "@hob-agent/inbox-web")!;
  assert.deepEqual(
    unreachableProductionFiles(hubSourceRoot, hubEntryRoots),
    [],
    "every Hub production module is reachable from the process or a declared CLI entry",
  );
  assert.deepEqual(
    unreachableProductionFiles(contractsPackage.directory, packageExportRoots(contractsPackage)),
    [],
    "every bridge-contract production module is reachable from a published package entry",
  );
  assert.deepEqual(
    unreachableProductionFiles(inboxPackage.directory, packageExportRoots(inboxPackage)),
    [],
    "every Inbox production module is reachable from a published package entry",
  );

  const misplacedBridgeFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:bridge-(?!credential-setup)|home-assistant-(?:adapter|bridge)|xiaomi-home-bridge|synthetic-bridge)/.test(name));
  assert.deepEqual(misplacedBridgeFiles, [], "bridge domain modules and their tests belong under src/bridge");

  const misplacedArtifactFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:artifact-|neutral-artifact)/.test(name));
  assert.deepEqual(misplacedArtifactFiles, [], "artifact domain modules and their tests belong under src/artifact");

  const misplacedAuthorityFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:action-authority-config|authority-|identity-authority|one-shot-action-)/.test(name));
  assert.deepEqual(misplacedAuthorityFiles, [], "authority domain modules and their tests belong under src/authority");

  const misplacedMediaFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:media-|music-assistant-(?!credential-setup)|home-media-)/.test(name));
  assert.deepEqual(misplacedMediaFiles, [], "media domain modules and their tests belong under src/media");

  const misplacedWorldFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:world-|home-world-|ingest-journal|ingest-properties)/.test(name));
  assert.deepEqual(misplacedWorldFiles, [], "world domain modules and their tests belong under src/world");

  const misplacedHomeFiles = readdirSync(hubSourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(?:home-(?!agent-runtime)|household-review-center-service|observation-audit-store|proposal-store|product-view-recipe-draft-store)/.test(name));
  assert.deepEqual(misplacedHomeFiles, [], "household product modules and their tests belong under src/home");

  const ignoreRules = readFileSync(join(repositoryRoot, ".gitignore"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(ignoreRules.includes("/home/"), "the runtime household workspace ignore is anchored to the repository root");
  assert.equal(ignoreRules.includes("home/"), false, "the Hub home source domain remains trackable");

  assert.deepEqual(
    violations(artifactFiles, /from ["']\.\.\/home\//, false),
    [],
    "artifact production source depends on injected proposal and review ports",
  );
  assert.deepEqual(
    violations(authorityFiles, /from ["']\.\.\/artifact\//, false),
    [],
    "authority production source uses Hub foundation identity utilities",
  );
  assert.deepEqual(
    violations(authorityFiles, /from ["']\.\.\/world\//, false),
    [],
    "authority production source owns governance policy without world implementation dependencies",
  );
  assert.deepEqual(
    violations(artifactFiles, /from ["']\.\.\/authority\/(?!authority-candidate-port\.js)/, false),
    [],
    "artifact production source reaches authority through the candidate port",
  );
  assert.deepEqual(
    violations(bridgeFiles, /from ["']\.\.\/(?:artifact|world)\//, false),
    [],
    "bridge adapters expose neutral capabilities and events without policy or projection dependencies",
  );
  assert.deepEqual(
    violations(worldFiles, /from ["']\.\.\/artifact\//, false),
    [],
    "world production source exposes neutral observations without artifact dependencies",
  );

  const cliModuleNames = [
    "bridge-credential-setup",
    "home-map-draft",
    "home-observe-once",
    "home-retention-operation",
    "home-validation",
    "model-credential-probe",
    "model-credential-setup",
    "music-assistant-credential-setup",
  ];
  for (const moduleName of cliModuleNames) {
    assert.equal(existsSync(join(hubSourceRoot, "cli", `${moduleName}.ts`)), true, `${moduleName} belongs to the CLI domain`);
    assert.equal(existsSync(join(hubSourceRoot, "cli", `${moduleName}.test.ts`)), true, `${moduleName} CLI tests stay with their command`);
  }

  assert.deepEqual(
    violations(agentFiles, /home[ -]?assistant|homeassistant|entity_id|\bHASS\b/i),
    [],
    "agent-layer production source must not depend on an ecosystem vocabulary",
  );

  const adapterImport = /\b(?:from|import)\s*(?:\(\s*)?["'][^"']*(?:home-assistant|homeassistant|xiaomi-home)[^"']*["']/i;
  const allowedProductBundle = join(hubSourceRoot, "bridge", "bridge-bundle.ts");
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
    "launch-config.ts",
  ].map((name) => join(hubSourceRoot, name)).concat(join(hubSourceRoot, "world", "home-world-service.ts"));
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
    join(agentSourceRoot, "dsh-compatibility-set.ts"),
    join(hubSourceRoot, "bridge", "synthetic-bridge.ts"),
    join(hubSourceRoot, "home-assistant-service.ts"),
    join(hubSourceRoot, "home-assistant-service.test.ts"),
    join(hubSourceRoot, "home-inbox.ts"),
    join(hubSourceRoot, "home-inbox.test.ts"),
    join(hubSourceRoot, "authority", "identity-authority.ts"),
    join(hubSourceRoot, "authority", "principal-registry.ts"),
    join(hubSourceRoot, "authority", "principal-registry.test.ts"),
    join(inboxSourceRoot, "advice-client.ts"),
    join(inboxSourceRoot, "advice-client.test.ts"),
    join(inboxSourceRoot, "inbox-styles.ts"),
  ].filter(existsSync).map((path) => relative(repositoryRoot, path));
  assert.deepEqual(removedEntries, [], "superseded contracts, re-export shims, ecosystem services, and the second runtime entry stay deleted");

  assert.equal(rootPackage.scripts?.["inbox:home"], undefined, "the product exposes one runtime entry");
  assert.match(
    String(rootPackage.scripts?.test),
    /sh tests\/typescript-test-discovery\.test\.sh/,
    "the test command verifies recursive TypeScript test discovery",
  );
  assert.match(
    String(rootPackage.scripts?.test),
    /sh tests\/run-typescript-tests\.sh/,
    "the test command runs every recursively discovered TypeScript test",
  );
  for (const [scriptName, command] of Object.entries(rootPackage.scripts ?? {})) {
    const match = /^tsx (packages\/hub\/src\/\S+\.ts)$/u.exec(String(command));
    if (match) assert.equal(existsSync(join(repositoryRoot, match[1])), true, `${scriptName} points to a tracked Hub command`);
  }

  const hubPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages", "hub", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(hubPackage.dependencies?.["@hob/bridge-contract"], "workspace:*", "Hub must declare its neutral contract dependency");
  assert.deepEqual(
    violations(hubFilesWithTests, /(?:from|import\s*\()["'][^"']*(?:\.\.\/)+contracts\//, false),
    [],
    "Hub production and test source must consume the bridge contract through its package entry point",
  );
  assert.deepEqual(
    violations(
      hubFiles,
      /export\s+(?:\{\s*(?:SqliteIngestJournal\s+as\s+IngestJournalStore|BridgeIngest\s+as\s+HomeWorldIngest|HomeAssistantBridgeAdapter\s+as\s+HomeAssistantAdapter|REQUIRED_HOME_ENV)\s*\}|const\s+IngestJournal\s*=)/,
      false,
    ),
    [],
    "Hub production source exports one canonical name for each runtime implementation",
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
