# Proposal selected-device space coverage

Status: accepted for Phase 0 implementation.

The development household has substantially fewer devices with an unambiguous
neutral space than total observed devices. A proposal can therefore have valid
state evidence while still relying on an incomplete understanding of where the
selected devices belong. Model-authored rationale or uncertainty text cannot
authoritatively describe that mapping coverage.

For every new Home Agent draft, the Hub binds an aggregate selected-device
space summary into the proposal:

- selected device count;
- devices with exactly one accepted neutral space;
- devices with no accepted neutral space; and
- devices with multiple accepted neutral spaces.

The three coverage categories are mutually exclusive and sum to the selected
device count. Unknown or stale space references count as no accepted space.
The summary contains no space names, device names, native identifiers, current
values, or model text.

Incomplete or ambiguous coverage does not itself reject a review-only
proposal. The Inbox displays it beside the Agent's rationale and Hub evidence
so the household can reject an incorrect assumption, request more observation,
or correct HOME.md. It never grants authority or silently changes a risk level,
household knowledge, approval, or device state.

The safe aggregate is also returned by the governed proposal tool after the
Hub accepts the draft, allowing the Agent to acknowledge the mapping limitation
in its final response without exposing names or native identities.

The store requires this Hub-produced summary for new proposals whose producer
is the DSH Home Agent, alongside the household rationale. Existing persisted v1
rows without the additive summary remain readable.
