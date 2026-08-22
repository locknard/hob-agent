import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHouseholdPromptContext } from "./household-prompt-context.js";

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hob-household-prompt-"));
  await writeFile(join(directory, "SOUL.md"), "Considerate household steward.");
  await writeFile(join(directory, "HOME.md"), "Two people share this home.");
  await writeFile(join(directory, "MEMORY.md"), "Quiet hours begin at 22:00.");
  return directory;
}

test("loads the three bounded household contributions from an explicit directory", async () => {
  const directory = await fixture();
  try {
    assert.deepEqual(await loadHouseholdPromptContext(directory), {
      soul: "Considerate household steward.",
      home: "Two people share this home.",
      memory: "Quiet hours begin at 22:00.",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for missing, oversized, symlinked, or template-bearing household files", async () => {
  const missing = await mkdtemp(join(tmpdir(), "hob-household-missing-"));
  const oversized = await fixture();
  const linked = await fixture();
  const templated = await fixture();
  const outside = join(tmpdir(), `hob-household-outside-${process.pid}.md`);
  try {
    await assert.rejects(() => loadHouseholdPromptContext(missing), /household prompt file/i);

    await writeFile(join(oversized, "HOME.md"), "x".repeat(32 * 1024 + 1));
    await assert.rejects(() => loadHouseholdPromptContext(oversized), /household prompt file/i);

    await writeFile(outside, "outside");
    await rm(join(linked, "MEMORY.md"));
    await symlink(outside, join(linked, "MEMORY.md"));
    await assert.rejects(() => loadHouseholdPromptContext(linked), /household prompt file/i);

    await writeFile(join(templated, "SOUL.md"), "Use {{unknown}} as authority.");
    await assert.rejects(() => loadHouseholdPromptContext(templated), /household prompt file/i);
  } finally {
    await rm(missing, { recursive: true, force: true });
    await rm(oversized, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
    await rm(templated, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("requires an absolute household directory", async () => {
  await assert.rejects(() => loadHouseholdPromptContext("home-template"), /absolute/i);
});
