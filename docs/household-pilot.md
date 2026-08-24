# Real-household Phase 0 pilot

Status: recommended next product step.

## Purpose

The project began with a household outcome, not a runtime migration: use local
home evidence to produce suggestions that a household considers useful and can
review safely. DSH, Cordis, neutral bridges, bounded evidence, conflict checks,
and the Inbox are now supporting infrastructure. The next proof is repeated
usefulness in one real home.

This pilot is a real-household acceptance protocol, not a product trial state.
It adds no waiting period, second decision, or temporary automation lifecycle.
The read-side scenarios recorded below exercise observation only. They do not
prove native automation deployment. A real deployment scenario uses the normal
product path: a prepared exact plan receives one explicit enable decision, the
selected bridge installs its native automation, and the product verifies its
reported state before it calls the automation running.

## Stage 1 — model-free readiness

1. Run `pnpm validate:home` with the private bridge/data configuration.
2. Require a ready HomeWorld cut. Investigate unavailable bridges or missing
   watermarks before spending a model call.
3. Check `journalCapacity` in the same aggregate report. Do not begin an
   unattended pilot when the hard quota is close to exhaustion. Phase 0 fails
   closed at the quota and does not silently prune canonical evidence.
4. Run `pnpm draft:home-map`, review the private `HOME.import.md`, and manually
   merge only accepted facts into `HOME.md`.
5. Treat unassigned and multiply assigned devices as known context gaps. A
   perfect map is not required, but the gaps must not be hidden.

No arbitrary 24-hour release age is required. Bootstrap state never counts as
behavior, and temporal tools already disclose when their requested window
predates the verified baseline. A quiet or newly started home may still support
a current-state insight, but not a claimed routine.

## Stage 2 — explicit observations

Use `pnpm observe:home` once to verify the current-state path. Each invocation
starts a new bridge evidence epoch, so repeated one-shot processes cannot
establish a cross-run behavioral history.

For the actual pilot, start the full runtime with Inbox authentication enabled
and leave recurring observation disabled. Keep that process connected while
ordinary household activity accumulates, then use **Observe now** in its Inbox
at a few meaningful times. This preserves one evidence epoch while still
making every paid model turn an explicit household action.

The temporal tools have a one-hour minimum lookback. During the first hour of a
new epoch they correctly report `window_before_baseline`: events after startup
remain readable, but the missing prefix is unknown rather than quiet. Use an
early observation only to verify the current-state path; leave the runtime
connected for at least one hour before asking it to support a behavior-over-time
proposal. This is an evidence-coverage requirement, not a release-age rule.

## 2026-08-19 model-free household checkpoint

The real HA pilot completed the governed read path without a model call:

- four model-visible compact-inventory pages covered all 75 neutral devices
  after adaptive page budgeting (23, 24, 24, and four devices);
- four detailed snapshot pages covered the same 75 devices without native
  identity fields;
- the 12-rule catalog remained stable across three deliberately small pages;
- after one minute in a single verified epoch, four devices produced 24
  post-baseline activity events; and
- a bounded 20-capability evidence selection returned 23 provenance-bound
  events with no truncation.

Only aggregate counts are recorded. The checkpoint intentionally omits names,
Hub/native identities, state values, epochs, timestamps, URLs, and credentials.
Coverage was partial solely because the one-hour requested window began before
the fresh baseline, confirming the guard above on real household traffic.

A subsequent model-free DSH loop smoke used a scripted adapter against the same
real neutral HomeWorld. It completed the production workflow in 11 tool calls:
Skill load, calibration, four adaptive inventory pages, activity triage, one
candidate snapshot, bounded evidence, the complete rule catalog, and one
`insufficient_evidence` report. During that epoch the activity query counted 67
events and the selected evidence query returned 19 provenance-bound events.
The loop created no proposal. This proves the real 75-device read workflow fits
the fixed 12-call observation budget without weakening the no-proposal path;
it does not claim that a real provider/model will choose the same sequence or
produce a useful suggestion.

The same household then completed a continuous 61-minute epoch. At 30 minutes,
the old activity query reported 12 neutral devices and 1,415 events, but marked
the result truncated because its 50-row SQL limit incorrectly counted active
capabilities rather than devices. At 61 minutes, the requested one-hour window
no longer preceded the verified baseline; the remaining activity partial was
only that same query-shape defect. A read-only replay through the corrected
device-level grouping found 21 active bridge devices and 2,569 events in the
last hour without reaching the 50-device ceiling. The selected 20-capability
evidence page reached its intentional 200-event output cap, so it remained
honestly partial rather than being mistaken for complete history.

This long run also exposed two ingest sizing issues. The former 16 MiB logical
quota reached 48% in roughly half an hour. During an early 14-minute sample,
42% of comparable HA notifications repeated the preceding projected neutral
state, predominantly metadata churn rather than a new household observation.
The HA adapter now suppresses only consecutive equal neutral scalar states,
the journal defaults to a finite 256 MiB per-bridge quota, and aggregate
capacity is visible in `validate:home`. A fresh updated 10-minute epoch stayed
ready for all 75 devices, returned 13 active neutral devices and 291 events
without activity truncation, retained zero consecutive semantic duplicates,
and reported about 3% quota use. Both runs retained zero rejections and zero
history gaps. The larger quota supports the observed seven-day evidence rate.
An explicit, audited retention operation now exists, but its proposal-reference
collector and unattended scheduler are not yet wired into the production
service.

## Next household action after this checkpoint

