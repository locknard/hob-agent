# Home observation audit

Autonomous household observation is a product-owned operation, even though the
reasoning loop runs on DSH. The Hub therefore keeps a small durable audit ledger
that is separate from DSH session persistence and diagnostic traces.

Each attempt records only a generated run id, its trigger (`startup`,
`scheduled`, `manual`, or `one_shot`), start and completion timestamps, and the
closed product outcome. A `no_proposal` attempt may additionally retain one
bounded, explicitly Agent-reported disposition; see
[`observation-disposition.md`](observation-disposition.md). It must not persist prompts, model responses, tool
arguments or results, native bridge identifiers, device names, capability
values, credentials, or arbitrary exception text.

The Hub writes a `running` row before it asks the Agent to observe and completes
that same row after the governed operation returns. A row left running after a
process interruption is presented as `interrupted`; it is not silently treated
as success or retried. Failure to start the audit row prevents the autonomous
operation. Failure to complete it is surfaced as an audit failure rather than
being hidden by an in-memory status.

An explicit manual observation propagates either audit failure to its caller.
The recurring scheduler additionally records an in-memory `failed` last
attempt and continues at the next configured boundary; one local SQLite error
must not silently terminate scheduling while the Inbox still says it is
enabled. This recovery never runs the model when the audit start itself failed.

The Inbox may read the bounded recent ledger to explain whether observation is
working when no proposal exists. DSH traces remain optional debugging material;
they are not the household governance record and are never copied into this
ledger.

All-time lifecycle, outcome, and bounded disposition counts are available to
the local Inbox without attempt identities or content; see
[`household-calibration-summary.md`](household-calibration-summary.md).
