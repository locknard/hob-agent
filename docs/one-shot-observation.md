# Explicit one-shot home observation

## Decision

The first real-household Agent check must not require enabling a recurring
schedule. `pnpm observe:home` therefore mounts the normal HomeWorld, proposal
store, metadata-only observation audit, and DSH Home Agent, performs at most
one governed observation, reports a metadata-only outcome, and disposes the
runtime.

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
created, no proposal identity or content. A successful turn that found no
materially useful change reports `completed` with `proposal: "none"`; it is not
reported as a failure or as merely started.
