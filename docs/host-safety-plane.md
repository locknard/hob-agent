# Host Safety Plane

## Ownership

`HomeSafetyService` is the Hub owner for household safety incidents. It
receives the neutral `HomeWorldSnapshot`, evaluates an explicit binding list,
stores incident state, and exposes a bounded projection to Inbox and Host
Shell.

Each binding names:

- one `hwCapabilityId`;
- one reviewed `kind`: `water_leak`, `smoke`, `gas`, `door_open`, or
  `lock_unlocked`;
- one state attribute;
- explicit active values and clear values;
- the household-facing title, source, and local handling link.

The capability ID is the authority anchor. The device name, room label,
adapter label, and semantic hint provide display context only.

## Incident lifecycle

```text
trusted active value
        |
        v
     active -- acknowledge --> acknowledged
        |                           |
        +----------- clear value ---+
                        |
                        v
                     resolved
```

`active` and `acknowledged` remain visible to every layout. Acknowledgement
changes announcement intensity and records the actor; it keeps the active
physical fact visible. A trusted clear value resolves the incident.

The clear transition requires all of the following:

1. the exact configured `hwCapabilityId` exists in the current world;
2. the bound device is valid;
3. the bound bridge reports `connection: up` and `consistency: ready`;
4. the bound state attribute equals one of the configured clear values.

The service keeps the incident active when the bridge is disconnected, the
state is stale, the capability is unavailable, or the state value is outside
the configured vocabulary.

## Host Shell contract

The product shell receives `safetyAlerts` as a host-owned projection. The
fixed frame renders the safety banner before navigation and ordinary layout
content. A layout provider supplies ordinary content and keeps the banner
visible.

Safety alert projections carry `severity: "safety"` and
`snoozeAllowed: false`. The fixed frame never renders a snooze action for this
class. Active alerts use an assertive live region; acknowledged alerts use a
polite live region and keep the same handling link.

The `我已看到` action posts to the host route
`/safety/:alertId/acknowledge`. The route checks the authenticated household
principal and returns to `/home`. It changes the incident to `acknowledged`
and leaves physical resolution to the trusted sensor state.

## Persistence

`SqliteHomeSafetyStore` stores incident records in the private data directory
under `home-safety.sqlite`. The store keeps the capability ID, binding ID,
kind, timestamps, acknowledgement actor, and resolution time. A new active
cycle receives a new incident ID while prior resolved records remain in the
store for audit inspection.

An empty binding list produces an empty safety projection. Production setup
adds reviewed bindings explicitly; the Hub never creates a safety binding from
device names or model output.
