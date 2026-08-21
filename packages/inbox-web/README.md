# Household review surface

The authenticated local surface uses the Product Shell as its single renderer.
The root path redirects to `/home`. Canonical destinations are:

- `/home` — the household overview and current connection state;
- `/conversation` — one household question with its live progress;
- `/review-center` — two independent queues: time-limited runtime confirmations and persistent household proposals;
- `/activity` — bounded actions and explanations;
- `/control` — explicit one-shot controls supplied by the Hub;
- `/settings` — connections, model, access, and household preferences;
- `/onboarding` — the guided first-run setup.

The review center keeps runtime confirmations and persistent proposals separate.
Runtime confirmations show a countdown and expire into an audit record. Proposal
capacity includes snoozed proposals, and proposal decisions remain with the
proposal owner. The page presents household language first and keeps technical
diagnostics one level deeper.

The Inbox consumes neutral projections from Hub services. The Hub supplies
runtime confirmation authority, proposal governance, safety incidents, and
explicit one-shot action descriptors. A missing descriptor produces a read-only
control. Semantic hints and device names provide display context only.

The package keeps household data local. Authenticated HTTP delivery is an
optional sibling service, disabled without an explicit local credential, bound
to `127.0.0.1`, protected by HTTP Basic authentication, bounded request
bodies, same-origin review mutations, and restrictive browser security headers.
