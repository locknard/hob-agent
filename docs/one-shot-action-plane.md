# One-shot household action plane

Status: accepted implementation contract for the V4 product slice.

## Decision

One-shot household control uses the neutral bridge `actions@1` extension. The
Hub owns policy, approval, execution tickets, read-back verification, undo,
and audit. Bridge adapters translate one bounded neutral action into their
ecosystem command and return a bounded acknowledgement.

The action lifecycle is:

`intent → fresh state → authority → policy class → approval when required → execute → read-back → activity`

An undo request enters the same lifecycle as a new inverse action. It reads the
latest state and authority again before execution.

## Neutral actions

The first contract supports the common reversible device operations required by
the V4 interaction package:

- set a boolean capability;
- set a normalized level from 0 through 1;
- start one exact prepared media reference on one exact player;
- stop playback on one exact player, including as the verified inverse of a
  successful start request.

Every request names one Hub capability ID and one current bridge binding. The
Hub resolves that binding from its world model. Product clients and agents
cannot provide a native ecosystem identifier.

## Three policy classes

- `direct`: a small, reversible action with a present person. Execute
  immediately, verify the resulting state, then expose a ten-second undo when
  the inverse remains safe.
- `confirmation`: a broad reversible action tied to the active session and a
  present person. Create a ten-second runtime confirmation. Expiry records a
  fail-closed activity and executes nothing.
- `administrator`: locks, water, security, and irreversible effects. Route the
  confirmation to an authenticated adult administrator on a bound private
  device. The policy supplies the bounded TTL.

Runtime rejection ends that request. Persistent proposal latches belong only
to proposal governance.

Each approved action-authority binding records its policy class explicitly.
Onboarding may suggest a class from the neutral capability kind, and an adult
administrator confirms that class before the binding becomes executable. The
action plane reads the reviewed class on every request. This makes a water
valve represented as a generic switch retain administrator handling and keeps
ecosystem naming outside the policy decision.

## Verification and result vocabulary

Adapter command acknowledgement means the ecosystem accepted the command.
Verified success requires a subsequent neutral state read that matches the
requested effect within the bounded verification window.

The product receives one of:

- `verified`: the neutral state matches the requested effect;
- `failed`: the command was rejected or policy denied execution;
- `unknown`: command acknowledgement arrived while fresh read-back could not
  establish the resulting state.

The product displays undo only for `verified` reversible work.

## Ownership

- `contracts` owns the Zod-first `actions@1` request and result schemas.
- trusted bridge adapters own ecosystem translation and command acknowledgement.
- `packages/hub` owns tickets, policy, approval binding, verification, undo,
  persistence, and audit.
- `packages/agent-layer` and `packages/inbox-web` use typed Hub intents only.

This action plane is independent of HA. Home Assistant and Xiaomi are peer
adapter implementations of the same extension.

## Explicit action descriptor boundary

The Hub review center exposes an `actionDescriptorFor(capabilityId)` catalog.
The negotiated `actions@1` handle has two neutral operations: `describe` and
`execute`. `describe` receives an exact Hub capability binding plus bounded
current-state facts and returns one adapter-owned concrete intent, such as the
next boolean value, a supported cover level, or an explicitly supported media
stop. The descriptor carries reversible metadata and contains no device name
or semantic kind.

HomeWorld resolves the reviewed action authority, requires exactly one live
binding and a manifest-consistent current state, then asks that binding's
adapter for its descriptor. Ambiguous cross-bridge bindings, stale or unknown
state, unavailable bridges, missing extension negotiation, and unsupported
intents return no descriptor and keep the capability read-only. The review
center receives this HomeWorld-owned source by default and combines the
descriptor with the private reviewed `policyClass` before the Inbox renders an
executable control. Inbox and agent layers never infer actions from names,
semantic kind, schema shape, or a test fixture.
