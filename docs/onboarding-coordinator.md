# Hub-owned onboarding coordinator

The Home Hub owns the V4 eight-step onboarding state machine. Inbox Web submits
one allowlisted typed command at a time and renders the resulting state.

## Command boundary

The coordinator accepts exactly one command for the current step:

1. `name_household` stores the household and Agent names and updates the
   household source files when a private household directory is configured.
2. `preflight_bridge` checks a named bridge for a ready connection and a
   completed read-only watermark.
3. `confirm_map` records the digest of the current neutral HomeWorld map.
4. `bind_private_device` records the authenticated adult member only when the
   request comes from that member's present, bound private device.
5. `set_action_policy` validates real `hwCapabilityId` values and atomically
   writes the selected direct, confirmation, or administrator class to the
   Hub-owned private `action-authority.json` source. The running
   `AuthorityCoordinator` receives the new projection only after that write
   succeeds; an unavailable or ambiguous capability leaves the step blocked
   and keeps the safe default.
6. `acknowledge_safety_rules` records the explicit acknowledgement.
7. `set_observation_schedule` commits the consent, interval, and quiet hours
   to the durable onboarding source, then applies the same typed schedule to
   the live `HomeObservationSchedulerService`. On restart the scheduler reads
   that persisted schedule before any environment defaults; a failed runtime
   application leaves the step blocked.
8. `ask_first_question` records the first real household question.

The coordinator also derives a transient `choices` projection from the latest
neutral HomeWorld snapshot. It lists bridge IDs with readable labels and only
lists valid capabilities whose binding identifies exactly one ready bridge.
Offline bridges remain visible as unavailable choices, while stale, unbound,
or ambiguously bound capabilities stay out of the form. A capability's
`suggestedPolicyClass` is a starting hint for the screen; the selected policy
is the only value that reaches the authority configuration.

The coordinator advances only after the command's Hub-side check succeeds. A
missing bridge baseline or an unavailable capability produces a durable
`blocked` step result and leaves the current step unchanged. The Inbox never
merges arbitrary form fields into durable state.

## Persistence and composition

`FileHomeOnboardingStore` stores the typed state in the private local
`onboarding.sqlite` file. Production composition supplies that path from the
launch data directory. `InMemoryHomeOnboardingStore` exists only as an explicit
test seam; no production constructor creates an in-memory store.

The action policy source is the private `action-authority.json` beside the
HomeWorld journal directory. Its replacement uses a private temporary file and
one atomic rename, and the active coordinator changes only after the rename.
The onboarding record stores the completed step and the observation schedule;
the observation scheduler reads that record at startup, exposes a typed
`configure` boundary for a live update, and suppresses recurring turns during
the configured quiet-hours window. No Inbox field merge or memory-only fallback
supplies either runtime configuration.

`HomeOnboardingCoordinatorService` is mounted by the full Home Agent runtime
and passed to Inbox HTTP as an `OnboardingPort`. The product receives
the same coordinator when it is launched from its configured persistent data
directory. An Inbox started without the Hub owner exposes a blocked setup page
and cannot advance onboarding. Inbox normalizes the coordinator's identity and
choice projection before putting it into the product shell. Every canonical
route receives the saved household and Agent names from that projection; the
member name and role continue to come from the authenticated principal.
