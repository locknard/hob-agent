import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ACTION_AUTHORITY_CONFIG_FILE,
  actionAuthorityConfigurationPath,
  loadActionAuthorityConfiguration,
  writeActionAuthorityConfiguration,
} from "./action-authority-config.js";

const VALID = {
  version: 2,
  bindings: [
    { hwCapabilityId: "hwc-curtain-level", bridgeId: "ha-main", approved: true, policyClass: "confirmation", revision: 3 },
    { hwCapabilityId: "hwc-lamp", bridgeId: "xiaomi-main", approved: false, policyClass: "direct", revision: 1 },
  ],
};

async function withDataDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hob-action-authority-"));
  await chmod(directory, 0o700);
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeConfig(directory: string, raw: string): Promise<string> {
  const path = actionAuthorityConfigurationPath(directory);
  await writeFile(path, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return path;
}

async function writeJson(directory: string, value: unknown): Promise<string> {
  return writeConfig(directory, JSON.stringify(value));
}

test("returns an empty coordinator map for the missing fixed-path file without creating it", async () => {
  await withDataDirectory(async (directory) => {
    assert.equal(actionAuthorityConfigurationPath(directory), join(directory, ACTION_AUTHORITY_CONFIG_FILE));
    assert.deepEqual(await loadActionAuthorityConfiguration(directory), {});
    await assert.rejects(() => lstat(actionAuthorityConfigurationPath(directory)), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), []);
  });
});

test("loads strict bindings into opaque coordinator configurations", async () => {
  await withDataDirectory(async (directory) => {
    await writeJson(directory, VALID);
    const result = await loadActionAuthorityConfiguration(directory);

    assert.deepEqual(Object.keys(result), ["hwc-curtain-level", "hwc-lamp"]);
    assert.equal(result["hwc-curtain-level"]?.bridgeId, "ha-main");
    assert.equal(result["hwc-curtain-level"]?.approved, true);
    assert.equal(result["hwc-curtain-level"]?.policyClass, "confirmation");
    assert.equal(result["hwc-curtain-level"]?.configRevision, 3);
    assert.match(result["hwc-curtain-level"]?.configIdentity ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(result["hwc-lamp"]?.approved, false);
    assert.equal(result["hwc-lamp"]?.policyClass, "direct");
    assert.equal("hwCapabilityId" in (result["hwc-curtain-level"] ?? {}), false);
    assert.equal("revision" in (result["hwc-curtain-level"] ?? {}), false);
    assert.equal("nativeId" in (result["hwc-curtain-level"] ?? {}), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result["hwc-curtain-level"]!), true);
  });
});

test("loads an explicit policy class and binds it into the canonical identity", async () => {
  await withDataDirectory(async (directory) => {
    await writeJson(directory, {
      version: 2,
      bindings: [{
        hwCapabilityId: "hwc-water-valve",
        bridgeId: "ha-main",
        approved: true,
        policyClass: "administrator",
        revision: 1,
      }],
    });
    const administrator = await loadActionAuthorityConfiguration(directory);
    assert.equal(administrator["hwc-water-valve"]?.policyClass, "administrator");

    await rm(actionAuthorityConfigurationPath(directory));
    await writeJson(directory, {
      version: 2,
      bindings: [{
        hwCapabilityId: "hwc-water-valve",
        bridgeId: "ha-main",
        approved: true,
        policyClass: "confirmation",
        revision: 2,
      }],
    });
    const confirmation = await loadActionAuthorityConfiguration(directory);
    assert.notEqual(
      confirmation["hwc-water-valve"]?.configIdentity,
      administrator["hwc-water-valve"]?.configIdentity,
    );
  });
});

