# Agent layer

Embeds the agent loop, builds role prompts from the home workspace, and exposes
only governed tools with audit logging and approval checks.

DSH is the only Agent Runtime in this package. It owns the LLM seam, session,
prompt, tool, agent, and loop services. The Home Product Bundle contributes the
read-only `get_home_snapshot`, bounded read-only `get_home_evidence`, and
review-only `create_home_proposal` tools through DSH's registry; it does not
create a parallel Agent or tool system. The snapshot and evidence tools inject
the neutral `homeWorld` service. They project deterministic devices,
capabilities, states, bridge watermarks, and
consistency/event/connection summaries. External attributes are bounded and
JSON-normalized before they reach the model.

The proposal tool accepts bounded intent, risk, and selected hub identities,
then delegates to the hub. It cannot supply its own evidence or conflict-check
result, approve the proposal, or apply it. DSH session/call identity is injected
as trusted provenance by the tool implementation.

`AgentLoopTraceService` is a bounded, read-only projection of DSH's canonical
`session/event` stream. It exposes turn/step/tool status, timing, and aggregate
token counts to the local review surface, while omitting prompts, assistant and
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
