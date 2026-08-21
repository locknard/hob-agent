# Household Product Experience Recovery Plan

Status: proposed

## Why this reset is necessary

The current web surface exposes a synchronous backend workflow as if it were a
consumer product. An advice submission can occupy the HTTP request for the
whole model turn, while every unavailable state is collapsed into a raw
`Household advice unavailable` response. Users cannot tell whether the home is
still connecting, the model is working, another turn is active, configuration
is missing, or a real failure occurred.

This contradicts the product direction in `PRODUCT.md`: household members
should not need to understand bridges, model providers, or the agent runtime in
order to ask for help with their home.

The recovery has four non-negotiable properties:

1. Accept an interaction immediately and always show a meaningful state.
2. Stream safe progress and answer output without exposing hidden reasoning,
   tool arguments, credentials, or untrusted raw device payloads.
3. Make first-run home and model setup a guided product flow.
4. Keep DeepSeek Harness as the only agent runtime and keep Phase 0 inside the
   existing TypeScript service and governance boundary.

## Product information architecture

The default surface is a household product, not a runtime console.

- **Home**: one primary text/voice composer, the active turn, the latest useful
  result, and household decisions that need attention.
- **Reviews**: proposed persistent behaviours and consequential actions that
  require evidence and approval.
- **Home map**: rooms, capabilities, device availability, and data quality in
  household language.
- **Settings**: home connections, model, voice and media, and household
  preferences.
- **Advanced diagnostics**: bridge health, model probes, agent-loop trace,
  retention, and raw identifiers. This is progressively disclosed and is not
  the home page.

The primary experience remains a bounded household assistant rather than an
unrestricted general-purpose chat application. Advice may propose persistent
behaviour, but the existing proposal, dry-run, approval, artifact, and audit
path remains mandatory.

## Interaction lifecycle

### Replace the boolean availability gate

Replace `canAsk(): boolean` with a typed availability result:

- `ready`
- `setup_required`
- `home_connecting`
- `model_unavailable`
- `agent_busy`
- `active_request`, including the existing request identifier
- `stopped`

Every state maps to household-facing copy, a next action, and an HTTP response
that preserves the application shell. Expected product states must never be
rendered as a raw 404 or 500 page.

### Accept first, run asynchronously

Submitting advice creates a persisted `running` record and redirects to it
immediately. A hub-owned background task then executes the DSH turn. A repeated
submission while a turn is active navigates to that turn rather than failing.
On restart, orphaned work is marked interrupted and is safe to retry.

Target submission acknowledgement is under 200 ms. The user sees a visible
working state within 250 ms.

### Stream observable progress, not private reasoning

Add a same-origin Server-Sent Events endpoint for an advice record. It supports
event sequence identifiers, `Last-Event-ID` replay, heartbeat, reconnect, and
cancel. Initial semantic events are:

- `accepted`
- `inspecting_home`
- `reading_inventory`
- `checking_rules`
- `evaluating_evidence`
- `composing_answer`
- `answer_delta`
- `completed`
- `failed`
- `cancelled`

Existing redacted DSH session events can drive semantic progress. They must not
be forwarded directly. `answer_delta` is emitted only from a dedicated
assistant presentation channel; it is not chain-of-thought or a tool/event-log
mirror. The final validated structured report remains the persisted authority
and the input to any governed proposal flow.

The UI state machine is explicit: `ready`, `submitted`, `streaming`, `complete`,
`error`, and `cancelled`. Reloading resumes the active turn. A disconnected
stream reconnects without duplicating work.

## First-run onboarding

Configuration becomes a product workflow, while environment variables and CLI
commands remain the headless operations path.

1. Choose language and confirm local access expectations.
2. Choose a home connection. Home Assistant and Xiaomi are equal adapter
   choices, not primary and secondary product tiers.
3. Enter connection URL and credential, verify it server-side, store the secret
   in the platform credential store, and show the discovered rooms/devices in
   household language.
4. Choose a model provider. Standard and custom OpenAI-compatible endpoints are
   supported. Verify `/models`, allow manual model ID entry when discovery is
   unavailable, and label any paid probe before it runs.
5. Review room mapping, missing signals, and readiness without exposing adapter
   payloads.
6. Ask a first grounded household question and see the same streamed experience
   used by the finished product.

