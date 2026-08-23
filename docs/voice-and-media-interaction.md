# Voice and media interaction

Status: accepted product direction. Neutral media discovery, preparation, the
governed action path, and an explicit media-only DSH turn seam are implemented;
the durable Product action-turn owner and household-facing entry remain pending.

## Product decision

hob-agent will provide a calm, voice-first household surface inspired by the
immediacy of modern voice assistants, without copying their visual identity or
turning speech into ungoverned device authority. Voice is another input and
output mode for the one DSH Agent Runtime. It is not a second Agent loop, a
second chat runtime, or a privileged path around Hub policy.

The first representative request is:

> 帮我在多媒体室放一部爵士音乐。

The useful product behavior is not merely speech-to-text. The Agent must:

1. resolve “多媒体室” through neutral Hub space identity;
2. discover eligible media players in that space;
3. interpret “爵士音乐” as a broad preference, not invent an exact recording;
4. search only household-authorized media catalogs;
5. present the selected source, player, and bounded initial volume;
6. obtain the confirmation required by policy;
7. ask the Hub action plane to perform the exact reviewed operation; and
8. report the verified result or an honest failed/indeterminate outcome.

If a room, player, catalog, result, or account is ambiguous, the Agent asks one
short clarification. If no authorized catalog is connected, it explains that
and may offer local-library or radio sources already available to the home. It
never fabricates availability or turns model-generated URLs into playback
targets.

## One runtime and one authority path

```text
microphone / text
  -> bounded voice session adapter
  -> DSH turn and governed Home tools
  -> neutral room + player discovery
  -> read-only media catalog search
  -> exact media action intent
  -> Hub policy and approval ticket
  -> neutral actions@1 route
  -> bridge adapter
  -> postcondition read + Home audit
  -> DSH response -> captions / speech
```

DSH owns the turn, cancellation, streaming response, tool calls, and session
history. Cordis composes lifecycle-scoped speech, catalog, and Home Product
Bundle services. The Hub remains the only owner of identity, action authority,
policy, ticket claiming, bridge invocation, verification, and audit.

Speech, UI clicks, Skills, plugins, and model output may express intent. None of
them grants device authority. An imperative utterance is evidence of user
intent, but the Hub decides whether the exact low-risk operation can use a
session-bound confirmation or needs an additional explicit confirmation.

## Neutral media seams

Player control and media discovery are separate capabilities:

- `mediaPlayer@1` is a bridge-side device capability. It exposes bounded
  playback state and reviewed operations such as play, pause, stop, queue one
  item, and set a policy-capped volume.
- `mediaCatalog@1` is a read-only catalog provider. It searches an authorized
  service or local library and returns bounded neutral candidates.

The current HA adapter now declares an additive exact `ha.media-player@1`
read schema for `semanticKind: media`. It carries only the normalized playback
state, optional `[0,1]` reported volume, optional availability, and an unknown
attribute count. HA feature masks, entity IDs, services, content IDs, and
provider URIs remain adapter-private. Invalid optional volume data is omitted
without dropping an otherwise usable state event.

The Hub mounts `homeMediaPlayers` over the authority-selected HomeWorld read
model and exposes a paged DSH `get_home_media_players` tool. A player entry has
only `hwCapabilityId`, `hwId`, zero or more neutral spaces, an untrusted display
label, normalized availability/playback state, and reported volume evidence.
Reported volume does not assert that volume control is supported or authorized.
Equal labels remain separate candidates because room names and display names
are not identities. Stale or non-valid HomeWorld devices remain discoverable
but their availability, playback state, and volume are projected as unknown.
Missing or non-up bridge connection evidence also suppresses cached playback
state and volume instead of treating absence of diagnostics as permission to
reuse them.

Media-player pagination uses a Hub-owned opaque read cut. The first page
captures one bounded neutral inventory; a continuation cursor is valid only
with the returned read-cut token, and later pages read that same immutable cut
even if HomeWorld changes. Tokens encode no device or bridge data, have a short
bounded lifetime, and are retained under a small in-memory cap. The final page
releases its cut. Unknown, expired, or mismatched continuation state fails
closed and tells the caller to restart from the first page; it never falls back
to a fresh inventory behind an old cursor.