test("keeps per-capability identity stable across entry ordering and changes it only for bridge or approval", async () => {
  await withDataDirectory(async (directory) => {
    await writeJson(directory, VALID);
    const first = await loadActionAuthorityConfiguration(directory);
    const firstCurtain = first["hwc-curtain-level"]!;
    const firstLamp = first["hwc-lamp"]!;

    await rm(actionAuthorityConfigurationPath(directory));
    await writeJson(directory, {
      version: 2,
      bindings: [
        { hwCapabilityId: "hwc-lamp", bridgeId: "xiaomi-main", approved: false, policyClass: "direct", revision: 99 },
        { hwCapabilityId: "hwc-curtain-level", bridgeId: "ha-main", approved: true, policyClass: "confirmation", revision: 4 },
      ],
    });
    const reordered = await loadActionAuthorityConfiguration(directory);
    assert.equal(reordered["hwc-curtain-level"]?.configIdentity, firstCurtain.configIdentity);
    assert.equal(reordered["hwc-curtain-level"]?.configRevision, 4);
    assert.equal(reordered["hwc-lamp"]?.configIdentity, firstLamp.configIdentity);

    await rm(actionAuthorityConfigurationPath(directory));
    await writeJson(directory, {
      version: 2,
      bindings: [
        { hwCapabilityId: "hwc-curtain-level", bridgeId: "ha-secondary", approved: true, policyClass: "confirmation", revision: 5 },
        { hwCapabilityId: "hwc-lamp", bridgeId: "xiaomi-main", approved: false, policyClass: "direct", revision: 1 },
      ],
    });
    const rebound = await loadActionAuthorityConfiguration(directory);
    assert.notEqual(rebound["hwc-curtain-level"]?.configIdentity, firstCurtain.configIdentity);
    assert.equal(rebound["hwc-lamp"]?.configIdentity, firstLamp.configIdentity);

    await rm(actionAuthorityConfigurationPath(directory));
    await writeJson(directory, {
      version: 2,
      bindings: [
        { hwCapabilityId: "hwc-curtain-level", bridgeId: "ha-main", approved: false, policyClass: "confirmation", revision: 6 },
        { hwCapabilityId: "hwc-lamp", bridgeId: "xiaomi-main", approved: false, policyClass: "direct", revision: 1 },
      ],
    });
    const revoked = await loadActionAuthorityConfiguration(directory);
    assert.notEqual(revoked["hwc-curtain-level"]?.configIdentity, firstCurtain.configIdentity);
    assert.equal(revoked["hwc-lamp"]?.configIdentity, firstLamp.configIdentity);
  });
});

test("rejects malformed, duplicate, unknown, oversized, and route-bearing content without echoing it", async () => {
  await withDataDirectory(async (directory) => {
    const invalidInputs = [
      "{\"version\":1,\"version\":1,\"bindings\":[]}",
      JSON.stringify({ version: 1, bindings: [] }),
      JSON.stringify({ version: 2, bindings: [], extra: "must-not-echo" }),
      JSON.stringify({ version: 2, bindings: [{ hwCapabilityId: "hwc-a", bridgeId: "ha-a", approved: true, policyClass: "direct", revision: 0 }] }),
      JSON.stringify({ version: 2, bindings: [{ hwCapabilityId: "hwc-a", bridgeId: "ha-a", approved: true, policyClass: "direct", revision: 1, route: "secret-route" }] }),
      JSON.stringify({ version: 2, bindings: [{ hwCapabilityId: "hwc-a", bridgeId: "ha-a", approved: true, policyClass: "direct", revision: 1 }, { hwCapabilityId: "hwc-a", bridgeId: "ha-b", approved: true, policyClass: "direct", revision: 2 }] }),
      JSON.stringify({ version: 2, bindings: [{ hwCapabilityId: "hwc-a", bridgeId: "ha-a", approved: true, revision: 1 }] }),
      JSON.stringify({ version: 2, bindings: [{ hwCapabilityId: "hwc-a", bridgeId: "ha-a", approved: true, policyClass: "observe", revision: 1 }] }),
      "not-json",
      "x".repeat(65 * 1024),
    ];

    for (const raw of invalidInputs) {
      await rm(actionAuthorityConfigurationPath(directory), { force: true });
      await writeConfig(directory, raw);
      await assert.rejects(
        () => loadActionAuthorityConfiguration(directory),
        (error: unknown) => error instanceof Error
          && /action authority configuration/i.test(error.message)
          && !error.message.includes("must-not-echo")
          && !error.message.includes("secret-route"),
      );
    }
  });
});

