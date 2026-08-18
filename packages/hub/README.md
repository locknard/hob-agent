# Hub

The Phase 0 monolith: Home Assistant connectivity, append-only event ingestion,
world-model indexing, scheduling, and policy-enforced action boundaries.

`HomeAssistantService` exposes the Phase 0 bridge as the Cordis
`ctx.homeAssistant` service. Mounting awaits the initial HA snapshot; disposing
its fiber closes the owned WebSocket connection.

`HomeAgentRuntime` owns the single root Cordis context and mounts Home
Assistant before the DSH Home Agent. `pnpm start` reads only the explicit
`HOB_HA_URL`, `HOB_HA_TOKEN`, `HOB_MODEL`, and selected provider credential
variables, then installs bounded SIGINT/SIGTERM shutdown for that root.

`probeHomeAssistantEndpoint` is the credential-free onboarding preflight. It
reads only HA's initial `auth_required` challenge, returns version and latency,
sends no socket data, and fails after a bounded timeout.
