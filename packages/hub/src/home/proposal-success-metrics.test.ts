import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateProposalSuccessMetrics,
  type ProposalSuccessMetricsInputRow,
} from "./proposal-success-metrics.js";

const AS_OF = "2026-03-01T00:00:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

type EventAction =
  | "created"
  | "approved"
  | "rejected"
  | "expired"
  | "deployment_verified"
  | "paused"
  | "resumed"
  | "closed"
  | "recovery_required"
  | "recovery_started"
  | "recovery_failed"
  | "drift_detected"
  | "drift_restored";

function event(action: EventAction, at: string, revision: number): Record<string, unknown> {
  return { id: `audit-${revision}`, at, action, actor: "system", revision };
}

function automationPayload(options: {
  readonly id: string;
  readonly status?: "pending_review" | "approved" | "rejected" | "expired";
  readonly lifecycle?: string;
  readonly events: readonly Record<string, unknown>[];
  readonly kind?: string;
  readonly createdAt?: string;
  readonly verifiedAt?: string;
  readonly deploymentStatus?: "verified" | "failed" | "rolled_back";
}): Record<string, unknown> {
  const createdAt = options.createdAt ?? CREATED_AT;
  const verifiedAt = options.verifiedAt ?? "2026-01-01T00:00:00.000Z";
  const hasVerifiedEvent = options.events.some((candidate) => candidate.action === "deployment_verified");
  return {
    id: options.id,
    schemaVersion: "1",
    kind: options.kind ?? "automation-draft",
    status: options.status ?? "approved",
    revision: options.events.length,
    createdAt,
    updatedAt: options.events.at(-1)?.at ?? createdAt,
    lifecycle: options.lifecycle ?? "active",
    audit: options.events,
    ...(hasVerifiedEvent ? {
      deployment: {
        status: options.deploymentStatus ?? "verified",
        requestedAt: verifiedAt,
        deploymentId: `deployment-${options.id}`,
        target: "ha-main",
        verifiedAt,
      },
    } : {}),
  };
}

function row(payload: Record<string, unknown>): ProposalSuccessMetricsInputRow {
  return {
    proposalId: String(payload.id),
    status: String(payload.status),
    revision: Number(payload.revision),
    createdAt: String(payload.createdAt),
    updatedAt: String(payload.updatedAt),
    payloadJson: JSON.stringify(payload),
  };
}

function reviewedEvents(action: "approved" | "rejected" | "expired"): readonly Record<string, unknown>[] {
  return [event("created", CREATED_AT, 1), event(action, "2026-01-02T00:00:00.000Z", 2)];
}

function verifiedEvents(...extra: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return [
    event("created", CREATED_AT, 1),
    event("approved", CREATED_AT, 2),
    event("deployment_verified", CREATED_AT, 3),
    ...extra,
  ];
}

test("computes one-decision enable rate without counting unreviewed or non-automation proposals", () => {
  const result = aggregateProposalSuccessMetrics([
    row(automationPayload({ id: "approved", events: reviewedEvents("approved") })),
    row({
      ...automationPayload({ id: "rejected", status: "rejected", events: reviewedEvents("rejected") }),
      lifecycle: "closed",
    }),
    row(automationPayload({ id: "pending", status: "pending_review", lifecycle: "ready", events: [event("created", CREATED_AT, 1)] })),
    ...["household-insight", "identity-link", "capability-binding", "action-authority-binding"].map((kind) => row(
      automationPayload({ id: kind, kind, events: reviewedEvents("approved") }),
    )),
  ], AS_OF);

  assert.equal(result.outcome, "metrics");
  if (result.outcome !== "metrics") return;
  assert.equal(result.reviewedProposalCount, 2);
  assert.equal(result.enableDecisionCount, 1);
  assert.equal(result.enableRate, 0.5);
  assert.equal(result.unreviewedProposalCount, 1);
  assert.equal(result.excludedProposalCount, 4);
});

test("excludes proposals and review decisions that are created or decided after as-of", () => {
  const result = aggregateProposalSuccessMetrics([
    row(automationPayload({
      id: "future-created",
      createdAt: "2026-04-01T00:00:00.000Z",
      events: reviewedEvents("approved"),
    })),
    row(automationPayload({
      id: "future-decided",
      status: "approved",
      events: [
        event("created", CREATED_AT, 1),
        event("approved", "2026-03-02T00:00:00.000Z", 2),
      ],
    })),
  ], AS_OF);

  assert.equal(result.outcome, "metrics");
  if (result.outcome !== "metrics") return;
  assert.equal(result.reviewedProposalCount, 0);
  assert.equal(result.enableDecisionCount, 0);
  assert.equal(result.enableRate, null);
  assert.equal(result.unreviewedProposalCount, 1);
});

