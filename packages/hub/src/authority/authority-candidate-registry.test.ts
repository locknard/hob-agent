import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuthorityCandidateRegistry,
  AuthorityCandidateRegistryError,
  type AuthorityCandidateResolveInput,
} from "./authority-candidate-registry.js";

const createdAt = "2026-08-20T01:00:00.000Z";
const bindingIdentityA = `sha256:${"1".repeat(64)}`;
const bindingIdentityB = `sha256:${"2".repeat(64)}`;
const configurationIdentityA = `sha256:${"3".repeat(64)}`;
const configurationIdentityB = `sha256:${"4".repeat(64)}`;

function configured(overrides: Partial<AuthorityCandidateResolveInput> = {}): AuthorityCandidateResolveInput {
  return {
    hwCapabilityId: "hwc-curtain-level",
    knownCapability: true,
    configured: true,
    approved: true,
    available: true,
    bindingIdentity: bindingIdentityA,
    configurationIdentity: configurationIdentityA,
    registrationGeneration: 7,
    ...overrides,
  };
}

function temporaryRegistry(name: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), `hob-authority-candidate-${name}-`));
  return { directory, path: join(directory, "authority-candidates.sqlite") };
}

function withRegistry<T>(name: string, run: (registry: AuthorityCandidateRegistry, path: string) => T): T {
  const temporary = temporaryRegistry(name);
  const registry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
  try {
    return run(registry, temporary.path);
  } finally {
    registry.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
}

test("resolves a durable opaque candidate and exposes only the neutral projection", () => {
  withRegistry("projection", (registry) => {
    const result = registry.resolve(configured());

    assert.equal(result.candidate.hwCapabilityId, "hwc-curtain-level");
    assert.equal(result.candidate.status, "available");
    assert.match(result.candidate.actionAuthorityCandidateId, /^candidate-[0-9a-f]{64}$/);
    assert.match(result.authorityRegistryIdentity, /^sha256:[0-9a-f]{64}$/);
    assert.equal("bindingIdentity" in result, false);
    assert.equal("configurationIdentity" in result, false);
    assert.equal("registrationGeneration" in result, false);
    assert.equal("bridgeId" in result, false);
    assert.equal("adapterType" in result, false);
    assert.equal("nativeId" in result, false);
    assert.equal("nativeInstanceId" in result, false);
    assert.equal("remoteInstanceId" in result, false);
    assert.equal(JSON.stringify(result).includes("binding-digest-a"), false);
    assert.equal(JSON.stringify(result).includes("native"), false);
  });
});

test("replays the same candidate and registry identity after restart", () => {
  const temporary = temporaryRegistry("restart");
  try {
    const firstRegistry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
    const first = firstRegistry.resolve(configured());
    firstRegistry.close();

    const secondRegistry = new AuthorityCandidateRegistry({
      path: temporary.path,
      now: () => "2026-08-20T02:00:00.000Z",
    });
    try {
      assert.deepEqual(secondRegistry.resolve(configured()), first);
    } finally {
      secondRegistry.close();
    }
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("returns an unavailable placeholder for a known capability without configuration and rejects unknown capabilities", () => {
  withRegistry("availability", (registry) => {
    const placeholder = registry.resolve({
      hwCapabilityId: "hwc-unconfigured",
      knownCapability: true,
      configured: false,
      approved: false,
      available: false,
    });

    assert.equal(placeholder.candidate.status, "unavailable");
    assert.match(placeholder.candidate.actionAuthorityCandidateId, /^candidate-[0-9a-f]{64}$/);
    assert.throws(
      () => registry.resolve({
        ...configured({ hwCapabilityId: "hwc-unknown" }),
        knownCapability: false,
      }),
      (error: unknown) => error instanceof AuthorityCandidateRegistryError
        && error.code === "unknown_capability",
    );
  });
});

test("changes in temporary availability keep identity while approval changes create a new candidate", () => {
  withRegistry("status", (registry) => {
    const available = registry.resolve(configured({ available: true }));
    const unavailable = registry.resolve(configured({ available: false }));

    assert.equal(unavailable.candidate.status, "unavailable");
    assert.equal(unavailable.candidate.actionAuthorityCandidateId, available.candidate.actionAuthorityCandidateId);
    assert.equal(unavailable.authorityRegistryIdentity, available.authorityRegistryIdentity);

    const notApproved = registry.resolve(configured({ available: true, approved: false }));
    assert.equal(notApproved.candidate.status, "not_approved");
    assert.notEqual(notApproved.candidate.actionAuthorityCandidateId, available.candidate.actionAuthorityCandidateId);
    assert.notEqual(notApproved.authorityRegistryIdentity, available.authorityRegistryIdentity);
  });
});

test("rebind or configuration changes create a new candidate and supersede the old one", () => {
  withRegistry("supersede", (registry) => {
    const first = registry.resolve(configured());
    const rebound = registry.resolve(configured({
      bindingIdentity: bindingIdentityB,
      configurationIdentity: configurationIdentityB,
      registrationGeneration: 8,
    }));

    assert.notEqual(rebound.candidate.actionAuthorityCandidateId, first.candidate.actionAuthorityCandidateId);
    assert.notEqual(rebound.authorityRegistryIdentity, first.authorityRegistryIdentity);
    assert.throws(
      () => registry.resolve(configured()),
      (error: unknown) => error instanceof AuthorityCandidateRegistryError
        && error.code === "stale_candidate",
    );
  });
});

test("requires configured binding and configuration identities to be Hub sha256 digests", () => {
  withRegistry("identity-format", (registry) => {
    for (const field of ["bindingIdentity", "configurationIdentity"] as const) {
      assert.throws(
        () => registry.resolve(configured({ [field]: "https://user:secret@example.invalid/route" })),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "invalid_input",
      );
      assert.throws(
        () => registry.resolve(configured({ [field]: `sha256:${"a".repeat(63)}` })),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "invalid_input",
      );
      assert.throws(
        () => registry.resolve(configured({ [field]: `sha256:${"A".repeat(64)}` })),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "invalid_input",
      );
    }
  });
});

test("scopes registry identity to the resolved capability", () => {
  withRegistry("scoped-identity", (registry) => {
    const first = registry.resolve(configured());
    registry.resolve(configured({
      hwCapabilityId: "hwc-unrelated",
      bindingIdentity: bindingIdentityB,
      configurationIdentity: configurationIdentityB,
    }));

    const replay = registry.resolve(configured());
    assert.equal(replay.candidate.actionAuthorityCandidateId, first.candidate.actionAuthorityCandidateId);
    assert.equal(replay.authorityRegistryIdentity, first.authorityRegistryIdentity);
  });
});

test("explicit revoke is durable, idempotent, and never reactivates the revoked candidate", () => {
  withRegistry("revoke", (registry) => {
    const active = registry.resolve(configured());
    const revoked = registry.revoke(active.candidate.actionAuthorityCandidateId, "human authority was withdrawn");

    assert.equal(revoked.candidate.actionAuthorityCandidateId, active.candidate.actionAuthorityCandidateId);
    assert.equal(revoked.candidate.status, "not_approved");
    assert.notEqual(revoked.authorityRegistryIdentity, active.authorityRegistryIdentity);
    assert.deepEqual(
      registry.revoke(active.candidate.actionAuthorityCandidateId, "human authority was withdrawn"),
      revoked,
    );
    assert.deepEqual(registry.resolve(configured()), revoked);
  });
});

test("serializes two registry connections into one active candidate and one creation audit", () => {
  const temporary = temporaryRegistry("concurrency");
  const firstRegistry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
  const secondRegistry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
  try {
    const first = firstRegistry.resolve(configured());
    const second = secondRegistry.resolve(configured());

    assert.deepEqual(second, first);
    const db = new DatabaseSync(temporary.path);
    try {
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM authority_candidates WHERE lifecycle = 'active'").get()?.count), 1);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM authority_audit WHERE action = 'created'").get()?.count), 1);
    } finally {
      db.close();
    }
  } finally {
    firstRegistry.close();
    secondRegistry.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("keeps the SQLite main file and existing WAL sidecars private", () => {
  withRegistry("permissions", (registry, path) => {
    registry.resolve(configured());
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        assert.equal(statSync(candidate).mode & 0o777, 0o600, candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });
});

test("fails closed on missing audit history and never reconstructs a candidate", () => {
  const temporary = temporaryRegistry("corruption");
  try {
    const firstRegistry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
    firstRegistry.resolve(configured());
    firstRegistry.close();

    const db = new DatabaseSync(temporary.path);
    try {
      db.prepare("DELETE FROM authority_audit").run();
    } finally {
      db.close();
    }

    const reopened = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
    try {
      assert.throws(
        () => reopened.resolve(configured()),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "corrupt_record",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("fails closed when tampering creates two active candidates for one capability", () => {
  const temporary = temporaryRegistry("ambiguous-active");
  try {
    const firstRegistry = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
    const first = firstRegistry.resolve(configured());
    const rebound = firstRegistry.resolve(configured({
      bindingIdentity: bindingIdentityB,
      configurationIdentity: configurationIdentityB,
      registrationGeneration: 8,
    }));
    firstRegistry.close();

    const db = new DatabaseSync(temporary.path);
    try {
      // Remove only the old row's transition audit so both rows have a
      // self-consistent-looking active history before the lifecycle tamper.
      db.prepare("DELETE FROM authority_audit WHERE candidate_id = ? AND action = 'superseded'").run(
        first.candidate.actionAuthorityCandidateId,
      );
      db.prepare(`UPDATE authority_candidates
        SET lifecycle = 'active', superseded_at = NULL
        WHERE candidate_id = ?`).run(first.candidate.actionAuthorityCandidateId);
    } finally {
      db.close();
    }

    const reopened = new AuthorityCandidateRegistry({ path: temporary.path, now: () => createdAt });
    try {
      assert.throws(
        () => reopened.resolve(configured({
          bindingIdentity: bindingIdentityB,
          configurationIdentity: configurationIdentityB,
          registrationGeneration: 8,
        })),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "corrupt_record",
      );
      assert.throws(
        () => (reopened as unknown as { registryIdentity: (hwCapabilityId: string) => unknown })
          .registryIdentity("hwc-curtain-level"),
        (error: unknown) => error instanceof AuthorityCandidateRegistryError
          && error.code === "corrupt_record",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test("rejects route-like caller fields and exposes no execution or control surface", () => {
  withRegistry("surface", (registry) => {
    assert.throws(
      () => registry.resolve({
        ...configured(),
        bridgeId: "bridge-secret-route",
      } as never),
      (error: unknown) => error instanceof AuthorityCandidateRegistryError
        && error.code === "invalid_input",
    );
    for (const forbidden of ["control", "execute", "send", "write", "route", "credentials", "bridge"]) {
      assert.equal(forbidden in registry, false, forbidden);
    }
  });
});