The initial neutral media kinds are `artist`, `album`, `track`, `playlist`,
`radio`, `audiobook`, `podcast`, `episode`, and `genre`. Search results carry an
explicit `playable` flag because a useful discovery result is not necessarily a
direct playback target. A genre or artist may instead seed a provider-owned
mix. The Hub never infers playability from a title or media kind.

A search candidate contains a Hub-issued opaque `mediaRef`, title, media kind,
source label, `playable`, optional creator, and optional duration. It contains
no bearer token, provider-native account identifier, arbitrary provider
payload, or model-authored URL. A `mediaRef` is short-lived, tenant-scoped,
bound to the catalog generation, and resolved only by the Hub when preparing
an exact action ticket.

The DSH-facing `search_home_media` projection is narrower still: it exposes
only those neutral discovery fields and omits the expiry timestamp. The tool is
registered only when an explicit neutral catalog service exists. It forwards
DSH cancellation to that service, caps the model request at three candidates,
and has no player, queue, resolve, or action method. Catalog text is untrusted
data; neither a result nor its `playable` hint grants authority.

### V4 media conversation and clarification card

The Hub-owned `HomeMediaConversationService` is the only orchestration seam for
the media request card. It joins catalog search, one exact preparation, and the
existing `HouseholdReviewCenterService` action-ticket owner. It does not retain
a second ticket or confirmation state.

The conversation accepts three bounded operations: `search`, `prepare`, and
`request_action`. A prepared intent carries exactly one opaque `mediaRef`, one
Hub `playerCapabilityId`, and one explicit `queueMode`. The Agent projection
does not accept a provider URI, native player id, queue id, volume request,
actor field, or confirmation command.

When a required slot is absent or ambiguous, the service returns a closed
`clarification` state. Its `slot` is one of `query`, `mediaRef`,
`playerCapabilityId`, or `queueMode`; its `reason` is one of `missing`,
`ambiguous`, `no_match`, or `not_playable`; and its options contain only exact
opaque references or the three fixed queue modes. The caller asks for the
missing slot and then submits the selected exact value. The service never
guesses a player, media reference, or queue behavior.

`request_action` calls `prepare` first and then calls
`HouseholdReviewCenterService.requestAction` with the exact neutral
`play_media` action. A `direct` result is executed and read back by the action
plane; a `confirmation` or `administrator` result returns that plane's real
`ticketId` and remains pending until its owner approves it. The media
conversation service has no local confirmation reducer, expiry timer, or
approval store.

Click and spoken confirmation both call the existing action-ticket owner with
the exact ticket id. A spoken confirmation additionally carries an explicit
authenticated actor assertion from a present private device whose binding
matches its principal. Missing actor data, ordinary advice text, and shared
screen speech do not create identity and fail closed. A click cannot approve a
different ticket by using the latest card or a request-local fallback.

### Explicit media action turn

Ordinary Home Advice is permanently read-only. It never receives an actor or a
mutable media scope, even when the request came from an authenticated product
session. A household media command instead enters a distinct, explicit action
turn on the same mounted DSH Agent and AgentLoop. This is a capability boundary,
not a second chat runtime or a model-classification shortcut.

`HomeMediaConversationService.runActionTurn` binds one present actor and one
Hub-owned request id to the callback. Only the first `request_action` in that
scope may reach the existing action-ticket owner. The model tool accepts no
actor, ticket id, or request id; it can supply only bounded search text, an
opaque media reference, a neutral player capability id, and an explicit queue
mode. Separate household turns therefore cannot alias an old ticket by reusing
model output, while retries owned by one future durable turn can retain one
idempotency key.

`DshHomeAgentService.requestMediaActionTurn` uses the existing Agent with a
media-only tool guard, an independent bounded tool budget, and a bounded
deadline. It permits read-only player discovery and the governed media
conversation tool; proposal, advice-report, observation-report, inventory, and
other control tools fail in code. A cancelled or timed-out scope is revocable,
so a provider completion that arrives later cannot acquire its former actor or
create a ticket.

The backend seam is intentionally not exposed by `/conversation` or `/voice`
yet. Product delivery requires a Hub-owned durable media-action turn that
creates the request id, starts the scoped DSH turn with the current authenticated
actor, stores only the closed clarification or existing ticket id, and projects
the ticket's current result rather than copying confirmation or execution state.
Restart may recover an already-created ticket, but it must never replay an
unfinished command with stale presence.

