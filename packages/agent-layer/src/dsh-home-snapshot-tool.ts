import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type HomeWorldDeviceValidity = "valid" | "stale" | "invalid-source" | "present-but-invalid";
export type HomeWorldConnectionState =
  | "starting"
  | "syncing"
  | "ready"
  | "degraded"
  | "paused"
  | "quarantined"
  | "down";

export interface HomeWorldBinding {
  readonly bridgeId: string;
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly hwSpaceId?: string;
}

export interface HomeWorldSpace {
  readonly hwSpaceId: string;
  readonly name?: string;
  readonly bindings: { readonly bridgeId: string; readonly nativeSpaceId: string }[];
}

export interface HomeWorldCapability {
  readonly hwCapabilityId: string;
  readonly hwId: string;
  readonly schema: string;
  readonly schemaVersion: string;
  readonly semanticKind?: HomeWorldCapabilitySemanticKind;
  readonly bindings: HomeWorldBinding[];
}

const HOME_WORLD_CAPABILITY_SEMANTIC_KINDS = [
  "light", "switch", "button", "sensor", "binary-sensor",
  "numeric-control", "choice-control", "text-control", "time-control",
  "event", "media", "cover", "lock", "presence", "fan", "camera",
  "vacuum", "climate", "weather", "automation",
] as const;
export type HomeWorldCapabilitySemanticKind = typeof HOME_WORLD_CAPABILITY_SEMANTIC_KINDS[number];

export interface HomeWorldState {
  readonly nativeId: string;
  readonly nativeInstanceId: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly time: {
    readonly sourceTs?: string;
    readonly sourceTsQuality: "device" | "platform" | "none";
  };
  readonly origin: "observed" | "imported";
}

export interface HomeWorldDevice {
  readonly hwId: string;
  readonly bindings: readonly HomeWorldBinding[];
  readonly name?: string;
  readonly capabilities: readonly HomeWorldCapability[];
  readonly states: readonly HomeWorldState[];
  readonly validity: HomeWorldDeviceValidity;
}

/** Neutral device record emitted by the home-world service's bridge reducer. */
export interface HomeWorldDeviceRecord {
  readonly bridgeId?: string;
  readonly hwId: string;
  readonly bindings: readonly HomeWorldBinding[];
  readonly name?: string;
  readonly capabilities: readonly HomeWorldCapability[];
  readonly states: readonly HomeWorldState[] | Readonly<Record<string, HomeWorldState>>;
  readonly validity: HomeWorldDeviceValidity;
}

export interface HomeWorldWatermark {
  readonly bridgeId: string;
  readonly epochId: string;
  readonly lastSeq: number;
  readonly lastSyncCompleteAt?: string;
}

export interface HomeWorldDiagnostics {
  readonly bridgeId: string;
  readonly connectionState: HomeWorldConnectionState;
  readonly lastSyncCompleteAt?: string;
  readonly lastEventReceivedAt?: string;
  readonly lastSuccessfulContactAt?: string;
}

export interface HomeWorldBridgeMetrics {
  readonly consistency: "ready" | "not_ready" | "degraded";
  readonly eventActivity: "active" | "idle";
  readonly connection: "up" | "degraded" | "down";
}

export interface HomeWorldBridgeSnapshot {
  readonly bridgeId?: string;
  readonly diagnostics?: Omit<HomeWorldDiagnostics, "bridgeId"> & { readonly bridgeId?: string };
  readonly watermark?: Omit<HomeWorldWatermark, "bridgeId"> & { readonly bridgeId?: string } | null;
  readonly devices?: readonly HomeWorldDeviceRecord[];
  readonly metrics?: HomeWorldBridgeMetrics;
}

export interface HomeWorldSnapshot {
  readonly spaces?: readonly HomeWorldSpace[];
  readonly devices?: readonly (HomeWorldDevice | HomeWorldDeviceRecord)[];
  /** `watermarks` is accepted as the internal facade name; output is canonicalized. */
  readonly bridgeWatermarks?: readonly HomeWorldWatermark[];
  readonly watermarks?: readonly HomeWorldWatermark[];
  readonly diagnostics?: readonly (Omit<HomeWorldDiagnostics, "bridgeId"> & { readonly bridgeId?: string })[];
  readonly bridges?: Readonly<Record<string, HomeWorldBridgeSnapshot>>;
  readonly watermarkVector?: Readonly<Record<string, Omit<HomeWorldWatermark, "bridgeId"> & { readonly bridgeId?: string } | null>>;
}

export interface HomeWorldService {
  readonly snapshot: HomeWorldSnapshot | (() => HomeWorldSnapshot | undefined | Promise<HomeWorldSnapshot | undefined>);
}

