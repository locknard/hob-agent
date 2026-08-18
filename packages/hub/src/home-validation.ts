import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { HomeWorldService } from "./home-world-service.js";
import {
  readHomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";

const CONNECTION_STATES = [
  "starting", "syncing", "ready", "degraded", "paused", "quarantined", "down",
] as const;
const SEMANTIC_KINDS = [
  "light", "switch", "button", "sensor", "binary-sensor",
  "numeric-control", "choice-control", "text-control", "time-control",
  "event", "media", "cover", "lock", "presence", "fan", "camera",
  "vacuum", "climate", "weather", "automation",
] as const;

interface ValidationSnapshot {
  readonly bridges: Readonly<Record<string, unknown>>;
  readonly bridgeWatermarks: readonly { readonly bridgeId: string }[];
  readonly diagnostics: readonly { readonly bridgeId: string; readonly connectionState: string }[];
  readonly spaces: readonly unknown[];
  readonly devices: readonly {
    readonly bindings?: readonly { readonly hwSpaceId?: string }[];
    readonly capabilities: readonly { readonly semanticKind?: string }[];
    readonly states: readonly unknown[];
  }[];
}

export interface HomeValidationReport {
  readonly status: "ready" | "not_ready";
  readonly configuredBridges: number;
  readonly representedBridges: number;
  readonly bridgeStates: Readonly<Record<string, number>>;
  readonly spaces: number;
  readonly devices: number;
  readonly devicesWithSpace: number;
  readonly devicesWithoutSpace: number;
  readonly capabilities: number;
  readonly states: number;
  readonly semanticKinds: Readonly<Record<string, number>>;
}

export function projectHomeValidation(input: {
  readonly configuredBridgeCount: number;
  readonly snapshot: ValidationSnapshot;
}): HomeValidationReport {
  const bridgeIds = Object.keys(input.snapshot.bridges);
  const watermarks = new Set(input.snapshot.bridgeWatermarks.map((item) => item.bridgeId));
  const diagnostics = new Map(input.snapshot.diagnostics.map((item) => [item.bridgeId, item.connectionState]));
  const bridgeStates = countClosed(
    input.snapshot.diagnostics.map((item) => item.connectionState),
    CONNECTION_STATES,
    "invalid",
  );
  const capabilities = input.snapshot.devices.flatMap((device) => device.capabilities);
  const semanticKinds = countClosed(
    capabilities.map((capability) => capability.semanticKind),
    SEMANTIC_KINDS,
    "unclassified",
  );
  const devicesWithSpace = input.snapshot.devices.filter((device) =>
    device.bindings?.some((binding) => binding.hwSpaceId !== undefined) === true).length;
  const ready = input.configuredBridgeCount > 0
    && bridgeIds.length === input.configuredBridgeCount
    && bridgeIds.every((bridgeId) => diagnostics.get(bridgeId) === "ready" && watermarks.has(bridgeId));
  return {
    status: ready ? "ready" : "not_ready",
    configuredBridges: input.configuredBridgeCount,
    representedBridges: bridgeIds.length,
    bridgeStates,
    spaces: input.snapshot.spaces.length,
    devices: input.snapshot.devices.length,
    devicesWithSpace,
    devicesWithoutSpace: input.snapshot.devices.length - devicesWithSpace,
    capabilities: capabilities.length,
    states: input.snapshot.devices.reduce((total, device) => total + device.states.length, 0),
    semanticKinds,
  };
}

export async function validateHomeEnvironment(
  environment: LaunchEnvironment,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<HomeValidationReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5_000) {
    throw new TypeError("home validation timing is invalid or unbounded");
  }
  const config = readHomeWorldLaunchConfig(environment);
  const ctx = new Context();
  try {
    await ctx.plugin(HomeWorldService, {
      catalog: config.catalog,
      bridges: config.bridges,
      credentialSource: config.bridgeCredentialSource,
      journalDirectory: config.journalDirectory,
      registryPath: config.registryPath,
      worldModelPath: config.worldModelPath,
    });
    const deadline = Date.now() + timeoutMs;
    let report = projectHomeValidation({
      configuredBridgeCount: config.bridges.length,
      snapshot: ctx.homeWorld.snapshot(),
    });
    while (report.status !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      report = projectHomeValidation({
        configuredBridgeCount: config.bridges.length,
        snapshot: ctx.homeWorld.snapshot(),
      });
    }
    return report;
  } finally {
    await ctx.fiber.dispose();
  }
}

function countClosed(
  values: readonly (string | undefined)[],
  allowed: readonly string[],
  fallback: string,
): Record<string, number> {
  const allowedSet = new Set(allowed);
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value !== undefined && allowedSet.has(value) ? value : fallback;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void validateHomeEnvironment(process.env).then(
    (report) => console.log(JSON.stringify(report)),
    () => {
      console.error("hob-agent home validation failed");
      process.exitCode = 1;
    },
  );
}
