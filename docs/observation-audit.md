# Home observation audit

Autonomous household observation is a product-owned operation, even though the
reasoning loop runs on DSH. The Hub therefore keeps a small durable audit ledger
that is separate from DSH session persistence and diagnostic traces.

Each attempt records only a generated run id, its trigger (`startup`,
`scheduled`, `manual`, or `one_shot`), start and completion timestamps, and the
closed product outcome. It must not persist prompts, model responses, tool
arguments or results, native bridge identifiers, device names, capability
values, credentials, or arbitrary exception text.

The Hub writes a `running` row before it asks the Agent to observe and completes
that same row after the governed operation returns. A row left running after a
process interruption is presented as `interrupted`; it is not silently treated
as success or retried. Failure to start the audit row prevents the autonomous
operation. Failure to complete it is surfaced as an audit failure rather than
being hidden by an in-memory status.

The Inbox may read the bounded recent ledger to explain whether observation is
working when no proposal exists. DSH traces remain optional debugging material;
they are not the household governance record and are never copied into this
ledger.
