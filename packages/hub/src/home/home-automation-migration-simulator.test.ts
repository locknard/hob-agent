import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HomeAutomationMigrationSimulator,
  computeHomeAutomationMigrationCandidateContentHash,
  type HomeAutomationMigrationSimulatorInput,
} from "./home-automation-migration-simulator.js";

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-24T08:00:00.000Z";
const RULE_REF = "ha-rule:evening-light";
const PROPOSAL_ID = "proposal-evening-light";
const PROPOSAL_REVISION = 4;

const CONTENT = {
  trigger: { kind: "schedule", timezone: "Etc/UTC", daysOfWeek: [1], at: "20:30" },
  conditions: [],
  actions: [{ kind: "notify_local", message: "Review the evening light" }],
  rollback: { kind: "no_remote_change" },
  postconditions: [],
} as const;

const CANDIDATE = {
  status: "candidate",
  ruleRef: RULE_REF,
  sourceFingerprint: SOURCE_FINGERPRINT,
  title: "Review the evening light",
  content: CONTENT,
} as const;

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPOSAL_ID,
    revision: PROPOSAL_REVISION,
    kind: "automation-draft",
    status: "pending_review",
    lifecycle: "preparing",
    title: CANDIDATE.title,
    summary: "A review-only evening light note.",
    intent: {
      type: "notify_local",
      description: "Review the evening light.",
      rollback: "No remote change exists.",
    },
    rationale: {
      householdValue: "Keep the household informed.",
      whyNow: "The imported rule needs review.",
      uncertainties: ["The household decides whether to keep it."],
    },
    risk: {
      level: "low",
      reasons: [],
      requiresHumanApproval: true,
    },
    artifactCandidate: {
      schemaVersion: "1",
      content: CONTENT,
    },
    ...overrides,
  };
}

function preparation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: PROPOSAL_ID,
    proposalRevision: PROPOSAL_REVISION,
    status: "succeeded",
    attempt: 1,
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function preparedArtifact(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "artifact-evening-light",
    revision: 1,
    contentHash: `sha256:${"b".repeat(64)}`,
    compileResultId: `sha256:${"c".repeat(64)}`,
    dryRunResultId: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

function preparedContentHash(value: Record<string, unknown>): string {
  const snapshot = {
    title: value.title,
    summary: value.summary,
    intent: value.intent,
    rationale: value.rationale ?? null,
    artifactCandidate: value.artifactCandidate ?? null,
    risk: value.risk,
    actionPolicyClasses: value.actionPolicyClasses ?? null,
    confirmationDeviceNames: value.confirmationDeviceNames ?? null,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
}

function input(overrides: Partial<HomeAutomationMigrationSimulatorInput> = {}): HomeAutomationMigrationSimulatorInput {
  return {
    ruleRef: RULE_REF,
    sourceFingerprint: SOURCE_FINGERPRINT,
    candidate: CANDIDATE,
    proposal: proposal(),
    ...overrides,
  };
}

const simulator = new HomeAutomationMigrationSimulator();

test("projects an exact review-only candidate before preparation as translated", () => {
  const result = simulator.project(input());

  assert.deepEqual(result, {
    status: "translated",
    ruleRef: RULE_REF,
    sourceFingerprint: SOURCE_FINGERPRINT,
    proposalId: PROPOSAL_ID,
    candidateProposalRevision: PROPOSAL_REVISION,
    candidateContentHash: computeHomeAutomationMigrationCandidateContentHash(CONTENT),
    writesPerformed: false,
  });
});

test("maps succeeded durable preparation refs to simulated without creating an Artifact", () => {
  const prepared = preparedArtifact();
  // A succeeded preparation can remain preparing while the review capacity is
  // full. The job status is the simulation proof; refs are only promoted onto
  // the ProposalEnvelope when the owner moves it to ready.
  const simulated = simulator.project(input({
    proposal: proposal(),
    preparation: preparation(),
  }));
  assert.deepEqual(simulated, {
    status: "simulated",
    ruleRef: RULE_REF,
    sourceFingerprint: SOURCE_FINGERPRINT,
    proposalId: PROPOSAL_ID,
    candidateProposalRevision: PROPOSAL_REVISION,
    candidateContentHash: computeHomeAutomationMigrationCandidateContentHash(CONTENT),
    writesPerformed: false,
  });

  assert.deepEqual(simulator.project(input({
    proposal: proposal({ preparedArtifact: prepared }),
    preparation: preparation(),
  })), {
    status: "needs_attention",
    reason: "proposal_mismatch",
    writesPerformed: false,
  });
});

test("maps a prepared proposal with an exact content hash to ready", () => {
  const candidateProposalRevision = PROPOSAL_REVISION;
  const reviewProposalRevision = candidateProposalRevision + 1;
  const currentProposal = proposal({ lifecycle: "ready", revision: reviewProposalRevision });
  const result = simulator.project(input({
    proposal: {
      ...currentProposal,
      preparedContentHash: preparedContentHash(currentProposal),
      preparedArtifact: preparedArtifact(),
    },
    preparation: preparation({ proposalRevision: candidateProposalRevision }),
  }));

  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.proposalId, PROPOSAL_ID);
    assert.equal(result.candidateProposalRevision, candidateProposalRevision);
    assert.equal(result.reviewProposalRevision, reviewProposalRevision);
    assert.deepEqual(result.preparedArtifact, preparedArtifact());
    assert.equal(result.writesPerformed, false);
  }
});

