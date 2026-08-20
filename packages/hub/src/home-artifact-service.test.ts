import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  createArtifactAuthorityAssessment,
  createArtifactEvidenceAttestation,
  createArtifactRiskAssessment,
} from "./artifact-assessments.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { HomeArtifactService } from "./home-artifact-service.js";
import { createArtifactRevision } from "./neutral-artifact.js";

function fixtureArtifact() {
  return createArtifactRevision({
    schemaVersion: "1",
    kind: "event-condition-action",
    artifactId: "artifact-service-fixture",
    revision: 1,
    title: "Local reminder",
    summary: "Create one local review notification without a remote change.",
    sourceProposal: { proposalId: "proposal-service-fixture", proposalRevision: 2 },
    content: {
      trigger: {
        kind: "schedule",
        timezone: "Etc/UTC",
        daysOfWeek: [1],
        at: "08:00",
      },
      conditions: [],
      actions: [{ kind: "notify_local", message: "Review the morning comfort window." }],
      rollback: { kind: "no_remote_change" },
      postconditions: [],
    },
    createdAt: "2026-08-20T01:00:00.000Z",
  });
}

test("mounts a restart-safe read-only artifact boundary with no action surface", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-home-artifacts-"));
  const path = join(directory, "artifacts.sqlite");
  try {
    let auditSequence = 0;
    const seed = new ArtifactRegistry({
      path,
      now: () => "2026-08-20T01:00:00.000Z",
      id: () => `artifact-audit-fixture-${++auditSequence}`,
    });
    const artifact = fixtureArtifact();
    seed.createDraft({ artifact, idempotencyKey: "seed-artifact", actor: "hub-test" });
    const artifactRef = {
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
    };
    const watermark = {
      bridgeId: "bridge-service-fixture",
      epochId: "epoch-service-fixture",
      lastSeq: 1,
      lastSyncCompleteAt: "2026-08-20T00:59:00.000Z",
      freshness: "fresh" as const,
      gapCount: 0,
    };
    const evidence = createArtifactEvidenceAttestation({
      artifact: artifactRef,
      attestationId: "evidence-service-fixture",
      capturedAt: "2026-08-20T01:00:00.000Z",
      source: "home-world-consistent-cut",
      sourceProposal: artifact.sourceProposal,
      proposalEvidenceIdentity: `sha256:${"b".repeat(64)}`,
      selectedHwCapabilityIds: [],
      watermarks: [watermark],
      coverage: "complete",
      reasons: [],
    });
    const authority = createArtifactAuthorityAssessment({
      artifact: artifactRef,
      assessmentId: "authority-service-fixture",
      assessedAt: "2026-08-20T01:00:00.000Z",
      authorityRegistryIdentity: `sha256:${"d".repeat(64)}`,
      candidates: [],
      checkedWatermarks: [watermark],
    }, { hwCapabilityIds: ["hwc-service-fixture"] });
    seed.recordEvidenceAttestation({
      assessment: evidence,
      idempotencyKey: "seed-artifact-evidence",
      actor: "hub-evidence",
    });
    seed.recordAuthorityAssessment({
      assessment: authority,
      idempotencyKey: "seed-artifact-authority",
      actor: "hub-authority",
    });
    const risk = createArtifactRiskAssessment({
      artifact: artifactRef,
      assessmentId: "risk-service-fixture",
      assessedAt: "2026-08-20T01:00:00.000Z",
      evidence: {
        attestationId: evidence.attestationId,
        inputIdentity: evidence.inputIdentity,
      },
      authority: {
        assessmentId: authority.assessmentId,
        inputIdentity: authority.inputIdentity,
      },
      conflictInputIdentity: `sha256:${"c".repeat(64)}`,
      class: "observe_or_notify",
      reasons: ["Local notification only; no remote state changes."],
      policyId: "home-artifact-phase-one",
      policyVersion: "1.0.0",
    });
    seed.recordRiskAssessment({
      assessment: risk,
      idempotencyKey: "seed-artifact-risk",
      actor: "hub-policy",
    });
    seed.close();

    const context = new Context();
    await context.plugin(HomeArtifactService, { path });
    const service = context.homeArtifacts;

    assert.equal(service.capabilities().schemaVersion, "1");
    assert.equal(service.capabilities().canCompile, false);
    assert.equal(service.capabilities().canSimulate, false);
    assert.equal(service.capabilities().canExecute, false);
    assert.deepEqual(service.diagnostics(), {
      status: "ready",
      schemaVersion: "1",
      lifecycleStates: ["draft", "superseded"],
      hasRecords: true,
      canCompile: false,
      canSimulate: false,
      canExecute: false,
    });
    assert.equal(JSON.stringify(service.diagnostics()).includes(artifact.title), false);
    assert.equal(service.getRevision(artifact.artifactId, 1)?.artifact.contentHash, artifact.contentHash);
    assert.equal(service.list({ limit: 1 }).length, 1);
    assert.equal(service.audit({ limit: 1 })[0]?.actor, "hub-test");
    assert.equal(service.listAttestations({
      kind: "risk-assessment",
      artifact: risk.artifact,
      limit: 1,
    })[0]?.recordId, risk.assessmentId);
    assert.equal(service.latestAttestation({
      kind: "risk-assessment",
      artifact: risk.artifact,
    })?.inputIdentity, risk.inputIdentity);
    for (const forbidden of [
      "createDraft",
      "appendRevision",
      "markSuperseded",
      "recordEvidenceAttestation",
      "recordRiskAssessment",
      "recordAuthorityAssessment",
      "compile",
      "apply",
      "execute",
    ]) {
      assert.equal(forbidden in service, false, forbidden);
    }

    await context.fiber.dispose();
    assert.throws(() => service.list({ limit: 1 }), /closed/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
