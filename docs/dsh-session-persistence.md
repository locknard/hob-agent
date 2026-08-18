# DSH session persistence

## Decision

The production Home Agent uses the official
`@deepseek-ai/dsh-session-persistence-sqlite` provider. DSH remains the sole
owner of the session event log, recovery rules, and agent resume operation.
The Hub supplies only a private local path and the stable Home Agent session
identity. We do not define a second session schema or replay mechanism.

The database lives at `HOB_DATA_DIR/dsh-sessions.sqlite`. An absent session is
created; a materialized session with the configured identity is resumed. A
load, validation, corruption, or version error fails startup closed rather
than silently replacing household history with a new session.

## Privacy and lifecycle

Unlike the bounded, metadata-only Inbox trace projection, the DSH database can
contain raw user messages, model responses, tool arguments, tool results, and
session metadata. It is local household data. The containing directory and
database files must remain private and must never be committed or exposed by
the Inbox.

DSH owns flush and teardown through its Cordis service lifecycle. The Home
Agent's existing trace service rebuilds its bounded safe projection from the
resumed canonical event stream, so proposal provenance can remain reviewable
without copying raw content into the proposal database.

The official SQLite provider currently has no deletion or retention API.
Retention, export, household reset, and multi-household separation therefore
remain explicit future governance work; this integration must not invent
ad-hoc SQL deletion around the provider.

For deterministic unit tests only, `:memory:` may be passed explicitly. The
executable launch path always supplies the durable path under `HOB_DATA_DIR`.
