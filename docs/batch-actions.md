# Hub batch actions

`HomeBatchActionService` owns one bounded batch command. The command names a
request, an authenticated present actor, an ordered unique `capabilityIds`
list, and one exact `descriptor` for each target in `targets`.

The service reads `HouseholdReviewCenterService.actionDescriptorFor` again for
every target before it requests any action. The submitted descriptor matches
the current Hub descriptor, including its neutral action and display metadata.
The Hub supplies the reviewed `policyClass`; a changed, unknown, unsupported,
or stale descriptor rejects the complete command before an owner request.

Each target calls `HouseholdReviewCenterService.requestAction` independently.
The target request id is deterministic: `batch:<batchRequestId>:<capabilityId>`
for delimiter-free bounded ids, and a bounded SHA-256 form when an id carries
the delimiter or exceeds the target bound.
The existing one-shot action owner deduplicates that target request id, while
the batch store binds the whole request id to its command fingerprint and
result.

The result preserves target order and exposes only per-target lifecycle states:

```ts
type HomeBatchActionStatus =
  | "verified"
  | "pending_confirmation"
  | "failed"
  | "unknown";
```

Every item carries its target request id, reviewed policy class, status,
reason, verification state, and the owner ticket id when the owner produced a
ticket. The aggregate contains only `total`, `verified`,
`pending_confirmation`, `failed`, and `unknown` counts. The result has no
whole-batch success state.

## Root integration

The root mounts `HomeBatchActionService` after `HouseholdReviewCenterService`
and passes the existing review center through
`HomeBatchActionServiceOptions.reviewCenter`. Production passes a private
`SqliteHomeBatchActionStore` path through `path`, or supplies a durable
`HomeBatchActionStore` implementation through `store`. Tests and deterministic
embedders use `InMemoryHomeBatchActionStore`.

The root obtains each descriptor from the review center at command preparation
time, places the descriptor beside its matching capability id, and forwards
the authenticated actor unchanged. The batch service requests actions only;
existing runtime confirmation approval and rejection methods continue to own
confirmation decisions.
