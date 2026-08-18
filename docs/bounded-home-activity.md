# Bounded home activity discovery

## Evidence

The Phase 0 household has roughly 75 devices and 779 capability instances.
Complete compact inventory discovery prevents first-page bias, but names,
semantic kinds, and opaque ordering still do not tell the Agent which parts of
the home have actually changed since the current verified bridge baseline.
Choosing detailed candidates from those fields alone can waste the bounded
tool budget or over-focus on familiar device names.

## Decision

The Hub exposes a bounded, read-only activity index over post-baseline live
state events. The DSH `get_home_activity` tool returns at most 50 neutral device
summaries containing only:

- opaque Hub device identity;
- aggregate state-event count;
- latest Hub receive timestamp; and
- accepted semantic kinds represented by those events.

It never returns state values, capability/native identities, device or room
names, schemas, rule content, credentials, or arbitrary bridge data. Results
are ordered by event count, latest observation time, then opaque Hub identity.
The query has a bounded lookback and reports per-bridge baseline/coverage gaps
and truncation.

Because the minimum lookback is one hour, a newly started epoch reports
`window_before_baseline` until it has observed the entire requested interval.
Post-baseline events are still returned, but the unobserved prefix is unknown,
not evidence that nothing happened. A behavior-over-time proposal must wait for
complete coverage or use a different source with explicit provenance.

The index is a discovery aid, not behavioral evidence. High activity may be
noise, integration churn, or repeated identical updates. An Agent must still
select a small candidate set, read its detailed snapshot, and use
`get_home_evidence` before claiming a routine or creating a behavior-based
proposal. Bootstrap state remains excluded.

This is an internal Hub/DSH capability. It does not revise the process-external
bridge contract and grants no device or rule authority.
