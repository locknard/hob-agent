# Aggregate-only home validation

## Purpose

Before enabling paid or autonomous Agent observation, a household operator
needs to know whether the configured bridges can produce one consistent neutral
HomeWorld snapshot. Starting the full Agent is a poor diagnostic because it
mixes bridge credentials, provider credentials, model calls, and scheduling.

`pnpm validate:home` therefore starts only the Hub-owned HomeWorld path with the
normal launch configuration. It waits for a bounded period and prints one JSON
report containing only:

- ready/not-ready status;
- configured and represented bridge counts;
- counts by closed bridge connection state;
- neutral space, device, capability, and current-state counts;
- mutually exclusive device counts with one, zero, or multiple accepted
  neutral space bindings; and
- the zero-space split between explicitly non-spatial objects and devices that
  still require household placement review; and
- counts by closed capability semantic kind; and
- available/unavailable neutral existing-rule catalog counts plus the aggregate
  number of visible rules; and
- aggregate counts of proposed device-identity links and capability bindings
  that still require governance review; and
- aggregate logical ingest-journal bytes used, maximum bytes, remaining bytes,
  utilization percentage, and the number of bridges that reported capacity.

The report never contains bridge IDs, native IDs, hub IDs, names, state values,
attributes, URLs, credentials, provider errors, or household prompt content.
Rule names, opaque references, epochs, and bridge identities are also omitted.
Identity proposal IDs, participating Hub IDs, identity claims, evidence, and
reasons are omitted as well; these counts indicate review work, not accepted
equivalence or authority.
Journal capacity contains no records or values. It is operational evidence:
the Phase 0 journal has a hard quota and fails closed at that boundary. The
report makes approaching exhaustion visible, but does not silently delete or
compress canonical evidence; retention still requires an explicit reviewed
policy.
Every configured bridge must also have delivered traffic to the current
process and completed a ready cut. A restored consistent SQLite cut remains
readable but cannot make validation return before the new adapter bootstrap
and its extension catalogs exist.
The command does not mount DSH, call a model, create a proposal, or enable the
observation schedule. It uses the normal private journal, registry, and world
model paths so the validation cut is the same cut the product will later read.

Credentials remain explicit environment input. The command must not discover
browser storage, enumerate Keychain, or scan unrelated files for a token.
