# Platform bridge History profile (`history@1`)

Status: implemented Phase 0 profile for the first recorder-history slice. The
profile is read-only. It does not add an execution path, a second runtime, or a
new persistence service.

## Decision

`history@1` is a versioned optional platform-bridge handle. The adapter reads
the platform history API, validates and projects each row into the neutral
`StateEvent` shape, and returns a bounded history page. Vendor rows, raw
attributes, context identifiers, rule identifiers, and other vendor payloads
remain inside the adapter.

The Hub stores imported history in an imported-history partition of its own
SQLite journal. Imported rows do not enter the live ingest stream, do not
advance the live watermark, do not advance the consistent watermark, do not
participate in snapshot manifests, and do not change the current live reducer
state. The Hub exposes imported history only through an explicitly imported
evidence query that preserves its lower confidence.

The first implementation uses Home Assistant's authenticated REST history
endpoint. The existing adapter credential and bounded `fetchImpl` seam provide
the transport. The Home Assistant history WebSocket command remains a
compatible future transport and does not expand the first implementation.

## Handle shape

The contract package defines the following implemented `history@1` shape.

```ts
interface HistoryHandle {
  fetchHistory(
    request: HistoryRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<HistoryPage>;
}

interface HistoryRequest {
  /** RFC3339 UTC range, half-open: [since, until). */
  readonly since: string;
  readonly until: string;
  /** Hub-resolved bridge bindings; callers never provide HA entity IDs. */
  readonly bindings: readonly {
    readonly nativeId: string;
    readonly nativeInstanceId: string;
  }[];
  /** Hub-owned verified cut captured immediately before the adapter call. */
  readonly liveCut: { readonly epochId: string; readonly lastSeq: number };
}

interface HistoryPage {
  readonly importId: string;
  readonly source: "home-assistant-recorder";
  readonly sourceRange: { readonly since: string; readonly until: string };
  /** Exact echo of request.liveCut; this is not a history event sequence. */
  readonly liveCut: { readonly epochId: string; readonly lastSeq: number };
  readonly coverage: "partial" | "unavailable";
  readonly reasons: readonly HistoryCoverageReason[];
  readonly records: readonly {
    readonly historySeq: number;
    readonly state: StateEvent; // state.origin is always "imported"
  }[];
}
```

`history@1` does not return `Envelope` values with fabricated live
`epochId/seq` values. `historySeq` orders accepted rows within the imported
page/import partition. The durable row also records the live cut, Hub
`receivedAt`, source timestamp quality, and the import ID.

The first version returns `partial` for every successful page because the HA
recorder API does not expose a trusted retention floor or a source completeness
watermark. `complete` is reserved for a future profile version or an explicit
operator-supplied recorder coverage proof. An empty successful response is
therefore not evidence that no history exists; it is `partial` with an explicit
coverage reason.

## Home Assistant read

The REST request is a GET with the adapter-private entity IDs resolved from
`bindings`:

```text
GET /api/history/period/<since>
  ?end_time=<until>
  &filter_entity_id=<comma-separated adapter-private entity IDs>
  &skip_initial_state
  &significant_changes_only=1
  &minimal_response=0
  &no_attributes=0
Authorization: Bearer <scoped token>
```

The adapter requests the full response shape so it can validate entity
membership, state, attributes, and timestamps. It treats the response's
per-entity arrays as untrusted input. A top-level shape error rejects the page;
an invalid individual row is omitted and adds `invalid_row` to coverage. The
adapter never forwards the raw response or a raw `entity_id` to the Hub's
agent-facing surfaces.

The future WebSocket transport uses Home Assistant's
`history/history_during_period` command with the same half-open range, entity
selection, and disabled start-time sample. It must produce the same
`HistoryPage`; transport choice never changes provenance or coverage semantics.

## Fixed budgets

The first implementation enforces all of the following limits:

| Resource | Limit | Rule on violation |
| --- | ---: | --- |
| Range | 168 hours | Reject request before transport |
| Bridge bindings | 20 | Reject request before transport |
| Request deadline | 5 seconds | Abort and return `unavailable: timeout` |
| In-flight history reads | 1 per bridge | Return `unavailable: busy` |
| Raw REST/WS response | 1 MiB | Abort; commit no rows; return `partial: response_too_large` |
| Imported records per page | 200 | Commit no rows; return `partial: record_limit` |
| One normalized event | 64 KiB | Omit the row; return `partial: record_too_large` |

The raw response is bounded before JSON parsing. The normalized `StateEvent`
also passes the existing neutral resource budget. A page is committed as one
bounded unit; a transport or top-level schema failure never commits a prefix
that could look complete.

Only one history request runs for a bridge at a time. Cancellation aborts the
request and commits no rows. The handle performs no Home Assistant write.

## Neutral projection and time

Every accepted record has:

```ts
{
  origin: "imported",
  time: {
    sourceTs: <validated HA timestamp>,
    sourceTsQuality: "platform",
  },
}
```

The adapter uses the recorder row's validated `last_updated` as `sourceTs`,
falling back to `last_changed` when `last_updated` is absent. A missing or
invalid timestamp sets `sourceTsQuality: "none"`, omits `sourceTs`, and marks
the page partial. `receivedAt` is the Hub clock time at durable acceptance; it
never substitutes for a missing historical source time.

The adapter applies the same neutral capability projection discipline as the
live state path. Only schema-approved neutral state values and attributes cross
the boundary. Native IDs are bridge-bound identity fields already present in
the neutral contract; HA entity IDs, raw attributes, context IDs, and native
automation data do not become public evidence fields.