export interface HomeSnapshotToolValue {
  readonly spaces: HomeWorldSpace[];
  readonly devices: {
    readonly bridgeId?: string;
    readonly hwId: string;
    readonly bindings: HomeWorldBinding[];
    readonly name?: string;
    readonly validity: HomeWorldDeviceValidity;
    readonly capabilities: HomeWorldCapability[];
    readonly states: {
      readonly nativeId: string;
      readonly nativeInstanceId: string;
      readonly attrs: Record<string, JsonValue>;
      readonly time: {
        readonly sourceTs?: string;
        readonly sourceTsQuality: "device" | "platform" | "none";
      };
      readonly origin: "observed" | "imported";
    }[];
  }[];
  readonly bridgeWatermarks: HomeWorldWatermark[];
  readonly metrics: {
    readonly consistency: {
      readonly bridgeId: string;
      readonly state: HomeWorldConnectionState;
      readonly lastSyncCompleteAt?: string;
    }[];
    readonly eventActivity: {
      readonly bridgeId: string;
      readonly lastEventReceivedAt?: string;
    }[];
    readonly connectionActivity: {
      readonly bridgeId: string;
      readonly state: HomeWorldConnectionState;
      readonly lastSuccessfulContactAt?: string;
    }[];
  };
  readonly topology: {
    readonly spaces: number;
    readonly totalDevices: number;
    readonly devicesWithSingleSpace: number;
    readonly devicesWithoutSpace: number;
    readonly devicesWithMultipleSpaces: number;
  };
}

export interface HomeSnapshotQuery {
  readonly afterHwId?: string;
  readonly limit?: number;
  readonly hwIds?: readonly string[];
  readonly hwSpaceIds?: readonly string[];
  readonly semanticKinds?: readonly HomeWorldCapabilitySemanticKind[];
}

export interface HomeSnapshotPageValue {
  readonly spaces: { readonly hwSpaceId: string; readonly name?: string }[];
  readonly devices: {
    readonly hwId: string;
    readonly name?: string;
    readonly validity: HomeWorldDeviceValidity;
    readonly bridgeIds: string[];
    readonly hwSpaceIds: string[];
    readonly capabilities: {
      readonly hwCapabilityId: string;
      readonly hwId: string;
      readonly semanticKind?: HomeWorldCapabilitySemanticKind;
      readonly bridgeIds: string[];
      readonly hwSpaceIds: string[];
    }[];
    readonly states: {
      readonly hwCapabilityId: string;
      readonly bridgeId: string;
      readonly attrs: Record<string, JsonValue>;
      readonly time: {
        readonly sourceTs?: string;
        readonly sourceTsQuality: "device" | "platform" | "none";
      };
      readonly origin: "observed" | "imported";
    }[];
  }[];
  readonly bridgeWatermarks: HomeWorldWatermark[];
  readonly metrics: HomeSnapshotToolValue["metrics"];
  readonly topology: HomeSnapshotToolValue["topology"];
  readonly page: {
    readonly limit: number;
    readonly returnedDevices: number;
    readonly totalMatchedDevices: number;
    readonly nextAfterHwId?: string;
  };
}

type HomeWorldContext = Context & { homeWorld: HomeWorldService };

export const name = "dsh-home-snapshot-tool";
export const inject = ["tools", "homeWorld"] as const;

const metricConsistencySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bridgeId: { type: "string", required: true },
    state: { type: "string", required: true },
    lastSyncCompleteAt: { type: "string" },
  },
} as const;

const metricEventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bridgeId: { type: "string", required: true },
    lastEventReceivedAt: { type: "string" },
  },
} as const;

const metricConnectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bridgeId: { type: "string", required: true },
    state: { type: "string", required: true },
    lastSuccessfulContactAt: { type: "string" },
  },
} as const;

