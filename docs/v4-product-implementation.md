# V4 product implementation contract

Status: implementation source of truth
Design source: `HobAgentUI设计稿评审包v4.zip` (2026-08, 32 screens)
Scope: the existing `packages/hub`, `packages/agent-layer`, and
`packages/inbox-web` runtime; this is not a separate prototype runtime.

The V4 review package is visual and product evidence, not executable authority.
Its screens define what a household member must be able to understand and do.
All writes still cross the neutral Hub policy boundary, and no view may grant
more authority than the Hub service it calls.

## 1. Product surfaces

The authenticated local web product exposes one responsive shell with these
stable semantic destinations:

| Destination | Household purpose | Required backend projection |
| --- | --- | --- |
| Home | See whether the home is normal and act on common devices | fresh neutral world snapshot, bridge contact and change time, safety alerts |
| Conversation | Ask, watch progress, stop, resume, and correct | durable advice turn, replayable SSE, structured answer and correction acknowledgement |
| Review center | Decide runtime confirmations and persistent proposals | two independent queues, independent counts and commands |
| Activity | Understand who did what and why | bounded household activity records and redacted cause chains |
| Control | Use the same home state in a denser layout | neutral capabilities and the same governed intent seam |
| Settings | Complete setup and manage connections, permissions and preferences | non-secret setup checkpoints and explicit capability availability |

The built-in Life and Control providers share these projections and register in
the `ProductViewRegistry`. The browser stores a device-local provider preference;
semantic routes remain stable during a switch. Providers arrange the canonical
projection, while the Host Shell owns authentication, safety alerts, review
counts, provider recovery, and write-command dispatch.

The top Host switcher changes the current browser session. Settings owns the
persistent device default and its permission check: a member manages a bound
private device, while an administrator manages a shared device. The Control
provider presents spaces, current values, policy labels and governed actions in
one continuous dense surface; it uses the same Hub intent handlers as Life.

The shared presentation layer also owns accessibility conformance. It exposes one
page heading and a skip target, labels every form control, uses native time inputs,
announces onboarding progress, preserves visible keyboard focus and supplies
reduced-motion, reduced-transparency, increased-contrast and mobile safe-area
variants. Providers inherit these semantics through the shared presentation layer.

## 2. Three action gates

1. **Direct** — reversible, within granted device scope, and initiated by a
   present person. Execute immediately, verify, write activity, and offer a
   ten-second undo when the inverse action is still safe.
2. **Confirmation** — broad-impact but reversible actions initiated by a present
   person. A spoken or tapped confirmation is equivalent. No response within ten
   seconds fails closed. A rule, system task, or proposal without a present
   initiator becomes a longer-lived runtime confirmation instead.
3. **Administrator** — locks, water valves, security, or irreversible effects.
   Approval must come from an authenticated private device belonging to any adult
   administrator. Voice and shared displays are not identity.

The reviewed action-authority binding stores one explicit policy class for each
Hub capability. Neutral semantic kinds provide onboarding suggestions; the
stored class governs execution. This preserves administrator handling for water,
security, and other high-impact devices whose ecosystem presents them as a
generic switch.

Batch actions are classified per target. The UI reports each result as verified,
failed, or unknown; it must never collapse partial completion into success.

## 3. Review-center invariants

Runtime confirmations and persistent proposals are different domain objects and
must not share reducers, commands, counts, rejection side effects, or expiry
semantics.

The Hub has one source of truth for each object. `HomeProposalService` and its
SQLite proposal store own persistent proposals, evidence, review, artifact
preparation, snooze metadata and deduplication latches. The runtime-confirmation
service owns short-lived action tickets and their expiry activity. The review
center composes reads and commands directly over those owners. Each write commits
once in its owning store.

### Runtime confirmation

- Every card contains exact target, effect, source, eligible actor, policy class,
  absolute expiry and remaining TTL.
- Expiry and rejection fail closed and never write a proposal deduplication latch.
- Expiry writes an activity record and a one-time next-open summary.
- An expired, superseded, already-decided or unauthorized confirmation cannot be
  approved.
- The first valid approval wins atomically and invalidates other device cards.

### Persistent proposal

- `pending + snoozed <= 5`; a snoozed proposal still occupies one slot.
- Snooze choices are tomorrow, weekend, or next week. A proposal may be snoozed
  twice; the next appearance must be decided or allowed to expire naturally.
- Natural expiry is normally fourteen days and is not a rejection latch.
- “Only this time” closes the current proposal without a latch. “Do not suggest
  this again” writes a `dedupKey` latch and visibly acknowledges the promise.
- New evidence for the same `dedupKey` merges into the existing unresolved card.
- Direction approval is the first consent. Trial and eventual enablement remain
  separate, visible states; Phase 0 never implies that approval installed a rule.

The Web sidebar and mobile navigation show independent amber and blue counts.
There is no aggregate red dot.

## 4. Advice and correction contract

Advice turns are durable and replayable:

```text
accepted -> inspecting -> streaming -> completed
                       \-> background -> completed notification
                       \-> cancelled
                       \-> failed -> retry
```

- Press feedback is immediate. Within one second the UI says the request was
  received. Between one and ten seconds it names product-level work and exposes
  Stop. After ten seconds it can continue in the background without restarting.
- Reconnect resumes by advice id and event cursor. Progress never exposes prompts,
  model reasoning, tool arguments, raw bridge payloads, or false percentages.
- Answers render verified facts, unknowns, and suggestions as distinct layers.
- A completed turn presents an explicit choice of `household_fact`,
  `household_preference`, or `future_behavior`; the UI never infers a class from
  the wording. The form binds the advice id, authenticated actor, and an
  idempotency key.
