import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactValidationError,
  artifactRevisionSchema,
  createArtifactRevision,
  parseArtifactContent,
  parseArtifactJson,
  parseArtifactRevision,
  verifyArtifactRevision,
  type CreateArtifactRevisionInput,
} from "./neutral-artifact.js";

function baseInput(): CreateArtifactRevisionInput {
  return {
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-comfort-window-1",
    revision: 1,
    title: "Morning comfort position",
    summary: "Apply one bounded reversible level change.",
    sourceProposal: { proposalId: "proposal-17", proposalRevision: 2 },
    content: {
      trigger: {
        kind: "schedule",
        timezone: "Etc/UTC",
        daysOfWeek: [1, 2, 3, 4, 5],
        at: "07:30",
      },
      conditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-light-context" },
        operator: "less_than",
        value: 0.4,
      }],
      actions: [{
        kind: "set_level",
        target: { hwCapabilityId: "hwc-cover-1" },
        value: 0.65,
        transitionSeconds: 30,
      }],
      rollback: {
        kind: "restore_previous_state",
        target: { hwCapabilityId: "hwc-cover-1" },
        maxAgeSeconds: 900,
      },
      postconditions: [{
        kind: "capability_value",
        source: { hwCapabilityId: "hwc-cover-1" },
        operator: "equals",
        value: 0.65,
        withinSeconds: 120,
      }],
    },
    createdAt: "2026-08-20T01:00:00.000Z",
  };
}

function artifactWith(overrides: Record<string, unknown> = {}) {
  return createArtifactRevision({ ...baseInput(), ...overrides } as CreateArtifactRevisionInput);
}

function cloned(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function hasCode(code: ArtifactValidationError["code"]) {
  return (error: unknown): error is ArtifactValidationError =>
    error instanceof ArtifactValidationError && error.code === code;
}

test("creates a valid closed neutral artifact with a computed hash", () => {
  const artifact = artifactWith();

  assert.match(artifact.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verifyArtifactRevision(artifact), true);
  assert.deepEqual(parseArtifactRevision(artifact), artifact);
  assert.equal("evidence" in artifact, false);
  assert.equal("risk" in artifact, false);
});

test("validates review-only content with the same closed ECA and resource budget", () => {
  const content = baseInput().content;
  assert.deepEqual(parseArtifactContent(content), content);
  assert.throws(
    () => parseArtifactContent({
      ...content,
      actions: [{
        kind: "set_level",
        target: { hwCapabilityId: "hwc-cover-1", entityId: "cover.native" },
        value: 0.5,
      }],
    }),
    hasCode("invalid_artifact"),
  );
  assert.throws(
    () => parseArtifactContent({ ...content, extra: "x".repeat(70 * 1024) }),
    hasCode("resource_exhausted"),
  );
});

test("canonical hash is stable when object insertion order changes", () => {
  const artifact = artifactWith();
  const reordered = cloned(artifact);
  reordered.content = {
    postconditions: (artifact.content.postconditions as unknown[]).map((item) => item),
    rollback: artifact.content.rollback,
    actions: artifact.content.actions,
    conditions: artifact.content.conditions,
    trigger: artifact.content.trigger,
  };
  reordered.sourceProposal = {
    proposalRevision: artifact.sourceProposal.proposalRevision,
    proposalId: artifact.sourceProposal.proposalId,
  };

  assert.equal(parseArtifactRevision(reordered).contentHash, artifact.contentHash);
});

test("canonical hash stays stable across deterministic insertion-order permutations", () => {
  const artifact = artifactWith();
  const permutedHashes = new Set<string>();

  for (let seed = 0; seed < 8; seed += 1) {
    const permuted = reorderObjectKeys(artifact, seed);
    permutedHashes.add(parseArtifactRevision(permuted).contentHash);
  }

  assert.deepEqual([...permutedHashes], [artifact.contentHash]);
});

test("canonical hash changes when action array order changes", () => {
  const content = cloned(baseInput().content);
  content.actions = [
    ...(content.actions as unknown[]),
    { kind: "set_boolean", target: { hwCapabilityId: "hwc-cover-1" }, value: true },
  ];
  const first = artifactWith({ content });
  const reversedContent = cloned(content);
  reversedContent.actions = [...(content.actions as unknown[])].reverse();
  const second = artifactWith({ content: reversedContent });

  assert.notEqual(first.contentHash, second.contentHash);
});

test("canonical hash changes for source proposal, rollback, and postcondition semantics", () => {
  const first = artifactWith();
  const proposal = artifactWith({
    sourceProposal: { proposalId: "proposal-17", proposalRevision: 3 },
  });
  const rollbackContent = cloned(baseInput().content);
  rollbackContent.rollback = {
    kind: "restore_previous_state",
    target: { hwCapabilityId: "hwc-cover-1" },
    maxAgeSeconds: 901,
  };
  const rollback = artifactWith({ content: rollbackContent });
  const postconditionContent = cloned(baseInput().content);
  postconditionContent.postconditions = [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-cover-1" },
    operator: "equals",
    value: 0.65,
    withinSeconds: 121,
  }];
  const postcondition = artifactWith({ content: postconditionContent });

  assert.notEqual(first.contentHash, proposal.contentHash);
  assert.notEqual(first.contentHash, rollback.contentHash);
  assert.notEqual(first.contentHash, postcondition.contentHash);
});

