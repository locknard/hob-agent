# Household prompt and context

## Decision

The first household-specialization slice uses the official DSH system-prompt
registry. It does not introduce a second prompt engine or Skill format.

An explicitly configured `HOB_HOME_DIR` may contribute three bounded files:

- `SOUL.md` extends the deployment persona with household tone and preferences;
- `HOME.md` is a sourced DSH runtime-context snapshot; and
- `MEMORY.md` is a separate sourced DSH runtime-context snapshot.

`HEARTBEAT.md` is not loaded until DSH jobs/scheduling has a governed product
composition. `AGENTS.md` remains the template's operating manual rather than a
second runtime instruction loader. `skills/` remains inactive until the
official DSH filesystem Skill packages are available in the same compatibility
family as the runtime.

## Authority and safety

Household Markdown can personalize reasoning and supply facts, but it cannot
register tools, change bridge policy, approve proposals, control devices, or
bypass Hub enforcement. A fixed product safety preamble remains before the
household persona. HOME and MEMORY are runtime context, not hidden authority.

The directory is optional and must be an explicit absolute path. When it is
configured, all three files are required, regular non-symlink files, valid
UTF-8, and individually bounded to 32 KiB. The combined content is bounded to
96 KiB. DSH currently interprets complete `{{...}}` groups as strict prompt
variables and has no escape syntax, so household files containing prompt
template delimiters fail startup rather than being reinterpreted.

The initial implementation snapshots files at process startup. Editing a file
requires a restart; watching, hot reload, writes to MEMORY, and household UI
editing are deferred. Raw household content remains local, enters the DSH
session context history, and must never be copied into proposal or Inbox trace
metadata.