The neutral action describes the desired outcome rather than an HA service:

```text
play_media {
  player: hwCapabilityId,
  media: mediaRef,
  queueMode: replace_and_play | play_next | add_to_queue
}
```

Queue behavior is always explicit because replacing what a household is
already listening to is materially different from playing next or appending.
The pending action UI must say which will happen. Volume is a separate player
operation and policy check; a catalog result never supplies it. The first
playback slice uses the current verified volume or refuses a policy-exceeding
volume. It does not hide a non-atomic volume change inside `play_media`.

### Phase 0 media intent preparation

Before an approval ticket or executor exists, the Hub may prepare—but never
apply—one exact media intent. This is a distinct read-only boundary rather than
an extension of catalog search:

```text
prepare_media_playback {
  intent: {
    kind: play_media,
    playerHwCapabilityId: Hub capability id,
    mediaRef: Hub-issued opaque reference,
    queueMode: replace_and_play | play_next | add_to_queue
  }
}
```

The Hub reparses the strict object, resolves the reference for the configured
tenant and current time, verifies the selected candidate is playable, and
requires one exact currently available player from the latest neutral
inventory. A successful preparation returns `requires_confirmation` with a
bounded neutral projection of the player, selection, queue behavior, and
reported current volume. It does not create or claim an approval ticket, call
a bridge, change a queue, set volume, or claim that playback occurred.

Preparation fails closed with a closed reason when the reference is expired or
unknown, the result is not playable, the player is absent or unavailable, or
the player's current availability cannot be proven. Native ids, routes,
services, URLs, provider ids, queue ids, credentials, and volume requests are
rejected by the strict intent schema. Same-label candidates are never merged;
the Agent must first select one exact Hub capability or ask the household to
clarify. This preparation result is not durable authority and must be rebuilt
against fresh state before a later ticket can be issued.

Home Assistant, Xiaomi, AirPlay, a local music server, and future ecosystem
adapters must pass the same conformance surface. HA entity ids, service calls,
MIoT identifiers, Spotify URIs, Apple Music ids, and authentication material do
not cross into the Agent-facing contract.

Catalog plugins can contribute search candidates but cannot select an action
target, resolve a `mediaRef` outside their granted tenant scope, invoke a
player, or claim that playback succeeded. Uninstalling a catalog or bridge
cannot erase the Hub audit trail.

### Music Assistant reference model