test("createdAt is audit metadata and does not change the stable content hash", () => {
  const first = artifactWith({ createdAt: "2026-08-20T01:00:00.000Z" });
  const second = artifactWith({ createdAt: "2026-08-20T02:00:00.000Z" });

  assert.notEqual(first.createdAt, second.createdAt);
  assert.equal(first.contentHash, second.contentHash);
});

test("semantic behavior changes produce a different content hash", () => {
  const first = artifactWith();
  const changedContent = cloned(baseInput().content);
  const actions = changedContent.actions as Array<Record<string, unknown>>;
  actions[0] = { ...actions[0], value: 0.8 };
  const second = artifactWith({ content: changedContent });

  assert.notEqual(first.contentHash, second.contentHash);
});

test("rejects unknown dynamic fields and vendor/native target fields", () => {
  const unknown = cloned(artifactWith());
  unknown.evidence = { coverage: "complete" };
  assert.throws(() => parseArtifactRevision(unknown), hasCode("invalid_artifact"));

  const nativeTarget = cloned(artifactWith());
  const content = nativeTarget.content as Record<string, unknown>;
  const actions = content.actions as Array<Record<string, unknown>>;
  actions[0] = {
    ...actions[0],
    target: { hwCapabilityId: "hwc-cover-1", nativeId: "device-1" },
  };
  assert.throws(() => parseArtifactRevision(nativeTarget), hasCode("invalid_artifact"));

  const candidateTarget = cloned(artifactWith());
  const candidateContent = candidateTarget.content as Record<string, unknown>;
  const candidateActions = candidateContent.actions as Array<Record<string, unknown>>;
  candidateActions[0] = {
    ...candidateActions[0],
    target: { hwCapabilityId: "hwc-cover-1", actionAuthorityCandidateId: "candidate-1" },
  };
  assert.throws(() => parseArtifactRevision(candidateTarget), hasCode("invalid_artifact"));
});

