import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

import { DshProfileCredentialProvider } from "./dsh-profile-credential-provider.js";

test("resolves only explicit DSH aliases through selected SecretRefs per operation", async () => {
  const values: Record<string, string> = {
    "keychain:hob-agent/deepseek:primary": "first-key",
  };
  const reads: string[] = [];
  const ctx = new Context();
  const fiber = await ctx.plugin(DshProfileCredentialProvider, {
    references: { DEEPSEEK_API_KEY: "keychain:hob-agent/deepseek:primary" },
    vault: {
      read: async (reference: string) => {
        reads.push(reference);
        return values[reference];
      },
    },
  });

  assert.deepEqual(await ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY")), {
    value: "first-key",
    source: "profile",
  });
  values["keychain:hob-agent/deepseek:primary"] = "rotated-key";
  assert.equal((await ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY")))?.value, "rotated-key");
  assert.equal(await ctx.credentials.resolve(credentialRef("OPENAI_API_KEY")), undefined);
  assert.deepEqual(reads, [
    "keychain:hob-agent/deepseek:primary",
    "keychain:hob-agent/deepseek:primary",
  ]);

  await fiber.dispose();
  await ctx.fiber.dispose();
});

test("describes current credential availability and remains read-only", async () => {
  let reads = 0;
  let value: string | undefined = "secret";
  const ctx = new Context();
  await ctx.plugin(DshProfileCredentialProvider, {
    references: { DEEPSEEK_API_KEY: "keychain:hob-agent/deepseek:primary" },
    vault: { read: async () => { reads += 1; return value; } },
  });
  const ref = credentialRef("DEEPSEEK_API_KEY");

  assert.deepEqual(await ctx.credentials.describe(ref), {
    configured: true,
    source: "profile",
    writable: false,
  });
  value = undefined;
  assert.deepEqual(await ctx.credentials.describe(ref), {
    configured: false,
    writable: false,
  });
  assert.deepEqual(await ctx.credentials.describe(credentialRef("OPENAI_API_KEY")), {
    configured: false,
    writable: false,
  });
  assert.equal(reads, 2);
  await assert.rejects(ctx.credentials.set(ref, "replacement"), /read-only/);
  await assert.rejects(ctx.credentials.unset(ref), /read-only/);
  assert.equal(reads, 2);

  await ctx.fiber.dispose();
});
