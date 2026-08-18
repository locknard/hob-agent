# Proposal inbox

The minimal local review surface for household proposals: list, detail,
evidence watermarks, conflict findings, dry-run result, risk, and optimistic
approve/reject. Approval records intent only; this package has no apply,
automation-install, or device-control method.

The package also owns the pure `renderAgentLoopTimeline` fragment used to show
the local DSH trajectory beside a proposal. It accepts only the metadata-safe
`AgentLoopTrace` read model; it does not receive raw session messages or create
another agent/runtime connection.

`ProposalInboxService` mounts in the same Cordis root after the DSH Home Agent
and composes durable hub proposal state with that trace. The current slice
provides escaped HTML fragments and a review controller; authenticated HTTP
delivery remains a separate boundary.
