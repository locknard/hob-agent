# Capability semantics v6.4

## Evidence and problem

An early aggregate-only read of the development Home Assistant instance on
2026-08-19 found 75 valid devices, 540 current states, 779 capabilities, one
ready bridge watermark, no history gap, and 15 raw automation entities. Every
capability still used the adapter schema `ha.entity`. The largest entity-domain
groups were sensors (420), switches (76), binary sensors (70), buttons (69),
and numeric controls (66). No household names, identifiers, or state values are
recorded here.

The later committed neutral cut still contains 75 devices, 540 states, and 779
capabilities. Its `foreignRules@2` catalog exposes 12 configured rules after
unavailable restored placeholders are excluded. HomeWorld accepts that catalog
only when its exact `epochId + lastSeq` matches the bridge's committed
watermark. The difference is filtering semantics, not evidence that three
household rules were deleted.

Schema provenance is correct but insufficient for a useful cross-ecosystem
Home Agent. It cannot reliably group a light and a sensor without importing HA
or MIoT vocabulary into the agent layer.

## Additive contract decision

Bridge contract v6.4 adds an optional per-instance `semanticKind` to
`AdapterCapabilityRef`. The closed initial vocabulary is:

`light`, `switch`, `button`, `sensor`, `binary-sensor`, `numeric-control`,
`choice-control`, `text-control`, `time-control`, `event`, `media`, `cover`,
`lock`, `presence`, `fan`, `camera`, `vacuum`, `climate`, `weather`, and
`automation`.

This is a read-side classification hint with adapter provenance. It does not:

- replace or weaken the adapter-owned schema and attrs validation;
- claim two capability instances are equivalent;
- enable automatic identity or capability binding;
- imply that an observation is writable; or
- grant action, artifact, approval, or execution authority.

The original schema, schema version, native binding, hub capability identity,
and source bridge remain visible. Unknown or ambiguous capabilities omit the
hint. The Hub and Agent must never invent a fallback classification.

## Adapter qualification

The HA adapter derives a hint only from the stable entity-domain prefix that it
already consumes while building a descriptor. Device class is not required;
the observed registry did not provide it consistently. Unmapped domains remain
unclassified.

The Xiaomi bridge cannot infer semantics from `siid`/`piid`, primitive format,
or writability. An authorized transport may provide a validated semantic kind
only when it has resolved the MIoT specification. The neutral adapter passes
that bounded claim through; absent metadata remains unclassified.

`EquivalenceMapping` stays inactive. A later reviewed mapping may relate
adapter schemas or propose cross-bridge capability binding, but semantic hints
alone are never sufficient for that decision.

## M3c Hub-private resolver decision

M3c uses a closed, Hub-private capability-semantics resolver. The resolver is
keyed by the exact adapter schema and version, not by `semanticKind`:

`ha.entity@1.0.0` and `miot.property@1.0.0` are the initial reviewed entries.
The implementation belongs in `packages/hub/src/capability-semantics.ts` (or a
same-purpose Hub-private module), not in `contracts`, an adapter, or the agent
layer.

The bridge catalog admits registrations by major version, but that is not a
semantic review. A future minor or patch version must be added to the resolver
allowlist explicitly; an unknown schema or exact version is unsupported even
when its capability carries a familiar `semanticKind`.

The resolver has three deliberately separate responsibilities:

1. **Read semantics** determine whether the current projected value is a
   neutral scalar and which condition operators are type-safe. The resolver
   never coerces strings, applies units, or interprets native payloads.
2. **Action compatibility** determines whether a neutral artifact action has a
   reviewed representation for that schema and current value. This returns
   only neutral `before`/`after` values and a compatibility result; it does not
   create a provider action or prove that the device can be executed.
3. **Authority** remains outside the resolver. The Hub must separately resolve
   an explicitly configured, approved action binding and candidate at the same
   verified world cut. Compatibility is never authority.