[Music Assistant](https://github.com/music-assistant/server) is the primary
reference and the first real integration candidate for this seam. Its useful
architectural lessons are:

- Music Providers, Player Providers, metadata providers, and queues are
  separate concerns. hob-agent preserves the same separation instead of
  treating every media function as an HA media-player service.
- Search spans the local library and connected streaming providers and accepts
  explicit media-type filters. hob-agent adopts bounded kind filters, while
  returning a smaller neutral candidate projection.
- Each player owns a queue and queue insertion has explicit semantics. The Hub
  therefore binds `queueMode` into the future approval ticket.
- A provider-facing Player and an API-facing PlayerState are different. The
  Hub similarly keeps provider/native routing and identifiers private while
  exposing only a neutral state projection.
- A physical player may have several output protocols. The Hub may eventually
  model multiple action routes behind one reviewed player identity, but it
  must not silently merge HA, Music Assistant, AirPlay, Cast, or DLNA records
  merely because their names match.

Music Assistant exposes rich URIs, provider mappings, image URLs, raw player
ids, queue ids, and provider-specific metadata. Those are valid inside Music
Assistant but are deliberately not copied into `mediaCatalog@1`. A future
trusted Music Assistant client and the implemented search adapter keep them
behind the Hub-issued `mediaRef` and
player binding. Search results remain candidates; compatibility between a
candidate and the selected player route is revalidated privately before an
action ticket is issued.

The neutral contract intentionally adopts only a reviewed subset of the Music
Assistant model:

- MA `MediaType` values `artist`, `album`, `track`, `playlist`, `radio`,
  `audiobook`, `podcast`, and `genre` map directly. `podcast_episode` maps to
  neutral `episode` when an item-oriented adapter supplies it. MA's current
  grouped global `music/search` response has no episode bucket, so the search
  adapter does not invent episode results. Provider folders, announcements,
  flow streams, audio sources, and sound effects are not silently treated as
  ordinary playable catalog results; each needs a separate product and policy
  decision.
- MA `ProviderMapping`, item URI, provider instance, image path, and external
  ids remain adapter-private. A Hub `mediaRef` represents one time-bounded
  reviewed candidate, not a stable copy of an MA URI.
- MA `Player` supplies useful state evidence. MA `OutputProtocol` confirms that
  one physical output can have several routes. The neutral player identity is
  therefore separate from its adapter-private routes. A route is selected and
  revalidated during preparation; route ids and protocol priorities are not
  offered to the model as alternate device identities.
- MA feature flags describe what a route reports it can do. They do not grant
  authority. A Hub operation is available only when the versioned neutral
  contract, current selected route, household policy, and approval state all
  permit it.

Queue semantics use an explicit, lossless subset of MA `QueueOption`:

| Neutral `queueMode` | Music Assistant adapter mapping | Meaning |
| --- | --- | --- |
| `replace_and_play` | `REPLACE` | Replace the whole queue and start the new selection. |
| `play_next` | `NEXT` | Insert after the currently playing or buffered item. |
| `add_to_queue` | `ADD` | Append according to the queue's current ordering rules. |

MA `PLAY` inserts at the current position and starts immediately; it is not an
alias for `REPLACE`. MA `REPLACE_NEXT` also has distinct destructive semantics.
Neither operation is exposed by the first neutral contract. An adapter must
fail closed instead of approximating either with a supported mode.

MA browse trees, recommendations, current-media detail, and queue inspection
are useful future read models, but they should not enlarge `search_home_media`
implicitly. They require separate bounded projections and opaque cursors so a
model never receives a provider path, raw current-media URI, or queue id.

The implemented Phase 0 adapter is transport-injected: it accepts the grouped
result of MA `music/search`, maps only reviewed fields, interleaves requested
media groups under one total result cap, and passes cancellation to the
injected client. It has no socket, credential store, player client, or queue
client. Cordis disposal is forwarded once to the injected client so a future
transport cannot outlive the catalog service. Unknown future buckets and all
provider mappings, images, external ids, and metadata are ignored. The result
is best-effort because one provider may be unavailable even when the overall
search returns; an empty page is not evidence that the household has no
matching media. `mediaCatalog@1` preserves this as machine-readable `complete`
or `best_effort` coverage, and the DSH tool returns that field alongside
candidates.

For the first real integration, an explicitly configured Music Assistant
client should be injected into this adapter instead of converting search into
an arbitrary Home Assistant service call. The HA integration may help
discovery and onboarding, but HA service payloads and Music Assistant URIs do
not become the neutral contract. No Music Assistant network client is enabled
during Phase 0 merely because the pure adapter exists.

The first transport remains opt-in and read-only. A trusted launch setting
supplies the Music Assistant base URL and a scoped `SecretRef`; the token stays
in the configured vault and is resolved only while establishing an
authenticated request. HA media labels, unknown attributes, entity metadata,
and discovered player names never imply that Music Assistant exists and never
authorize endpoint discovery. Without both explicit settings, the runtime does
not open a Music Assistant socket, read its credential, or register catalog
search.

The reviewed transport follows Music Assistant's regular WebSocket API rather
than HA Ingress impersonation. It first reads the bounded server-info greeting
without sending credentials, rejects unfinished onboarding and an incompatible
minimum schema, then authenticates with a long-lived token before issuing only
`music/search`. Search uses a short connection lifetime, one in-flight command,
a hard timeout, cancellation, frame and response budgets, and generic redacted
errors. Disposal aborts every in-flight request. The initial transport has no
player, queue, browse, recommendation, config, token-management, or arbitrary
command method; adding any of those requires a separate reviewed contract.

## Voice surface state machine

The visual surface exposes the actual system state through captions and one
signature “home pulse” object:

```text
idle
  -> listening
  -> transcribing
  -> thinking
  -> presenting_choice | awaiting_confirmation
  -> acting
  -> verifying
  -> speaking
  -> idle

any active state -> cancelled | failed | indeterminate
```

The pulse breathes slowly only in `idle`, follows input energy in `listening`,
uses a contained orbit in `thinking`, becomes still with a clear action card in
`awaiting_confirmation`, and shows a bounded progress sweep during
`acting/verifying`. Motion is supplementary: text, iconography, and live-region
status always carry the same meaning. `prefers-reduced-motion` replaces pulse
and orbit animation with discrete color and label changes.

The design extends the quiet household Product Shell. The memorable element is a room-aware pulse
whose rings represent the requested room, selected media source, and action
state. Everything around it stays restrained and operational.

Initial visual tokens extend, rather than replace, the current Inbox palette:

- canvas `oklch(97.5% 0.008 145)` and surface `oklch(99.2% 0.004 145)`;
- ink `oklch(25% 0.025 242)` and muted ink `oklch(48% 0.022 242)`;
- listening blue `oklch(62% 0.16 246)`;
- thinking violet `oklch(60% 0.14 292)`;
- verified green `oklch(48% 0.09 145)`;
- uncertain amber `oklch(60% 0.12 55)`.

The first UI is push-to-talk. Always-listening wake-word support is a later,
explicit household choice and should run locally when feasible. The interface
always displays microphone state, the live/final transcript, selected room and
player, the exact pending action, cancel, and a keyboard/text equivalent.

These choices follow two durable interaction lessons from current assistants:

- [ChatGPT Voice](https://help.openai.com/en/articles/20001274) keeps spoken and
  typed interaction in the same conversation, exposes live text, and supports
  natural interruption. hob-agent should likewise make voice an integrated
  modality, while postponing full-duplex interruption until the bounded
  push-to-talk path is trustworthy.
- [Apple's Siri design guidance](https://developer.apple.com/design/human-interface-guidelines/siri)
  treats actions as explicit intents/entities and requires responses to work
  both audibly and visually. [Apple's privacy description](https://www.apple.com/privacy/features/)
  also reinforces local processing where feasible and visible disclosure when
  server processing is required.

The product borrows those principles, not either product's orb, animation,
voice persona, or visual trade dress.

## Privacy and accessibility

- Microphone permission is requested only after a direct user gesture.
- Raw audio is not persisted by default. Transcript retention is local,
  visible, bounded, and independently configurable from audit retention.
- Model, speech-to-text, text-to-speech, and catalog providers are shown before
  use; household audio is never silently sent to a new provider.
- A physical or OS microphone denial fails closed and leaves text input usable.
- Partial transcripts are untrusted presentation data. Only a final bounded
  transcript may start a DSH turn.
- Speech output never hides a confirmation, safety warning, failure, or
  `indeterminate` result that is visible on screen.
- All controls work by keyboard and touch, captions remain available while
  audio plays, focus is restored after cancellation, and status changes use a
  non-interrupting live region except for confirmation and safety failures.

## Representative conversation

When the household has one eligible player and one preferred catalog:

```text
User: 帮我在多媒体室放一部爵士音乐。
Agent: 我找到了多媒体室的音响，并从家庭已连接的音乐库里选了
       “晚间爵士”。当前音量 20%，这会替换当前队列并开始播放。继续吗？
User: 播放。
Agent: 已在多媒体室开始播放“晚间爵士”，当前音量 20%。
```

The last sentence is allowed only after the Hub verifies playback state. With
two players, the Agent asks which one. With several equally plausible results,
it presents at most three choices. With a timeout after dispatch, it says that
the result is uncertain and does not retry automatically.

## Phase 0 Web voice seam

The `/voice` path serves the bounded Web V1 interaction. The conversation
composer links directly to it. Its push-to-talk control constructs the browser's
`SpeechRecognition`/`webkitSpeechRecognition` implementation only after the
household member's direct click. It shows the live partial transcript, keeps a
final transcript in a reviewable state, and exposes Stop while recognition is
active. A permission denial leaves the text route available. A no-input or
recognition failure produces an escalating first and second recovery prompt;
the third consecutive failure stops the voice loop and offers the text exit.

The browser capability check is explicit. When Web Speech is unavailable, the
surface says so and moves to text mode without opening a microphone or adding a
product-owned cloud speech dependency. Raw audio is not persisted. Only a
bounded final transcript can be submitted, through the existing same-origin `POST
/conversation` form. The voice script does not call a media player, Hub
action, bridge endpoint, or alternate conversation API. Therefore media and
high-impact utterances enter the existing DSH turn and remain subject to the
Hub's neutral confirmation and administrator gates.

The server-rendered form and the browser adapter deliberately share the
canonical conversation action. If that action is ever changed or replaced by
an embedding, the adapter fails closed to text mode instead of posting to an
unreviewed route. Stop aborts the active recognition session and never submits
the partial transcript.

## Hub-owned background advice lifecycle

The Hub owns the Conversation advice turn from acceptance through its terminal
result. A running advice moves to `background` through the typed
`homeAdvice.background(id)` port, and that transition keeps the same advice id,
question, and DSH turn. The SQLite advice row stores `running`, `background`,
`completed`, or `failed` as the lifecycle state.

The Hub stores a bounded semantic event cursor for each advice. Events contain
the advice id, lifecycle stage, and timestamp, and the store retains at most
the configured local progress bound (64 events by default, with a 1–256 guard).
The durable `events(id, afterSeq)` query supports reconnect replay from the
latest retained cursor. The store records lifecycle metadata only; prompts,
reasoning, provider errors, and raw tool arguments remain outside this record.

Completion and failure set one durable notification bit alongside the terminal
row and terminal event. `consumeCompletionNotification(id)` returns the
terminal status and event cursor once, then returns no notification on later
consumption. `consumeNextCompletionNotification()` claims the oldest pending
notification by `completedAt` ascending and `adviceId` ascending, which gives
the Home page a stable FIFO-like order with a deterministic tie break. Each
claim is atomic across store connections. A cancelled background turn records
a failed terminal row with a `cancelled` event so the household receives the
same durable completion path.

Service restart reopens a `background` row and reattaches the original advice
id to the current Hub Agent when the home is ready. The recovery path preserves
the retained event cursor and resumes the same question. A running row remains
owned by its original process and receives the existing startup recovery rule;
an explicit `background` transition provides durable restart ownership. The Hub
runs one bounded recovery timer at a low default frequency of one second while
durable background work awaits a ready World and Agent. Service disposal clears
the timer and leaves the background row available for a later process.

The durable advice row stores no actor identity because Advice owns no mutable
actor scope. Restart recovery remains read-only. Media commands use the separate
durable action-turn design above and cannot inherit Advice recovery or presence.

Cancellation applies only to the active running or background advice. Terminal
advice rejects further cancellation and background transitions. Retry starts a
new Hub-owned advice turn from a failed question after the home and Agent are
ready, while the failed record and its terminal notification remain intact.

## Delivery sequence

1. **V0 — contract and visual foundation:** the state vocabulary established
   the complete interaction model used by the product route.
2. **V1 — read-only Web voice turn (implemented):** push-to-talk, explicit
   permission handling, partial/final captions, cancellation, three bounded
   failures with a text exit, and one canonical DSH advice turn. This remains
   non-applying: the browser submits only `/conversation`, and Hub policy and
   confirmation continue to own every device or media effect.
3. **V2 — media discovery (implemented):** the Hub-owned `mediaCatalog@1`
   boundary, authority-selected neutral player inventory, HA exact read schema,
   two DSH read-only tools, and an explicitly mounted synthetic provider are in
   place. The synthetic provider is never a production default or a Bridge
   adapter. The search and player tools remain read-only.
4. **V3 — governed playback backend (implemented):** the exact `play_media` intent now
   flows through preparation and the existing action-ticket, executor,
   postcondition, and audit path. The V4 conversation seam returns closed
   clarification states, preserves exact opaque references, routes confirmation
   through the ticket owner, and allows direct actions only after Hub policy
   approval and read-back verification. One explicit media-only turn uses the
   same DSH Agent, while ordinary Advice remains non-applying.
5. **V4 — household media command product (pending):** add the durable Hub turn
   owner, explicit text/private-voice mode, clarification/result projection,
   and links to the one existing confirmation ticket and Activity record.
6. **V5 — ambient household assistant:** evaluate local wake word, barge-in,
   multi-room handoff, household-member policy, and local speech providers only
   after push-to-talk privacy and reliability are proven.

V1 browser voice never calls a device or bridge directly. V3 device effects
remain inside the Hub action plane and its policy, approval, verification, and
audit boundaries.
