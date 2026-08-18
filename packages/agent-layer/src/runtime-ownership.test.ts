import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };

test("DSH is the only Agent Runtime dependency and implementation", () => {
  assert.equal(packageJson.dependencies?.["@earendil-works/pi-agent-core"], undefined);

  const sourceDirectory = new URL("./", import.meta.url);
  const forbiddenFiles = new Set([
    "read-only-agent-service.test.ts",
    "read-only-agent-service.ts",
    "read-only-agent.test.ts",
    "read-only-agent.ts",
  ]);
  const present = readdirSync(sourceDirectory)
    .filter((file) => forbiddenFiles.has(file))
    .sort();

  assert.deepEqual(present, []);

  const productionSources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  for (const file of productionSources) {
    const source = readFileSync(new URL(file, sourceDirectory), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-agent-core/, file);
  }
});