- `HomeCorrectionService` is the sole Hub owner. Facts are written atomically
  into the marked `MEMORY.md#household-facts` section; preferences use the
  marked `SOUL.md#household-preferences` section. The response says “已更新”
  and names the destination.
- `future_behavior` submits a typed no-artifact draft to
  `HomeProposalService.createDraftGoverned`, returns the durable proposal id
  and current count. The correction's persistent effect is the pending proposal;
  knowledge files and household behavior remain under their owning workflows.
  The proposal owner reads the current `HomeWorld` snapshot to
  produce watermarks, freshness, history-gap counts, conflict scope and space
  coverage. A degraded or gapped bridge remains degraded or gapped in the
  stored evidence. A household-wide correction uses an empty selected-device
  set and records zero selected devices. Missing advice completion, actor permission,
  household directory, proposal owner, or persistence produces an explicit
  failure and no success acknowledgement.
- Correction audit and replay state live in the private
  `home-corrections.sqlite` store. A repeated actor/advice/idempotency command
  replays the original result; a key bound to another advice or class is a
  conflict.

## 5. Activity and safety

Activity records use a closed attribution vocabulary:

- `physical` — physical switch or direct local interaction
- `member` — authenticated household member
- `hob` — governed hob action
- `external-rule` — HA or another bridge-owned rule
- `system` — maintenance, expiry or recovery
- `unknown` — provenance could not be established

A bounded `CauseRef` chain explains trigger, governing rule/approval, action and
verification without leaking ecosystem-native payloads. A correction affects the
selected occurrence unless the user explicitly opens the rule.

Safety alerts are Host-owned and layout-independent. Acknowledgement only stops
attention feedback; the alert remains active until trusted sensors or policy mark
the condition resolved. Safety alerts cannot be snoozed.

## 6. Onboarding checkpoints

The eight V4 steps are resumable checkpoints:

1. Meet and name the household instance.
2. Add an existing home read-only and show what was discovered.
3. Confirm the neutral household map.
4. Bind adult administrators to private devices; children and guests remain
   present-person contexts without approval identity.
5. Decide direct, confirmation and administrator device scopes independently.
6. Rehearse the three non-overridable safety rules.
7. Set first-week expectations without promising autonomous behavior.
8. Enter the real conversation surface with the first question.

Secrets appear once and are stored through existing credential services. UI
checkpoints contain locators and health only, never secret values.

## 7. Verification evidence

Implementation is not complete until all of the following exist and pass:

- deterministic domain tests for every review transition and impossible state;
- HTTP tests for authentication, exact origin, route semantics, SSE replay and
  write-command rejection;
- renderer tests for both queues, both badges, safety penetration, loading,
  reconnecting, empty, failure, completion and cancellation states;
- browser interaction tests at 1440x900 and 390x844;
- visual comparisons against the corresponding V4 PNG at equal viewport and
  density, with no unresolved P0/P1/P2 findings;
- `pnpm test`, `pnpm check`, and a fresh browser console check with zero errors.

## 8. Screen-to-capability audit

The V4 screens map to one production Product Shell and typed Hub owners. The
status vocabulary is:

- `browser-passed`: the canonical route and interaction state passed responsive
  browser verification;
- `http-passed`: authenticated transport and command routing passed tests;
- `domain-passed`: the owner state machine, persistence and policy passed tests.

| V4 surface | Frontend and backend proof | Status |
| --- | --- | --- |
| Home · normal / disconnected | neutral world, contact/change clocks, quiet/disconnected copy, recovery entry | browser-passed + domain-passed |
| Conversation · progress / answer / correction | durable SSE, stop/background/retry, fact/unknown/suggestion layers, visible correction destination | http-passed + domain-passed |
| Voice · listening / result / clarification / failure | direct-gesture Web Speech, partial/final caption, canonical conversation submit, bounded three-failure exit | browser-passed + http-passed |
| Media clarification and playback | exact player and media refs, queue clarification, typed `play_media`, policy ticket and verification | domain-passed |
| Direct action / high-impact confirmation / undo | exact descriptor re-read, three policy classes, private-device guard, fresh read-back, ten-second inverse action | http-passed + domain-passed |
| Batch action | preflighted exact targets, per-target policy, ordered verified/pending/failed/unknown result | browser-passed + domain-passed |
| Review center · two sections / detail / snooze | independent lifecycles and badges, live TTL, 5-slot capacity, two consent stages, three snooze choices | browser-passed + domain-passed |
| Activity · cause chain | closed attribution vocabulary, bounded causes and verification text | browser-passed + domain-passed |
| Safety · banner / handling | Host-owned penetrating alert, acknowledgement, fresh-sensor resolution | http-passed + domain-passed |
| Onboarding · steps 1–8 | durable checkpoints, real bridge/capability choices, authority policy, observation schedule, first durable advice turn | browser-passed + domain-passed |
| Wall display / Control view | responsive dense controls, shared-device approval projection, governed batch actions | browser-passed + domain-passed |
| Web · overview / conversation / review / activity | one authenticated Host Shell and one canonical projection at 1440×900 | browser-passed |

## 9. Release evidence

- 1,184 deterministic tests pass.
- Type checking and instruction-file synchronization pass.
- All eight canonical destinations pass at 1440×900 and 390×844 with one
  `main` landmark and zero horizontal overflow.
- Runtime TTL changes in place; batch selection updates all four policy counts
  and enables submission only after a target is selected.
- The browser console reports zero warnings or errors.
- The repository scan contains no committed test or production secret.