test("rejects invalid identifiers, revisions, and security-shaped fields", async () => {
  await withDataDirectory(async (directory) => {
    const invalidEntries = [
      { hwCapabilityId: "", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "hwc-a", bridgeId: " ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "hwc-a\nforged", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "hwc/a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "__proto__", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "https://native.invalid", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1 },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1.5 },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: Number.MAX_SAFE_INTEGER + 1 },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1, nativeId: "native-secret" },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1, schema: "ha.cover" },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1, credential: "token" },
      { hwCapabilityId: "hwc-a", bridgeId: "ha-main", approved: true, policyClass: "direct", revision: 1, registrationGeneration: 3 },
    ];
    for (const entry of invalidEntries) {
      await rm(actionAuthorityConfigurationPath(directory), { force: true });
      await writeJson(directory, { version: 2, bindings: [entry] });
      await assert.rejects(() => loadActionAuthorityConfiguration(directory), /action authority configuration/i);
    }
  });
});

test("fails closed for symlinked, wide, and non-regular filesystem objects", async () => {
  await withDataDirectory(async (directory) => {
    const filePath = actionAuthorityConfigurationPath(directory);
    const targetDirectory = `${directory}-target`;
    await mkdir(targetDirectory, { mode: 0o700 });
    await chmod(targetDirectory, 0o700);
    const linkedDirectory = `${directory}-linked`;
    await symlink(targetDirectory, linkedDirectory);
    await assert.rejects(() => loadActionAuthorityConfiguration(linkedDirectory), /action authority configuration/i);

    await writeJson(directory, VALID);
    await chmod(directory, 0o750);
    await assert.rejects(() => loadActionAuthorityConfiguration(directory), /action authority configuration/i);
    await chmod(directory, 0o700);

    await chmod(filePath, 0o640);
    await assert.rejects(() => loadActionAuthorityConfiguration(directory), /action authority configuration/i);
    await rm(filePath);
    await mkdir(filePath, { mode: 0o700 });
    await assert.rejects(() => loadActionAuthorityConfiguration(directory), /action authority configuration/i);
    await rm(filePath, { recursive: true });

    const targetFile = `${directory}-target.json`;
    await writeFile(targetFile, JSON.stringify(VALID), { encoding: "utf8", mode: 0o600 });
    await chmod(targetFile, 0o600);
    await symlink(targetFile, filePath);
    await assert.rejects(() => loadActionAuthorityConfiguration(directory), /action authority configuration/i);
    await rm(linkedDirectory, { force: true });
    await rm(targetDirectory, { recursive: true, force: true });
    await rm(targetFile, { force: true });
  });
});

test("fails closed when a present configuration disappears before its descriptor is opened", async () => {
  await withDataDirectory(async (directory) => {
    const path = await writeJson(directory, VALID);
    await assert.rejects(
      () => loadActionAuthorityConfiguration(directory, { afterFileMetadata: () => rm(path) }),
      /action authority configuration/i,
    );
  });
});

test("does not expose file content or provide mutation methods", async () => {
  await withDataDirectory(async (directory) => {
    await writeJson(directory, VALID);
    const config = await loadActionAuthorityConfiguration(directory);
    assert.equal(JSON.stringify(config).includes("ha-main"), true);
    assert.equal(JSON.stringify(config).includes("native"), false);
    assert.equal("write" in config, false);
    assert.equal("watch" in config, false);
    assert.equal(constants.O_NOFOLLOW > 0, true);
    assert.equal((await readFile(actionAuthorityConfigurationPath(directory), "utf8")).includes("ha-main"), true);
  });
});

test("writes the onboarding-selected action classes atomically into the canonical private source", async () => {
  await withDataDirectory(async (directory) => {
    const projected = writeActionAuthorityConfiguration(actionAuthorityConfigurationPath(directory), [{
      hwCapabilityId: "hwc-lamp",
      bridgeId: "ha-main",
      approved: true,
      policyClass: "direct",
      revision: 1,
    }]);
    assert.equal(projected["hwc-lamp"]?.policyClass, "direct");
    assert.equal(projected["hwc-lamp"]?.approved, true);
    assert.deepEqual(await loadActionAuthorityConfiguration(directory), projected);
    assert.equal((await lstat(actionAuthorityConfigurationPath(directory))).mode & 0o777, 0o600);
  });
});
