# Standalone local proposal review

## Decision

`pnpm inbox:home` opens the persisted proposal Inbox without reconnecting a
home bridge or starting DSH. This closes the review gap after
`pnpm observe:home`: a household can inspect and approve or reject the durable
result without causing another device snapshot, model request, or observation.

The command mounts one Cordis root containing only the Hub proposal store, the
Inbox review facade, and authenticated localhost HTTP delivery. This is a
smaller composition of existing neutral services, not a second Agent Runtime.
It requires an explicit absolute `HOB_DATA_DIR` and the same explicit
`HOB_INBOX_AUTH_TOKEN`; `HOB_MODEL`, provider credentials, `HOB_BRIDGES`, and
bridge credentials are neither required nor read.

## Safety boundary

- HTTP remains fixed to `127.0.0.1`, authenticated on every request, protected
  by restrictive response headers and exact same-origin review POSTs.
- The standalone surface can list, inspect, approve, reject, or expire a
  proposal. Approval remains a terminal record with
  `applicationStatus: not_available`; it cannot install an automation or
  control a device.
- DSH trace detail is optional. Because DSH is intentionally absent, standalone
  proposal detail omits the live metadata trace rather than opening its session
  database or inventing another trace reader.
- The existing bounded process shutdown controller owns SIGINT and SIGTERM and
  disposes the complete Cordis tree.

The regular all-in-one process continues to use the same Inbox services and
may include a live metadata-only DSH trace. No proposal schema or external
bridge contract changes.
