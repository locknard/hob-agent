# DSH runtime invariant companions

Status: accepted for Phase 0 implementation.

The Home Agent mounts the official `dsh-invariants` registry and the executable
companions for the stateful DSH packages it actively composes:

- session event enclosure and call/result pairing;
- Agent lifecycle and inbox transitions;
- scoped event subject identity;
- Agent-loop request reconstruction;
- LLM stream grammar;
- tool pipeline and frozen result publication;
- authoritative system-prompt assembly; and
- durable compaction marker, summary, replacement, and end pairing.

These companions observe DSH's own runtime protocols. They do not add prompts,
tools, authority, persistence, or a second policy engine. An invariant failure
is a structural runtime fault and fails the affected operation with the owning
DSH package name; arbitrary model, provider, tool-result, or household content
must not be surfaced as a user-facing error.

Companions whose official rc.7 implementation explicitly declares that the
package has no runtime invariant are not mounted merely to increase a count.
Their pure/configuration behavior remains covered by load and unit tests. The
registry and executable companions must be installed before the first Agent is
created or model request is issued, so live-only checks cannot miss the start
of the lifecycle they protect.