Secrets never enter the DOM after submission and never appear in URLs, logs,
SQLite records, agent traces, or error details.

## Delivery milestones

### R0 — Remove the dead end (1 day)

- Introduce typed advice availability.
- Replace raw unavailable/error pages with an in-shell explanation and action.
- Redirect duplicate submissions to the active request.
- Add deterministic tests for every availability and failure state.

### R1 — Honest waiting and streaming (2–4 days)

- Split advice acceptance from DSH execution.
- Persist running/interrupted state.
- Add safe SSE progress, reconnect, heartbeat, cancel, and final-result handoff.
- Show a useful staged waiting experience; never use an indefinite spinner as
  the only feedback.

### R2 — Household-first shell (3–5 days)

- Rebuild the navigation and home surface around the household task.
- Make the active turn and review queue the central objects.
- Move bridge/runtime/provider detail under Advanced diagnostics.
- Implement mobile-first, keyboard, focus, reduced-motion, contrast, empty,
  loading, partial, and error states.

Before this milestone begins, approve a low-fidelity screen flow and one visual
direction. The implementation remains bundled and served by
`packages/inbox-web`; it does not introduce a second backend or microservice.

### R3 — Product-grade onboarding (4–7 days)

- Implement the home connection and model provider wizard.
- Add secure credential write/update/delete endpoints with explicit audit
  semantics.
- Add connection/model discovery, verification, retry, and edit flows.
- Support an unfinished onboarding session without trapping the user.

### R4 — Voice and governed media (5–10 days)

- Add push-to-talk, live capture state, editable transcript, streamed response,
  stop, and optional TTS.
- Reuse the same turn lifecycle instead of creating a separate voice agent.
- For media requests, search and present choices first; playback enters the
  typed, policy-checked action path and asks for confirmation where policy
  requires it.

### R5 — Product hardening (continuous)

- Exercise real HA, Xiaomi, custom-model, disconnect, restart, model-outage,
  credential-rotation, and slow-stream scenarios.
- Add Chinese and English copy review, WCAG AA audit, mobile viewport tests, and
  reduced-motion coverage.
- Keep operational telemetry local and metadata-only by default.

## Acceptance criteria

- A new household can reach its first grounded answer in under 10 minutes.
- Advice submission is acknowledged in under 200 ms and visibly changes state
  in under 250 ms.
- There is no silent wait longer than 2 seconds; stream heartbeat is at most 10
  seconds apart.
- Reload resumes the same active turn, and a second submission never produces a
  raw 404.
- Every expected failure says what happened, what remains safe, and what the
  user can do next.
- The primary home surface contains no requirement to understand HA entity IDs,
  bridge internals, model probes, or DSH runtime vocabulary.
- No secret is present in HTML, URLs, logs, persistence, or traces.
- Core flows are usable by keyboard, meet WCAG AA contrast, use at least 44 px
  mobile targets, and respect reduced motion.
- Real Home Assistant plus the configured custom model passes the onboarding,
  streamed-advice, reconnect, and failure-recovery end-to-end suite.
- DSH remains the sole agent runtime and all device effects remain governed hub
  actions.

## Skills and reference implementations

Use a small, non-overlapping set of skills as quality gates:

- `pbakaus/impeccable`: product shaping, onboarding, clarity, responsive
  adaptation, hardening, and final interface audit.
- `anthropics/skills` `frontend-design`: intentional visual direction rather
  than a generic admin dashboard.
- `vercel-labs/agent-skills` `web-design-guidelines`: interaction,
  accessibility, form, error, and motion review.
- `anthropics/skills` `webapp-testing`: browser-level verification of stream,
  reconnect, onboarding, mobile, keyboard, and error paths.

Supplemental onboarding and AI UI skills may be consulted for patterns, but are
not automatically installed or copied. Framework-specific examples are adapted
to this repository's architecture and reviewed for age and security.

Reference product patterns:

- Home Assistant: onboarding progress, connection initialization, language,
  loading, and recovery patterns.
- Open WebUI: provider URL/key setup, `/models` verification, and manual model
  fallback.
- Vercel AI SDK: explicit submitted/streaming/ready/error UI states, stop, and
  typed message parts.
- assistant-ui: reconnectable/resumable turn streams and cancel semantics.

These are interaction references, not replacement runtimes or product identity.
