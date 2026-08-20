import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createArtifactRevision,
  type ArtifactRef,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import {
  ArtifactRegistry,
} from "./artifact-registry.js";
import {
  AuthorityCandidateRegistry,
  type AuthorityCandidateResolveInput,
} from "./authority-candidate-registry.js";
import {
  ArtifactAuthorityProducer,
  ArtifactAuthorityProducerError,
  type AuthorityBindingInputPort,
  type AuthorityFreshWorldCut,
} from "./artifact-authority-producer.js";

const createdAt = "2026-08-20T01:00:00.000Z";
const bindingIdentity = `sha256:${"1".repeat(64)}`;
const configurationIdentity = `sha256:${"2".repeat(64)}`;

const freshWatermark = {
  bridgeId: "bridge-authority-fixture",
  epochId: "epoch-authority-fixture",
  lastSeq: 42,
  lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
  freshness: "fresh" as const,
  gapCount: 0,
};

function resolveInput(overrides: Partial<AuthorityCandidateResolveInput> = {}): AuthorityCandidateResolveInput {
  return {
    hwCapabilityId: "hwc-cover-1",
    knownCapability: true,
    configured: true,
    approved: true,
    available: true,
    bindingIdentity,
    configurationIdentity,
    registrationGeneration: 3,
    ...overrides,
  };
}

function deviceContent(target = "hwc-cover-1"): ArtifactRevision["content"] {
  return {
    trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
    conditions: [],
    actions: [{ kind: "set_level", target: { hwCapabilityId: target }, value: 0.65 }],
    rollback: { kind: "restore_previous_state", target: { hwCapabilityId: target }, maxAgeSeconds: 900 },
    postconditions: [{
      kind: "capability_value",
      source: { hwCapabilityId: target },
      operator: "equals",
      value: 0.65,
      withinSeconds: 120,
    }],
  };
}

function notifyContent(): ArtifactRevision["content"] {
  return {
    trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "08:00" },
    conditions: [],
    actions: [{ kind: "notify_local", message: "Review the household note." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
}

function artifact(content = deviceContent()): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-authority-fixture",
    revision: 1,
    title: "Authority fixture",
    summary: "A bounded authority assessment fixture.",
    sourceProposal: { proposalId: "proposal-authority-fixture", proposalRevision: 2 },
    content,
    createdAt,
  });
}

function ref(value: ArtifactRevision): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

class StubBindingInput implements AuthorityBindingInputPort {
  readonly calls: Array<{ artifact: ArtifactRef; hwCapabilityIds: readonly string[] }> = [];
  constructor(public cut: AuthorityFreshWorldCut) {}

  readFreshWorldCut(input: { artifact: ArtifactRef; hwCapabilityIds: readonly string[] }): AuthorityFreshWorldCut {
    this.calls.push(input);
    return this.cut;
  }
}

function cut(input: AuthorityCandidateResolveInput = resolveInput()): AuthorityFreshWorldCut {
  return {
    capturedAt: createdAt,
    watermarks: [freshWatermark],
    bindings: [{
      hwCapabilityId: input.hwCapabilityId,
      resolveInput: input,
      watermarkBridgeIds: [freshWatermark.bridgeId],
    }],
  };
}

interface Environment {
  readonly producer: ArtifactAuthorityProducer;
  readonly artifactRegistry: ArtifactRegistry;
  readonly authorityRegistry: AuthorityCandidateRegistry;
  readonly bindingInput: StubBindingInput;
  readonly ref: ArtifactRef;
  readonly close: () => void;
}

function environment(content = deviceContent()): Environment {
  const artifactRegistry = new ArtifactRegistry({ path: ":memory:", now: () => createdAt });
  const authorityRegistry = new AuthorityCandidateRegistry({ path: ":memory:", now: () => createdAt });
  const stored = artifactRegistry.createDraft({
    artifact: artifact(content),
    idempotencyKey: "artifact-authority-fixture:v1",
  });
  const bindingInput = new StubBindingInput(cut());
  const producer = new ArtifactAuthorityProducer({
    artifacts: artifactRegistry,
    authority: authorityRegistry,
    bindingInput,
  });
  return {
    producer,
    artifactRegistry,
    authorityRegistry,
    bindingInput,
    ref: ref(stored.artifact),
    close: () => {
      authorityRegistry.close();
      artifactRegistry.close();
    },
  };
}

test("re-reads the immutable artifact, resolves the canonical target once, and persists a neutral assessment", () => {
  const env = environment();
  try {
    const entry = env.producer.produce(env.ref);

    assert.equal(entry.kind, "authority-assessment");
    assert.equal(entry.artifact.artifactId, env.ref.artifactId);
    assert.deepEqual(entry.assessment.candidates.map((candidate) => candidate.hwCapabilityId), ["hwc-cover-1"]);
    assert.equal(entry.assessment.candidates.length, 1);
    assert.equal(entry.assessment.checkedWatermarks[0]?.bridgeId, freshWatermark.bridgeId);
    assert.equal(env.bindingInput.calls.length, 1);
    assert.deepEqual(env.bindingInput.calls[0], {
      artifact: env.ref,
      hwCapabilityIds: ["hwc-cover-1"],
    });
    assert.equal(JSON.stringify(entry).includes("bindingIdentity"), false);
    assert.equal(JSON.stringify(entry).includes("nativeId"), false);
    assert.equal(JSON.stringify(entry).includes("route"), false);
  } finally {
    env.close();
  }
});

test("deduplicates repeated device-action targets before candidate resolution", () => {
  const base = deviceContent();
  const env = environment({
    ...base,
    actions: [...base.actions, { ...base.actions[0]! }],
  });
  try {
    env.producer.produce(env.ref);
    assert.deepEqual(env.bindingInput.calls[0]?.hwCapabilityIds, ["hwc-cover-1"]);
  } finally {
    env.close();
  }
});