const HOME_SNAPSHOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    spaces: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hwSpaceId: { type: "string", required: true },
          name: { type: "string" },
        },
      },
    },
    devices: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hwId: { type: "string", required: true },
          name: { type: "string" },
          validity: {
            type: "string",
            required: true,
            enum: ["valid", "stale", "invalid-source", "present-but-invalid"],
          },
          bridgeIds: { type: "array", required: true, items: { type: "string" } },
          hwSpaceIds: { type: "array", required: true, items: { type: "string" } },
          capabilities: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                hwCapabilityId: { type: "string", required: true },
                hwId: { type: "string", required: true },
                semanticKind: { type: "string", enum: HOME_WORLD_CAPABILITY_SEMANTIC_KINDS },
                bridgeIds: { type: "array", required: true, items: { type: "string" } },
                hwSpaceIds: { type: "array", required: true, items: { type: "string" } },
              },
            },
          },
          states: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                hwCapabilityId: { type: "string", required: true },
                bridgeId: { type: "string", required: true },
                attrs: { type: "object", required: true, additionalProperties: true },
                time: {
                  type: "object",
                  additionalProperties: false,
                  required: true,
                  properties: {
                    sourceTs: { type: "string" },
                    sourceTsQuality: {
                      type: "string",
                      required: true,
                      enum: ["device", "platform", "none"],
                    },
                  },
                },
                origin: { type: "string", required: true, enum: ["observed", "imported"] },
              },
            },
          },
        },
      },
    },
    bridgeWatermarks: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          bridgeId: { type: "string", required: true },
          epochId: { type: "string", required: true },
          lastSeq: { type: "number", required: true },
          lastSyncCompleteAt: { type: "string" },
        },
      },
    },
    metrics: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        consistency: { type: "array", required: true, items: metricConsistencySchema },
        eventActivity: { type: "array", required: true, items: metricEventSchema },
        connectionActivity: { type: "array", required: true, items: metricConnectionSchema },
      },
    },
    topology: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        spaces: { type: "integer", required: true },
        totalDevices: { type: "integer", required: true },
        devicesWithSingleSpace: { type: "integer", required: true },
        devicesWithoutSpace: { type: "integer", required: true },
        devicesWithMultipleSpaces: { type: "integer", required: true },
      },
    },
    page: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        limit: { type: "number", required: true },
        returnedDevices: { type: "number", required: true },
        totalMatchedDevices: { type: "number", required: true },
        nextAfterHwId: { type: "string" },
      },
    },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_snapshot",
    description: [
      "Read a bounded page of the current neutral home-world snapshot.",
      "Use exact hub IDs, neutral spaces, or semantic kinds to narrow the result.",
      "Pass nextAfterHwId back as afterHwId to continue pagination.",
      "This tool is read-only.",
    ].join(" "),
    parameters: {
      afterHwId: { type: "string" },
      limit: { type: "integer" },
      hwIds: { type: "array", items: { type: "string" } },
      hwSpaceIds: { type: "array", items: { type: "string" } },
      semanticKinds: { type: "array", items: { type: "string", enum: HOME_WORLD_CAPABILITY_SEMANTIC_KINDS } },
    },
    output: {
      schema: HOME_SNAPSHOT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args) => pageHomeSnapshot(
      projectHomeSnapshot(await readHomeWorld((ctx as HomeWorldContext).homeWorld)),
      args,
    ),
  }));
}

const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 20;
const MAX_HW_IDS = 20;
const MAX_SPACE_IDS = 10;
const MAX_ID_LENGTH = 256;

/** Applies the bounded model-facing query to an already normalized snapshot. */
export function pageHomeSnapshot(
  snapshot: HomeSnapshotToolValue,
  query: HomeSnapshotQuery,
): HomeSnapshotPageValue {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }
  const afterHwId = validateOptionalId(query.afterHwId, "afterHwId");
  const hwIds = validateIdSelection(query.hwIds, "hwIds", MAX_HW_IDS);
  const hwSpaceIds = validateIdSelection(query.hwSpaceIds, "hwSpaceIds", MAX_SPACE_IDS);
  const semanticKinds = validateSemanticKinds(query.semanticKinds);
  const selectedHwIds = hwIds === undefined ? undefined : new Set(hwIds);
  const selectedSpaceIds = hwSpaceIds === undefined ? undefined : new Set(hwSpaceIds);
  const selectedSemanticKinds = semanticKinds === undefined ? undefined : new Set(semanticKinds);

  const matchedDevices = snapshot.devices
    .filter((device) => selectedHwIds === undefined || selectedHwIds.has(device.hwId))
    .map((device) => filterDevice(device, selectedSpaceIds, selectedSemanticKinds))
    .filter((device): device is HomeSnapshotToolValue["devices"][number] => device !== undefined);
  const start = afterHwId === undefined
    ? 0
    : matchedDevices.findIndex((device) => compareStrings(device.hwId, afterHwId) > 0);
  const pageStart = start < 0 ? matchedDevices.length : start;
  const pageDevices = matchedDevices.slice(pageStart, pageStart + limit);
  const hasNextPage = pageStart + pageDevices.length < matchedDevices.length;
  const referencedSpaceIds = new Set(pageDevices.flatMap((device) =>
    device.bindings.flatMap((binding) => binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId])));

  return {
    spaces: snapshot.spaces.filter((space) => referencedSpaceIds.has(space.hwSpaceId))
      .map(({ hwSpaceId, name }) => ({ hwSpaceId, ...(name === undefined ? {} : { name }) })),
    devices: pageDevices.map(projectModelDevice),
    bridgeWatermarks: snapshot.bridgeWatermarks,
    metrics: snapshot.metrics,
    topology: snapshot.topology,
    page: {
      limit,
      returnedDevices: pageDevices.length,
      totalMatchedDevices: matchedDevices.length,
      ...(hasNextPage && pageDevices.length > 0 ? { nextAfterHwId: pageDevices.at(-1)!.hwId } : {}),
    },
  };
}