test("bounds every Hub id by UTF-8 bytes without trimming or normalizing", () => {
  const exact = artifactWith({ artifactId: "é".repeat(100) });
  assert.equal(Buffer.byteLength(exact.artifactId, "utf8"), 200);

  const overLimit = "é".repeat(101);
  assert.throws(() => artifactWith({ artifactId: overLimit }), hasCode("invalid_artifact"));
  assert.throws(
    () => artifactWith({ sourceProposal: { proposalId: overLimit, proposalRevision: 2 } }),
    hasCode("invalid_artifact"),
  );

  const oversizedCapabilityContent = cloned(baseInput().content);
  const oversizedCapabilityActions = oversizedCapabilityContent.actions as Array<Record<string, unknown>>;
  oversizedCapabilityActions[0] = {
    ...oversizedCapabilityActions[0],
    target: { hwCapabilityId: overLimit },
  };
  assert.throws(
    () => artifactWith({ content: oversizedCapabilityContent }),
    hasCode("invalid_artifact"),
  );

  assert.throws(() => artifactWith({ artifactId: " artifact-1" }), hasCode("invalid_artifact"));
  assert.throws(() => artifactWith({ artifactId: "artifact-1 " }), hasCode("invalid_artifact"));

  const composed = artifactWith({ artifactId: "artifact-é" });
  const decomposed = artifactWith({ artifactId: "artifact-e\u0301" });
  assert.notEqual(composed.artifactId, decomposed.artifactId);
  assert.notEqual(composed.contentHash, decomposed.contentHash);
});

test("rejects unsafe closed-set values and open automation shapes", () => {
  const unsafeRevision = cloned(artifactWith());
  unsafeRevision.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseArtifactRevision(unsafeRevision), hasCode("invalid_artifact"));

  const cron = cloned(artifactWith());
  (cron.content as Record<string, unknown>).trigger = {
    kind: "schedule",
    timezone: "Etc/UTC",
    daysOfWeek: [1],
    at: "0 7 * * *",
  };
  assert.throws(() => parseArtifactRevision(cron), hasCode("invalid_artifact"));

  const arbitraryAction = cloned(artifactWith());
  (arbitraryAction.content as Record<string, unknown>).actions = [{
    kind: "run_script",
    target: { hwCapabilityId: "hwc-cover-1" },
    script: "send-anything",
  }];
  assert.throws(() => parseArtifactRevision(arbitraryAction), hasCode("invalid_artifact"));
});

test("allows at most one device target and requires rollback/postcondition target consistency", () => {
  const multipleTargets = cloned(artifactWith());
  (multipleTargets.content as Record<string, unknown>).actions = [
    ...(artifactWith().content.actions as unknown[]),
    {
      kind: "set_boolean",
      target: { hwCapabilityId: "hwc-other" },
      value: true,
    },
  ];
  assert.throws(() => parseArtifactRevision(multipleTargets), hasCode("invalid_artifact"));

  const wrongRollback = cloned(artifactWith());
  (wrongRollback.content as Record<string, unknown>).rollback = {
    kind: "restore_previous_state",
    target: { hwCapabilityId: "hwc-other" },
    maxAgeSeconds: 900,
  };
  assert.throws(() => parseArtifactRevision(wrongRollback), hasCode("invalid_artifact"));

  const missingPostcondition = cloned(artifactWith());
  (missingPostcondition.content as Record<string, unknown>).postconditions = [];
  assert.throws(() => parseArtifactRevision(missingPostcondition), hasCode("invalid_artifact"));
});

