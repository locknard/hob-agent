import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { HomeWorldService } from "./home-world-service.js";
import {
  readHomeWorldLaunchConfig,
  type HomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "./launch-config.js";
import { projectHomeValidation } from "./home-validation.js";

const DRAFT_NAME = "HOME.import.md";
const MAX_DRAFT_BYTES = 32 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_MS = 250;

interface HomeMapBinding {
  readonly hwSpaceId?: string;
}

export interface HomeMapSnapshot {
  readonly bridges: Readonly<Record<string, unknown>>;
  readonly bridgeWatermarks: readonly { readonly bridgeId: string }[];
  readonly diagnostics: readonly { readonly bridgeId: string; readonly connectionState: string }[];
  readonly spaces: readonly { readonly hwSpaceId: string; readonly name?: string }[];
  readonly devices: readonly {
    readonly hwId: string;
    readonly name?: string;
    readonly bindings: readonly HomeMapBinding[];
    readonly capabilities: readonly { readonly semanticKind?: string }[];
    readonly states: readonly unknown[];
  }[];
}

export interface DraftHomeMapOptions {
  readonly readyTimeoutMs?: number;
  readonly readyPollMs?: number;
  readonly snapshotLoader?: (
    config: HomeWorldLaunchConfig,
    timing: { readonly timeoutMs: number; readonly pollMs: number },
  ) => Promise<HomeMapSnapshot>;
}

export interface HomeMapDraftReport {
  readonly status: "created";
  readonly spaces: number;
  readonly devices: number;
  readonly devicesWithoutSpace: number;
}

/** Produces a bounded private review artifact without current state values. */
export function renderHomeMapDraft(snapshot: Pick<HomeMapSnapshot, "spaces" | "devices">, generatedAt: string): string {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("home map draft timestamp is invalid");
  const spaces = [...snapshot.spaces].sort((left, right) => left.hwSpaceId.localeCompare(right.hwSpaceId));
  const knownSpaceIds = new Set(spaces.map((space) => space.hwSpaceId));
  const devices = [...snapshot.devices].sort((left, right) => left.hwId.localeCompare(right.hwId));
  const lines = [
    "# Imported home map — review required",
    "",
    `Generated from a read-only neutral HomeWorld snapshot at ${generatedAt}.`,
    "This file is not loaded automatically. Verify every name and assignment before merging accepted facts into HOME.md.",
    "",
  ];
  for (const space of spaces) {
    lines.push(`## Space: ${quoted(space.name ?? "Unnamed space")}`, "");
    const assigned = devices.filter((device) => device.bindings.some((binding) => binding.hwSpaceId === space.hwSpaceId));
    if (assigned.length === 0) lines.push("_No devices currently assigned._");
    else lines.push(...assigned.map(deviceLine));
    lines.push("");
  }
  const unassigned = devices.filter((device) =>
    !device.bindings.some((binding) => binding.hwSpaceId !== undefined && knownSpaceIds.has(binding.hwSpaceId)));
  lines.push("## Unassigned", "");
  if (unassigned.length === 0) lines.push("_No unassigned devices._");
  else lines.push(...unassigned.map(deviceLine));
  lines.push("");
  const draft = lines.join("\n");
  if (Buffer.byteLength(draft, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Home map draft is too large for the bounded household context");
  }
  return draft;
}

/** Exclusively creates the private draft; existing user work is never replaced. */
export async function writeHomeMapDraft(directory: string, content: string): Promise<void> {
  if (typeof directory !== "string" || !isAbsolute(directory)
    || typeof content !== "string" || content.includes("\0")
    || Buffer.byteLength(content, "utf8") > MAX_DRAFT_BYTES) {
    throw new Error("Home map draft target or content is invalid");
  }
  const metadata = await lstat(directory).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Home map draft directory is missing or unsafe");
  }
  const path = join(directory, DRAFT_NAME);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error("Home map draft already exists or could not be created");
  }
  let completed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    completed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) await unlink(path).catch(() => undefined);
  }
}

export async function draftHomeMapEnvironment(
  environment: LaunchEnvironment,
  options: DraftHomeMapOptions = {},
): Promise<HomeMapDraftReport> {
  const homeDirectory = environment.HOB_HOME_DIR;
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) {
    throw new Error("HOB_HOME_DIR must be an explicit absolute directory");
  }
  const timeoutMs = boundedInteger(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000, 300_000);
  const pollMs = boundedInteger(options.readyPollMs ?? DEFAULT_READY_POLL_MS, 10, 5_000);
  const config = readHomeWorldLaunchConfig(environment);
  const snapshot = await (options.snapshotLoader ?? loadReadySnapshot)(config, { timeoutMs, pollMs });
  const readiness = projectHomeValidation({ configuredBridgeCount: config.bridges.length, snapshot });
  if (readiness.status !== "ready") throw new Error("Home map draft requires a ready home world");
  const draft = renderHomeMapDraft(snapshot, new Date().toISOString());
  await writeHomeMapDraft(homeDirectory, draft);
  return {
    status: "created",
    spaces: readiness.spaces,
    devices: readiness.devices,
    devicesWithoutSpace: readiness.devicesWithoutSpace,
  };
}

async function loadReadySnapshot(
  config: HomeWorldLaunchConfig,
  timing: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<HomeMapSnapshot> {
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
    const deadline = Date.now() + timing.timeoutMs;
    while (true) {
      const snapshot: HomeMapSnapshot = ctx.homeWorld.snapshot();
      if (projectHomeValidation({ configuredBridgeCount: config.bridges.length, snapshot }).status === "ready") {
        return snapshot;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Home map draft requires a ready home world");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(timing.pollMs, remaining)));
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

function deviceLine(device: HomeMapSnapshot["devices"][number]): string {
  const kinds = [...new Set(device.capabilities.map((capability) => capability.semanticKind ?? "unclassified"))]
    .sort((left, right) => left.localeCompare(right));
  return `- ${quoted(device.name ?? "Unnamed device")} (\`${safeHubId(device.hwId)}\`) — ${kinds.join(", ") || "unclassified"}`;
}

function quoted(value: string): string {
  return JSON.stringify(value).replace(/[<>`*_{}[\]()#+.!|\-]/g, "\\$&");
}

function safeHubId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.includes("`") || value.includes("\n")) {
    throw new Error("Home map contains an invalid Hub identity");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Home map draft timing is invalid or unbounded");
  }
  return value;
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void draftHomeMapEnvironment(process.env).then(
    (report) => console.log(JSON.stringify(report)),
    () => {
      console.error("hob-agent home map draft failed");
      process.exitCode = 1;
    },
  );
}
