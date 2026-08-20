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

test("forwards the validated custom endpoint into the profile-scoped DSH probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-custom-model-probe-"));
  const values = new Map<string, string>();
  const vault = {
    read: async (reference: string) => values.get(reference),
    write: async (reference: string, value: string) => { values.set(reference, value); },
    delete: async (reference: string) => { values.delete(reference); },
  };
  await provisionPrimaryModelApiKey(directory, "custom", "private-custom-key", vault);

  const result = await probeConfiguredModelCredential({
    HOB_DATA_DIR: directory,
    HOB_MODEL: "custom/deepseek-v4-flash-0731",
    HOB_MODEL_BASE_URL: "https://models.example.test:8443/v1/",
  }, vault, async ({ profile, baseURL }) => {
    assert.equal(profile.id, "custom:primary");
    assert.equal(baseURL, "https://models.example.test:8443/v1");
    return { model: "custom/deepseek-v4-flash-0731", status: "ok", latencyMs: 15 };
  });

  assert.deepEqual(result, {
    model: "custom/deepseek-v4-flash-0731",
    status: "ok",
    latencyMs: 15,
  });
});
