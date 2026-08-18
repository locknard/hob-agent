import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterRegistrationSchema,
  bridgeAdapterSchema,
  bridgeControlSchema,
  bridgeEventSchema,
  bridgeInfoSchema,
  bridgeStreamErrorReasonSchema,
  canonicalExtensionKey,
  controlResultSchema,
  credentialMaterialSchema,
  deviceDescriptorSchema,
  envelopeSchema,
  hubBridgeDiagnosticsSchema,
  identityClaimSchema,
  ingestRecordSchema,
  normalizeBridgeStreamError,
  resourceBudgetSchema,
  schemaRegistrationSchema,
  worldCapabilitySchema,
  BridgeStreamError,
  type ExtensionHandleRegistry,
} from "./bridge-contract.js";
import { z } from "zod";

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "test-actions@1": { readonly execute: () => void };
  }
}

type TestActionsHandle = ExtensionHandleRegistry["test-actions@1"];
const augmentationIsTyped: TestActionsHandle = { execute: () => undefined };
void augmentationIsTyped;

test("validates the frozen bridge info, event envelope, and open extension payload", () => {
  const info = bridgeInfoSchema.parse({
    bridgeId: "bridge-ha",
    coreVersion: "6.3.0",
    ecosystem: "home-assistant",
    heartbeatIntervalMs: 60_000,
    extensions: [{ id: "actions", version: "1.2.0", metadata: { mode: "safe" } }],
  });

  assert.equal("remoteInstanceId" in info, false);
  assert.equal(canonicalExtensionKey({ id: "actions", version: "1.2.0" }), "actions@1");
  assert.ok(
    envelopeSchema.parse({
      epochId: "epoch-1",
      seq: 1,
      event: {
        kind: "sync-start",
        snapshotId: "snapshot-1",
        remoteInstanceId: "ha-prod",
        reason: "initial",
      },
    }),
  );
  assert.ok(
    bridgeEventSchema.parse({ kind: "ext", ext: "actions@1", payload: { action: "turn_on" } }),
  );
  assert.throws(() => bridgeInfoSchema.parse({ ...info, adapterType: "home-assistant" }));
  assert.throws(() =>
    bridgeEventSchema.parse({ kind: "sync-start", snapshotId: "snapshot-1", reason: "initial" }),
  );
});

test("requires semantic core versions and rejects duplicate extension canonical keys", () => {
  const info = {
    bridgeId: "bridge-ha",
    coreVersion: "6.3.0",
    ecosystem: "home-assistant",
    heartbeatIntervalMs: 60_000,
    extensions: [],
  };

  assert.throws(() => bridgeInfoSchema.parse({ ...info, coreVersion: "6" }));
  assert.throws(() => bridgeInfoSchema.parse({ ...info, coreVersion: "v6.3.0" }));
  assert.throws(() => bridgeInfoSchema.parse({
    ...info,
    extensions: [
      { id: "actions", version: "1.2.0" },
      { id: "actions", version: "1.9.0" },
    ],
  }));
  assert.throws(() => bridgeInfoSchema.parse({
    ...info,
    extensions: [{ id: "actions", version: "1.2" }],
  }));
});

test("keeps adapter lifecycle seams typed and journal records envelope-shaped", () => {
  const control = {
    requestResync: async () => ({ status: "completed" as const }),
    dispose: async () => undefined,
  };
  const adapter = {
    info: {
      bridgeId: "bridge-ha",
      coreVersion: "6.3.0",
      ecosystem: "home-assistant",
      heartbeatIntervalMs: 60_000,
      extensions: [],
    },
    events: async function* () {
      yield {
        epochId: "epoch-1",
        seq: 1,
        event: { kind: "heartbeat" as const },
      };
    },
    control,
    extension: () => undefined,
  };
  assert.ok(bridgeControlSchema.parse(control));
  assert.ok(bridgeAdapterSchema.parse(adapter));
  assert.ok(
    ingestRecordSchema.parse({
      bridgeId: "bridge-ha",
      receivedAt: "2026-08-18T00:00:00.000Z",
      envelope: { epochId: "epoch-1", seq: 1, event: { kind: "heartbeat" } },
    }),
  );
});

test("keeps identity claims closed by source provenance", () => {
  assert.ok(
    identityClaimSchema.parse({
      type: "ieee",
      value: "00:11:22:33:44:55:66:77",
      source: { kind: "independent_registry", registry: "zigbee2mqtt" },
      confidence: "high",
    }),
  );
  assert.throws(() =>
    identityClaimSchema.parse({
      type: "ieee",
      value: "00:11",
      source: { kind: "platform_registry" },
      confidence: "high",
    }),
  );
});

