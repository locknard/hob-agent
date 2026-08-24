# Agent layer

Embeds the agent loop, builds role prompts from the home workspace, and exposes
only governed tools with audit logging and approval checks.

Source ownership is explicit under `src/`: `home` contains the household
product bundle, `model` contains provider selection, model-facing facades, and
the profile-to-DSH credential adapter, `runtime` contains DSH loop and trace
invariants, and `prompt` contains household prompt assembly. Private credential
infrastructure lives under `auth/{profiles,oauth,external-cli,secrets}`. Auth
module paths remain package-private; the stable credential APIs required by the
Hub are re-exported through the public `model-credentials` facade.

DSH is the only Agent Runtime in this package. It owns the LLM seam, session,
prompt, tool, agent, loop, token-meter, and compaction services. The official
runtime-invariant companions protect the stateful DSH protocols, and the Home
Product Bundle changes only the supported compaction summarizer hook to use a
household checkpoint rather than the upstream coding template. The Home
Product Bundle contributes
compact paginated `get_home_inventory`, metadata-only post-baseline
`get_home_activity` candidate triage, bounded paginated read-only
`get_home_snapshot`, bounded read-only `get_home_evidence`, and review-only
`get_home_history` for scalar imported recorder events about what happened and
when, and `create_home_proposal` tools through DSH's registry; imported history
never proves why and is not passed to `get_home_causality`. It does not create a
parallel Agent or tool system. The read tools inject the neutral `homeWorld`
service. Inventory discovery returns up to 50 compact device summaries without
current values or capability/native identities, so an observation can exhaust
discovery before requesting detailed state. Both device projections may carry
the closed neutral `non_spatial` disposition; absence remains unknown and the
hint grants no authority. The snapshot tool returns
deterministic pages
of at most 20 devices and can narrow them by hub device ID, per-binding neutral
space, or closed semantic kind. Its device, capability, state, space,
watermark, and health projections remain ecosystem-neutral. External
attributes are bounded and JSON-normalized before they reach the model. See
`docs/bounded-home-inventory.md`, `docs/bounded-home-activity.md`, and
`docs/bounded-home-query.md` for these
query boundaries.

The proposal tool accepts bounded intent, risk, selected hub identities, and a
model-authored household rationale. The rationale must state expected household
value, why the suggestion is timely, and at least one uncertainty; it is never
treated as evidence or authority. The tool cannot supply its own evidence or
conflict-check result, approve the proposal, or apply it. For a temporal claim
it may select current hub capability IDs and a bounded window; the Hub re-runs
the evidence query and binds exact epoch/sequence references and honest
coverage to the proposal. The tool result also returns the Hub-produced
single-space, unassigned, and multiple-space counts for the selected devices,
without names or native identities. DSH session/call identity is injected as
trusted provenance by the tool implementation.

`AgentLoopTraceService` is a bounded, read-only projection of DSH's canonical
`session/event` stream. It exposes turn/step/tool status, compaction/prune
maintenance, timing, and aggregate token counts to the local review surface,
while omitting prompts, summaries, raw outputs, provider errors, assistant and
reasoning text, tool arguments/results, and household state. It neither owns a
loop nor appears in the model's tool/context surface.

`pi-agent-core` is forbidden. Standard API-key providers use the official
`@deepseek-ai/dsh-llm-pi-ai` adapter beneath the DSH LLM seam. Its internal
`pi-ai` SDK is transitive implementation detail: this package neither declares
it nor imports it. `mountDshHomeAgent` maps the five product provider names to
DSH routes and owns the adapter and Home Agent in one Cordis lifecycle.

Selected API-key profiles bridge into the official DSH credential seam through
a read-only alias-to-SecretRef provider that resolves on every request. Claude
OAuth keeps the OpenClaw-derived refresh lock, SecretVault, expiry metadata and
redaction mechanisms behind a provider-neutral DSH-owned seam. The default
fails closed because the upstream DSH adapter does not yet expose interactive
OAuth. Do not bypass it with a second message/tool converter or disguise an
OAuth token as an API key.
