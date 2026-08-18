import { Service, type Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";

import {
  projectHomeSnapshot,
  type HomeSnapshotToolValue,
  type HomeWorldCapabilitySemanticKind,
  type HomeWorldDeviceValidity,
  type HomeWorldService,
  type HomeWorldSnapshot,
} from "./dsh-home-snapshot-tool.js";

export interface HomeInventoryQuery {
  readonly afterHwId?: string;
  readonly limit?: number;
}

export interface HomeInventoryPageValue {
  readonly inventoryVersion: string;
  readonly spaces: { readonly hwSpaceId: string; readonly name?: string }[];
  readonly devices: {
    readonly hwId: string;
    readonly name?: string;
    readonly validity: HomeWorldDeviceValidity;
    readonly spatialDisposition?: "non_spatial";
    readonly bridgeIds: string[];
    readonly hwSpaceIds: string[];
    readonly semanticKinds: HomeWorldCapabilitySemanticKind[];
    readonly capabilityCount: number;
    readonly stateCount: number;
  }[];
  readonly topology: HomeSnapshotToolValue["topology"];
  readonly page: {
    readonly limit: number;
    readonly returnedDevices: number;
    readonly totalDevices: number;
    readonly nextAfterHwId?: string;
  };
}

type HomeWorldContext = Context & { homeWorld: HomeWorldService };

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeInventoryCoverage: HomeInventoryCoverageService;
  }
}

/** Enforces complete ordered inventory discovery only during autonomous observations. */
export class HomeInventoryCoverageService extends Service {
  private active = false;
  private complete = false;
  private invalid = false;
  private expectedAfterHwId: string | undefined;
  private totalDevices: number | undefined;
  private inventoryVersion: string | undefined;

  constructor(ctx: Context) {
    super(ctx, "homeInventoryCoverage");
  }

  beginObservation(): void {
    this.active = true;
    this.resetSequence();
  }

  endObservation(): void {
    this.active = false;
    this.resetSequence();
  }

  record(query: HomeInventoryQuery, result: HomeInventoryPageValue): void {
    if (!this.active) return;
    if (query.afterHwId === undefined) {
      this.resetSequence();
      this.totalDevices = result.page.totalDevices;
      this.inventoryVersion = result.inventoryVersion;
    } else if (this.invalid
      || this.complete
      || query.afterHwId !== this.expectedAfterHwId
      || result.page.totalDevices !== this.totalDevices
      || result.inventoryVersion !== this.inventoryVersion) {
      this.invalid = true;
      this.complete = false;
      return;
    }
    this.expectedAfterHwId = result.page.nextAfterHwId;
    this.complete = result.page.nextAfterHwId === undefined;
  }

  assertProposalAllowed(): void {
    if (this.active && (!this.complete || this.invalid)) {
      throw new Error("Autonomous observation must exhaust a stable home inventory before proposing");
    }
  }

  private resetSequence(): void {
    this.complete = false;
    this.invalid = false;
    this.expectedAfterHwId = undefined;
    this.totalDevices = undefined;
    this.inventoryVersion = undefined;
  }
}

export const name = "dsh-home-inventory-tool";
export const inject = ["tools", "homeWorld"] as const;

const SEMANTIC_KINDS = [
  "light", "switch", "button", "sensor", "binary-sensor",
  "numeric-control", "choice-control", "text-control", "time-control",
  "event", "media", "cover", "lock", "presence", "fan", "camera",
  "vacuum", "climate", "weather", "automation",
] as const;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    inventoryVersion: { type: "string", required: true },
    spaces: {
      type: "array", required: true,
      items: {
        type: "object", additionalProperties: false,
        properties: { hwSpaceId: { type: "string", required: true }, name: { type: "string" } },
      },
    },
    devices: {
      type: "array", required: true,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          hwId: { type: "string", required: true },
          name: { type: "string" },
          validity: {
            type: "string", required: true,
            enum: ["valid", "stale", "invalid-source", "present-but-invalid"],
          },
          spatialDisposition: { type: "string", enum: ["non_spatial"] },
          bridgeIds: { type: "array", required: true, items: { type: "string" } },
          hwSpaceIds: { type: "array", required: true, items: { type: "string" } },
          semanticKinds: { type: "array", required: true, items: { type: "string", enum: SEMANTIC_KINDS } },
          capabilityCount: { type: "integer", required: true },
          stateCount: { type: "integer", required: true },
        },
      },
    },
    topology: {
      type: "object", required: true, additionalProperties: false,
      properties: {
        spaces: { type: "integer", required: true },
        totalDevices: { type: "integer", required: true },
        devicesWithSingleSpace: { type: "integer", required: true },
        devicesWithoutSpace: { type: "integer", required: true },
        devicesWithMultipleSpaces: { type: "integer", required: true },
      },
    },
    page: {
      type: "object", required: true, additionalProperties: false,
      properties: {
        limit: { type: "integer", required: true },
        returnedDevices: { type: "integer", required: true },
        totalDevices: { type: "integer", required: true },
        nextAfterHwId: { type: "string" },
      },
    },
  },
} as const;

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_inventory",
    description: [
      "Discover a compact bounded page of neutral home devices before reading detailed state.",
      "Follow nextAfterHwId until absent for household-wide discovery, then use exact hwIds with get_home_snapshot.",
      "This tool returns no current values, capability identities, adapter schemas, or native identities.",
      "A non_spatial disposition is a neutral committed hint that no room assignment is expected; missing means unknown.",
    ].join(" "),
    parameters: {
      afterHwId: { type: "string" },
      limit: { type: "integer" },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const result = pageHomeInventory(
        projectHomeSnapshot(await readHomeWorld((ctx as HomeWorldContext).homeWorld)),
        args,
      );
      ctx.get("homeInventoryCoverage")?.record(args, result);
      return result;
    },
  }));
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_ID_LENGTH = 256;
const MODEL_VISIBLE_PAGE_BYTES = 7_500;