The request disables Home Assistant's synthetic start-time state. A state in
effect at the beginning of a range is a sample, not an observed transition, and
is not imported as a behavior event.

## Epoch, baseline, and resync

The Hub captures the current verified live cut and places it in the request
before calling the handle:

```text
liveCut = { epochId: consistentWatermark.epochId,
            lastSeq: consistentWatermark.lastSeq }
```

The adapter echoes that exact cut in `HistoryPage`. The Hub rejects a page whose
cut differs from the request, whose bridge lifecycle or ready state changed
during the read, or whose adapter was replaced. An adapter-local send cursor
can never be mistaken for the Hub's durable consistent watermark.

The imported range may precede or overlap that live cut. The cut records the
relationship between the imported read and the current live stream; it does
not require imported rows to have live sequence numbers. Imported records do
not update the live baseline and are never silently joined to earlier live
epochs.

After the adapter returns, the Hub compares the current live epoch with
`liveCut.epochId`. A changed epoch means a resync occurred while the read was
in flight. The Hub commits no rows from that page and returns
`partial: resync_stale`; the caller retries against the new consistent cut.
Normal sequence advancement within the same epoch does not invalidate the
imported page, because the page remains in its independent partition.

The imported partition has its own bounded retention and quota accounting. It
never evicts live evidence to make room for recorder history. Quota pressure
returns `partial: imported_quota`. The journal persists one byte-accounted
quota gap per bridge and requested range when the remaining partition capacity
can hold that gap; otherwise the current result remains the signal and the hard
partition cap remains intact.

The first durable layout uses the same local SQLite file but separate tables:

```text
imported_history_events(
  bridge_id, import_id, history_seq,
  live_epoch_id, live_last_seq,
  received_at, source_ts, source_ts_quality,
  state_json, canonical_key, bytes,
  PRIMARY KEY (bridge_id, import_id, history_seq)
)

imported_history_gaps(
  bridge_id, import_id, since, until, reason, bytes
)
```

The event and coverage rows commit transactionally. The imported tables never
update `ingest_watermarks`, `ingest_consistent_watermarks`, or
`ingest_history_gaps`. Raw HA response JSON never enters either table.

## Deduplication and overlap

Home Assistant history reads have no stable cross-request row ID. The Hub uses
an exact canonical key within the imported source:

```text
(bridgeId, nativeId, nativeInstanceId, sourceTs, canonical neutral attrs)
```

Repeated exact rows from retries or overlapping ranges are stored once.
Different neutral values at the same timestamp are retained in deterministic
source order and mark the page partial with `source_conflict`; neither value
silently overwrites the other. Imported and observed rows are never deduplicated
across origins. The imported `historySeq` is assigned after canonical sorting
and remains stable for the committed import.

## Coverage and gaps

`HistoryCoverageReason` is a closed set:

```text
retention_floor_unknown
empty_or_purged
history_unavailable
recorder_disabled
invalid_response
invalid_row
response_too_large
record_limit
record_too_large
timeout
cancelled
busy
resync_stale
source_conflict
imported_quota
```

The Hub records recorder/source gaps in imported-history coverage, not in the
live `history-gap` table. A live transport gap still belongs to the live
ingest journal and continues to affect only live evidence. Imported coverage
does not close or reopen a live gap.

The first version reports `retention_floor_unknown` for every successful page.
It reports `empty_or_purged` when the source returns no rows. It never upgrades
that result to complete merely because the HTTP response is 200 or because a
current state exists. A future capability may provide a trusted recorder floor
and completeness watermark; that evidence must be added to a versioned profile
before `complete` becomes available.

## Causality boundary

Recorder history establishes what state was recorded and when it was recorded.
It does not establish why the state changed. `history@1` emits no cause and
never infers one from temporal proximity, rule names, device names, or state
values.

Live Home Assistant WebSocket events may carry a sanitized user causality
extension. Automation trace retrieval is a separate, permissioned profile
with its own retention and run identity. A future trace profile may associate a
trace with an imported state only when the adapter has an explicit, validated
association. Until then, the public explanation remains `cause_unknown`.

## Focused acceptance tests

The implementation must add focused tests before production code:

- contract tests reject ranges, binding counts, unknown fields, oversized rows,
  and any `StateEvent` whose origin is not `imported`;
- HA adapter tests verify REST URL/query construction, bearer auth, timeout,
  response byte limits, malformed nested rows, neutral projection, timestamp
  fallback, and absence of raw vendor payload;
- journal tests verify imported rows survive restart, exact overlap dedupe,
  source conflicts, imported quota/gaps, and unchanged live watermark and
  consistent watermark;
- HomeWorld tests verify baseline capture, same-epoch sequence advancement,
  epoch-changing resync stale rejection, imported/live provenance separation,
  and explicit partial coverage for empty/retention-unknown reads;
- integration tests verify a live WS event and an overlapping recorder row
  remain distinct origins and that no imported row enters current live reducer
  state or snapshot manifest.

## Authoritative references

- [Home Assistant REST API: history period](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant history REST implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/history/__init__.py)
- [Home Assistant history WebSocket implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/history/websocket_api.py)
- [Home Assistant Recorder retention and purge](https://www.home-assistant.io/integrations/recorder)
- [Home Assistant WebSocket state event context](https://developers.home-assistant.io/docs/api/websocket/)
- [Home Assistant automation trace WebSocket API](https://github.com/home-assistant/core/blob/dev/homeassistant/components/trace/websocket_api.py)
