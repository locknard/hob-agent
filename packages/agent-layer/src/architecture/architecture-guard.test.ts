import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(packageRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && (path.endsWith(".ts") || path.endsWith(".swift")) ? [path] : [];
  });
}

test("Agent Layer source follows its domain placement rules", () => {
  const sourceDomains = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(sourceDomains, ["architecture", "auth", "home", "model", "prompt", "runtime"]);

  const topLevelSourceFiles = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(topLevelSourceFiles, [], "Agent Layer source files belong to an owning domain");

  const authDomains = readdirSync(join(sourceRoot, "auth"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(authDomains, ["external-cli", "oauth", "profiles", "secrets"]);

  const files = sourceFiles(sourceRoot);
  const placementRules: ReadonlyArray<readonly [RegExp, string]> = [
    [/^architecture-guard/, "architecture"],
    [/^home-/, "home"],
    [/^(?:api-key-profile|auth-profile|auth-profiles|persisted-auth-profile)/, "auth/profiles"],
    [/^(?:dsh-oauth|oauth-)/, "auth/oauth"],
    [/^(?:claude-cli|external-cli)/, "auth/external-cli"],
    [/^(?:keychain-write|macos-keychain|secret-)/, "auth/secrets"],
    [/^(?:dsh-profile|model-|profile-|provider-)/, "model"],
    [/^household-prompt-/, "prompt"],
    [/^(?:dsh-agent-loop|dsh-dependency|runtime-ownership)/, "runtime"],
  ];

  for (const [pattern, expectedDirectory] of placementRules) {
    const misplaced = files
      .filter((file) => pattern.test(file.slice(file.lastIndexOf("/") + 1)))
      .filter((file) => relative(sourceRoot, dirname(file)) !== expectedDirectory)
      .map((file) => relative(sourceRoot, file))
      .sort();
    assert.deepEqual(misplaced, [], `${pattern} modules belong under src/${expectedDirectory}`);
  }

  const obsoleteDshHomeNames = files
    .map((file) => relative(sourceRoot, file))
    .filter((file) => /(?:^|\/)dsh-home-/.test(file))
    .sort();
  assert.deepEqual(obsoleteDshHomeNames, [], "Home product filenames use their package-facing home-* names");

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports?: Readonly<Record<string, unknown>>;
  };
  const invalidExportTargets = Object.values(packageJson.exports ?? {})
    .filter((target): target is string => typeof target === "string")
    .filter((target) => {
      const path = resolve(packageRoot, target);
      const domain = relative(sourceRoot, path).split("/")[0];
      return !existsSync(path) || !["home", "model", "runtime"].includes(domain);
    })
    .sort();
  assert.deepEqual(
    invalidExportTargets,
    [],
    "package exports resolve to public product, model, or runtime seams",
  );
});