export function pageHomeInventory(
  snapshot: HomeSnapshotToolValue,
  query: HomeInventoryQuery,
): HomeInventoryPageValue {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const afterHwId = query.afterHwId;
  if (afterHwId !== undefined
    && (typeof afterHwId !== "string" || afterHwId.length < 1 || afterHwId.length > MAX_ID_LENGTH)) {
    throw new TypeError("afterHwId is invalid");
  }
  const devices = [...snapshot.devices].sort((left, right) => compare(left.hwId, right.hwId));
  const start = afterHwId === undefined ? 0 : devices.findIndex((device) => compare(device.hwId, afterHwId) > 0);
  const pageStart = start < 0 ? devices.length : start;
  const projectedInventory = devices.map((device) => ({
    hwId: device.hwId,
    ...(device.name === undefined ? {} : { name: device.name }),
    validity: device.validity,
    ...(device.spatialDisposition === undefined ? {} : { spatialDisposition: device.spatialDisposition }),
    bridgeIds: unique(device.bindings.map((binding) => binding.bridgeId)),
    hwSpaceIds: unique(device.bindings.flatMap((binding) =>
      binding.hwSpaceId === undefined ? [] : [binding.hwSpaceId])),
    semanticKinds: unique(device.capabilities.flatMap((capability) =>
      capability.semanticKind === undefined ? [] : [capability.semanticKind])),
    capabilityCount: device.capabilities.length,
    stateCount: device.states.length,
  }));
  const inventorySpaces = snapshot.spaces.map(({ hwSpaceId, name: spaceName }) => ({
    hwSpaceId,
    ...(spaceName === undefined ? {} : { name: spaceName }),
  }));
  const inventoryVersion = createHash("sha256")
    .update(JSON.stringify({ spaces: inventorySpaces, devices: projectedInventory }))
    .digest("hex");
  let returnedDevices = Math.min(limit, devices.length - pageStart);
  while (returnedDevices >= 0) {
    const projectedDevices = projectedInventory.slice(pageStart, pageStart + returnedDevices);
    const referencedSpaceIds = new Set(projectedDevices.flatMap((device) => device.hwSpaceIds));
    const hasNextPage = pageStart + projectedDevices.length < devices.length;
    const page: HomeInventoryPageValue = {
      inventoryVersion,
      spaces: inventorySpaces.filter((space) => referencedSpaceIds.has(space.hwSpaceId)),
      devices: projectedDevices,
      topology: snapshot.topology,
      page: {
        limit,
        returnedDevices: projectedDevices.length,
        totalDevices: devices.length,
        ...(hasNextPage && projectedDevices.length > 0
          ? { nextAfterHwId: projectedDevices.at(-1)!.hwId }
          : {}),
      },
    };
    if (Buffer.byteLength(JSON.stringify(page), "utf8") <= MODEL_VISIBLE_PAGE_BYTES) return page;
    if (returnedDevices === 1) {
      throw new RangeError("one compact inventory device exceeds the model-visible page budget");
    }
    returnedDevices -= 1;
  }
  /* v8 ignore next -- the zero-device page has bounded fixed metadata. */
  throw new RangeError("compact inventory metadata exceeds the model-visible page budget");
}

async function readHomeWorld(service: HomeWorldService): Promise<HomeWorldSnapshot | undefined> {
  const source = service.snapshot;
  return typeof source === "function" ? await source.call(service) : source;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compare);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