test("requires no-remote-change for pure notifications and rejects device actions with that rollback", () => {
  const notification = baseInput();
  notification.content = {
    ...notification.content,
    actions: [{ kind: "notify_local", message: "Review this bounded suggestion." }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
  const validNotification = createArtifactRevision(notification);
  assert.equal(verifyArtifactRevision(validNotification), true);

  const notificationWithDevicePostcondition = cloned(validNotification);
  (notificationWithDevicePostcondition.content as Record<string, unknown>).postconditions = [{
    kind: "capability_value",
    source: { hwCapabilityId: "hwc-cover-1" },
    operator: "equals",
    value: 0.65,
    withinSeconds: 120,
  }];
  assert.throws(
    () => parseArtifactRevision(notificationWithDevicePostcondition),
    hasCode("invalid_artifact"),
  );

  const deviceWithNoRemoteChange = cloned(artifactWith());
  (deviceWithNoRemoteChange.content as Record<string, unknown>).rollback = {
    kind: "no_remote_change",
  };
  assert.throws(() => parseArtifactRevision(deviceWithNoRemoteChange), hasCode("invalid_artifact"));
});

test("rejects URLs embedded in neutral behavior content", () => {
  const notification = baseInput();
  notification.content = {
    ...notification.content,
    actions: [{ kind: "notify_local", message: "Open https://example.invalid/command" }],
    rollback: { kind: "no_remote_change" },
    postconditions: [],
  };
  assert.throws(() => createArtifactRevision(notification), hasCode("invalid_artifact"));

  const condition = cloned(baseInput().content);
  (condition.conditions as Array<Record<string, unknown>>)[0]!.value = "custom://opaque-payload";
  assert.throws(
    () => artifactWith({ content: condition }),
    hasCode("invalid_artifact"),
  );
});

test("rejects resource exhaustion before deep artifact admission", () => {
  const oversized = { ...baseInput(), summary: "x".repeat(70 * 1024) };

  assert.throws(
    () => parseArtifactRevision(oversized),
    hasCode("resource_exhausted"),
  );
});

test("rejects a placeholder or stale content hash", () => {
  const invalid = cloned(artifactWith());
  invalid.contentHash = `sha256:${"0".repeat(64)}`;

  assert.equal(artifactRevisionSchema.safeParse(invalid).success, false);
  assert.equal(verifyArtifactRevision(invalid), false);
  assert.throws(() => parseArtifactRevision(invalid), hasCode("hash_mismatch"));
});

test("rejects duplicate JSON keys at the raw JSON boundary", () => {
  const duplicate = '{"schemaVersion":"1","schemaVersion":"1"}';

  assert.throws(
    () => parseArtifactJson(duplicate),
    hasCode("duplicate_json_key"),
  );
});

test("rejects escaped-equivalent duplicate JSON keys before JSON.parse", () => {
  const duplicate = '{"schemaVersion":"1","\\u0073chemaVersion":"1"}';

  assert.throws(
    () => parseArtifactJson(duplicate),
    hasCode("duplicate_json_key"),
  );
});

test("fails closed for cycles, undefined, non-finite values, non-plain objects, and deep input", () => {
  const cycle = artifactWith() as unknown as Record<string, unknown>;
  cycle.cycle = cycle;
  assert.throws(() => parseArtifactRevision(cycle), hasCode("invalid_artifact"));

  const withUndefined = cloned(artifactWith());
  withUndefined.undefinedValue = undefined;
  assert.throws(() => parseArtifactRevision(withUndefined), hasCode("invalid_artifact"));

  const withInfinity = cloned(artifactWith());
  withInfinity.value = Number.POSITIVE_INFINITY;
  assert.throws(() => parseArtifactRevision(withInfinity), hasCode("invalid_artifact"));

  class UntrustedObject {
    readonly marker = "not-a-plain-object";
  }
  const withClass = cloned(artifactWith());
  withClass.content = new UntrustedObject();
  assert.throws(() => parseArtifactRevision(withClass), hasCode("invalid_artifact"));

  const tooDeep = cloned(artifactWith());
  let cursor = tooDeep;
  for (let index = 0; index < 20; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.nested = child;
    cursor = child;
  }
  assert.throws(() => parseArtifactRevision(tooDeep), hasCode("resource_exhausted"));
});

function reorderObjectKeys(value: unknown, seed: number): Record<string, unknown> {
  if (Array.isArray(value)) return value.map((item) => reorderObjectKeys(item, seed)) as unknown as Record<string, unknown>;
  if (value === null || typeof value !== "object") return value as Record<string, unknown>;
  const entries = Object.entries(value).map(([key, child]) => [key, reorderObjectKeys(child, seed + key.length)] as const);
  const offset = entries.length === 0 ? 0 : seed % entries.length;
  const rotated = [...entries.slice(offset), ...entries.slice(0, offset)];
  return Object.fromEntries(seed % 2 === 0 ? rotated : rotated.reverse());
}
