# Single runtime data-directory owner lease

Date: 2026-08-25
Status: current Phase 0/0.5 decision

## Decision

`HOB_DATA_DIR` has one process-level runtime owner. The production
`ProductRuntimeSupervisor` acquires that owner before it starts its Product
Host or mounts HomeWorld, keeps the owner alive for the supervisor lifetime,
and releases it during shutdown. The owner lease is a local, owner-only lock
sidecar; it is not a database and it contains no credential or household data.

The Home Assistant migration assessment and candidate-preview operators acquire
the same owner lease before creating a Cordis `Context`, connecting a bridge, or
opening `home-automation-migrations.sqlite`. A fresh owner makes these
operators fail closed with a bounded busy result/error. A stale regular lock
sidecar can be reclaimed once with an atomic identity check; the operators then
retry acquisition within a bounded attempt budget. No operator kills a process,
scans processes, or opens a second migration database.

The durable migration status operator remains lease-free. It opens only existing
SQLite files in read-only mode and never mounts a bridge or runtime.

## Lease contract

- The sidecar path is `<HOB_DATA_DIR>/.hob-agent-runtime-owner.lock`.
- Acquisition uses exclusive file creation and owner-only permissions. A
  supervisor heartbeat refreshes the sidecar timestamp while it is alive.
- A fresh sidecar is authoritative even when its metadata is unreadable; the
  caller fails closed. After the bounded stale interval, recovery compares the
  sidecar identity and atomically isolates it before unlinking it. A race or
  unsafe file type fails closed.
- Release is idempotent and removes only the exact inode and owner token that
  acquired the lease. Process crashes leave a recoverable sidecar; normal stop
  removes it.
- The supervisor and operator CLIs share this Hub-internal lease module. The
  migration domain and neutral bridge contract remain unchanged.

This decision closes the gap between the one-runtime product claim and
operator commands that previously created an independent HomeWorld and
migration runtime over the same Home Assistant connection and data directory.