function projectModelDevice(
  device: HomeSnapshotToolValue["devices"][number],
): HomeSnapshotPageValue["devices"][number] {
  const bridgeIds = uniqueSorted(device.bindings.map((binding) => binding.bridgeId));
  const hwSpaceIds = uniqueSorted(device.bindings.flatMap((binding) =>
    binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId]));
  const statesByBinding = new Map(device.states.map((state) =>
    [`${state.nativeId}\u0000${state.nativeInstanceId}`, state] as const));
  const states = new Map<string, HomeSnapshotPageValue["devices"][number]["states"][number]>();
  for (const capability of device.capabilities) {
    for (const binding of capability.bindings) {
      const state = statesByBinding.get(`${binding.nativeId}\u0000${binding.nativeInstanceId}`);
      if (state === undefined) continue;
      const key = `${capability.hwCapabilityId}\u0000${binding.bridgeId}`;
      if (states.has(key)) continue;
      states.set(key, {
        hwCapabilityId: capability.hwCapabilityId,
        bridgeId: binding.bridgeId,
        attrs: state.attrs,
        time: state.time,
        origin: state.origin,
      });
    }
  }
  return {
    hwId: device.hwId,
    ...(device.name === undefined ? {} : { name: device.name }),
    validity: device.validity,
    bridgeIds,
    hwSpaceIds,
    capabilities: device.capabilities.map((capability) => ({
      hwCapabilityId: capability.hwCapabilityId,
      hwId: capability.hwId,
      ...(capability.semanticKind === undefined ? {} : { semanticKind: capability.semanticKind }),
      bridgeIds: uniqueSorted(capability.bindings.map((binding) => binding.bridgeId)),
      hwSpaceIds: uniqueSorted(capability.bindings.flatMap((binding) =>
        binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId])),
    })),
    states: [...states.values()],
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function filterDevice(
  device: HomeSnapshotToolValue["devices"][number],
  selectedSpaceIds: ReadonlySet<string> | undefined,
  selectedSemanticKinds: ReadonlySet<HomeWorldCapabilitySemanticKind> | undefined,
): HomeSnapshotToolValue["devices"][number] | undefined {
  if (selectedSpaceIds === undefined && selectedSemanticKinds === undefined) return device;
  const capabilities = device.capabilities.flatMap((capability) => {
    if (selectedSemanticKinds !== undefined
      && (capability.semanticKind === undefined || !selectedSemanticKinds.has(capability.semanticKind))) return [];
    const bindings = selectedSpaceIds === undefined
      ? capability.bindings
      : capability.bindings.filter((binding) => binding.hwSpaceId !== undefined && selectedSpaceIds.has(binding.hwSpaceId));
    return bindings.length === 0 ? [] : [{ ...capability, bindings: [...bindings] }];
  });
  if (capabilities.length === 0) return undefined;
  const bindingKeys = new Set(capabilities.flatMap((capability) => capability.bindings.map(bindingKey)));
  const stateKeys = new Set(capabilities.flatMap((capability) => capability.bindings
    .map((binding) => `${binding.nativeId}\u0000${binding.nativeInstanceId}`)));
  return {
    ...device,
    bindings: device.bindings.filter((binding) => bindingKeys.has(bindingKey(binding))),
    capabilities,
    states: device.states.filter((state) => stateKeys.has(`${state.nativeId}\u0000${state.nativeInstanceId}`)),
  };
}

function validateOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function validateIdSelection(
  value: readonly string[] | undefined,
  field: string,
  maximum: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new RangeError(`${field} must contain from 1 to ${maximum} IDs`);
  }
  const ids = value.map((item) => validateOptionalId(item, field)!);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${field} must not contain duplicate IDs`);
  return ids;
}

function validateSemanticKinds(
  value: readonly HomeWorldCapabilitySemanticKind[] | undefined,
): HomeWorldCapabilitySemanticKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > HOME_WORLD_CAPABILITY_SEMANTIC_KINDS.length) {
    throw new RangeError("semanticKinds must be a non-empty bounded selection");
  }
  if (value.some((item) => safeSemanticKind(item) === undefined) || new Set(value).size !== value.length) {
    throw new TypeError("semanticKinds must contain unique supported values");
  }
  return [...value];
}

export function projectHomeSnapshot(snapshot: HomeWorldSnapshot | undefined): HomeSnapshotToolValue {
  const bridges = Object.entries(snapshot?.bridges ?? {}).sort(([left], [right]) => compareStrings(left, right));
  const spaces = normalizeSpaces(snapshot?.spaces);
  const activeSpaceIds = new Set(spaces.map((space) => space.hwSpaceId));
  const deviceInputs = [
    ...normalizeArray(snapshot?.devices),
    ...bridges.flatMap(([bridgeId, bridge]) => normalizeArray<HomeWorldDeviceRecord>(bridge.devices).map((device) => ({ ...device, bridgeId }))),
  ];
  const devicesByKey = new Map<string, HomeSnapshotToolValue["devices"][number]>();
  for (const input of deviceInputs) {
    const device = normalizeDevice(input, activeSpaceIds);
    if (device === undefined) continue;
    const key = `hw\u0000${device.hwId}`;
    const existing = devicesByKey.get(key);
    if (existing === undefined) devicesByKey.set(key, device);
    else devicesByKey.set(key, mergeDevices(existing, device));
  }
  const devices = [...devicesByKey.values()]
    .sort((left, right) => compareStrings(left.hwId, right.hwId)
      || compareStrings(left.bridgeId ?? "", right.bridgeId ?? ""));

  const watermarkInputs: Array<{ value: unknown; bridgeId?: string }> = [
    ...normalizeArray(snapshot?.bridgeWatermarks ?? snapshot?.watermarks).map((value) => ({ value })),
    ...Object.entries(snapshot?.watermarkVector ?? {}).map(([bridgeId, value]) => ({ value, bridgeId })),
    ...bridges.map(([bridgeId, bridge]) => ({ value: bridge.watermark, bridgeId })),
  ];
  const watermarksByBridge = new Map<string, HomeWorldWatermark>();
  for (const { value, bridgeId } of watermarkInputs) {
    const watermark = normalizeWatermark(value, bridgeId);
    if (watermark !== undefined && !watermarksByBridge.has(watermark.bridgeId)) {
      watermarksByBridge.set(watermark.bridgeId, watermark);
    }
  }
  const bridgeWatermarks = [...watermarksByBridge.values()].sort(compareWatermarks);

  const diagnosticsByBridge = new Map<string, HomeWorldDiagnostics>();
  for (const diagnostic of normalizeArray(snapshot?.diagnostics)) {
    const normalized = normalizeDiagnostics(diagnostic);
    if (normalized !== undefined) diagnosticsByBridge.set(normalized.bridgeId, normalized);
  }
  for (const [bridgeId, bridge] of bridges) {
    if (diagnosticsByBridge.has(bridgeId)) continue;
    const normalized = normalizeDiagnostics(bridge.diagnostics, bridgeId)
      ?? normalizeMetricDiagnostics(bridge.metrics, bridgeId);
    if (normalized !== undefined) diagnosticsByBridge.set(normalized.bridgeId, normalized);
  }
  const diagnostics = [...diagnosticsByBridge.values()].sort((left, right) => compareStrings(left.bridgeId, right.bridgeId));
  const deviceSpaceCounts = devices.map((device) =>
    new Set(device.bindings.flatMap((binding) =>
      binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId])).size);

  return {
    spaces,
    devices,
    bridgeWatermarks,
    metrics: {
      consistency: diagnostics.map(({ bridgeId, connectionState: state, lastSyncCompleteAt }) => ({
        bridgeId,
        state,
        ...(lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt }),
      })),
      eventActivity: diagnostics.map(({ bridgeId, lastEventReceivedAt }) => ({
        bridgeId,
        ...(lastEventReceivedAt === undefined ? {} : { lastEventReceivedAt }),
      })),
      connectionActivity: diagnostics.map(({ bridgeId, connectionState: state, lastSuccessfulContactAt }) => ({
        bridgeId,
        state,
        ...(lastSuccessfulContactAt === undefined ? {} : { lastSuccessfulContactAt }),
      })),
    },
    topology: {
      spaces: spaces.length,
      totalDevices: devices.length,
      devicesWithSingleSpace: deviceSpaceCounts.filter((count) => count === 1).length,
      devicesWithoutSpace: deviceSpaceCounts.filter((count) => count === 0).length,
      devicesWithMultipleSpaces: deviceSpaceCounts.filter((count) => count > 1).length,
    },
  };
}

async function readHomeWorld(service: HomeWorldService): Promise<HomeWorldSnapshot | undefined> {
  const snapshot = service?.snapshot;
  return typeof snapshot === "function" ? await snapshot.call(service) : snapshot;
}

function normalizeDevice(
  device: unknown,
  activeSpaceIds: ReadonlySet<string>,
): HomeSnapshotToolValue["devices"][number] | undefined {
  if (!isRecord(device)) return undefined;
  const hwId = safeString(device.hwId);
  const bindings = normalizeBindings(device.bindings, activeSpaceIds);
  if (hwId === undefined || bindings.length === 0) return undefined;
  if (!isArray(device.capabilities) || device.capabilities.length === 0) return undefined;
  const rawCapabilities = device.capabilities;
  const capabilities = normalizeArray(rawCapabilities)
    .map((capability) => normalizeCapability(capability, activeSpaceIds))
    .filter((capability): capability is HomeWorldCapability => capability !== undefined)
    .sort(compareCapabilities);
  const deviceBindingKeys = new Set(bindings.map((binding) => bindingKey(binding)));
  if (capabilities.length !== rawCapabilities.length
    || capabilities.some((capability) => capability.hwId !== hwId
      || capability.bindings.length === 0
      || capability.bindings.some((binding) => !deviceBindingKeys.has(bindingKey(binding))))) return undefined;
  const states = normalizeStates(device.states, undefined, new Set(bindings.map((binding) => binding.nativeId)))
    .filter((state): state is HomeSnapshotToolValue["devices"][number]["states"][number] => state !== undefined)
    .sort(compareStates);
  const name = safeString(device.name);
  const validity = isValidity(device.validity) ? device.validity : "invalid-source";
  const bridgeId = safeString(device.bridgeId);
  return {
    ...(bridgeId === undefined ? {} : { bridgeId }),
    hwId,
    bindings,
    ...(name === undefined ? {} : { name }),
    validity,
    capabilities,
    states,
  };
}

function normalizeStates(
  value: unknown,
  nativeId: string | undefined,
  allowedNativeIds: ReadonlySet<string> = new Set(),
): Array<HomeSnapshotToolValue["devices"][number]["states"][number] | undefined> {
  const values = Array.isArray(value)
    ? value
    : value instanceof Map
      ? [...value.values()]
      : isRecord(value) ? Object.entries(value).sort(([left], [right]) => compareStrings(left, right)).map(([, state]) => state) : [];
  return values.map((state) => normalizeState(state, nativeId, allowedNativeIds));
}

function normalizeCapability(
  capability: unknown,
  activeSpaceIds: ReadonlySet<string>,
): HomeWorldCapability | undefined {
  if (!isRecord(capability)) return undefined;
  const hwCapabilityId = safeString(capability?.hwCapabilityId);
  const hwId = safeString(capability?.hwId);
  const schema = safeString(capability?.schema);
  const schemaVersion = safeString(capability?.schemaVersion);
  if (hwCapabilityId === undefined || hwId === undefined || schema === undefined || schemaVersion === undefined) return undefined;
  const bindings = normalizeBindings(capability.bindings, activeSpaceIds);
  if (bindings.length === 0) return undefined;
  const semanticKind = safeSemanticKind(capability.semanticKind);
  return {
    hwCapabilityId,
    hwId,
    schema,
    schemaVersion,
    ...(semanticKind === undefined ? {} : { semanticKind }),
    bindings,
  };
}

function safeSemanticKind(value: unknown): HomeWorldCapabilitySemanticKind | undefined {
  return typeof value === "string"
      && (HOME_WORLD_CAPABILITY_SEMANTIC_KINDS as readonly string[]).includes(value)
    ? value as HomeWorldCapabilitySemanticKind
    : undefined;
}

function normalizeState(
  state: unknown,
  nativeId: string | undefined,
  allowedNativeIds: ReadonlySet<string> = new Set(),
): HomeSnapshotToolValue["devices"][number]["states"][number] | undefined {
  if (!isRecord(state)) return undefined;
  const stateNativeId = safeString(state?.nativeId);
  const nativeInstanceId = safeString(state?.nativeInstanceId);
  if (stateNativeId === undefined
    || (nativeId !== undefined && stateNativeId !== nativeId)
    || (nativeId === undefined && allowedNativeIds.size > 0 && !allowedNativeIds.has(stateNativeId))
    || nativeInstanceId === undefined
    || !isRecord(state.attrs)) return undefined;
  if (!isRecord(state.time) || !isSourceQuality(state.time.sourceTsQuality) || !isOrigin(state.origin)) return undefined;
  const attrs = stableRecord(state.attrs);
  const sourceTs = safeString(state.time.sourceTs);
  return {
    nativeId: stateNativeId,
    nativeInstanceId,
    attrs,
    time: {
      ...(sourceTs === undefined ? {} : { sourceTs }),
      sourceTsQuality: state.time.sourceTsQuality,
    },
    origin: state.origin,
  };
}

function normalizeBindings(value: unknown, activeSpaceIds?: ReadonlySet<string>): HomeWorldBinding[] {
  const bindings = normalizeArray(value)
    .map((binding): HomeWorldBinding | undefined => {
      if (!isRecord(binding)) return undefined;
      const bridgeId = safeString(binding.bridgeId);
      const nativeId = safeString(binding.nativeId);
      const nativeInstanceId = safeString(binding.nativeInstanceId);
      const candidateSpaceId = safeString(binding.hwSpaceId);
      const hwSpaceId = candidateSpaceId !== undefined
          && (activeSpaceIds === undefined || activeSpaceIds.has(candidateSpaceId))
        ? candidateSpaceId
        : undefined;
      if (bridgeId === undefined || nativeId === undefined || nativeInstanceId === undefined) return undefined;
      return {
        bridgeId,
        nativeId,
        nativeInstanceId,
        ...(hwSpaceId === undefined ? {} : { hwSpaceId }),
      };
    })
    .filter((binding): binding is HomeWorldBinding => binding !== undefined)
    .sort((left, right) => compareStrings(left.bridgeId, right.bridgeId)
      || compareStrings(left.nativeId, right.nativeId)
      || compareStrings(left.nativeInstanceId, right.nativeInstanceId));
  const unique = new Map<string, HomeWorldBinding>();
  for (const binding of bindings) {
    const key = `${binding.bridgeId}\u0000${binding.nativeId}\u0000${binding.nativeInstanceId}`;
    if (!unique.has(key)) unique.set(key, binding);
  }
  return [...unique.values()];
}

function normalizeSpaces(value: unknown): HomeWorldSpace[] {
  const spaces = normalizeArray(value)
    .map((space): HomeWorldSpace | undefined => {
      if (!isRecord(space)) return undefined;
      const hwSpaceId = safeString(space.hwSpaceId);
      if (hwSpaceId === undefined) return undefined;
      const bindings = normalizeArray(space.bindings)
        .map((binding): { bridgeId: string; nativeSpaceId: string } | undefined => {
          if (!isRecord(binding)) return undefined;
          const bridgeId = safeString(binding.bridgeId);
          const nativeSpaceId = safeString(binding.nativeSpaceId);
          return bridgeId === undefined || nativeSpaceId === undefined
            ? undefined
            : { bridgeId, nativeSpaceId };
        })
        .filter((binding): binding is { bridgeId: string; nativeSpaceId: string } => binding !== undefined)
        .sort((left, right) => compareStrings(left.bridgeId, right.bridgeId)
          || compareStrings(left.nativeSpaceId, right.nativeSpaceId));
      if (bindings.length === 0) return undefined;
      const name = safeString(space.name);
      return { hwSpaceId, ...(name === undefined ? {} : { name }), bindings };
    })
    .filter((space): space is HomeWorldSpace => space !== undefined)
    .sort((left, right) => compareStrings(left.hwSpaceId, right.hwSpaceId));
  const unique = new Map<string, HomeWorldSpace>();
  for (const space of spaces) if (!unique.has(space.hwSpaceId)) unique.set(space.hwSpaceId, space);
  return [...unique.values()];
}

function bindingKey(binding: HomeWorldBinding): string {
  return `${binding.bridgeId}\u0000${binding.nativeId}\u0000${binding.nativeInstanceId}`;
}

function mergeDevices(
  left: HomeSnapshotToolValue["devices"][number],
  right: HomeSnapshotToolValue["devices"][number],
): HomeSnapshotToolValue["devices"][number] {
  if (left.hwId !== right.hwId) return left;
  const bindings = normalizeBindings([...left.bindings, ...right.bindings]);
  const capabilitiesByKey = new Map<string, HomeWorldCapability>();
  for (const capability of [...left.capabilities, ...right.capabilities]) {
    const key = capability.hwCapabilityId;
    const prior = capabilitiesByKey.get(key);
    if (prior === undefined) {
      capabilitiesByKey.set(key, {
        ...capability,
        bindings: normalizeBindings(capability.bindings),
      });
    } else {
      capabilitiesByKey.set(key, {
        ...prior,
        bindings: normalizeBindings([...prior.bindings, ...capability.bindings]),
      });
    }
  }
  const statesByKey = new Map<string, HomeSnapshotToolValue["devices"][number]["states"][number]>();
  for (const state of [...left.states, ...right.states]) statesByKey.set(`${state.nativeId}\u0000${state.nativeInstanceId}`, state);
  return {
    ...(left.bridgeId === undefined ? {} : { bridgeId: left.bridgeId }),
    hwId: left.hwId,
    ...((left.name ?? right.name) === undefined ? {} : { name: left.name ?? right.name }),
    validity: left.validity === "valid" || right.validity === "valid" ? "valid" : left.validity,
    bindings,
    capabilities: [...capabilitiesByKey.values()].sort(compareCapabilities),
    states: [...statesByKey.values()].sort(compareStates),
  };
}

function normalizeWatermark(watermark: unknown, fallbackBridgeId?: string): HomeWorldWatermark | undefined {
  if (!isRecord(watermark)) return undefined;
  const bridgeId = safeString(watermark.bridgeId) ?? safeString(fallbackBridgeId);
  const epochId = safeString(watermark.epochId);
  const lastSeq = watermark.lastSeq;
  if (bridgeId === undefined || epochId === undefined || typeof lastSeq !== "number" || !Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    return undefined;
  }
  const lastSyncCompleteAt = safeString(watermark.lastSyncCompleteAt);
  return {
    bridgeId,
    epochId,
    lastSeq,
    ...(lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt }),
  };
}

function normalizeDiagnostics(diagnostic: unknown, fallbackBridgeId?: string): HomeWorldDiagnostics | undefined {
  if (!isRecord(diagnostic)) return undefined;
  const bridgeId = safeString(diagnostic.bridgeId) ?? safeString(fallbackBridgeId);
  if (bridgeId === undefined || !isConnectionState(diagnostic.connectionState)) return undefined;
  const lastSyncCompleteAt = safeString(diagnostic.lastSyncCompleteAt);
  const lastEventReceivedAt = safeString(diagnostic.lastEventReceivedAt);
  const lastSuccessfulContactAt = safeString(diagnostic.lastSuccessfulContactAt);
  return {
    bridgeId,
    connectionState: diagnostic.connectionState,
    ...(lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt }),
    ...(lastEventReceivedAt === undefined ? {} : { lastEventReceivedAt }),
    ...(lastSuccessfulContactAt === undefined ? {} : { lastSuccessfulContactAt }),
  };
}

function normalizeMetricDiagnostics(metrics: unknown, bridgeId: string): HomeWorldDiagnostics | undefined {
  if (!isRecord(metrics)) return undefined;
  const connection = metrics.connection;
  const connectionState = connection === "up" ? "ready" : connection === "degraded" ? "degraded" : connection === "down" ? "down" : undefined;
  if (connectionState === undefined) return undefined;
  return { bridgeId, connectionState };
}

function stableRecord(value: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const normalized = stableValue(value, new WeakSet<object>(), 0, { fields: 0, bytes: 0 });
  return isRecord(normalized) ? normalized as Record<string, JsonValue> : {};
}

const MAX_FIELDS = 128;
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 4_096;
const MAX_SERIALIZED_BYTES = 64 * 1024;

interface Budget {
  fields: number;
  bytes: number;
}

function stableValue(value: unknown, seen: WeakSet<object>, depth: number, budget: Budget): JsonValue | undefined {
  if (depth > MAX_DEPTH || budget.bytes > MAX_SERIALIZED_BYTES) return undefined;
  if (value === null) {
    budget.bytes += 4;
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) return undefined;
    budget.bytes += value.length;
    return value;
  }
  if (typeof value === "boolean") {
    budget.bytes += 5;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    budget.bytes += 8;
    return value;
  }
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value) {
        if (++budget.fields > MAX_FIELDS) break;
        const normalized = stableValue(item, seen, depth + 1, budget);
        if (normalized !== undefined) result.push(normalized);
      }
      return result;
    }

    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
      if (++budget.fields > MAX_FIELDS || key.length > MAX_STRING_LENGTH) break;
      const normalized = stableValue(item, seen, depth + 1, budget);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function normalizeArray<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) return value as T[];
  if (value instanceof Map) return [...value.values()] as T[];
  return [];
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidity(value: unknown): value is HomeWorldDeviceValidity {
  return value === "valid" || value === "stale" || value === "invalid-source" || value === "present-but-invalid";
}

function isSourceQuality(value: unknown): value is HomeWorldState["time"]["sourceTsQuality"] {
  return value === "device" || value === "platform" || value === "none";
}

function isOrigin(value: unknown): value is HomeWorldState["origin"] {
  return value === "observed" || value === "imported";
}

function isConnectionState(value: unknown): value is HomeWorldConnectionState {
  return value === "starting"
    || value === "syncing"
    || value === "ready"
    || value === "degraded"
    || value === "paused"
    || value === "quarantined"
    || value === "down";
}

function compareCapabilities(left: HomeWorldCapability, right: HomeWorldCapability): number {
  return compareStrings(left.hwCapabilityId, right.hwCapabilityId)
    || compareStrings(left.schema, right.schema)
    || compareStrings(left.schemaVersion, right.schemaVersion);
}

function compareStates(
  left: HomeSnapshotToolValue["devices"][number]["states"][number],
  right: HomeSnapshotToolValue["devices"][number]["states"][number],
): number {
  return compareStrings(left.nativeInstanceId, right.nativeInstanceId)
    || compareStrings(JSON.stringify(left.attrs), JSON.stringify(right.attrs))
    || compareStrings(left.origin, right.origin);
}

function compareWatermarks(left: HomeWorldWatermark, right: HomeWorldWatermark): number {
  return compareStrings(left.bridgeId, right.bridgeId)
    || compareStrings(left.epochId, right.epochId)
    || left.lastSeq - right.lastSeq;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
