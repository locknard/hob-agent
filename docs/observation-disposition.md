# Agent-reported observation disposition

Status: accepted for Phase 0 implementation.

The household needs to distinguish a genuinely uneventful observation from a
candidate that was withheld because its evidence, existing-rule screen, or
home mapping was not good enough. The existing `no_proposal` outcome cannot
make that distinction and therefore gives too little information for real-home
calibration.

When an autonomous DSH observation creates no proposal, the Agent should call a
governed reporting tool exactly once with one bounded disposition:

- `no_material_value`;
- `insufficient_evidence`;
- `existing_rule_overlap`;
- `mapping_uncertain`; or
- `other_uncertainty`.

The Hub continues to determine whether a proposal was actually created. It
stores the optional disposition only beside a `no_proposal` outcome. A missing
report remains valid for legacy/model compatibility and is displayed as not
reported rather than guessed.

The disposition is explicitly model-authored metadata. It is not Hub evidence,
does not change policy or tool authority, and cannot approve, apply, suppress,
or automatically tune future proposals. The Inbox labels it as Agent-reported.
Only the bounded category is persisted; household content and model prose are
not copied into the observation audit ledger.

