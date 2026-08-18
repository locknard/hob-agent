# Autonomous observation budget

## Decision

The Home Product Bundle owns a bounded policy for each autonomous household
observation. The policy is implemented through DSH's tool guard and Agent
cancellation surfaces. It does not wrap, fork, or replace the DSH Agent loop.

An observation may execute at most 12 governed tool calls and may run for at
most 120 seconds. The thirteenth call is denied before its tool body runs. A
tool-budget or wall-clock breach cancels the active observation turn and the
observation is reported as failed. Interactive Agent turns are not subject to
this product-specific budget.

The deadline uses `@deepseek-ai/dsh-timeout` for official signal fusion, then
cancels through the Agent surface because the timeout library intentionally
only delivers abort notification. The existing one-shot process deadline
remains an outer process bound for explicit observations.

## Why this belongs outside the core loop

DSH intentionally has no built-in turn budget. It treats runaway-turn policy as
an application concern implemented at lifecycle extension points. Household
observation has product-specific costs and risks: a real home may contain many
devices, inventory pages, evidence pages, and rules, while an ordinary chat
turn should not silently inherit the same limit.

At the current observed home scale, a normal useful path needs about six calls:
two inventory pages, one detailed snapshot, one evidence read, one rule read,
and at most one proposal. Twelve permits bounded correction and pagination
without allowing an open-ended loop.

## Safety properties

- Only calls made on behalf of the active autonomous observation Agent count.
- Every governed tool execution counts, including failed and nested calls.
- The call that exceeds the limit never reaches its tool implementation.
- Exhaustion cancels the current turn while preserving independently queued
  inbox work.
- Budget state is reset in `finally`, including cancellation and failures.
- The proposal review, approval, execution, and audit boundaries are unchanged.

## Deferred work

Do not make either limit tenant-configurable until real observation traces show
a need. If Code Mode is introduced, re-evaluate whether an outer `run_code` call
and its nested capability calls should both count; the conservative current
rule counts every actual execution.