test("validates descriptor capabilities, state, and manifest event shapes", () => {
  const descriptor = deviceDescriptorSchema.parse({
    nativeId: "light.living_room",
    name: "Living room light",
    capabilities: [{ nativeInstanceId: "entity-1", schema: "hob.light", schemaVersion: "1.0.0" }],
    identityClaims: [
      {
        type: "serial",
        value: "serial-1",
        source: { kind: "device_reported" },
        confidence: "medium",
      },
    ],
  });
  assert.equal(descriptor.capabilities[0]?.schema, "hob.light");
  assert.throws(() =>
    bridgeEventSchema.parse({
      kind: "sync-complete",
      manifest: { snapshotId: "s", deviceEnvelopeCount: -1, stateEnvelopeCount: 0 },
    }),
  );
});

test("accepts each scoped credential material and rejects unknown kinds", () => {
  assert.ok(credentialMaterialSchema.parse({ kind: "secret_text", value: "opaque" }));
  assert.ok(
    credentialMaterialSchema.parse({
      kind: "oauth",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2026-08-18T00:00:00.000Z",
    }),
  );
  assert.ok(
    credentialMaterialSchema.parse({
      kind: "certificate",
      certificatePem: "cert",
      privateKeyPem: "key",
      caPem: "ca",
    }),
  );
  assert.throws(() => credentialMaterialSchema.parse({ kind: "raw_vault", value: "secret" }));
});

test("keeps catalog registrations, budgets, and world capabilities structurally bounded", () => {
  const configSchema = z.object({ token: z.string() });
  const typedRegistration: import("./bridge-contract.js").SchemaRegistration<{ state: string }> = {
    schema: "hob.light",
    majorVersion: 1,
    attrsSchema: z.object({ state: z.string() }),
    canonicalHash: "sha256:abc",
  };
  assert.equal(typedRegistration.majorVersion, 1);
  assert.ok(
    adapterRegistrationSchema.parse({
      adapterType: "home-assistant",
      configSchema,
      credentialRequirements: [{ alias: "access-token", kind: "secret_text" }],
      capabilitySchemas: [
        {
          schema: "ha.light",
          majorVersion: 1,
          attrsSchema: z.object({ state: z.string() }),
          canonicalHash: "sha256:abc",
        },
      ],
      factory: () => ({})
    }),
  );
  assert.throws(() =>
    adapterRegistrationSchema.parse({
      adapterType: "async-adapter",
      configSchema,
      credentialRequirements: [],
      capabilitySchemas: [],
      factory: async () => ({}),
    }),
  );
  assert.ok(resourceBudgetSchema.parse({ maxFields: 10, maxStringLength: 100, maxDepth: 4, maxSerializedBytes: 4096 }));
  assert.throws(() => resourceBudgetSchema.parse({ maxFields: 0, maxStringLength: 100, maxDepth: 4, maxSerializedBytes: 4096 }));
  assert.ok(
    worldCapabilitySchema.parse({
      hwCapabilityId: "hwc-1",
      hwId: "hw-1",
      schema: "hob.light",
      bindings: [{ bridgeId: "bridge-ha", nativeId: "light.living_room", nativeInstanceId: "entity-1" }],
    }),
  );
  assert.ok(
    schemaRegistrationSchema.parse({
      schema: "hob.light",
      majorVersion: 1,
      attrsSchema: z.object({ state: z.string() }),
      canonicalHash: "sha256:abc",
    }),
  );
});

test("exposes closed control reasons and typed stream termination", () => {
  assert.ok(controlResultSchema.parse({ status: "completed" }));
  assert.ok(controlResultSchema.parse({ status: "failed", reason: "upstream_unavailable", adapterCode: "ha:offline" }));
  assert.throws(() => controlResultSchema.parse({ status: "failed", reason: "provider_secret" }));
  assert.ok(bridgeStreamErrorReasonSchema.parse("protocol_error"));
  const error = new BridgeStreamError("socket closed", "upstream_unavailable");
  assert.equal(error.name, "BridgeStreamError");
  assert.equal(error.reason, "upstream_unavailable");
  assert.equal(normalizeBridgeStreamError(new Error("opaque")).reason, "internal_error");
});

test("bounds retained diagnostics while preserving both sync and contact timestamps", () => {
  const diagnostic = {
    connectionState: "syncing" as const,
    lastSyncCompleteAt: "2026-08-18T00:00:00.000Z",
    lastEventReceivedAt: "2026-08-18T00:00:01.000Z",
    lastSuccessfulContactAt: "2026-08-18T00:00:01.000Z",
    droppedInvalidCount: 0,
    strippedFieldsCount: 0,
    staleEpochDropCount: 0,
    foldedStateCount: 0,
    unsupportedSchemaCount: 0,
    protocolViolationCount: 0,
    historyGapCount: 0,
    recentHistoryGaps: [],
  };
  assert.ok(hubBridgeDiagnosticsSchema.parse(diagnostic));
  assert.throws(() =>
    hubBridgeDiagnosticsSchema.parse({
      ...diagnostic,
      recentHistoryGaps: Array.from({ length: 33 }, (_, index) => ({ from: `${index}`, to: `${index}`, reason: "gap" })),
    }),
  );
});
