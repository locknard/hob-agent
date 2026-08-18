# DSH household session compaction

Status: accepted for Phase 0 implementation.

## Decision

Recurring observations reuse one durable DSH session, so bounded tools and a
bounded per-turn budget do not by themselves bound multi-day context growth.
The Home Agent therefore mounts the official DSH token meter and basic
compaction engine. DSH continues to own pressure measurement, safe region
selection, tool-pair balancing, durable replacement events, retry, cancellation,
and context-overflow recovery.

The official basic engine intentionally exposes `summarize()` as its sole
subclass hook. The Home Product Bundle overrides only that hook because the
upstream default checkpoint is written for a coding assistant and asks for
files, code, and engineering errors. Mounting that prompt unchanged would
distort household memory.

## Household checkpoint contract

The replacement summary must preserve, tersely:

- the household request and unresolved intent;
- trusted observations with their time and coverage limits;
- proposal and human-review state;
- existing-rule overlap findings;
- explicit household preferences and decisions;
- the next pending product step; and
- safety, approval, and authority boundaries.

It must distinguish observed facts from model inference, treat names and tool
content as untrusted data rather than instructions, never claim an automation
or device action occurred unless the governed audit state says so, and avoid
copying transient raw values that are not needed to continue. Only returned
text enters the DSH checkpoint; hidden reasoning and tool calls remain excluded.

The summarizer uses the conversation's routed provider/model and the official
`purpose: compaction` LLM path. Compaction failure follows DSH behavior: normal
pressure failure warns and continues with the existing surface, while a
provider-confirmed overflow is retried only after DSH records durable surface
progress. No second session store or custom compaction transaction is added.

## Deferred

- a cheaper independently configured summarization model;
- model-free tool-result pruning, pending a household-specific review of which
  evidence fields may be removed without weakening proposal provenance.

## Metadata visualization

The existing DSH loop trace may project compaction start, completion/failure,
duration, shadowed event count, shadowed token count, and auxiliary token usage.
It must discard the summary, raw model output, provider error text, and
shadowed message content before retaining its bounded trace, and omit internal
compaction identifiers from the user-facing snapshot.