test("persists an explicit empty authority assessment for notify-only artifacts", () => {
  const env = environment(notifyContent());
  try {
    env.bindingInput.cut = { capturedAt: createdAt, watermarks: [freshWatermark], bindings: [] };
    const entry = env.producer.produce(env.ref);

    assert.equal(entry.kind, "authority-assessment");
    assert.deepEqual(entry.assessment.candidates, []);
    assert.equal(env.bindingInput.calls.length, 1);
    assert.deepEqual(env.bindingInput.calls[0]?.hwCapabilityIds, []);
  } finally {
    env.close();
  }
});

test("accepts only an ArtifactRef and never caller candidates, watermarks, or routes", () => {
  const env = environment();
  try {
    for (const extra of [
      { candidates: [], checkedWatermarks: [] },
      { route: "bridge-route", bridgeId: "bridge-a", nativeId: "entity.cover" },
    ]) {
      assert.throws(
        () => env.producer.produce({ ...env.ref, ...extra } as never),
        (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "invalid_input",
      );
    }
    assert.throws(
      () => env.producer.produce({ ...env.ref, contentHash: `sha256:${"f".repeat(64)}` }),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "artifact_not_found",
    );
    assert.equal(env.bindingInput.calls.length, 0);
  } finally {
    env.close();
  }
});

test("fails closed for an incomplete or stale fresh-world cut before resolving authority", () => {
  const env = environment();
  try {
    env.bindingInput.cut = {
      capturedAt: createdAt,
      watermarks: [{ ...freshWatermark, freshness: "stale", gapCount: 1 }],
      bindings: cut().bindings,
    };
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "invalid_world_cut",
    );

    env.bindingInput.cut = { capturedAt: createdAt, watermarks: [freshWatermark], bindings: [] };
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "invalid_world_cut",
    );
  } finally {
    env.close();
  }
});

test("fails closed when a target binding is unknown or does not match the artifact target", () => {
  const env = environment();
  try {
    env.bindingInput.cut = cut(resolveInput({ knownCapability: false }));
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "authority_unavailable",
    );

    env.bindingInput.cut = cut({
      ...resolveInput(),
      route: "must-not-cross" as never,
    } as never);
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "invalid_world_cut",
    );

    env.bindingInput.cut = cut(resolveInput({ hwCapabilityId: "hwc-other" }));
    assert.throws(
      () => env.producer.produce(env.ref),
      (error: unknown) => error instanceof ArtifactAuthorityProducerError && error.code === "invalid_world_cut",
    );
  } finally {
    env.close();
  }
});

test("replays the same assessment after registry restart and does not include unrelated capability identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-artifact-authority-producer-"));
  const artifactPath = join(directory, "artifacts.sqlite");
  const authorityPath = join(directory, "authority.sqlite");
  try {
    const artifacts = new ArtifactRegistry({ path: artifactPath, now: () => createdAt });
    const stored = artifacts.createDraft({ artifact: artifact(), idempotencyKey: "artifact-authority-restart:v1" });
    const firstAuthority = new AuthorityCandidateRegistry({ path: authorityPath, now: () => createdAt });
    const firstBinding = new StubBindingInput(cut());
    const firstProducer = new ArtifactAuthorityProducer({
      artifacts,
      authority: firstAuthority,
      bindingInput: firstBinding,
    });
    const first = firstProducer.produce(ref(stored.artifact));
    firstAuthority.resolve({
      ...resolveInput({
        hwCapabilityId: "hwc-unrelated",
        bindingIdentity: `sha256:${"3".repeat(64)}`,
        configurationIdentity: `sha256:${"4".repeat(64)}`,
      }),
    });
    const second = firstProducer.produce(ref(stored.artifact));
    assert.deepEqual(second, first);
    firstAuthority.close();
    artifacts.close();

    const reopenedArtifacts = new ArtifactRegistry({ path: artifactPath, now: () => "2026-08-20T02:00:00.000Z" });
    const reopenedAuthority = new AuthorityCandidateRegistry({ path: authorityPath, now: () => "2026-08-20T02:00:00.000Z" });
    try {
      const replay = new ArtifactAuthorityProducer({
        artifacts: reopenedArtifacts,
        authority: reopenedAuthority,
        bindingInput: new StubBindingInput({
          ...cut(),
          capturedAt: "2026-08-20T02:00:00.000Z",
        }),
      }).produce(ref(stored.artifact));
      assert.deepEqual(replay, first);
      assert.equal(reopenedArtifacts.listAttestations({ kind: "authority-assessment", artifact: ref(stored.artifact) }).length, 1);
    } finally {
      reopenedAuthority.close();
      reopenedArtifacts.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changes status assessment without changing the scoped registry identity", () => {
  const env = environment();
  try {
    const available = env.producer.produce(env.ref);
    env.bindingInput.cut = cut(resolveInput({ available: false }));
    const unavailable = env.producer.produce(env.ref);

    assert.equal(unavailable.assessment.candidates[0]?.actionAuthorityCandidateId, available.assessment.candidates[0]?.actionAuthorityCandidateId);
    assert.equal(unavailable.assessment.candidates[0]?.status, "unavailable");
    assert.equal(unavailable.assessment.authorityRegistryIdentity, available.assessment.authorityRegistryIdentity);
    assert.notEqual(unavailable.assessment.inputIdentity, available.assessment.inputIdentity);
    assert.equal(env.artifactRegistry.listAttestations({ kind: "authority-assessment", artifact: env.ref }).length, 2);
  } finally {
    env.close();
  }
});