test("uses the audit history at each 30-day maturity boundary and separates survival outcomes", () => {
  const result = aggregateProposalSuccessMetrics([
    row(automationPayload({ id: "surviving", events: verifiedEvents() })),
    row(automationPayload({
      id: "disabled",
      lifecycle: "paused",
      events: verifiedEvents(event("paused", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "closed",
      lifecycle: "closed",
      deploymentStatus: "rolled_back",
      events: verifiedEvents(event("closed", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "rollback",
      lifecycle: "recovery_required",
      deploymentStatus: "failed",
      events: verifiedEvents(event("recovery_required", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "unknown",
      events: verifiedEvents(event("drift_detected", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "closed-after-maturity",
      lifecycle: "closed",
      deploymentStatus: "rolled_back",
      events: verifiedEvents(event("closed", "2026-02-15T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "immature",
      verifiedAt: "2026-02-15T00:00:00.000Z",
      events: [
        event("created", "2026-02-15T00:00:00.000Z", 1),
        event("approved", "2026-02-15T00:00:00.000Z", 2),
        event("deployment_verified", "2026-02-15T00:00:00.000Z", 3),
      ],
    })),
  ], AS_OF);

  assert.equal(result.outcome, "metrics");
  if (result.outcome !== "metrics") return;
  assert.deepEqual(result.survival, {
    windowDays: 30,
    maturedCohortCount: 6,
    immatureCohortCount: 1,
    survivingCount: 2,
    disabledCount: 1,
    closedCount: 1,
    rollbackCount: 0,
    unknownCount: 2,
    evidenceStatus: "unknown_present",
    survivalRate: null,
  });
});

test("remembers a pause during the first 30 days even when the automation resumes", () => {
  const result = aggregateProposalSuccessMetrics([
    row(automationPayload({
      id: "paused-then-resumed",
      events: verifiedEvents(
        event("paused", "2026-01-10T00:00:00.000Z", 4),
        event("resumed", "2026-01-11T00:00:00.000Z", 5),
      ),
    })),
  ], AS_OF);

  assert.equal(result.outcome, "metrics");
  if (result.outcome !== "metrics") return;
  assert.equal(result.survival.disabledCount, 1);
  assert.equal(result.survival.survivingCount, 0);
  assert.equal(result.survival.survivalRate, 0);
});

test("reports a numeric survival rate only when every matured outcome is known", () => {
  const result = aggregateProposalSuccessMetrics([
    row(automationPayload({ id: "surviving", events: verifiedEvents() })),
    row(automationPayload({
      id: "disabled",
      lifecycle: "paused",
      events: verifiedEvents(event("paused", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "closed",
      lifecycle: "closed",
      deploymentStatus: "rolled_back",
      events: verifiedEvents(event("closed", "2026-01-20T00:00:00.000Z", 4)),
    })),
    row(automationPayload({
      id: "rollback",
      lifecycle: "closed",
      deploymentStatus: "rolled_back",
      events: verifiedEvents(
        event("recovery_required", "2026-01-20T00:00:00.000Z", 4),
        event("recovery_started", "2026-01-21T00:00:00.000Z", 5),
        event("recovery_failed", "2026-01-22T00:00:00.000Z", 6),
        event("closed", "2026-01-23T00:00:00.000Z", 7),
      ),
    })),
  ], AS_OF);

  assert.equal(result.outcome, "metrics");
  if (result.outcome !== "metrics") return;
  assert.equal(result.survival.survivalRate, 0.25);
  assert.equal(result.survival.evidenceStatus, "complete");
});

test("fails closed with the missing durable audit field instead of guessing history", () => {
  const result = aggregateProposalSuccessMetrics([
    row({
      ...automationPayload({ id: "missing-audit", events: [event("created", CREATED_AT, 1)] }),
      audit: undefined,
    }),
  ], AS_OF);

  assert.deepEqual(result, {
    schemaVersion: "1",
    outcome: "insufficient_evidence",
    asOf: AS_OF,
    scope: "automation_proposals",
    readMode: "durable_only",
    reason: "missing_audit_history",
    missingDurableField: "proposal.audit",
    remoteWritesPerformed: false,
    localWritesPerformed: false,
  });
});
