# Existing-rule coverage gate

## Evidence and API boundary

The real Phase 0 household has roughly 12 active/configured Home Assistant
automations. The neutral `foreignRules@1` extension exposes their bounded names,
enabled state, timestamps, and opaque rule references. Until now, the trusted
prompt asked the Agent to inspect that catalog, but proposal creation did not
prove that every page had been read.

Home Assistant's documented REST API does not expose a stable endpoint for
reading every automation's full configuration. Its developer automation API is
also explicitly marked as active development and may change without a
deprecation notice. Phase 0 therefore does not call private
`config/automation/...` endpoints, read `automations.yaml`, or send raw
triggers/actions/templates to the model.

References:

- <https://developers.home-assistant.io/docs/api/rest/>
- <https://developers.home-assistant.io/docs/automations/>

## Decision

During an autonomous observation, `get_home_rules` now produces a stable
catalog version and records a strict ordered pagination sequence. The first
call starts without a cursor; subsequent calls must use the exact returned
cursor while retaining the same catalog version and total rule count. Proposal
creation remains closed until the final page is read. A new first page may
restart an invalidated sequence.

Unavailable catalogs remain explicit. Exhausting an unavailable catalog does
not make conflict coverage available: the Hub proposal service still rejects a
draft unless every bridge relevant to the selected devices has a committed,
available rule catalog.

This gate prevents skipped pages and prompt-only compliance. It does not claim
that names prove semantic equivalence, and the existing Hub-owned name-overlap
screen remains heuristic. No Bridge contract revision, write authority, or
HA-specific Agent tool is introduced.

