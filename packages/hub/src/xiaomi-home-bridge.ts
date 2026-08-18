import { createHash } from "node:crypto";

import { z } from "zod";

import {
  BridgeStreamError,
  capabilitySemanticKindSchema,
  JsonValueSchema,
  type AdapterFactoryContext,
  type AdapterRegistration,
  type BridgeAdapter,
  type BridgeControl,
  type BridgeEvent,
  type BridgeInfo,
  type CapabilitySemanticKind,
  type ControlResult,
  type CredentialRequirement,
  type Envelope,
  type ExtensionHandleRegistry,
  type JsonValue,
  type StateEvent,
} from "../../../contracts/bridge-contract.js";

export const XIAOMI_HOME_ADAPTER_TYPE = "xiaomi-home";
export const XIAOMI_HOME_PROPERTY_SCHEMA = "miot.property";
export const XIAOMI_HOME_PROPERTY_SCHEMA_VERSION = "1.0.0";
const CORE_VERSION = "6.4.0";
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_DEVICES = 2_048;
const MAX_PROPERTIES_PER_DEVICE = 256;
let epochCounter = 0;

const xiaomiHomeConfigSchema = z.object({
  region: z.enum(["cn", "de", "us", "ru", "tw", "sg", "in", "i2"]),
  transport: z.enum(["cloud", "central-gateway"]),
  homeIds: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict();

export type XiaomiHomeAdapterConfig = z.infer<typeof xiaomiHomeConfigSchema>;

const propertyAttrsSchema = z.object({
  value: JsonValueSchema,
  format: z.string().min(1).max(64),
  unit: z.string().min(1).max(128).optional(),
  writable: z.boolean(),
}).strict();

const PROPERTY_CANONICAL_FORM = "miot.property@1|value=json|format=string|unit=string?|writable=boolean";
export const XIAOMI_HOME_PROPERTY_SCHEMA_CANONICAL_HASH = `sha256:${createHash("sha256")
  .update(PROPERTY_CANONICAL_FORM)
  .digest("hex")}`;

export interface XiaomiHomeNativeProperty {
  readonly siid: number;
  readonly piid: number;
  readonly value: JsonValue;
  readonly format: string;
  readonly unit?: string;
  readonly writable?: boolean;
  readonly sourceTs?: string;
  /** Set only by a transport that resolved the MIoT specification. */
  readonly semanticKind?: CapabilitySemanticKind;
}

export interface XiaomiHomeNativeDevice {
  readonly did: string;
  readonly name?: string;
  readonly online?: boolean;
  readonly properties: readonly XiaomiHomeNativeProperty[];
}

export interface XiaomiHomeSnapshot {
  /** Stable transport-owned installation identity; never emitted verbatim. */
  readonly installationId: string;
  readonly devices: readonly XiaomiHomeNativeDevice[];
}

export type XiaomiHomeChange =
  | {
    readonly kind: "property";
    readonly did: string;
    readonly property: XiaomiHomeNativeProperty;
  }
  | { readonly kind: "online"; readonly did: string; readonly online?: boolean }
  | { readonly kind: "snapshot"; readonly snapshot: XiaomiHomeSnapshot };

/**
 * License-neutral port implemented by an authorized Xiaomi SDK or a local,
 * separately licensed gateway integration. Network and credential I/O starts
 * only from connect(), never from the synchronous catalog factory.
 */
export interface XiaomiHomeTransport {
  connect(signal: AbortSignal): Promise<XiaomiHomeSnapshot>;
  changes(signal: AbortSignal): AsyncIterable<XiaomiHomeChange>;
  resync(signal: AbortSignal): Promise<XiaomiHomeSnapshot>;
  dispose(): Promise<void>;
}

export interface XiaomiHomeTransportPlugin {
  readonly credentialRequirements: readonly CredentialRequirement[];
  create(context: AdapterFactoryContext<XiaomiHomeAdapterConfig>): XiaomiHomeTransport;
}

export function deriveXiaomiRemoteInstanceId(region: string, installationId: string): string {
  const normalizedRegion = region.trim().toLowerCase();
  const normalizedInstallationId = installationId.trim();
  if (normalizedRegion === "" || normalizedInstallationId === "" || normalizedInstallationId.length > 512) {
    throw new BridgeStreamError("protocol_error", "Xiaomi transport returned an invalid installation identity");
  }
  return `miot:${createHash("sha256")
    .update(`xiaomi-home-remote-v1\n${normalizedRegion}\n${normalizedInstallationId}`)
    .digest("hex")}`;
}

export function createXiaomiHomeAdapterRegistration(
  plugin: XiaomiHomeTransportPlugin,
): AdapterRegistration<XiaomiHomeAdapterConfig> {
  if (!plugin || typeof plugin.create !== "function" || !Array.isArray(plugin.credentialRequirements)) {
    throw new TypeError("Xiaomi transport plugin is invalid");
  }
  return Object.freeze({
    adapterType: XIAOMI_HOME_ADAPTER_TYPE,
    configSchema: xiaomiHomeConfigSchema,
    credentialRequirements: Object.freeze([...plugin.credentialRequirements]),
    capabilitySchemas: Object.freeze([{
      schema: XIAOMI_HOME_PROPERTY_SCHEMA,
      majorVersion: 1,
      attrsSchema: propertyAttrsSchema,
      canonicalHash: XIAOMI_HOME_PROPERTY_SCHEMA_CANONICAL_HASH,
    }]),
    factory: (context: AdapterFactoryContext<XiaomiHomeAdapterConfig>) =>
      new XiaomiHomeBridgeAdapter(context, plugin.create(context)),
  });
}

export class XiaomiHomeBridgeAdapter implements BridgeAdapter {
  readonly info: BridgeInfo;
  readonly control: BridgeControl;
  private state: "new" | "running" | "disposed" = "new";
  private started = false;
  private queue: ChangeQueue | undefined;
  private activeTransport = false;
  private resyncPromise: Promise<ControlResult> | undefined;
  private knownDevices = new Set<string>();
  private knownProperties = new Set<string>();

  constructor(
    private readonly context: AdapterFactoryContext<XiaomiHomeAdapterConfig>,
    private readonly transport: XiaomiHomeTransport,
  ) {
    this.info = Object.freeze({
      bridgeId: context.bridgeId,
      coreVersion: CORE_VERSION,
      ecosystem: "xiaomi-home",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      extensions: Object.freeze([]),
    });
    this.control = Object.freeze({
      requestResync: (signal: AbortSignal) => this.requestResync(signal),
      dispose: () => this.dispose(),
    });
  }

  events(signal: AbortSignal): AsyncIterable<Envelope> {
    if (this.started || this.state === "disposed") {
      throw new BridgeStreamError("protocol_error", "Xiaomi Home adapter has a single-use lifecycle");
    }
    this.started = true;
    return this.run(signal);
  }

  extension<K extends keyof ExtensionHandleRegistry>(_name: K): ExtensionHandleRegistry[K] | undefined {
    return undefined;
  }

  private async *run(signal: AbortSignal): AsyncGenerator<Envelope> {
    this.state = "running";
    this.activeTransport = true;
    const queue = new ChangeQueue();
    this.queue = queue;
    try {
      let current = prepareSnapshot(this.context, await this.transport.connect(signal));
      if (signal.aborted || this.isDisposed()) return;
      this.adoptSnapshot(current);
      yield* snapshotEnvelopes(current, "initial");

      void this.pumpChanges(signal, queue);
      while (!signal.aborted && this.isRunning()) {
        const change = await queue.next(signal);
        if (change === undefined) return;
        if (change.kind === "snapshot") {
          current = prepareSnapshot(this.context, change.snapshot);
          this.adoptSnapshot(current);
          yield* snapshotEnvelopes(current, "resync");
          continue;
        }
        if (change.kind === "online") {
          const nativeId = boundedString(change.did, 512, "device id");
          if (!this.knownDevices.has(nativeId)) continue;
          yield current.envelope({
            kind: "device-health",
            nativeId,
            status: change.online === undefined ? "unknown" : change.online ? "reachable" : "unreachable",
          });
          continue;
        }
        const state = projectPropertyState(change.did, change.property);
        if (!this.knownProperties.has(propertyBindingKey(state.nativeId, state.nativeInstanceId))) continue;
        yield current.envelope({ kind: "state", state });
      }
    } catch (error) {
      if (signal.aborted || this.isDisposed()) return;
      throw mapTransportError(error);
    } finally {
      this.state = "disposed";
      this.queue = undefined;
      this.knownDevices.clear();
      this.knownProperties.clear();
      queue.close();
      if (this.activeTransport) {
        this.activeTransport = false;
        await this.transport.dispose().catch(() => undefined);
      }
    }
  }

  private async pumpChanges(signal: AbortSignal, queue: ChangeQueue): Promise<void> {
    try {
      for await (const change of this.transport.changes(signal)) queue.push(change);
      queue.close();
    } catch (error) {
      queue.fail(mapTransportError(error));
    }
  }

  private adoptSnapshot(snapshot: SnapshotEmission): void {
    this.knownDevices = new Set(snapshot.devices.map((device) => device.did));
    this.knownProperties = new Set(snapshot.devices.flatMap((device) =>
      device.properties.map((property) => propertyBindingKey(device.did, propertyInstanceId(property))),
    ));
  }

  private requestResync(signal: AbortSignal): Promise<ControlResult> {
    if (signal.aborted) return Promise.resolve({ status: "failed", reason: "cancelled" });
    if (this.state !== "running" || this.queue === undefined) {
      return Promise.resolve({ status: "unsupported", reason: "not_ready" });
    }
    if (this.resyncPromise !== undefined) return this.resyncPromise;
    const queue = this.queue;
    const operation = this.performResync(signal, queue).finally(() => {
      if (this.resyncPromise === operation) this.resyncPromise = undefined;
    });
    this.resyncPromise = operation;
    return operation;
  }

  private async performResync(signal: AbortSignal, queue: ChangeQueue): Promise<ControlResult> {
    try {
      const snapshot = await this.transport.resync(signal);
      if (!signal.aborted) queue.push({ kind: "snapshot", snapshot });
      return signal.aborted
        ? { status: "failed", reason: "cancelled" }
        : { status: "completed" };
    } catch (error) {
      queue.fail(mapTransportError(error));
      return { status: "failed", reason: "upstream_unavailable" };
    }
  }

  private isDisposed(): boolean {
    return this.state === "disposed";
  }

  private isRunning(): boolean {
    return this.state === "running";
  }

  private async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.queue?.close();
    if (this.activeTransport) {
      this.activeTransport = false;
      await this.transport.dispose();
    }
  }
}

interface SnapshotEmission {
  readonly snapshotId: string;
  readonly remoteInstanceId: string;
  readonly devices: readonly ProjectedDevice[];
  envelope(event: BridgeEvent): Envelope;
}

interface ProjectedDevice {
  readonly did: string;
  readonly name?: string;
  readonly online?: boolean;
  readonly properties: readonly XiaomiHomeNativeProperty[];
}

function prepareSnapshot(
  context: AdapterFactoryContext<XiaomiHomeAdapterConfig>,
  snapshot: XiaomiHomeSnapshot,
): SnapshotEmission {
  if (!snapshot || !Array.isArray(snapshot.devices) || snapshot.devices.length > MAX_DEVICES) {
    throw new BridgeStreamError("protocol_error", "Xiaomi transport returned an invalid device snapshot");
  }
  const remoteInstanceId = deriveXiaomiRemoteInstanceId(context.config.region, snapshot.installationId);
  const devices = snapshot.devices.map((device) => validateDevice(device));
  const snapshotId = `miot-${createHash("sha256")
    .update(`${remoteInstanceId}\n${++epochCounter}`)
    .digest("hex")}`;
  const epochId = `${context.bridgeId}:${snapshotId}`;
  let seq = 1;
  return { snapshotId, remoteInstanceId, devices, envelope: (event) => ({ epochId, seq: seq++, event }) };
}

function validateDevice(device: XiaomiHomeNativeDevice): ProjectedDevice {
  const did = boundedString(device?.did, 512, "device id");
  if (!Array.isArray(device.properties) || device.properties.length > MAX_PROPERTIES_PER_DEVICE) {
    throw new BridgeStreamError("protocol_error", "Xiaomi transport returned too many device properties");
  }
  const seen = new Set<string>();
  const properties = device.properties.map((property) => {
    validateProperty(property);
    const id = propertyInstanceId(property);
    if (seen.has(id)) throw new BridgeStreamError("protocol_error", "Xiaomi transport returned duplicate properties");
    seen.add(id);
    return property;
  }).sort((left, right) => propertyInstanceId(left).localeCompare(propertyInstanceId(right)));
  return {
    did,
    ...(device.name === undefined ? {} : { name: boundedString(device.name, 512, "device name") }),
    ...(device.online === undefined ? {} : { online: device.online }),
    properties,
  };
}

function* snapshotEnvelopes(emission: SnapshotEmission, reason: "initial" | "resync"): Generator<Envelope> {
  yield emission.envelope({ kind: "sync-start", snapshotId: emission.snapshotId, remoteInstanceId: emission.remoteInstanceId, reason });
  let stateEnvelopeCount = 0;
  for (const device of emission.devices) {
    yield emission.envelope({
      kind: "device-upserted",
      device: {
        nativeId: device.did,
        ...(device.name === undefined ? {} : { name: device.name }),
        capabilities: device.properties.map((property) => ({
          nativeInstanceId: propertyInstanceId(property),
          schema: XIAOMI_HOME_PROPERTY_SCHEMA,
          schemaVersion: XIAOMI_HOME_PROPERTY_SCHEMA_VERSION,
          ...(property.semanticKind === undefined ? {} : { semanticKind: property.semanticKind }),
        })),
        identityClaims: [{
          type: "miotDid",
          value: device.did,
          source: { kind: "platform_registry", platform: "xiaomi-home" },
          confidence: "high",
        }],
      },
    });
    for (const property of device.properties) {
      yield emission.envelope({ kind: "state", state: projectPropertyState(device.did, property) });
      stateEnvelopeCount += 1;
    }
    yield emission.envelope({
      kind: "device-health",
      nativeId: device.did,
      status: device.online === undefined ? "unknown" : device.online ? "reachable" : "unreachable",
    });
  }
  yield emission.envelope({
    kind: "sync-complete",
    manifest: { snapshotId: emission.snapshotId, deviceEnvelopeCount: emission.devices.length, stateEnvelopeCount },
  });
}

function projectPropertyState(didValue: string, property: XiaomiHomeNativeProperty): StateEvent {
  const did = boundedString(didValue, 512, "device id");
  validateProperty(property);
  return {
    nativeId: did,
    nativeInstanceId: propertyInstanceId(property),
    attrs: {
      value: property.value,
      format: property.format,
      ...(property.unit === undefined ? {} : { unit: property.unit }),
      writable: property.writable ?? false,
    },
    time: property.sourceTs === undefined
      ? { sourceTsQuality: "none" }
      : { sourceTs: boundedString(property.sourceTs, 128, "source timestamp"), sourceTsQuality: "platform" },
    origin: "observed",
  };
}

function validateProperty(property: XiaomiHomeNativeProperty): void {
  if (!property || !Number.isSafeInteger(property.siid) || property.siid <= 0
    || !Number.isSafeInteger(property.piid) || property.piid <= 0
    || !JsonValueSchema.safeParse(property.value).success) {
    throw new BridgeStreamError("protocol_error", "Xiaomi transport returned an invalid property");
  }
  boundedString(property.format, 64, "property format");
  if (property.unit !== undefined) boundedString(property.unit, 128, "property unit");
  if (property.semanticKind !== undefined
    && !capabilitySemanticKindSchema.safeParse(property.semanticKind).success) {
    throw new BridgeStreamError("protocol_error", "Xiaomi transport returned an invalid semantic kind");
  }
}

function propertyInstanceId(property: Pick<XiaomiHomeNativeProperty, "siid" | "piid">): string {
  return `service:${property.siid}/property:${property.piid}`;
}

function propertyBindingKey(did: string, nativeInstanceId: string): string {
  return `${did}\u0000${nativeInstanceId}`;
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new BridgeStreamError("protocol_error", `Xiaomi transport returned an invalid ${label}`);
  }
  return value;
}

function mapTransportError(error: unknown): BridgeStreamError {
  if (error instanceof BridgeStreamError) return error;
  return new BridgeStreamError("upstream_unavailable", "Xiaomi Home transport unavailable");
}

class ChangeQueue {
  private readonly values: XiaomiHomeChange[] = [];
  private waiter: ((value: XiaomiHomeChange | undefined) => void) | undefined;
  private error: BridgeStreamError | undefined;
  private closed = false;

  push(value: XiaomiHomeChange): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(value);
    } else {
      this.values.push(value);
    }
  }

  fail(error: BridgeStreamError): void {
    this.error = error;
    this.close();
  }

  close(): void {
    this.closed = true;
    this.waiter?.(undefined);
    this.waiter = undefined;
  }

  async next(signal: AbortSignal): Promise<XiaomiHomeChange | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.error) throw this.error;
    if (this.closed || signal.aborted) return undefined;
    return await new Promise<XiaomiHomeChange | undefined>((resolve) => {
      const onAbort = () => {
        this.waiter = undefined;
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = (next) => {
        signal.removeEventListener("abort", onAbort);
        resolve(next);
      };
    }).then((next) => {
      if (next === undefined && this.error) throw this.error;
      return next;
    });
  }
}
