# Explicit one-shot home observation

## Decision

The first real-household Agent check must not require enabling a recurring
schedule. `pnpm observe:home` therefore mounts the normal HomeWorld, proposal
store, metadata-only observation audit, and DSH Home Agent, performs at most
one governed observation, reports a metadata-only outcome, and disposes the
runtime.

Every invocation creates a fresh bridge evidence epoch and disposes it after
the attempt. The command can validate the static/current-state path, but its
separate invocations cannot accumulate cross-day behavioral evidence. Use a
long-running full runtime and its authenticated **Observe now** control for
that pilot.

Invoking the command is an explicit request to call the configured model. The
model may receive the same bounded household snapshot, evidence, existing-rule
metadata, and household prompt context available to the production Home Agent;
the provider may charge for that request. The command never prints those tool
inputs, model text, rule or device names, proposal content, credentials, URLs,
or raw errors.

## Governance

The one-shot path uses the same Hub-owned gates as periodic observation:

- wait for a consistent ready HomeWorld cut;
- do not run while a proposal is already pending review;
- require the DSH Home Agent to be idle;
- create at most one review-only proposal through the governed tool; and
- keep device control, rule installation, and proposal application absent.

An existing pending proposal is reported without calling the model. World
readiness and the model turn have independent bounded timeouts. The command
does not mount the recurring scheduler or the Inbox HTTP listener even when
their environment settings are present. It uses the normal private SQLite
paths, so a created proposal remains available to the regular Inbox afterward.
The Hub starts the audit record before waiting for readiness or calling the
model and completes it with the same closed product outcome. A process restart
marks an unfinished attempt as interrupted rather than success.

The JSON result contains only the stable outcome and whether a new proposal was
created, no proposal identity or content. A successful turn that creates none
reports `completed` with `proposal: "none"` and may include one bounded
Agent-reported `disposition`. The Hub does not infer a missing disposition or
treat the Agent's category as trusted evidence.
