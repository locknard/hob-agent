import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const DSH_VERSION = "0.1.0-rc.7";
const REQUIRED_DSH_PACKAGES = Object.freeze([
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-code-runtime",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-compaction-tool-result-pruner",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-repeat-tool-reminder",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-persistence",
  "@deepseek-ai/dsh-session-persistence-sqlite",
  "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-tool-skill",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-typert-protocol",
  "@deepseek-ai/dsh-user-approval",
]);

function dependencyAlignmentViolations(dependencies: Readonly<Record<string, string>>): string[] {
  const expected = new Map(REQUIRED_DSH_PACKAGES.map((name) => [name, DSH_VERSION] as const));
  const violations: string[] = [];
  for (const [name, version] of expected) {
    if (dependencies[name] !== version) violations.push(`${name}: expected ${version}, received ${dependencies[name] ?? "missing"}`);
  }
  for (const name of Object.keys(dependencies).sort()) {
    if (name.startsWith("@deepseek-ai/dsh-") && !expected.has(name)) violations.push(`${name}: unregistered package`);
  }
  if (dependencies["@deepseek-ai/cordis"] !== "4.0.1") violations.push("@deepseek-ai/cordis: expected 4.0.1");
  if (dependencies["@deepseek-ai/schemastery"] !== "3.18.1") violations.push("@deepseek-ai/schemastery: expected 3.18.1");
  return violations;
}

describe("DSH dependency alignment", () => {
  it("keeps the complete official plugin family on one exact release", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    assert.deepEqual(dependencyAlignmentViolations(packageJson.dependencies ?? {}), []);
  });

  it("classifies mixed, ranged, missing, and unregistered packages", () => {
    const aligned = Object.fromEntries(REQUIRED_DSH_PACKAGES.map((name) => [name, DSH_VERSION]));
    const candidate = {
      ...aligned,
      "@deepseek-ai/cordis": "4.0.1",
      "@deepseek-ai/schemastery": "3.18.1",
      "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
      "@deepseek-ai/dsh-llm": `^${DSH_VERSION}`,
      "@deepseek-ai/dsh-future": DSH_VERSION,
    };
    delete candidate["@deepseek-ai/dsh-timeout"];

    assert.deepEqual(dependencyAlignmentViolations(candidate), [
      "@deepseek-ai/dsh-agent: expected 0.1.0-rc.7, received 0.1.0-rc.6",
      "@deepseek-ai/dsh-llm: expected 0.1.0-rc.7, received ^0.1.0-rc.7",
      "@deepseek-ai/dsh-timeout: expected 0.1.0-rc.7, received missing",
      "@deepseek-ai/dsh-future: unregistered package",
    ]);
  });
});
