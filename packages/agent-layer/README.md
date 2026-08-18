# Agent layer

Embeds the agent loop, builds role prompts from the home workspace, and exposes
only governed tools with audit logging and approval checks.

DSH is the only Agent Runtime in this package. It owns the LLM seam, session,
prompt, tool, agent, and loop services. The Home Product Bundle contributes the
read-only `get_home_snapshot` tool through DSH's registry; it does not create a
parallel Agent or tool system.

`pi-agent-core` is forbidden. Standard API-key providers use the official
`@deepseek-ai/dsh-llm-pi-ai` adapter beneath the DSH LLM seam; `pi-ai` is only
the provider SDK. `mountDshPiHomeAgent` maps the five product provider names to
their pi routes and owns the adapter and Home Agent in one Cordis lifecycle.

Selected API-key profiles bridge into the official DSH credential seam through
a read-only alias-to-SecretRef provider that resolves on every request. Claude
OAuth has secure pi credential-store foundations but the upstream DSH adapter
does not yet accept OAuth stores. Do not bypass it with a second, partial
message/tool converter or disguise an OAuth token as an API key.
