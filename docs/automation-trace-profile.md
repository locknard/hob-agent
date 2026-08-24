# ForeignRules automation trace companion (`automationTrace@1`)

This decision freezes the smallest Phase 0 automation-trace read boundary as a
separately negotiated companion within the platform ForeignRules profile. It
supports an exact live Home Assistant context association for the M2 question
“why did this change?” without adding an automation runtime, a trace store, or
write authority.

## Contract

The optional declaration is:

```ts
AUTOMATION_TRACE_EXTENSION = { id: "automationTrace", version: "1.0.0" }
AUTOMATION_TRACE_EXTENSION_KEY = "automationTrace@1"
```

The handle exposes one method:

```ts
readTrace(
  request: {
    ruleRef: string;                 // 1..200, opaque foreignRules@2 ref
    target: {
      epochId: string;               // 1..256
      seq: number;                   // positive safe integer
    };
  },
  options: { readonly signal: AbortSignal },
): Promise<AutomationTraceResult>
```

The same `automationTrace@1` handle may optionally expose a read-only
`coverage({ signal })` method. This additive method preserves existing
third-party `readTrace` handles; a handle without it is `unavailable` at the
Hub validation surface. The Hub owns the abort signal and a bounded deadline,
then rechecks adapter identity, lifecycle, readiness, and watermark before
accepting the result. It returns only bounded aggregate counts:

```ts
type AutomationTraceCoverage = {
  status: "complete" | "partial" | "unavailable";
  totalAutomationEntities: number;
  stableTraceIdentityEntities: number;
  missingTraceIdentityEntities: number;
  ambiguousTraceIdentityEntities: number;
};
```

The denominator is the bounded bootstrap state set of `automation.*` entities;
each state entity is joined to exactly one matching registry row before its
explicit unique, non-conflicting stable identity is counted. Registry-only
orphans do not inflate the denominator. The counts contain no entity, rule,
name, epoch, or provider value. `complete`/`partial` describe identity
prerequisites only; they do not prove trace permission, retention, or a
retained live context.

The request is strict. The Hub derives `ruleRef` and `target` from a current
catalog and accepted live state; an agent does not invent either value.

The result is a strict discriminated union:

```ts
type AutomationTraceResult =
  | { status: "complete"; ruleRef: string; target: Target; run: Run }
  | { status: "partial"; ruleRef: string; target: Target; run: Run; reasons: Reason[] }
  | { status: "unknown"; ruleRef: string; target: Target; reasons: Reason[] }
  | { status: "unavailable"; ruleRef: string; target: Target; reasons: Reason[] };
```

`complete` has no reasons. The other statuses have at least one unique reason
from this closed set:

```text
permission_denied, bridge_not_ready, busy, timeout, cancelled,
invalid_response, trace_not_retained, rule_not_found, association_missing,
association_stale, resync_stale, unsupported_trace
```

Status and reason carry one meaning. `partial` accepts only
`invalid_response` or `unsupported_trace` alongside an exact run.
`unknown` accepts trace retention, rule/association, resync, unsupported, or
invalid-response uncertainty. `unavailable` accepts permission, readiness,
busy, timeout, cancellation, unsupported, or invalid-response failures.
`trace_not_retained` is therefore always unknown rather than unavailable.

`Run` contains only these neutral fields:

```ts
type Run = {
  automationLabel?: string; // 1..256
  state: "running" | "completed" | "failed" | "unknown";
  outcome: "completed" | "condition_not_met" | "failed" | "cancelled" | "unknown";
  startedAt?: string;       // ISO timestamp with offset
  finishedAt?: string;      // ISO timestamp with offset
  steps: Array<{
    ordinal: number;        // 1..32, unique
    kind: "trigger" | "condition" | "action" | "wait" | "branch" | "unknown";
    status: "executed" | "passed" | "skipped" | "failed" | "unknown";
    errorKind?: "action_failed" | "template_failed" | "timeout" | "unknown";
  }>;
  truncated: boolean;
};
```

The contract contains no `traceRef`, `runId`, context object, native/provider
identifier, configuration, or free-form error text. It does not contain a
recorder field. `causality@1` remains the live event cause extension; this
profile provides a bounded read of the associated automation run.

## Evidence and lifecycle rules

The adapter returns `complete` only when it has an explicit, validated live
context association for the requested state and rule. A timestamp, matching
device, matching state value, or nearby trace step is not an association. A
recorder/history row can establish what was recorded and when, but it cannot
establish why; recorder time matching therefore returns `unknown` with
`association_missing`.

The Hub captures the current epoch and sequence before the call and verifies
the same lifecycle after the call. A bridge restart or resync creates a new
epoch and invalidates the read; the result is `resync_stale` and no evidence is
persisted. A same-epoch sequence advance does not by itself invalidate the
read, but the requested target remains exact.

The handle is read-only. It never writes the live journal, imported-history
partition, watermark, snapshot manifest, world model, proposal, artifact, or
automation state.

The adapter keeps raw Home Assistant trace data private, including native run
IDs, context IDs, entity/service IDs, configuration, blueprint inputs,
templates, credentials, and provider error text. Only the bounded neutral
projection above crosses the contract. Product/Agent projections further map
the result to neutral attribution and status; they do not expose provider
identity or raw trace content.

## Honest degradation and budgets

Home Assistant trace access is permissioned and trace retention is bounded and
configurable. Missing admin permission is `unavailable: permission_denied`.
An absent or purged trace is `unknown: trace_not_retained`; it does not prove
that the automation did not run. Unsupported domains return
`unavailable: unsupported_trace`. Malformed, oversized, or stale responses
return the corresponding closed reason and never become a successful run.

The adapter enforces one in-flight read per bridge, a 5-second abortable
deadline, a 256 KiB raw response cap, a 64 KiB normalized result cap, and at
most 32 projected steps. It does not enumerate the whole rule catalog or
expose a generic `trace/list`/`trace/get` method. Raw overflow or malformed
data produces `invalid_response`; a step projection that reaches its bound is
`partial` with reason `invalid_response` and sets `truncated: true`.

## Acceptance boundary

Focused contract and adapter tests must prove:

1. Every request, result, reason, run, and step rejects unknown fields and all
   native/provider fields.
2. Complete results require explicit live association; equal timestamps alone
   produce `unknown`.
3. Permission denial, retention loss, timeout, cancellation, malformed data,
   unsupported trace, and stale association map to fixed reasons.
4. Restart/resync invalidates the read without changing journal, watermark, or
   world state.
5. Raw trace values never reach Hub core, Agent, or Product Shell.

The HA adapter may use its permissioned trace API internally, but it must
return only this schema. A future contract revision is required for recorder
correlation, richer trace identity, or any additional authority.
