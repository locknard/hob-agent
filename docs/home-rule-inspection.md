# Bounded existing-rule inspection

## Decision

Before proposing a new household automation, the DSH Home Agent may inspect a
bounded, metadata-only catalog of rules already reported by neutral bridges.
The capability is read-only and is exposed as `get_home_rules`.

This closes a product gap in the proposal-first loop: a count discovered only
while creating a proposal is too late for the Agent to avoid an obvious
duplicate. Rule inspection remains advisory; the Hub still performs the
authoritative conflict check when the proposal is persisted.

## Boundary

The tool reads the existing optional `foreignRules@2` extension through
`HomeWorldService`. It does not change the frozen bridge core contract or add a
Home Assistant-specific API.

Autonomous observations must read every page in stable cursor order before
`create_home_proposal` is allowed. The catalog version covers the ordered
metadata projection, so a mid-read change fails closed and requires a fresh
first page. See [existing-rule coverage gate](existing-rule-coverage-gate.md).

Each result contains only:

- the neutral bridge identifier and catalog availability;
- the catalog epoch for a committed complete catalog (the Hub also requires
  its exact `epochId + lastSeq` to match the committed watermark before it is
  available);
- an opaque rule reference;
- an optional bounded display name, enabled state, and update time; and
- bounded page metadata.

Native rule IDs, triggers, conditions, actions, templates, YAML, device state,
credentials, and adapter errors are never returned. A missing, incomplete,
invalid, or uncommitted bridge catalog is represented as unavailable rather
than as an empty rule list. The tool returns no more than 50 rules per call and
uses an exclusive opaque rule-reference cursor.

Names and other bridge content remain untrusted household data. They can inform
deduplication but cannot grant tool authority or prove semantic equivalence.
The authoritative coverage gate is scoped to every bridge binding of the
devices selected by a proposal, not to every configured household bridge. An
unrelated bridge without `foreignRules@2` therefore cannot block a proposal;
selecting a device that is bound to that bridge does fail closed. A merged
cross-bridge device requires available catalogs from every one of its bindings.
The Inbox labels this as a metadata-only overlap screen and explicitly warns
that zero name matches does not prove non-interference. Full rule IR remains a
Phase 1 decision rather than an implied capability of `foreignRules@2`.
`create_home_proposal` continues to bind evidence and conflict findings inside
the Hub, and no rule execution or mutation path is introduced.