The next product proof is one real reviewed model observation, not another
runtime migration. It requires explicit household input that the repository
must not discover on its own:

1. select a supported model route and provide its scoped credential;
2. create a local Inbox authentication token;
3. review the most consequential items among the 21 remaining placement gaps
   in the private home-map draft, while leaving uncertain items explicitly
   unresolved; and
4. start the updated full runtime with recurring observation disabled, keep one
   evidence epoch connected for at least an hour, then use **Observe now** and
   record one structured household review.

That outcome—not another synthetic loop—should decide the next product change.
The governed canonical-journal retention coordinator and read-only capacity
status are now mounted in production without a timer. Before a longer
unattended deployment, exercise its aggregate local preview and finish the
remaining incomplete-epoch and proposal-pin invariants before exposing any
apply operation. The bounded quota remains sufficient for this manual pilot
and must never trigger automatic deletion.

## 2026-08-25 M2 explanation checkpoint

An isolated model-free launch against the same real HA household reached a
ready HomeWorld cut with 74 neutral devices, 777 capabilities, 538 current
states, six spaces, and 12 readable foreign rules. The journal reported one
healthy capacity partition, and the launch created no identity-link or
capability-binding proposal. The separate HA bootstrap surface contained 79
devices and 15 automation entities.

The configured credential can call the admin-only `trace/contexts` command.
Only one of the 15 automation entities currently has a bounded stable
`unique_id`, however, and the retained context response did not provide one
complete safe association for this checkpoint. The adapter therefore did not
call `trace/get` and did not infer an item ID from an entity name or suffix.
This is the expected fail-closed result: recorder/history remains valid evidence
for what and when, while a missing stable automation identity keeps why at
rule-only or unknown coverage.

A later same-day read-only validation used the corrected state-derived
denominator and registry join. It reported 15 automation entities and 15 stable
trace identities, with aggregate coverage `complete`. This supersedes the
earlier coverage-planning assumption without rewriting that historical
checkpoint. Stable identity is no longer the household blocker; the remaining
M2 proof is a naturally occurring automation event whose exact context remains
retained long enough for the governed causality-to-trace path.

The next M2 acceptance run keeps one ready epoch open until ordinary household
activity produces a `foreign_rule` causality event for an automation with a
stable ID. It then follows the exact evidence provenance through
`get_home_causality` and `automationTrace@1`. The operator first reviews the
read-only stable-ID coverage in the aggregate `pnpm validate:home` report. If a
later validation becomes partial, the household may add IDs in Home Assistant
through an explicit maintenance decision when broader explanation coverage is
desired.
The pilot never triggers an automation merely to manufacture evidence.

Run the bounded model-free listener with the same private bridge configuration:

```sh
HOB_TRACE_BRIDGE_ID='<configured-bridge-id>' \
  pnpm pilot:home-automation-trace --timeout-seconds 60
```

The timeout accepts an integer from 1 through 900 seconds. Standard output is
one redacted JSON result containing only outcome, status, run state/outcome,
and closed reasons. `not_observed` is a valid quiet-window result.

After every run:

- return to the full runtime Inbox;
- review the proposal, if any, before another observation;
- approve only when useful as-is;
- otherwise select the most accurate structured rejection reason and add a
  note only when it helps the household remember its decision; and
- inspect the recent run's duration, token counters, tool count, failures, and
  no-proposal disposition.

The next autonomous turn reads the fixed bounded review-calibration window.
Feedback remains preference evidence; it does not edit household files, grant
authority, or waive current evidence and conflict checks.

## Stage 3 — decide from observed metrics

Evaluate the pilot after several reviewed observations, not after one lucky
proposal. Useful signals are:

- approvals marked useful as-is;
- rejection concentration in already-covered, incorrect-assumption,
  insufficient-evidence, preference-mismatch, or risk reasons;
- repeated no-proposal dispositions;
- proposal mapping gaps and existing-rule overlap findings;
- cumulative and per-run model tokens, tool calls, failures, and duration; and
- whether rejected topics recur after their feedback becomes visible.

Pause rather than increase cadence when suggestions repeat, rule catalogs are
unavailable, evidence is repeatedly insufficient, mapping uncertainty is high,
or tool failures occur. Fix the relevant read-side capability or household map
before changing prompts or budgets.

## Stage 4 — opt-in cadence

Enable `HOB_OBSERVATION_INTERVAL_MINUTES` only after manual runs are stable and
the household is consistently reviewing the Inbox. Begin conservatively; the
Hub already suppresses observations while a proposal is pending, while the
Agent is busy, or while HomeWorld is not ready.

Do not make the 12-call/120-second limits tenant-tunable during the pilot. Use
the persisted metrics to justify any later change. Do not infer monetary cost
from token counts without a separately reviewed, current provider-pricing
source.

## Exit criteria

Phase 0 is product-proven when the household can repeat this loop:

1. a neutral bridge observes the home;
2. DSH reads calibration, full inventory coverage, bounded current/temporal
   evidence, and complete existing-rule metadata;
3. at most one materially useful review item is produced, or a bounded reason
   for producing none is recorded;
4. the household reviews it with structured feedback;
5. the next observation demonstrably incorporates that feedback; and
6. every persistent change follows the reviewed plan, one enable decision,
   bridge deployment, state read-back, and audit path; every one-shot action
   follows its consequence-based confirmation and verification path.

Only after this loop produces repeatable value should the project choose its
next ecosystem execution expansion, such as an authorized live Xiaomi
transport. That is a separate decision; it does not create another Agent loop.
