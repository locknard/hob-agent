import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
  type ArtifactAuthorityAssessment,
  type ArtifactEvidenceAttestation,
  type ArtifactRef,
  type ArtifactRiskAssessment,
} from "./artifact-assessments.js";
import {
  createArtifactRevision,
  type ArtifactRevision,
} from "./neutral-artifact.js";
import {
  ArtifactRegistry,
  ArtifactRegistryError,
  type ArtifactRegistryEntry,
  type ArtifactRegistryFaultPoint,
} from "./artifact-registry.js";

interface TemporaryDatabase {
  readonly path: string;
  readonly cleanup: () => void;
}

function temporaryPath(name: string): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "hob-artifact-registry-"), { encoding: "utf8" });
  return {
    path: join(directory, `${name}.sqlite`),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function content(target = "hwc-cover-1"): ArtifactRevision["content"] {
  return {
    trigger: {
      kind: "schedule",
      timezone: "Etc/UTC",
      daysOfWeek: [1, 2, 3, 4, 5],
      at: "07:30",
    },
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

function artifact(
  revision = 1,
  options: { readonly artifactId?: string; readonly title?: string; readonly target?: string } = {},
): ArtifactRevision {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: options.artifactId ?? "artifact-registry-fixture",
    revision,
    title: options.title ?? "Morning comfort",
    summary: "A bounded reversible level change.",
    sourceProposal: { proposalId: "proposal-fixture", proposalRevision: 2 },
    content: content(options.target),
    createdAt: "2026-08-20T01:00:00.000Z",
  });
}

function artifactRef(value = artifact()): ArtifactRef {
  return {
    artifactId: value.artifactId,
    revision: value.revision,
    contentHash: value.contentHash,
  };
}

function assessmentWatermark(lastSeq = 42) {
  return {
    bridgeId: "bridge-artifact-fixture",
    epochId: "epoch-artifact-fixture",
    lastSeq,
    lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
    freshness: "fresh" as const,
    gapCount: 0,
  };
}

function evidenceAssessment(
  ref: ReturnType<typeof artifactRef>,
  attestationId = "evidence-registry-fixture-1",
  lastSeq = 42,
): ArtifactEvidenceAttestation {
  return createArtifactEvidenceAttestation({
    artifact: ref,
    attestationId,
    capturedAt: "2026-08-20T01:00:00.000Z",
    source: "home-world-consistent-cut",
    sourceProposal: { proposalId: "proposal-fixture", proposalRevision: 2 },
    proposalEvidenceIdentity: `sha256:${"b".repeat(64)}`,
    selectedHwCapabilityIds: ["hwc-cover-1"],
    watermarks: [assessmentWatermark(lastSeq)],
    coverage: "complete",
    reasons: [],
  });
}

function riskAssessment(
  ref: ReturnType<typeof artifactRef>,
  assessmentId = "risk-registry-fixture-1",
  policyVersion = "1.0.0",
  dependencies: {
    readonly evidence?: ArtifactEvidenceAttestation;
    readonly authority?: ArtifactAuthorityAssessment;
  } = {},
): ArtifactRiskAssessment {
  const evidence = dependencies.evidence ?? evidenceAssessment(ref);
  const authority = dependencies.authority ?? authorityAssessment(ref);
  return createArtifactRiskAssessment({
    artifact: ref,
    assessmentId,
    assessedAt: "2026-08-20T01:00:00.000Z",
    evidence: { attestationId: evidence.attestationId, inputIdentity: evidence.inputIdentity },
    authority: { assessmentId: authority.assessmentId, inputIdentity: authority.inputIdentity },
    conflictInputIdentity: `sha256:${"c".repeat(64)}`,
    class: "comfort_reversible",
    reasons: ["Bounded reversible level change with restore."],
    policyId: "policy-home-v1",
    policyVersion,
  });
}

function authorityAssessment(
  ref: ReturnType<typeof artifactRef>,
  assessmentId = "authority-registry-fixture-1",
  lastSeq = 42,
): ArtifactAuthorityAssessment {
  return createArtifactAuthorityAssessment({
    artifact: ref,
    assessmentId,
    assessedAt: "2026-08-20T01:00:00.000Z",
    authorityRegistryIdentity: `sha256:${"d".repeat(64)}`,
    candidates: [{
      actionAuthorityCandidateId: "candidate-registry-fixture-1",
      hwCapabilityId: "hwc-cover-1",
      status: "available",
    }],
    checkedWatermarks: [assessmentWatermark(lastSeq)],
  }, { hwCapabilityIds: ["hwc-cover-1"] });
}

function recordRiskDependencies(
  registry: ArtifactRegistry,
  ref: ReturnType<typeof artifactRef>,
): { readonly evidence: ArtifactEvidenceAttestation; readonly authority: ArtifactAuthorityAssessment } {
  const evidence = evidenceAssessment(ref);
  const authority = authorityAssessment(ref);
  registry.recordEvidenceAttestation({
    assessment: evidence,
    idempotencyKey: "idem-risk-default-evidence",
  });
  registry.recordAuthorityAssessment({
    assessment: authority,
    idempotencyKey: "idem-risk-default-authority",
  });
  return { evidence, authority };
}

function openRegistry(path: string): ArtifactRegistry {
  return new ArtifactRegistry({
    path,
    now: () => "2026-08-20T01:00:00.000Z",
    id: (() => {
      let next = 0;
      return () => `registry-id-${++next}`;
    })(),
  });
}

function withRegistry<T>(name: string, run: (registry: ArtifactRegistry) => T): T {
  const temporary = temporaryPath(name);
  try {
    const registry = openRegistry(temporary.path);
    try {
      return run(registry);
    } finally {
      registry.close();
    }
  } finally {
    temporary.cleanup();
  }
}

test("creates revision one, validates it on read, and lists bounded immutable rows", () => {
  withRegistry("create", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-create-1", actor: "source-a" });

    assert.equal(created.artifact.revision, 1);
    assert.equal(created.status, "draft");
    assert.equal(created.tombstone, false);
    assert.equal(created.audit.length, 1);
    assert.equal(created.audit[0]?.action, "created");
    assert.equal(created.audit[0]?.actor, "source-a");
    assert.equal("artifact" in (created.audit[0] ?? {}), false);
    assert.deepEqual(registry.getRevision(created.artifact.artifactId, 1), created);
    assert.deepEqual(registry.list({ artifactId: created.artifact.artifactId, limit: 1 }), [created]);
  });
});

