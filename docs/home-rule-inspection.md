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

The tool reads the existing optional `foreignRules@1` extension through
`HomeWorldService`. It does not change the frozen bridge core contract or add a
Home Assistant-specific API.

Each result contains only:

- the neutral bridge identifier and catalog availability;
- the catalog epoch for a committed complete catalog;
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
`create_home_proposal` continues to bind evidence and conflict findings inside
the Hub, and no rule execution or mutation path is introduced.
