import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  HomeSkillProvider,
  type HomeSkillProviderOptions,
} from "./dsh-home-skill-provider.js";

const FRONTMATTER = (name: string, description = `${name} description`) => [
  "---",
  `name: ${name}`,
  `description: ${description}`,
  "---",
].join("\n");

async function fixture(): Promise<{ directory: string; skills: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-skills-"));
  const skills = join(directory, "skills");
  await mkdir(skills);
  return { directory, skills };
}

function provider(skillsDirectory: string, overrides: Partial<HomeSkillProviderOptions> = {}): HomeSkillProvider {
  return new HomeSkillProvider(new Context(), {
    signal: new AbortController().signal,
    invalidate: () => undefined,
  }, {
    directory: skillsDirectory,
    ...overrides,
  });
}

function observedCandidates(value: Awaited<ReturnType<HomeSkillProvider["list"]>>) {
  return Array.isArray(value) ? value : value.candidates;
}

test("discovers canonical flat and bundled SKILL.md files deterministically and loads bodies on demand", async () => {
  const { directory, skills } = await fixture();
  try {
    await mkdir(join(skills, "zeta"));
    await writeFile(join(skills, "zeta", "SKILL.md"), `${FRONTMATTER("zeta")}\nzeta body`);
    await writeFile(join(skills, "alpha.md"), `${FRONTMATTER("alpha")}\nalpha body`);

    const homeProvider = provider(skills);
    const listed = await homeProvider.list({});
    const candidates = observedCandidates(listed);

    assert.deepEqual(candidates.map((candidate) => candidate.name), ["alpha", "zeta"]);
    assert.equal(candidates.every((candidate) => candidate.path === undefined), true);
    assert.equal(JSON.stringify(candidates).includes(directory), false);

    const alpha = candidates.find((candidate) => candidate.name === "alpha");
    assert.ok(alpha);
    await writeFile(join(skills, "alpha.md"), `${FRONTMATTER("alpha")}\nupdated body`);
    const loaded = await homeProvider.get(alpha, {});
    assert.equal(loaded?.content, "updated body");
    assert.deepEqual(loaded?.resourceBase, {
      kind: "opaque",
      description: "Tenant skill resources are unavailable in Phase 0",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing tenant skills directory degrades to an empty complete catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-home-skills-missing-"));
  try {
    const listed = await provider(join(directory, "skills")).list({});
    assert.deepEqual(observedCandidates(listed), []);
    assert.equal(Array.isArray(listed) || listed.complete, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects root, bundle, and file symlinks without exposing their targets", async () => {
  const { directory, skills } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "hob-home-skills-outside-"));
  const linkedRoot = join(directory, "linked-skills");
  try {
    await writeFile(join(outside, "outside.md"), `${FRONTMATTER("outside")}\noutside body`);
    await symlink(outside, linkedRoot);
    await mkdir(join(skills, "bundle"));
    await symlink(join(outside, "outside.md"), join(skills, "bundle", "SKILL.md"));
    await symlink(join(outside, "outside.md"), join(skills, "flat.md"));

    const homeProvider = provider(skills);
    const listed = await homeProvider.list({});
    assert.deepEqual(observedCandidates(listed), []);
    assert.equal(Array.isArray(listed) ? true : listed.complete, false);

    const linkedProvider = provider(linkedRoot);
    const linked = await linkedProvider.list({});
    assert.deepEqual(observedCandidates(linked), []);
    assert.equal(Array.isArray(linked) ? true : linked.complete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("enforces single-file and total discovery byte budgets, including on-demand reloads", async () => {
  const { directory, skills } = await fixture();
  try {
    const options = { maxFileBytes: 200, maxTotalBytes: 340 } satisfies Partial<HomeSkillProviderOptions>;
    await writeFile(join(skills, "a.md"), `${FRONTMATTER("a")}\n${"a".repeat(120)}`);
    await writeFile(join(skills, "b.md"), `${FRONTMATTER("b")}\n${"b".repeat(120)}`);
    await writeFile(join(skills, "too-large.md"), `${FRONTMATTER("too-large")}\n${"x".repeat(200)}`);

    const homeProvider = provider(skills, options);
    const listed = await homeProvider.list({});
    const candidates = observedCandidates(listed);
    assert.equal(Array.isArray(listed) ? true : listed.complete, false);
    assert.deepEqual(candidates.map((candidate) => candidate.name), ["a", "b"]);

    const a = candidates.find((candidate) => candidate.name === "a");
    assert.ok(a);
    await writeFile(join(skills, "a.md"), `${FRONTMATTER("a")}\n${"a".repeat(200)}`);
    assert.equal(await homeProvider.get(a, {}), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omits every candidate participating in a duplicate declared skill name", async () => {
  const { directory, skills } = await fixture();
  try {
    await mkdir(join(skills, "first"));
    await writeFile(join(skills, "first", "SKILL.md"), `${FRONTMATTER("duplicate")}\nfirst`);
    await writeFile(join(skills, "second.md"), `${FRONTMATTER("duplicate")}\nsecond`);
    await writeFile(join(skills, "safe.md"), `${FRONTMATTER("safe")}\nsafe`);

    const listed = await provider(skills).list({});
    assert.deepEqual(observedCandidates(listed).map((candidate) => candidate.name), ["safe"]);
    assert.equal(Array.isArray(listed) ? true : listed.complete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not admit legacy invocation fields that could misstate model or user policy", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "legacy.md"), [
      "---",
      "name: legacy",
      "description: legacy",
      "modelInvocable: true",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "allowed.md"), [
      "---",
      "name: allowed",
      "description: allowed",
      "disable-model-invocation: true",
      "user-invocable: false",
      "---",
      "body",
    ].join("\n"));

    const candidates = observedCandidates(await provider(skills).list({}));
    assert.deepEqual(candidates.map((candidate) => candidate.name), ["allowed"]);
    assert.deepEqual(candidates[0]?.invocation, { modelInvocable: false, userInvocable: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a standard bounded metadata object without exposing a filesystem path", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "metadata.md"), [
      "---",
      "name: metadata",
      "description: metadata skill",
      "metadata:",
      "  owner: household",
      "  revision: 1",
      "---",
      "metadata body",
    ].join("\n"));
    const homeProvider = provider(skills);
    const candidates = observedCandidates(await homeProvider.list({}));
    assert.equal(candidates.length, 1);
    const loaded = await homeProvider.get(candidates[0]!, {});
    assert.deepEqual(loaded?.metadata, { owner: "household", revision: 1 });
    assert.equal(loaded?.path, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown and duplicate top-level frontmatter fields", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "unknown.md"), [
      "---",
      "name: unknown",
      "description: unknown",
      "tool: create-anything",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "duplicate.md"), [
      "---",
      "name: first-name",
      "name: second-name",
      "description: duplicate",
      "---",
      "body",
    ].join("\n"));

    const candidates = observedCandidates(await provider(skills).list({}));
    assert.deepEqual(candidates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects indentation outside the metadata object", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "indented.md"), [
      "---",
      "name: indented",
      "  description: ignored-but-dangerous",
      "description: actual description",
      "---",
      "body",
    ].join("\n"));

    assert.deepEqual(observedCandidates(await provider(skills).list({})), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects indented comments outside the metadata object", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "indented-comment.md"), [
      "---",
      "name: indented-comment",
      "description: indented comment",
      "  # this is not a metadata entry",
      "---",
      "body",
    ].join("\n"));

    assert.deepEqual(observedCandidates(await provider(skills).list({})), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed or duplicate metadata entries", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "malformed.md"), [
      "---",
      "name: malformed",
      "description: malformed",
      "metadata: [not-an-object]",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "nested.md"), [
      "---",
      "name: nested",
      "description: nested",
      "metadata:",
      "  owner: first",
      "  owner: second",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "broken.md"), [
      "---",
      "name: broken",
      "description: broken",
      "metadata:",
      "  not-a-mapping-entry",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "inline-duplicate.md"), [
      "---",
      "name: inline-duplicate",
      "description: inline duplicate",
      'metadata: {"owner":"first","owner":"second"}',
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "null-metadata.md"), [
      "---",
      "name: null-metadata",
      "description: null metadata",
      "metadata: null",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "tab-metadata.md"), [
      "---",
      "name: tab-metadata",
      "description: tab metadata",
      "metadata:",
      "  \towner: household",
      "---",
      "body",
    ].join("\n"));

    assert.deepEqual(observedCandidates(await provider(skills).list({})), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects repeated top-level metadata blocks", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "repeated-metadata.md"), [
      "---",
      "name: repeated-metadata",
      "description: repeated metadata",
      "metadata:",
      "  owner: first",
      "metadata:",
      "  revision: second",
      "---",
      "body",
    ].join("\n"));

    assert.deepEqual(observedCandidates(await provider(skills).list({})), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires non-empty name and description but permits an explicitly empty body", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "empty-name.md"), [
      "---",
      "name:",
      "description: missing name",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "empty-description.md"), [
      "---",
      "name: missing-description",
      "description:",
      "---",
      "body",
    ].join("\n"));
    await writeFile(join(skills, "empty-body.md"), [
      "---",
      "name: empty-body",
      "description: body may be empty",
      "---",
    ].join("\n"));

    const candidates = observedCandidates(await provider(skills).list({}));
    assert.deepEqual(candidates.map((candidate) => candidate.name), ["empty-body"]);
    const loaded = await provider(skills).get(candidates[0]!, {});
    assert.equal(loaded?.content, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a candidate locator scoped when a caller supplies a traversal path", async () => {
  const { directory, skills } = await fixture();
  try {
    await writeFile(join(skills, "safe.md"), `${FRONTMATTER("safe")}\nsafe`);
    const homeProvider = provider(skills);
    const listed = observedCandidates(await homeProvider.list({}));
    const candidate = listed[0];
    assert.ok(candidate);
    const unsafe = {
      ...candidate,
      locator: { relativePath: "../outside.md", expectedName: candidate.name },
    };
    assert.equal(await homeProvider.get(unsafe, {}), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