test("same idempotency key and hash returns the exact existing row without another audit", () => {
  withRegistry("create-idempotency", (registry) => {
    const input = { artifact: artifact(), idempotencyKey: "idem-create-1", actor: "source-a" };
    const first = registry.createDraft(input);
    const replay = registry.createDraft(input);

    assert.deepEqual(replay, first);
    assert.equal(registry.list({ artifactId: first.artifact.artifactId }).length, 1);
    assert.equal(registry.audit().length, 1);
    assert.throws(
      () => registry.createDraft({ artifact: artifact(1, { target: "hwc-other" }), idempotencyKey: input.idempotencyKey }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.appendRevision({
        artifact: artifact(2),
        expectedPreviousRevision: 1,
        idempotencyKey: input.idempotencyKey,
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.createDraft({ ...input, actor: "source-b" }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
  });
});

test("appends only expected-next immutable revisions and rejects same-revision hash conflicts", () => {
  withRegistry("append", (registry) => {
    const first = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-create-1" });
    const appendInput = {
      artifact: artifact(2, { title: "Evening comfort" }),
      expectedPreviousRevision: first.artifact.revision,
      idempotencyKey: "idem-append-2",
    };
    const second = registry.appendRevision(appendInput);
    const replay = registry.appendRevision(appendInput);

    assert.equal(second.artifact.revision, 2);
    assert.deepEqual(replay, second);
    assert.equal(registry.getRevision(first.artifact.artifactId, 1)?.artifact.title, "Morning comfort");
    assert.deepEqual(registry.list({ artifactId: first.artifact.artifactId }).map((row) => row.artifact.revision), [1, 2]);

    assert.throws(
      () => registry.appendRevision({
        artifact: artifact(2, { target: "hwc-other" }),
        expectedPreviousRevision: 1,
        idempotencyKey: "idem-conflict",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.appendRevision({
        artifact: artifact(4),
        expectedPreviousRevision: 2,
        idempotencyKey: "idem-gap",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
  });
});

test("marks a revision superseded by appending status and audit while retaining old bytes", () => {
  withRegistry("supersede", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-create-1" });
    const supersedeInput = {
      artifactId: created.artifact.artifactId,
      revision: created.artifact.revision,
      idempotencyKey: "idem-supersede-1",
      reason: "replaced by a newer household proposal",
    };
    const superseded = registry.markSuperseded(supersedeInput);
    const replay = registry.markSuperseded(supersedeInput);

    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.tombstone, true);
    assert.deepEqual(replay, superseded);
    assert.equal(registry.getRevision(created.artifact.artifactId, 1)?.artifact.contentHash, created.artifact.contentHash);
    assert.equal(registry.audit().length, 2);
    assert.throws(
      () => registry.markSuperseded({ ...supersedeInput, reason: "a different reason" }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
  });
});

test("recovers rows and append-only audit after restart with private SQLite WAL files", () => {
  const temporary = temporaryPath("restart");
  try {
    const first = openRegistry(temporary.path);
    let created: ArtifactRegistryEntry;
    try {
      created = first.createDraft({ artifact: artifact(), idempotencyKey: "idem-create-1" });
    } finally {
      first.close();
    }

    const second = openRegistry(temporary.path);
    try {
      assert.deepEqual(second.getRevision(created.artifact.artifactId, 1), created);
      assert.equal(second.audit().length, 1);
      assert.equal(statSync(temporary.path).mode & 0o777, 0o600);
      for (const sidecar of [`${temporary.path}-wal`, `${temporary.path}-shm`]) {
        try {
          assert.equal(statSync(sidecar).mode & 0o777, 0o600);
        } catch (error: unknown) {
          if (!isMissingFileError(error)) throw error;
        }
      }
      const inspect = new DatabaseSync(temporary.path);
      try {
        const journalMode = inspect.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown };
        assert.equal(String(journalMode.journal_mode).toLowerCase(), "wal");
      } finally {
        inspect.close();
      }
    } finally {
      second.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("rolls back a crash injected between immutable row and audit append", () => {
  const temporary = temporaryPath("rollback");
  try {
    let injected: ArtifactRegistryFaultPoint | undefined;
    const failing = new ArtifactRegistry({
      path: temporary.path,
      now: () => "2026-08-20T01:00:00.000Z",
      fault: (point) => {
        injected = point;
        if (point === "after-artifact-row") throw new Error("injected crash");
      },
    });
    try {
      assert.throws(() => failing.createDraft({ artifact: artifact(), idempotencyKey: "idem-crash" }));
      assert.equal(injected, "after-artifact-row");
    } finally {
      failing.close();
    }

    const recovered = openRegistry(temporary.path);
    try {
      assert.deepEqual(recovered.list(), []);
      assert.deepEqual(recovered.audit(), []);
    } finally {
      recovered.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("fails closed when a persisted artifact row is corrupted", () => {
  const temporary = temporaryPath("corrupt");
  try {
    const registry = openRegistry(temporary.path);
    let created: ArtifactRegistryEntry;
    try {
      created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-corrupt" });
    } finally {
      registry.close();
    }

    const tamper = new DatabaseSync(temporary.path);
    try {
      tamper.prepare("UPDATE artifact_revisions SET artifact_json = ? WHERE artifact_id = ? AND revision = ?")
        .run("{\"schemaVersion\":\"1\",\"corrupt\":true}", created.artifact.artifactId, 1);
    } finally {
      tamper.close();
    }

    const reopened = openRegistry(temporary.path);
    try {
      assert.throws(
        () => reopened.getRevision(created.artifact.artifactId, 1),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "corrupt_record",
      );
    } finally {
      reopened.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("has no compile, apply, bridge, credential, or action surface", () => {
  withRegistry("surface", (registry) => {
    for (const forbidden of ["compile", "apply", "execute", "bridge", "credential", "action"]) {
      assert.equal(forbidden in registry, false, forbidden);
    }
  });
});

test("bounds list and audit enumeration with explicit defaults and maximums", () => {
  withRegistry("bounds", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-create-1" });

    assert.equal(registry.list().length, 1);
    assert.equal(registry.audit().length, 1);
    assert.equal(registry.list({ limit: 200 }).length, 1);
    assert.equal(registry.audit({ limit: 200 }).length, 1);
    assert.throws(() => registry.list({ limit: 201 }), (error: unknown) => (
      error instanceof ArtifactRegistryError && error.code === "invalid_input"
    ));
    assert.throws(() => registry.audit({ limit: 201 }), (error: unknown) => (
      error instanceof ArtifactRegistryError && error.code === "invalid_input"
    ));
    assert.equal(registry.list({ artifactId: created.artifact.artifactId, limit: 1 }).length, 1);
  });
});

test("matches neutral artifact id rules while bounding idempotency and actor text by UTF-8 bytes", () => {
  withRegistry("input-boundaries", (registry) => {
    assert.equal(registry.getRevision("界".repeat(60), 1), undefined);
    assert.throws(
      () => registry.getRevision(" padded-id ", 1),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => registry.getRevision("a".repeat(201), 1),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => registry.createDraft({ artifact: artifact(), idempotencyKey: "é".repeat(101) }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-padded", actor: " hub " }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-long-actor", actor: "界".repeat(101) }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
  });
});

test("serializes a replay across two registry connections and preserves the original actor", () => {
  const temporary = temporaryPath("two-connections");
  try {
    const first = openRegistry(temporary.path);
    const second = openRegistry(temporary.path);
    try {
      const input = { artifact: artifact(), idempotencyKey: "idem-cross-connection", actor: "source-a" };
      const created = first.createDraft(input);
      const replay = second.createDraft(input);

      assert.deepEqual(replay, created);
      assert.equal(second.audit({ limit: 200 }).length, 1);
      assert.throws(
        () => second.createDraft({ ...input, actor: "source-b" }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
      );
    } finally {
      second.close();
      first.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("persists all three Hub assessments as immutable metadata-only rows", () => {
  withRegistry("assessments", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const evidence = evidenceAssessment(ref);
    const authority = authorityAssessment(ref);
    const risk = riskAssessment(ref, "risk-registry-fixture-1", "1.0.0", { evidence, authority });

    const evidenceRow = registry.recordEvidenceAttestation({
      assessment: evidence,
      idempotencyKey: "idem-assessment-evidence",
      actor: "hub-assessment",
    });
    const authorityRow = registry.recordAuthorityAssessment({
      assessment: authority,
      idempotencyKey: "idem-assessment-authority",
    });
    const riskRow = registry.recordRiskAssessment({
      assessment: risk,
      idempotencyKey: "idem-assessment-risk",
    });

    for (const [row, expected, recordId] of [
      [evidenceRow, evidence, evidence.attestationId],
      [riskRow, risk, risk.assessmentId],
      [authorityRow, authority, authority.assessmentId],
    ] as const) {
      assert.deepEqual(row.assessment, expected);
      assert.equal(row.kind, expected.kind);
      assert.equal(row.recordId, recordId);
      assert.deepEqual(row.artifact, ref);
      assert.equal(row.inputIdentity, expected.inputIdentity);
      assert.equal(row.recordedAt, "2026-08-20T01:00:00.000Z");
      assert.equal(row.audit.every((entry) => "assessment" in entry === false), true);
      assert.deepEqual(row.audit.map((entry) => [entry.action, entry.kind, entry.recordId]), [
        ["assessment_recorded", expected.kind, recordId],
      ]);
    }

    assert.equal(registry.listAttestations({ artifact: ref, limit: 200 }).length, 3);
    assert.deepEqual(registry.latestAttestation({ kind: "authority-assessment", artifact: ref }), authorityRow);
    assert.equal(registry.audit({ limit: 200 }).filter((entry) => entry.action === "assessment_recorded").length, 3);
    assert.deepEqual(registry.getRevision(ref.artifactId, ref.revision)?.audit.map((entry) => entry.action), ["created"]);
  });
});

test("requires risk evidence and authority dependencies to be persisted and exact", () => {
  withRegistry("assessment-risk-dependencies", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-risk-dependency-artifact" });
    const ref = artifactRef(created.artifact);

    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-missing-dependencies"),
        idempotencyKey: "idem-risk-missing-dependencies",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "not_found",
    );

    const evidence = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-risk-dependency"),
      idempotencyKey: "idem-evidence-risk-dependency",
    });
    const authority = registry.recordAuthorityAssessment({
      assessment: authorityAssessment(ref, "authority-risk-dependency"),
      idempotencyKey: "idem-authority-risk-dependency",
    });
    const valid = registry.recordRiskAssessment({
      assessment: riskAssessment(ref, "risk-valid-dependencies", "1.0.0", {
        evidence: evidence.assessment,
        authority: authority.assessment,
      }),
      idempotencyKey: "idem-risk-valid-dependencies",
    });
    assert.equal(valid.assessment.evidence.attestationId, evidence.assessment.attestationId);
    assert.equal(valid.assessment.evidence.inputIdentity, evidence.assessment.inputIdentity);
    assert.equal(valid.assessment.authority.assessmentId, authority.assessment.assessmentId);
    assert.equal(valid.assessment.authority.inputIdentity, authority.assessment.inputIdentity);

    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-wrong-evidence", "1.0.0", {
          evidence: { ...evidence.assessment, inputIdentity: `sha256:${"f".repeat(64)}` },
          authority: authority.assessment,
        }),
        idempotencyKey: "idem-risk-wrong-evidence",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-wrong-authority", "1.0.0", {
          evidence: evidence.assessment,
          authority: { ...authority.assessment, inputIdentity: `sha256:${"f".repeat(64)}` },
        }),
        idempotencyKey: "idem-risk-wrong-authority",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );

    const other = registry.createDraft({
      artifact: artifact(1, { artifactId: "artifact-registry-other", title: "Other artifact", target: "hwc-other" }),
      idempotencyKey: "idem-risk-dependency-other-artifact",
    });
    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(artifactRef(other.artifact), "risk-cross-artifact", "1.0.0", {
          evidence: evidence.assessment,
          authority: authority.assessment,
        }),
        idempotencyKey: "idem-risk-cross-artifact",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
  });
});

test("deduplicates assessment identity independent of caller record id and binds idempotency conflicts", () => {
  withRegistry("assessment-idempotency", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const first = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-original"),
      idempotencyKey: "idem-evidence-original",
    });
    const semanticReplay = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-new-caller-id"),
      idempotencyKey: "idem-evidence-new-caller-id",
    });

    assert.deepEqual(semanticReplay, first);
    assert.equal(registry.listAttestations({ kind: "evidence-attestation", artifact: ref }).length, 1);
    assert.equal(registry.audit({ limit: 200 }).filter((entry) => entry.action === "assessment_recorded").length, 1);
    assert.deepEqual(
      registry.recordEvidenceAttestation({
        assessment: evidenceAssessment(ref, "evidence-new-caller-id"),
        idempotencyKey: "idem-evidence-new-caller-id",
      }),
      first,
    );
    assert.throws(
      () => registry.recordEvidenceAttestation({
        assessment: evidenceAssessment(ref, "evidence-different-source"),
        idempotencyKey: "idem-evidence-different-source",
        actor: "another-source",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.recordEvidenceAttestation({
        assessment: evidenceAssessment(ref, "evidence-new-caller-id", 43),
        idempotencyKey: "idem-evidence-new-caller-id",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );

    assert.throws(
      () => registry.recordEvidenceAttestation({
        assessment: evidenceAssessment(ref, "evidence-original", 43),
        idempotencyKey: "idem-evidence-different-row",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );

    const authority = registry.recordAuthorityAssessment({
      assessment: authorityAssessment(ref),
      idempotencyKey: "idem-risk-dedup-authority",
    });

    const sameIdRisk = riskAssessment(ref, "evidence-original", "1.0.1");
    assert.throws(
      () => registry.recordRiskAssessment({ assessment: sameIdRisk, idempotencyKey: "idem-risk-collision" }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );

    const firstRisk = registry.recordRiskAssessment({
      assessment: riskAssessment(ref, "risk-original", "1.0.0", {
        evidence: first.assessment,
        authority: authority.assessment,
      }),
      idempotencyKey: "idem-shared-content",
    });
    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-new-input", "1.0.1", {
          evidence: first.assessment,
          authority: authority.assessment,
        }),
        idempotencyKey: "idem-shared-content",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.deepEqual(registry.latestAttestation({ kind: "risk-assessment", artifact: ref }), firstRisk);
  });
});

test("appends dynamic assessment identities without changing the artifact revision", () => {
  withRegistry("assessment-refresh", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const first = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-refresh-1", 42),
      idempotencyKey: "idem-evidence-refresh-1",
    });
    const refreshed = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-refresh-2", 43),
      idempotencyKey: "idem-evidence-refresh-2",
    });

    assert.notEqual(first.inputIdentity, refreshed.inputIdentity);
    assert.equal(registry.getRevision(ref.artifactId, ref.revision)?.artifact.contentHash, ref.contentHash);
    assert.equal(registry.listAttestations({ kind: "evidence-attestation", artifact: ref }).length, 2);
    assert.deepEqual(registry.latestAttestation({ kind: "evidence-attestation", artifact: ref }), refreshed);
  });
});

test("finds an exact assessment identity without depending on the bounded history list", () => {
  withRegistry("assessment-exact-identity", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-exact-artifact" });
    const ref = artifactRef(created.artifact);
    const evidence = registry.recordEvidenceAttestation({
      assessment: evidenceAssessment(ref, "evidence-exact-identity"),
      idempotencyKey: "idem-exact-evidence",
    });
    const authority = registry.recordAuthorityAssessment({
      assessment: authorityAssessment(ref, "authority-exact-identity"),
      idempotencyKey: "idem-exact-authority",
    });
    const risks: ArtifactRiskAssessment[] = [];
    for (let index = 0; index <= 200; index += 1) {
      const risk = createArtifactRiskAssessment({
        artifact: ref,
        assessmentId: `risk-exact-${index}`,
        assessedAt: "2026-08-20T01:00:00.000Z",
        evidence: { attestationId: evidence.assessment.attestationId, inputIdentity: evidence.inputIdentity },
        authority: { assessmentId: authority.assessment.assessmentId, inputIdentity: authority.inputIdentity },
        conflictInputIdentity: `sha256:${index.toString(16).padStart(64, "0")}`,
        class: "comfort_reversible",
        reasons: ["Bounded exact identity fixture."],
        policyId: "policy-home-v1",
        policyVersion: "1.0.0",
      });
      risks.push(risk);
      registry.recordRiskAssessment({ assessment: risk, idempotencyKey: `idem-exact-risk-${index}` });
    }

    const target = risks[0]!;
    assert.deepEqual(
      registry.attestationByInputIdentity({
        kind: "risk-assessment",
        artifact: ref,
        inputIdentity: target.inputIdentity,
      })?.assessment,
      target,
    );
    assert.equal(registry.attestationByInputIdentity({
      kind: "risk-assessment",
      artifact: { ...ref, artifactId: "other-artifact" },
      inputIdentity: target.inputIdentity,
    }), undefined);
    assert.throws(
      () => (registry.attestationByInputIdentity as (query: unknown) => unknown)({
        kind: "risk-assessment",
        artifact: ref,
        inputIdentity: "not-a-sha256-digest",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => (registry.attestationByInputIdentity as (query: unknown) => unknown)({
        kind: "unsupported",
        artifact: ref,
        inputIdentity: target.inputIdentity,
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
    assert.throws(
      () => (registry.attestationByInputIdentity as (query: unknown) => unknown)({
        kind: "risk-assessment",
        artifact: ref,
        inputIdentity: target.inputIdentity,
        limit: 1,
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
    );
  });
});

test("cross-checks assessment refs and blocks assessments for superseded revisions", () => {
  withRegistry("assessment-cross-check", (registry) => {
    const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const mismatchedHash = { ...ref, contentHash: `sha256:${"f".repeat(64)}` };
    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment(mismatchedHash),
        idempotencyKey: "idem-assessment-wrong-hash",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
    assert.throws(
      () => registry.recordRiskAssessment({
        assessment: riskAssessment({ ...ref, artifactId: "unknown-artifact" }),
        idempotencyKey: "idem-assessment-unknown-artifact",
      }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "not_found",
    );

    registry.markSuperseded({
      artifactId: ref.artifactId,
      revision: ref.revision,
      idempotencyKey: "idem-assessment-supersede",
    });
    assert.throws(
      () => registry.recordRiskAssessment({ assessment: riskAssessment(ref), idempotencyKey: "idem-after-supersede" }),
      (error: unknown) => error instanceof ArtifactRegistryError && error.code === "revision_conflict",
    );
  });
});

test("restores assessments, bounds queries, and fails closed on tampered payloads", () => {
  const temporary = temporaryPath("assessment-restart");
  try {
    const first = openRegistry(temporary.path);
    const created = first.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const dependencies = recordRiskDependencies(first, ref);
    const recorded = first.recordRiskAssessment({
      assessment: riskAssessment(ref, "risk-registry-fixture-1", "1.0.0", dependencies),
      idempotencyKey: "idem-assessment-restart",
    });
    first.close();

    const second = openRegistry(temporary.path);
    try {
      assert.deepEqual(second.latestAttestation({ kind: "risk-assessment", artifact: ref }), recorded);
      assert.equal(second.listAttestations({ limit: 200 }).length, 3);
      assert.throws(() => second.listAttestations({ limit: 201 }), (error: unknown) => (
        error instanceof ArtifactRegistryError && error.code === "invalid_input"
      ));
      assert.equal(statSync(temporary.path).mode & 0o777, 0o600);
      assert.throws(
        () => (second.latestAttestation as (query: unknown) => unknown)({ kind: "risk-assessment" }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
      );
      assert.throws(
        () => (second.latestAttestation as (query: unknown) => unknown)({ artifact: ref }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
      );
      assert.throws(
        () => second.latestAttestation({ kind: "risk-assessment", artifact: ref, limit: 201 }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "invalid_input",
      );
    } finally {
      second.close();
    }

    const tamper = new DatabaseSync(temporary.path);
    try {
      tamper.prepare("UPDATE artifact_assessments SET payload_json = ? WHERE record_id = ?")
        .run("{\"kind\":\"risk-assessment\",\"corrupt\":true}", recorded.recordId);
    } finally {
      tamper.close();
    }
    const corrupted = openRegistry(temporary.path);
    try {
      assert.throws(
        () => corrupted.latestAttestation({ kind: "risk-assessment", artifact: ref }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "corrupt_record",
      );
    } finally {
      corrupted.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("assessment reads fail closed when the referenced artifact is deleted or corrupted", () => {
  for (const mode of ["deleted", "corrupted"] as const) {
    const temporary = temporaryPath(`assessment-artifact-${mode}`);
    try {
      const seed = openRegistry(temporary.path);
      const created = seed.createDraft({ artifact: artifact(), idempotencyKey: `idem-${mode}-artifact` });
      const ref = artifactRef(created.artifact);
      const dependencies = recordRiskDependencies(seed, ref);
      seed.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-registry-fixture-1", "1.0.0", dependencies),
        idempotencyKey: `idem-${mode}-risk`,
      });
      seed.close();
      const tamper = new DatabaseSync(temporary.path);
      try {
        if (mode === "deleted") {
          tamper.prepare("DELETE FROM artifact_revisions WHERE artifact_id = ? AND revision = ?")
            .run(ref.artifactId, ref.revision);
        } else {
          tamper.prepare("UPDATE artifact_revisions SET artifact_json = ? WHERE artifact_id = ? AND revision = ?")
            .run("{\"corrupt\":true}", ref.artifactId, ref.revision);
        }
      } finally {
        tamper.close();
      }
      const reopened = openRegistry(temporary.path);
      try {
        assert.throws(
          () => reopened.latestAttestation({ kind: "risk-assessment", artifact: ref }),
          (error: unknown) => error instanceof ArtifactRegistryError
            && (error.code === "not_found" || error.code === "corrupt_record"),
        );
      } finally {
        reopened.close();
      }
    } finally {
      temporary.cleanup();
    }
  }
});

test("fails closed when an assessment idempotency row points at another valid assessment", () => {
  const temporary = temporaryPath("assessment-operation-corrupt");
  try {
    const seed = openRegistry(temporary.path);
    const created = seed.createDraft({ artifact: artifact(), idempotencyKey: "idem-operation-corrupt-artifact" });
    const ref = artifactRef(created.artifact);
    const dependencies = recordRiskDependencies(seed, ref);
    const first = riskAssessment(ref, "risk-operation-first", "1.0.0", dependencies);
    const second = riskAssessment(ref, "risk-operation-second", "1.0.1", dependencies);
    seed.recordRiskAssessment({ assessment: first, idempotencyKey: "idem-operation-first" });
    seed.recordRiskAssessment({ assessment: second, idempotencyKey: "idem-operation-second" });
    seed.close();

    const tamper = new DatabaseSync(temporary.path);
    try {
      tamper.prepare("UPDATE artifact_operations SET record_id = ? WHERE idempotency_key = ?")
        .run(second.assessmentId, "idem-operation-first");
    } finally {
      tamper.close();
    }

    const reopened = openRegistry(temporary.path);
    try {
      assert.throws(
        () => reopened.recordRiskAssessment({ assessment: first, idempotencyKey: "idem-operation-first" }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "corrupt_record",
      );
    } finally {
      reopened.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("rejects assessment audit rows without exact assessment metadata", () => {
  const temporary = temporaryPath("assessment-audit-corrupt");
  try {
    const seed = openRegistry(temporary.path);
    const created = seed.createDraft({ artifact: artifact(), idempotencyKey: "idem-audit-corrupt-artifact" });
    const ref = artifactRef(created.artifact);
    const dependencies = recordRiskDependencies(seed, ref);
    seed.recordRiskAssessment({
      assessment: riskAssessment(ref, "risk-registry-fixture-1", "1.0.0", dependencies),
      idempotencyKey: "idem-audit-corrupt-risk",
    });
    seed.close();
    const tamper = new DatabaseSync(temporary.path);
    try {
      tamper.prepare("UPDATE artifact_audit SET record_kind = NULL, record_id = NULL WHERE action = 'assessment_recorded'").run();
    } finally {
      tamper.close();
    }
    const reopened = openRegistry(temporary.path);
    try {
      assert.throws(
        () => reopened.audit({ limit: 200 }),
        (error: unknown) => error instanceof ArtifactRegistryError && error.code === "corrupt_record",
      );
    } finally {
      reopened.close();
    }
  } finally {
    temporary.cleanup();
  }
});

test("recording an assessment after close fails with the closed registry error", () => {
  const temporary = temporaryPath("assessment-closed");
  const registry = openRegistry(temporary.path);
  const created = registry.createDraft({ artifact: artifact(), idempotencyKey: "idem-closed-artifact" });
  const ref = artifactRef(created.artifact);
  registry.close();
  temporary.cleanup();
  assert.throws(
    () => registry.recordRiskAssessment({ assessment: riskAssessment(ref), idempotencyKey: "idem-closed-risk" }),
    (error: unknown) => error instanceof ArtifactRegistryError && error.code === "closed",
  );
});

test("rolls back an injected assessment write without a partial audit", () => {
  const temporary = temporaryPath("assessment-rollback");
  try {
    const seed = openRegistry(temporary.path);
    const created = seed.createDraft({ artifact: artifact(), idempotencyKey: "idem-assessment-artifact" });
    const ref = artifactRef(created.artifact);
    const dependencies = recordRiskDependencies(seed, ref);
    seed.close();
    const failing = new ArtifactRegistry({
      path: temporary.path,
      now: () => "2026-08-20T01:00:00.000Z",
      fault: (point) => {
        if (point === "after-assessment-row") throw new Error("injected assessment crash");
      },
    });
    try {
      assert.throws(() => failing.recordRiskAssessment({
        assessment: riskAssessment(ref, "risk-registry-fixture-1", "1.0.0", dependencies),
        idempotencyKey: "idem-assessment-crash",
      }));
    } finally {
      failing.close();
    }
    const recovered = openRegistry(temporary.path);
    try {
      assert.equal(recovered.listAttestations({ kind: "risk-assessment", limit: 200 }).length, 0);
      assert.equal(recovered.audit({ limit: 200 }).filter((entry) => entry.action === "assessment_recorded").length, 2);
    } finally {
      recovered.close();
    }
  } finally {
    temporary.cleanup();
  }
});

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
