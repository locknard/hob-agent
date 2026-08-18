# Real-household Phase 0 pilot

Status: recommended next product step.

## Purpose

The project began with a household outcome, not a runtime migration: use local
home evidence to produce suggestions that a household considers useful and can
review safely. DSH, Cordis, neutral bridges, bounded evidence, conflict checks,
and the Inbox are now supporting infrastructure. The next proof is repeated
usefulness in one real home.

This pilot does not enable device control or automation installation. Approval
continues to record household judgment only.

## Stage 1 — model-free readiness

1. Run `pnpm validate:home` with the private bridge/data configuration.
2. Require a ready HomeWorld cut. Investigate unavailable bridges or missing
   watermarks before spending a model call.
3. Run `pnpm draft:home-map`, review the private `HOME.import.md`, and manually
   merge only accepted facts into `HOME.md`.
4. Treat unassigned and multiply assigned devices as known context gaps. A
   perfect map is not required, but the gaps must not be hidden.

No arbitrary 24-hour release age is required. Bootstrap state never counts as
behavior, and temporal tools already disclose when their requested window
predates the verified baseline. A quiet or newly started home may still support
a current-state insight, but not a claimed routine.

## Stage 2 — explicit observations

Start with `pnpm observe:home`; leave recurring observation disabled. Run a
small number of observations across ordinary household conditions rather than
repeating calls immediately against the same evidence.

After every run:

- open the persisted Inbox with `pnpm inbox:home`;
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
6. no approval, observation, Skill, plugin, or bridge path can apply a change.

Only after this loop produces repeatable value should the project choose a
Phase 1 artifact compiler/simulator or an authorized live Xiaomi transport.
Those are separate decisions; neither should be smuggled into the Agent loop.
