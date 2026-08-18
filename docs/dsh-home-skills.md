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
of the instructions. Structured household review outcomes are read-only
preference evidence; they do not become instructions or authority.

## Trust boundary

The embedded Skill is reviewed first-party product code and follows the exact
DSH Skill definition. Household facts remain data supplied through the bounded
prompt and HomeWorld tools; they are not allowed to register instructions.

Before enabling tenant filesystem Skills, add and test all of the following:

- a canonical root containment check on every discovery and body read;
- rejection of symbolic links and non-regular files;
- byte limits for frontmatter, body, and referenced resources;
- explicit installation/review state separate from file presence;
- a clear distinction between loading instructions and receiving authority.

These guards should wrap or configure the upstream provider seam, not create a
parallel registry or model-facing loader.
