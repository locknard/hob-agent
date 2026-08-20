# DSH Home Skills first slice

Status: accepted for Phase 0 implementation.

## Decision

Hob-agent uses the official DSH Skill registry and model-facing `skill` tool.
There is no Home Skill registry, loader, or second Skill format. The Home
Product Bundle initially contributes one small embedded first-party Skill for
the governed household-observation workflow.

The first slice deliberately does not mount `dsh-skill-filesystem` over the
tenant-editable `home-template/skills` directory. In DSH rc.7, local Skill
bodies are uncapped, are reread on demand, and the Node filesystem fallback
follows symbolic links. Those are acceptable assumptions for trusted coding
environment Skills, but not yet for household content that may later be edited
through a product surface.

## Composition

The sole runtime mounts:

1. `@deepseek-ai/dsh-skill` as `ctx.skills`;
2. the first-party Home Product Bundle Skill contribution;
3. `@deepseek-ai/dsh-tool-skill` for the durable catalog and loader tool;
4. the existing DSH Agent loop.

The Home Skill describes how to use the already-governed calibration,
inventory, activity, snapshot, evidence, existing-rule, and proposal tools.
Loading it grants no additional
tool, policy exception, device authority, approval, or execution path. The Hub
continues to enforce inventory/rule coverage and trusted evidence independently
of the instructions. It also enforces one calibration read before an
autonomous proposal can be created. Structured household review outcomes are read-only
preference evidence; they do not become instructions or authority.

## Trust boundary

The embedded Skill is reviewed first-party product code and follows the exact
DSH Skill definition. Household facts remain data supplied through the bounded
prompt and HomeWorld tools; they are not allowed to register instructions.

## Tenant `SKILL.md` provider

The first tenant slice is now mounted only when `householdDirectory` is
configured. It registers a narrow provider with the existing `ctx.skills`
registry; `dsh-tool-skill` remains the only model-facing catalog and loader.
The provider reads `<householdDirectory>/skills` and accepts the same two
filesystem shapes as the official provider: a flat `*.md` entry or one-level
`<directory>/SKILL.md`. It does not introduce another frontmatter format,
registry, loader, watcher, or tool seam.
Its frontmatter is the official `SKILL.md` YAML shape as a strict, bounded
subset: only `name`, `description`, `whenToUse`,
`disable-model-invocation`, `user-invocable`, and `metadata` are accepted.
Required `name` and `description` must be non-empty; an empty body is valid.
An empty `metadata:` block is treated as absent, while explicit null,
non-object, malformed, or repeated metadata entries are rejected.
Unknown or repeated top-level keys, indentation outside `metadata`, malformed
metadata, and repeated metadata keys reject the whole file rather than
creating a silent compatibility sub-format.

The official `@deepseek-ai/dsh-skill-filesystem@0.1.0-rc.7` provider was
audited before mounting. Its general-purpose host-local defaults are not a
safe tenant boundary: native discovery follows symbolic links, watcher
configuration defaults to following links, and skill parsing reads files
without a body/total byte budget. The Home provider therefore reuses only the
official `SkillProvider` contract and keeps tenant policy narrow:

- The configured root must be absolute and a real directory. Every discovery
  and on-demand body read rechecks canonical containment, rejects symlinks and
  non-regular files, and opens the final file with `O_NOFOLLOW`.
- Each file is capped at 64 KiB by default, discovery is capped at 256 KiB
  across all files, and at most 64 entries are considered. Limits are
  configurable for deterministic tests and deployment policy.
- Missing `skills` is an empty complete catalog. Unsafe entries or a root
  transition produce no unsafe candidate and an incomplete observation, so the
  registry does not cache it as authoritative. Malformed or invalid
  frontmatter is omitted.
- Discovery order is code-point lexical order. If two files declare the same
  Skill name, every candidate with that name is omitted and the observation is
  marked incomplete; an ambiguous tenant file cannot shadow a reviewed
  runtime Skill. Tenant candidates use the higher numeric rank (700) and thus
  lower precedence than the embedded reviewed Home Skills (250), so a
  same-name tenant file cannot replace them.
- `ctx.skills.get()` rereads and revalidates the candidate on demand under the
  same single-file limit. Tenant definitions expose an opaque resource base;
  no tenant path is handed to the model for follow-up resource reads in Phase
  0.

Loading tenant instructions does not register tools, grant authority, bypass
approval, or change the Hub policy boundary. Tenant text remains untrusted
model input. A missing or changed file can make a later load return no
definition; the registry/provider does not retain a body cache or run a tenant
watcher. The provider's intentionally small frontmatter reader accepts only
that official bounded subset and fails closed on unsupported or malformed
fields rather than becoming a second Skill format.
