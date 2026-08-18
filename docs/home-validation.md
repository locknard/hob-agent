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
- counts by closed capability semantic kind.

The report never contains bridge IDs, native IDs, hub IDs, names, state values,
attributes, URLs, credentials, provider errors, or household prompt content.
The command does not mount DSH, call a model, create a proposal, or enable the
observation schedule. It uses the normal private journal, registry, and world
model paths so the validation cut is the same cut the product will later read.

Credentials remain explicit environment input. The command must not discover
browser storage, enumerate Keychain, or scan unrelated files for a token.
