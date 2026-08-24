# ADR: Private encrypted credential vault for Phase 0 local runtime

Status: accepted

## Context

The Phase 0 process must retain model, bridge, and private voice credentials
locally on Linux hosts where the macOS Keychain is unavailable. Credential
locators are durable product state, so a Linux fallback must preserve the same
bounded ownership, cleanup, and runtime-resolution rules without moving secret
material into Hub contracts, proposals, or setup drafts.

## Decision

When `HOB_VAULT_KEY_FILE` is explicitly configured, the process selects one
authenticated-encrypted local file vault for the product composition root. The
key file is an absolute, owner-readable regular file with no group or other
permissions and decodes to exactly 32 bytes. The vault stores its bounded
per-reference entries below `HOB_DATA_DIR`, encrypts each value with
AES-256-GCM and reference-bound associated data, with a file-level integrity
record covering the bounded entry map, and writes updates through a 0600
temporary file followed by an atomic rename. A private lock serializes writes;
malformed, tampered, over-sized, concurrent, or permission-unsafe state fails
closed. Errors do not include secrets or filesystem paths.

The selected vault instance is shared by model setup and resolution, bridge
setup and runtime resolution, and ASR/TTS setup and runtime resolution. The
default remains the macOS Keychain when the explicit key-file setting is
absent, preserving existing macOS behavior and tests.

`vault:` is the canonical durable `SecretRef` source for this encrypted vault.
`keychain:` remains a compatibility ingress for existing macOS state and
explicitly remains supported until the macOS compatibility window closes and
all durable references have been migrated to `vault:`. New production setup
references use the selected source, so an encrypted-vault deployment never
creates a new `keychain:` locator.

## Consequences

The vault key is an operator-managed local secret and is never copied into
application state. The encrypted file is process-local state and is not
portable without the explicit key file. Setup cleanup ledgers and bootstrap
validation accept both durable sources while retaining exact owner and
generation checks. No new runtime, process boundary, dependency, or external
credential protocol is introduced.