test("keeps the fingerprint outside the ProposalEnvelope while binding it to rule and candidate content", () => {
  const result = simulator.project(input({
    proposal: proposal(),
    preparation: preparation(),
  }));

  assert.equal(result.status, "simulated");
  assert.equal("sourceFingerprint" in proposal(), false);
  if (result.status === "simulated") {
    assert.equal(result.sourceFingerprint, SOURCE_FINGERPRINT);
    assert.equal(result.ruleRef, RULE_REF);
    assert.match(result.candidateContentHash, /^sha256:[a-f0-9]{64}$/u);
  }
});

test("rejects a ready envelope with same or gapped preparation revision", async (t) => {
  const cases: readonly [string, number, number][] = [
    ["same revision", PROPOSAL_REVISION, PROPOSAL_REVISION],
    ["revision gap", PROPOSAL_REVISION, PROPOSAL_REVISION + 2],
  ];
  for (const [name, candidateRevision, reviewRevision] of cases) {
    await t.test(name, () => {
      const currentProposal = proposal({
        lifecycle: "ready",
        revision: reviewRevision,
        preparedContentHash: preparedContentHash(proposal({ revision: reviewRevision })),
        preparedArtifact: preparedArtifact(),
      });
      assert.deepEqual(simulator.project(input({
        proposal: currentProposal,
        preparation: preparation({ proposalRevision: candidateRevision }),
      })), {
        status: "needs_attention",
        reason: "proposal_mismatch",
        writesPerformed: false,
      });
    });
  }
});

test("returns fixed needs-attention reasons for binding and preparation failures", async (t) => {
  const cases: readonly [string, Partial<HomeAutomationMigrationSimulatorInput>, string][] = [
    ["rule mismatch", { ruleRef: "ha-rule:other" }, "rule_binding_mismatch"],
    ["fingerprint mismatch", { sourceFingerprint: `sha256:${"e".repeat(64)}` }, "source_fingerprint_mismatch"],
    ["candidate content mismatch", { candidate: { ...CANDIDATE, content: { ...CONTENT, actions: [{ kind: "notify_local", message: "changed" }] } } }, "candidate_mismatch"],
    ["preparation failure", { preparation: preparation({ status: "failed" }) }, "preparation_failed"],
    ["preparation revision mismatch", { preparation: preparation({ proposalRevision: PROPOSAL_REVISION + 1 }) }, "proposal_mismatch"],
    ["ready without preparation", { proposal: proposal({ lifecycle: "ready" }) }, "preparation_not_succeeded"],
  ];

  for (const [name, overrides, reason] of cases) {
    await t.test(name, () => {
      assert.deepEqual(simulator.project(input(overrides)), {
        status: "needs_attention",
        reason,
        writesPerformed: false,
      });
    });
  }
});

test("rejects malformed or provider-shaped candidate and proposal values without leaking details", async (t) => {
  const cases: readonly [string, Partial<HomeAutomationMigrationSimulatorInput>][] = [
    ["candidate extra field", { candidate: { ...CANDIDATE, nativeId: "secret" } }],
    ["candidate invalid content", { candidate: { ...CANDIDATE, content: { ...CONTENT, service: "light.turn_on" } } }],
    ["proposal missing candidate", { proposal: proposal({ artifactCandidate: undefined }) }],
    ["proposal wrong kind", { proposal: proposal({ kind: "household-insight" }) }],
    ["malformed preparation", { preparation: { status: "succeeded" } }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      const result = simulator.project(input(overrides));
      assert.deepEqual(result, {
        status: "needs_attention",
        reason: name === "malformed preparation" ? "preparation_unavailable" : name === "proposal wrong kind" || name === "proposal missing candidate" ? "proposal_unavailable" : "invalid_candidate",
        writesPerformed: false,
      });
      assert.equal(JSON.stringify(result).includes("secret"), false);
      assert.equal(JSON.stringify(result).includes("light.turn_on"), false);
    });
  }

  await t.test("proxy getter", () => {
    const candidate = new Proxy(CANDIDATE, {
      get() {
        throw new Error("provider getter");
      },
    });
    assert.deepEqual(simulator.project(input({ candidate })), {
      status: "needs_attention",
      reason: "invalid_candidate",
      writesPerformed: false,
    });
  });
});