The minimum safe API is therefore a pure resolver with separate operations such
as `resolveRead`, `checkPredicate`, and `checkAction`. Its input is the exact
schema/version, projected attrs, current-state validity/freshness, and the
neutral action or predicate. It must not accept `semanticKind` as an action
decision input and must not return native IDs, routes, credentials, or approval
state. Missing, stale, or invalid-source state produces `unavailable`; it must
not be represented as an assumed no-op or an invented `before` value.

The M3c world-cut producer, not the compiler contract consumer, invokes this
resolver while it still has a Hub-private verified snapshot. It projects the
read result and one neutral action-compatibility result for each referenced
device action, bound to that action's consecutive one-based artifact order.
It also projects one predicate-compatibility result for each condition and
postcondition, using an explicit phase plus the consecutive one-based order
within that phase. A capability-change trigger is covered by the projected read
result and does not invent a predicate.
The projection contains only status, closed reason, and neutral
`before`/`after` scalars. It never carries `attrs`, MIoT format/unit fields,
HA service vocabulary, writable metadata, bindings, or native routes. The
compiler therefore cannot re-infer compatibility from `semanticKind`, schema
names, or scalar shape, and it does not need provider data to consume the
already reviewed result. Changing any projected compatibility result changes
the world-cut identity.

### Initial reviewed matrix

| Exact schema/version | Read value and conditions/postconditions | Action compatibility | Neutral before/after |
| --- | --- | --- | --- |
| `ha.entity@1.0.0` | The primary value is projected `attrs.state`, a string. Only `equals` and `not_equals` with string operands are safe. Numeric-looking states remain strings; `greater_than` and `less_than` are rejected. | `set_boolean` and `set_level` are unsupported. The optional `brightness` attribute is auxiliary, not a normalized writable level contract. | A valid current `state` may be a string `before` value for read/diff evidence; no action `after` value is admitted. |
| `miot.property@1.0.0`, scalar `value` | `string`, `boolean`, `null`, and finite `number` values can be retained as neutral scalars. Strings, booleans, and null support equality only; finite numbers support all four scalar comparison operators. Arrays and objects are unsupported for M3c scalar predicates/diffs. `format` and `unit` do not coerce or normalize the value. | The only initial action-compatible case is `set_boolean` when `attrs.format` is exactly `"bool"`, `attrs.value` is a boolean, and `attrs.writable` is `true`. This is compatibility only; Xiaomi execution is still disabled in the current action plane. `set_level` is unsupported for every current MIoT property. | A valid scalar current value can be the neutral `before`; a requested boolean is the neutral `after` only for the reviewed boolean case. Writable metadata never grants authority. |

The HA adapter's domain mapping remains a read hint (`light` to `light`,
`switch` to `switch`, `cover` to `cover`, and the other closed domain mappings
in its projection). It does not change the `ha.entity@1.0.0` row above. In
particular, a `cover` hint is not a level mapping.

### Cover and `set_level` fail-closed boundary

The current HA projection does not provide a reviewed normalized cover position,
write range, writable declaration, or provider action mapping. A raw
`current_position`-like attribute is not part of the admitted neutral schema.
The current MIoT projection likewise has no reviewed scale/action mapping;
`unit: "percentage"`, a numeric primitive such as `uint8`, or
`semanticKind: "cover"` is insufficient to infer `value / 100`.

Consequently, M3c must reject or mark unavailable every current `set_level`
request, including synthetic curtain fixtures, rather than fabricate numeric
before/after values. Supporting curtains later requires a separately reviewed
schema/version mapping that declares the current-position field, normalized
range, target write representation, and state/action compatibility. That
mapping must be added to this allowlist with its own tests.

### Required TDD gate

Before implementing or widening the resolver, add deterministic Hub tests for:

- HA `on`/`open` states: string equality works; numeric predicates and both
  action kinds fail closed.
- HA `cover` with an omitted or unknown current position: no normalized level
  or writable inference is produced.
- HA numeric-looking text such as `"21.5"`: it remains a string.
- Xiaomi boolean with `format: "bool"`, boolean value, and `writable: true`:
  `set_boolean` returns neutral before/after; `writable: false` remains
  readable but action-incompatible.
