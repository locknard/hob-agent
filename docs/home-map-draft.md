# Review-first home map draft

## Decision

`pnpm draft:home-map` converts one ready neutral HomeWorld snapshot into a
private, editable `HOME.import.md` draft. It is the first implementation step
for the onboarding promise to turn a vendor inventory into a household map.

The command does not call DSH or a model. It reads the normal bridge paths and
requires an explicit absolute `HOB_HOME_DIR`. It creates the draft with mode
`0600` and exclusive-create semantics; an existing file, symlink, unsafe
directory, incomplete world, oversized result, or write failure fails closed.
It never replaces `HOME.md` and never modifies `SOUL.md` or `MEMORY.md`.

## Draft content

The draft contains:

- an explicit review-required warning;
- neutral spaces with their current display names;
- devices grouped by accepted Hub space binding;
- a separate unassigned section;
- opaque Hub device IDs; and
- closed neutral capability semantic kinds.

It omits current state values, native device/entity/property/space IDs,
credentials, URLs, bridge errors, model content, and existing rule bodies.
Untrusted display names are encoded as quoted JSON string literals and Markdown
punctuation is escaped rather than treated as links, formatting, or
instructions. The result is bounded to the existing 32 KiB `HOME.md` loader
limit.

## Review boundary

`HOME.import.md` is never loaded automatically. The household must inspect,
rename, reorganize, and deliberately merge accepted facts into `HOME.md`.
Names and space assignments imported from a bridge are suggestions with source
provenance, not verified household truth. Missing assignments remain explicit;
the command never infers a room from a device name.
