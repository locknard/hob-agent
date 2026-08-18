# Hub

The Phase 0 monolith: Home Assistant connectivity, append-only event ingestion,
world-model indexing, scheduling, and policy-enforced action boundaries.

`HomeAssistantService` exposes the Phase 0 bridge as the Cordis
`ctx.homeAssistant` service. Mounting awaits the initial HA snapshot; disposing
its fiber closes the owned WebSocket connection.

`probeHomeAssistantEndpoint` is the credential-free onboarding preflight. It
reads only HA's initial `auth_required` challenge, returns version and latency,
sends no socket data, and fails after a bounded timeout.
