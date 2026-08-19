import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  probeConfiguredModelCredential,
} from "./model-credential-probe.js";
import { provisionPrimaryModelApiKey } from "./model-credential-profile.js";

test("probes the explicitly selected profile and returns metadata only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-model-probe-"));
  const values = new Map<string, string>();
  const vault = {
    read: async (reference: string) => values.get(reference),
    write: async (reference: string, value: string) => { values.set(reference, value); },
    delete: async (reference: string) => { values.delete(reference); },
  };
  await provisionPrimaryModelApiKey(directory, "deepseek", "private-key", vault);
  let selectedProfileId: string | undefined;

  const result = await probeConfiguredModelCredential({
    HOB_DATA_DIR: directory,
    HOB_MODEL: "deepseek/deepseek-v4-flash",
  }, vault, async ({ profile }) => {
    selectedProfileId = profile.id;
    return { model: "deepseek/deepseek-v4-flash", status: "ok", latencyMs: 12 };
  });

  assert.equal(selectedProfileId, "deepseek:primary");
  assert.deepEqual(result, { model: "deepseek/deepseek-v4-flash", status: "ok", latencyMs: 12 });
  assert.equal(JSON.stringify(result).includes("private-key"), false);
});
