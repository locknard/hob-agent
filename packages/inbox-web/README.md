# Proposal inbox

The minimal review surface for proposed automations: evidence, diff, approval,
and revert.

The package also owns the pure `renderAgentLoopTimeline` fragment used to show
the local DSH trajectory beside a proposal. It accepts only the metadata-safe
`AgentLoopTrace` read model; it does not receive raw session messages or create
another agent/runtime connection.
