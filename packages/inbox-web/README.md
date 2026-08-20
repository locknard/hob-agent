# Proposal inbox

The local Control Center is available at `/` and `/control-center`. It leads
with household decisions and plain-language connection, home-map, Agent, and
observation status. Pending proposals are normal review work rather than a
system-health warning. Provider, adapter, bridge, and sequence identifiers are
kept in a closed technical-diagnostics disclosure. The page never reads or
returns credential values, raw device payloads, remote bridge identity, or an
execution control.

The proposal review surface is available at `/proposals`: list, detail,
evidence watermarks, conflict findings, dry-run result, risk, and optimistic
approve/reject. Reviews collect one bounded quality reason plus an optional
note so useful, duplicate, weakly evidenced, incorrect, preference-mismatched,
or risky suggestions can be distinguished without reinterpreting prose.
New Agent proposals also display expected household value, timing, and
uncertainties in a clearly model-authored section separate from Hub evidence.
The Hub's selected-device space coverage is displayed separately again, with
single-space, unassigned, and multiple-space counts but no household names.
Approval records intent only; this package has no apply,
automation-install, or device-control method.

The package also owns the pure `renderAgentLoopTimeline` fragment used to show
the local DSH trajectory beside a proposal. It accepts only the metadata-safe
`AgentLoopTrace` read model; it does not receive raw session messages or create
another agent/runtime connection.

`ProposalInboxService` mounts in the same Cordis root after the DSH Home Agent
and composes durable hub proposal state with that trace. The current slice
provides escaped HTML fragments and a review controller; authenticated HTTP
delivery is an optional sibling service. It is disabled without an explicit
credential, binds only to `127.0.0.1`, requires HTTP Basic authentication
(`home` plus the configured local token), rejects cross-origin review POSTs,
bounds form bodies, and emits restrictive browser security headers.
