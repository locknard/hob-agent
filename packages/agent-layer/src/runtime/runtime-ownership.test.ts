import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };

const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
}

test("DSH is the only Agent Runtime dependency and implementation", () => {
  assert.equal(packageJson.dependencies?.["@earendil-works/pi-agent-core"], undefined);
  assert.equal(packageJson.dependencies?.["@earendil-works/pi-ai"], undefined);

  const forbiddenFiles = new Set([
    "read-only-agent-service.test.ts",
    "read-only-agent-service.ts",
    "read-only-agent.test.ts",
    "read-only-agent.ts",
    "provider-login.test.ts",
    "provider-login.ts",
    "pi-credential-store.test.ts",
    "pi-credential-store.ts",
    "dsh-pi-home-agent.test.ts",
    "dsh-pi-home-agent.ts",
    "oauth-refresh-coordinator.test.ts",
    "oauth-refresh-coordinator.ts",
    "profile-credential-runtime.test.ts",
    "profile-credential-runtime.ts",
  ]);
  const allSources = sourceFiles(sourceDirectory);
  const present = allSources
    .filter((file) => forbiddenFiles.has(basename(file)))
    .map((file) => relative(sourceDirectory, file))
    .sort();

  assert.deepEqual(present, []);

  const productionSources = allSources
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  for (const file of productionSources) {
    const source = readFileSync(file, "utf8");
    const sourcePath = relative(sourceDirectory, file);
    assert.doesNotMatch(source, /@earendil-works\/pi-agent-core/, sourcePath);
    assert.doesNotMatch(source, /@earendil-works\/pi-ai/, sourcePath);
  }
});
