# Governed action plane

Status: proposed implementation sequence after the real-household Phase 0 exit gate.

## Product boundary

The action plane turns one reviewed household proposal into an exact, auditable
artifact operation. It is not an Agent tool that controls devices. DSH remains
the sole Agent runtime; the Hub owns policy, approval binding, execution,
verification, and audit.

Phase 0 continues to terminate at review. This document freezes the next
cross-package invariants before `actions@1` or `artifactHost@1` production code
is introduced.

```text
DSH Agent proposal
  -> Hub evidence/conflict binding
  -> neutral artifact draft
  -> compiler + dry run
  -> exact human approval ticket
  -> Hub executor
  -> bridge action authority / artifact host
  -> postcondition verification + audit
```

## Approval is a capability, not a boolean

An approval ticket must bind all of the following:

- proposal id and immutable proposal revision;
- canonical artifact bytes and artifact hash;
- compiler id and version;
- selected action route or artifact host;
- policy version and risk class;
- affected Hub capability ids only, never adapter-native ids;
- the exact authority target for every affected capability: Hub bridge id,
  catalog-owned adapter type, bridge-registry binding generation, and the
  bound remote-instance identity; these fields are Hub-produced and are never
  accepted from model or plugin output;
- the per-bridge consistent watermark vector used by the dry run;
- expected postconditions and bounded verification deadline;
- approval principal, issue time, expiry, and one-use nonce.

Changing any bound field invalidates the ticket and returns the artifact to
review. Approval never grants a plugin, Skill, model, or bridge permission to
select a different target or operation.

The nonce is claimed exactly once in the same Hub transaction that changes the
ticket from `approved` to `executing` and appends its audit-start record. That
transaction compares the complete immutable ticket tuple above, not only the
nonce or artifact hash, and must commit before any remote call. A concurrent or
replayed claimant observes an already-consumed ticket and performs no bridge
operation. A committed claim is never released for retry, including when the
process cannot prove that the remote call started.

## Canonical state machines

Artifact lifecycle:

```text
draft -> compiled -> simulated -> awaiting_approval -> approved
approved -> executing -> applied -> verified
approved -> executing -> failed
approved -> executing -> indeterminate
verified -> superseded | rollback_proposed
```

`indeterminate` is terminal for automatic execution. The Hub must inspect the
target through a fresh consistent read or request explicit household review;
it must never automatically retry a possibly applied action.

Before accepting new execution work at startup, a recovery sweep changes every
durable `executing` record without a terminal result to `indeterminate` and
appends a recovery audit record. This includes a crash immediately after the
atomic claim/audit transaction and before the bridge invocation: safety takes
precedence over guessing that nothing happened. Only a new household-reviewed
ticket may authorize a later attempt. Timeouts, lost acknowledgements, and
unclassified bridge failures also resolve to `indeterminate`, never `failed`.

The proposal review record remains separate. Approving a proposal permits an
exact artifact ticket to be prepared; it does not itself mean the artifact was
compiled, installed, enabled, or executed.

## Neutral artifact first slice

The first artifact kind is a bounded event-condition-action automation draft.
It supports only reviewed neutral capability predicates, bounded schedules,
and low-risk reversible actions. It cannot embed ecosystem payloads, template
languages, shell commands, arbitrary URLs, or plugin executable code.

Initial risk classes:

- `observe_or_notify`: local notification and record-only effects;
- `comfort_reversible`: lighting, curtain, and bounded climate preference
  changes with an explicit previous-state or previous-artifact restore path;
- `safety_sensitive`: locks, access control, cooking, water, gas, alarms,
  medical, and destructive device operations; unavailable in the first slice.

Risk is computed by Hub policy from the canonical artifact and selected
capabilities. A model-authored risk label is presentation data only.

## Bridge extensions

`actions@1` executes bounded immediate operations through the explicitly
configured action authority for each Hub capability. `artifactHost@1` installs,
updates, disables, and removes compiled persistent artifacts. Neither extension
may request authority from its own payload.

Both extensions require:

- Hub-generated idempotency keys and adapter-edge deduplication;
- structured `applied | failed | indeterminate` results;
- bounded timeouts and cancellation semantics;
- no raw provider errors or native identifiers in household-facing output;
- post-operation resync support;
- conformance tests shared by HA, Xiaomi, and future bridges.

The Hub Artifact Registry is the source of truth. HA automation ids, Xiaomi
rule ids, labels, and tags are adapter bindings and recovery hints, not
ownership proof.

## Execution ownership

Only a Hub executor may consume an approval ticket. It revalidates the complete
immutable ticket tuple: proposal revision, canonical artifact and compiler,
policy and risk, postconditions, expiry, action route, affected capabilities,
bridge id, adapter type, binding generation, remote-instance identity, bridge
readiness, and relevant watermarks. It then atomically claims the nonce,
changes the record to `executing`, and writes the audit start before invoking a
bridge. A bridge rebind, adapter migration, authority change, or stale
watermark invalidates the ticket. The executor writes the terminal result
transactionally before presenting completion.

DSH may explain, draft, compile through a governed proposal tool, or answer a
question. It cannot receive the ticket secret, call the executor, or interpret
approval UI state as authority.

## Implementation milestones

1. **M3b — artifact contract and registry:** freeze the Zod-first neutral
   artifact, canonical hashing, immutable revisions, and non-applying registry.
2. **M3c — neutral compiler and simulation:** compile one neutral artifact to a
   provider-independent in-memory plan, render an exact neutral diff, evaluate
   current existing-rule overlap, and persist no remote change. HA-specific
   rendering begins behind the later reviewed `artifactHost@1` seam in M3e; it
   is not part of the Agent-facing or neutral M3c contract.
3. **M3d — approval ticket and executor shell:** issue one-use exact tickets,
   persist execution audit, atomically claim the complete ticket tuple, recover
   orphaned `executing` rows as `indeterminate`, and use a synthetic bridge plus
   concurrent/crash injection to prove replay, failed, and indeterminate
   behavior.
4. **M3e — `artifactHost@1` HA implementation:** install only disabled
   low-risk artifacts first; require a second explicit activation decision.
5. **M3f — reversible actions:** enable the reviewed comfort subset with
   postcondition verification and rollback proposals.
6. **M3g — Xiaomi parity:** implement the same conformance surface only after
   an authorized native Xiaomi transport is available.

## Entry and exit gates

M3b does not start until the real-household pilot has repeated useful reviews
and canonical retention supports unattended evidence. Production execution is
not enabled until the Control Center can show the exact artifact diff,
authority route, evidence freshness, risk, ticket expiry, result, and rollback
state.

The first action-plane release exits only when crash injection proves that no
restart can turn `indeterminate` into an automatic retry, every remote write is
linked to one exact approval ticket, and uninstalling a plugin cannot erase or
reinterpret the Hub audit trail.
