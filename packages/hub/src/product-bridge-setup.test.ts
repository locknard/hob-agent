import assert from "node:assert/strict";
import test from "node:test";

import { ProductBridgeSetup } from "./product-bridge-setup.js";

class MemoryVault {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  read(reference: string) { return Promise.resolve(this.values.get(reference)); }
  write(reference: string, value: string) { this.values.set(reference, value); return Promise.resolve(); }
  delete(reference: string) { this.deleted.push(reference); this.values.delete(reference); return Promise.resolve(); }
}

const registration = {
  adapterType: "fixture-peer",
  label: "Fixture Peer",
  credentialAlias: "access-token",
  normalizeConfig(input: Readonly<Record<string, unknown>>) {
    if (typeof input.serverAddress !== "string") throw new TypeError();
    return { serverAddress: input.serverAddress };
  },
  displayEndpoint(config: Readonly<Record<string, unknown>>) { return String(config.serverAddress); },
  probe: async () => ({
    status: "connected" as const,
    latencyMs: 28,
    summary: { states: 21, entities: 20, devices: 8, areas: 4 },
  }),
};

test("stages and probes one catalog-owned bridge without adapter imports", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({ vault, registrations: [registration], createStageNonce: () => "stage-1" });
  const result = await setup.probe({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-local-bridge-secret",
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("expected ready bridge probe");
  assert.match(result.stage.bridgeId, /^bridge-[a-f0-9]{16}$/u);
  assert.equal(result.stage.credentialRefs["access-token"], `keychain:hob-agent/bridge:${result.stage.bridgeId}:access-token`);
  assert.equal(vault.values.get(result.stage.credentialRefs["access-token"]!), "request-local-bridge-secret");
  assert.equal(result.stage.endpoint, "fixture://peer.local");
  assert.deepEqual(result.stage.config, { serverAddress: "fixture://peer.local" });
  await setup.discard(result.stage);
  assert.equal(vault.values.size, 0);
});

test("cleans the staged credential when the catalog probe rejects it", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({
    vault,
    createStageNonce: () => "stage-rejected",
    registrations: [{ ...registration, probe: async () => ({ status: "credential_rejected" as const }) }],
  });
  assert.deepEqual(await setup.probe({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "wrong-secret",
  }), { status: "credential_rejected" });
  assert.equal(vault.values.size, 0);
  assert.equal(vault.deleted.length, 1);
});

test("rejects an invalid adapter display endpoint before staging a credential", async () => {
  const vault = new MemoryVault();
  const setup = new ProductBridgeSetup({
    vault,
    registrations: [{ ...registration, displayEndpoint: () => "peer\nsecret" }],
  });

  assert.deepEqual(await setup.probe({
    setupId: "draft-home",
    adapterType: "fixture-peer",
    config: { serverAddress: "fixture://peer.local" },
    credential: "request-local-bridge-secret",
  }), { status: "incompatible" });
  assert.equal(vault.values.size, 0);
});