- Xiaomi finite numbers, including `uint8` plus `percentage`, and floats:
  numeric read predicates work, but `set_level` is rejected without a reviewed
  mapping.
- Xiaomi string, null, array, and object values, plus unknown schema/version:
  only the documented scalar behavior is admitted and no semantic hint creates
  a fallback.
- Missing, stale, or invalid-source state: action/diff is unavailable and
  `before` is absent.
- The same compatible MIoT boolean with no configured authority: resolver
  compatibility is unchanged, while the separate authority assessment fails
  closed.

## Reviewed HA cover-position mapping

The next additive mapping does not widen `ha.entity@1.0.0`. Home Assistant
cover capabilities use a separate exact adapter schema,
`ha.cover@1.0.0`, while every non-cover HA capability remains on
`ha.entity@1.0.0`. This keeps already persisted generic HA state truthful and
prevents an optional attribute on an unrelated entity from becoming a level
action claim.

The adapter-owned `ha.cover@1.0.0` state projection is a closed object with:

- `state: string`, retained as bounded read evidence;
- optional `level: number`, emitted only when HA `current_position` is an
  integer in `0..100`, normalized exactly as `current_position / 100`;
- optional `setLevelSupported: boolean`, emitted only when HA
  `supported_features` is a non-negative safe integer. It is `true` exactly
  when the HA cover `SET_POSITION` feature bit is present and `false` when a
  valid feature mask explicitly omits it;
- optional `available: boolean`; and
- optional non-negative `unknownAttributeCount`.

Invalid, fractional, non-finite, string, or out-of-range native positions are
omitted rather than clamped or coerced. A missing or invalid feature mask is
also omitted rather than treated as writable. The schema does not expose the
native feature mask, entity ID, service name, device class, route, or
credential material. Tilt position is deliberately outside this first mapping.

For `ha.cover@1.0.0`, the Hub-private primary read value is normalized
`level`. A missing level makes numeric read/predicate semantics unavailable;
the string `state` is not used as a type-changing fallback. `set_level` is
compatible only when all of the following hold at the exact fresh world cut:

1. `level` is present, finite, and within `0..1`;
2. `setLevelSupported` is exactly `true`;
3. the requested neutral level is finite, within `0..1`, and exactly
   representable at HA's integer-percent step (`value * 100` is an integer).

The compatibility result contains only the neutral normalized `before` and
unchanged requested `after`. It never rounds an approved value. Missing
position is unavailable; an explicit `setLevelSupported: false` is
action-incompatible; missing support metadata remains an unreviewed action
mapping. None of these results creates action authority.

Action authority continues through the separate Hub-private configuration and
opaque candidate registry. A candidate may exist for a `set_level` target
while schema compatibility still fails, and compatible cover semantics may
exist while authority is absent or unapproved. Both are required for a useful
compile result. The future executor must re-resolve the exact candidate and
private HA binding before translating neutral level to integer percent; no HA
service vocabulary or route is added to Artifact, Agent, plugin, or Inbox
surfaces here.

Changing the adapter projection means existing `ha.entity@1.0.0` cover rows do
not gain position evidence retroactively. A successful HA resync must produce
a new epoch with `ha.cover@1.0.0` descriptors and states before a real-home
world cut can use this mapping. Old cuts stay readable under their original
exact schema and continue to reject `set_level`.

### Additive TDD gate

Before implementing this mapping, tests must prove:

- only the `cover` entity domain selects `ha.cover@1.0.0`;
- valid boundary positions `0` and `100` project to `0` and `1`, and a middle
  integer percent projects without rounding;
- missing, fractional, string, non-finite, and out-of-range positions do not
  produce `level`;
- a valid feature mask projects an explicit support boolean, while a missing
  or invalid mask does not invent one;
- generic HA entities, brightness, semantic hints, and string states still
  cannot produce cover-level compatibility;
- the exact cover schema admits numeric predicates and representable
  `set_level` actions only with fresh valid state and explicit support;
- missing position, missing support, explicit no-support, stale state, and
  non-integer-percent requests all fail closed; and
- compatibility remains independent of opaque authority candidate creation
  and of any bridge control or execution route.
