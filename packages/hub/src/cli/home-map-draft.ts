import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";

import { HomeWorldService } from "../world/home-world-service.js";
import {
  readHomeWorldLaunchConfig,
  type HomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "../launch-config.js";
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
    readonly spatialDisposition?: "non_spatial";
    readonly bindings: readonly HomeMapBinding[];
    readonly capabilities: readonly { readonly semanticKind?: string }[];
    readonly states: readonly unknown[];
  }[];
  readonly identityProposals?: readonly {
    readonly kind: "identity-link";
    readonly status: "proposed" | "approved" | "rejected" | "applied";
    readonly hwId?: string;
    readonly targetHwId?: string;
    readonly sourceKind?: "device_reported" | "independent_registry" | "platform_registry" | "inferred";
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
  readonly devicesWithSingleSpace: number;
  readonly devicesWithoutSpace: number;
  readonly devicesWithMultipleSpaces: number;
  readonly devicesNotRequiringSpace: number;
  readonly devicesRequiringSpaceReview: number;
  readonly identityLinksForReview: number;
}

/** Produces a bounded private review artifact without current state values. */
export function renderHomeMapDraft(
  snapshot: Pick<HomeMapSnapshot, "spaces" | "devices" | "identityProposals">,
  generatedAt: string,
): string {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("home map draft timestamp is invalid");
  const spaces = [...snapshot.spaces].sort((left, right) => compareDisplay(
    left.name ?? "Unnamed space",
    left.hwSpaceId,
    right.name ?? "Unnamed space",
    right.hwSpaceId,
  ));
  const knownSpaceIds = new Set(spaces.map((space) => space.hwSpaceId));
  const devices = [...snapshot.devices].sort((left, right) => compareDisplay(
    left.name ?? "Unnamed device",
    left.hwId,
    right.name ?? "Unnamed device",
    right.hwId,
  ));
  const placements = classifyPlacements(devices, knownSpaceIds);
  const singleSpace = placements.filter((placement) => placement.spaceIds.length === 1);
  const nonSpatial = placements.filter((placement) => placement.spaceIds.length === 0
    && placement.device.spatialDisposition === "non_spatial");
  const unassigned = placements.filter((placement) => placement.spaceIds.length === 0
    && placement.device.spatialDisposition !== "non_spatial");
  const multipleSpaces = placements.filter((placement) => placement.spaceIds.length > 1);
  const spacesById = new Map(spaces.map((space) => [space.hwSpaceId, space]));
  const devicesById = new Map(devices.map((device) => [device.hwId, device]));
  const identityLinks = uniqueIdentityLinks(snapshot.identityProposals ?? [], devicesById);
  const lines = [
    "# Imported home map — review required",
    "",
    `Generated from a read-only neutral HomeWorld snapshot at ${generatedAt}.`,
    "This file is not loaded automatically. Verify every name and assignment before merging accepted facts into HOME.md.",
    "",
    "## Imported coverage",
    "",
    `- Single-space suggestions: ${singleSpace.length} of ${devices.length} devices`,
    `- Unassigned: ${unassigned.length}`,
    `- Non-spatial: ${nonSpatial.length}`,
    `- Multiple imported spaces: ${multipleSpaces.length}`,
    "",
  ];
  lines.push("## Possible duplicate devices", "",
    "These are record-only review hints. Marking a decision in this draft does not merge devices or change Hub identity.", "");
  if (identityLinks.length === 0) lines.push("_No possible duplicate-device links require review._");
  else lines.push(...identityLinks.map(({ left, right, sourceKind }) =>
    `- [ ] Are ${deviceIdentity(left)} and ${deviceIdentity(right)} the same physical device? Decision: same physical device / separate devices — source: ${sourceKindLabel(sourceKind)}`));
  lines.push("");
  for (const space of spaces) {
    lines.push(`## Space: ${quoted(space.name ?? "Unnamed space")}`, "");
    const assigned = singleSpace
      .filter((placement) => placement.spaceIds[0] === space.hwSpaceId)
      .map((placement) => placement.device);
    if (assigned.length === 0) lines.push("_No devices currently assigned._");
    else lines.push(...assigned.map((device) =>
      `- [ ] Confirm ${deviceDescription(device)} — source: imported space suggestion`));
    lines.push("");
  }
  lines.push("## Non-spatial or whole-home objects", "");
  if (nonSpatial.length === 0) lines.push("_No explicitly non-spatial objects._");
  else lines.push(...nonSpatial.map((placement) =>
    `- ${deviceDescription(placement.device)} — adapter-declared non-spatial service; no room assignment required`));
  lines.push("");
  lines.push("## Needs space confirmation", "", "### Unassigned", "");
  if (unassigned.length === 0) lines.push("_No unassigned devices._");
  else lines.push(...unassigned.map((placement) =>
    `- [ ] Assign ${deviceDescription(placement.device)} — household space: __________`));
  lines.push("", "### Multiple imported spaces", "");
  if (multipleSpaces.length === 0) lines.push("_No devices with multiple imported spaces._");
  else lines.push(...multipleSpaces.map((placement) => {
    const candidates = placement.spaceIds.map((spaceId) =>
      quoted(spacesById.get(spaceId)?.name ?? "Unnamed space")).join(", ");
    return `- [ ] Resolve ${deviceDescription(placement.device)} — imported candidates: ${candidates}; household space: __________`;
  }));
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
  const placementCounts = countPlacements(snapshot);
  return {
    status: "created",
    spaces: readiness.spaces,
    devices: readiness.devices,
    ...placementCounts,
    identityLinksForReview: countIdentityLinks(snapshot),
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
        return {
          ...snapshot,
          identityProposals: ctx.homeWorld.identity.proposals()
            .filter((proposal) => proposal.kind === "identity-link")
            .map(({ status, hwId, targetHwId, sourceKind }) => ({
              kind: "identity-link" as const,
              status,
              ...(hwId === undefined ? {} : { hwId }),
              ...(targetHwId === undefined ? {} : { targetHwId }),
              ...(sourceKind === undefined ? {} : { sourceKind }),
            })),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Home map draft requires a ready home world");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(timing.pollMs, remaining)));
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

function uniqueIdentityLinks(
  proposals: readonly NonNullable<HomeMapSnapshot["identityProposals"]>[number][],
  devicesById: ReadonlyMap<string, HomeMapSnapshot["devices"][number]>,
): readonly {
  readonly left: HomeMapSnapshot["devices"][number];
  readonly right: HomeMapSnapshot["devices"][number];
  readonly sourceKind: NonNullable<HomeMapSnapshot["identityProposals"]>[number]["sourceKind"];
}[] {
  const links = new Map<string, {
    readonly left: HomeMapSnapshot["devices"][number];
    readonly right: HomeMapSnapshot["devices"][number];
    readonly sourceKind: NonNullable<HomeMapSnapshot["identityProposals"]>[number]["sourceKind"];
  }>();
  for (const proposal of proposals) {
    if (proposal.status !== "proposed" || proposal.hwId === undefined || proposal.targetHwId === undefined) continue;
    const ids = [proposal.hwId, proposal.targetHwId].sort();
    const left = devicesById.get(ids[0]!);
    const right = devicesById.get(ids[1]!);
    if (left === undefined || right === undefined) continue;
    const key = ids.join("\u0000");
    if (!links.has(key)) links.set(key, { left, right, sourceKind: proposal.sourceKind });
  }
  return [...links.values()];
}

function countIdentityLinks(snapshot: Pick<HomeMapSnapshot, "devices" | "identityProposals">): number {
  return uniqueIdentityLinks(
    snapshot.identityProposals ?? [],
    new Map(snapshot.devices.map((device) => [device.hwId, device])),
  ).length;
}

function deviceIdentity(device: HomeMapSnapshot["devices"][number]): string {
  return `${quoted(device.name ?? "Unnamed device")} (\`${safeHubId(device.hwId)}\`)`;
}

function sourceKindLabel(sourceKind: NonNullable<HomeMapSnapshot["identityProposals"]>[number]["sourceKind"]): string {
  switch (sourceKind) {
    case "platform_registry": return "platform registry hint";
    case "inferred": return "adapter inference";
    case "device_reported": return "device-reported identity";
    case "independent_registry": return "independent registry";
    case undefined: return "unspecified identity hint";
  }
}

function deviceDescription(device: HomeMapSnapshot["devices"][number]): string {
  const kinds = [...new Set(device.capabilities.map((capability) => capability.semanticKind ?? "unclassified"))]
    .sort((left, right) => left.localeCompare(right));
  return `${quoted(device.name ?? "Unnamed device")} (\`${safeHubId(device.hwId)}\`) — ${kinds.join(", ") || "unclassified"}`;
}

function countPlacements(snapshot: Pick<HomeMapSnapshot, "spaces" | "devices">): {
  readonly devicesWithSingleSpace: number;
  readonly devicesWithoutSpace: number;
  readonly devicesWithMultipleSpaces: number;
  readonly devicesNotRequiringSpace: number;
  readonly devicesRequiringSpaceReview: number;
} {
  const knownSpaceIds = new Set(snapshot.spaces.map((space) => space.hwSpaceId));
  const placements = classifyPlacements(snapshot.devices, knownSpaceIds);
  return {
    devicesWithSingleSpace: placements.filter((placement) => placement.spaceIds.length === 1).length,
    devicesWithoutSpace: placements.filter((placement) => placement.spaceIds.length === 0).length,
    devicesWithMultipleSpaces: placements.filter((placement) => placement.spaceIds.length > 1).length,
    devicesNotRequiringSpace: placements.filter((placement) => placement.spaceIds.length === 0
      && placement.device.spatialDisposition === "non_spatial").length,
    devicesRequiringSpaceReview: placements.filter((placement) => placement.spaceIds.length === 0
      && placement.device.spatialDisposition !== "non_spatial").length,
  };
}

function classifyPlacements(
  devices: readonly HomeMapSnapshot["devices"][number][],
  knownSpaceIds: ReadonlySet<string>,
): readonly { readonly device: HomeMapSnapshot["devices"][number]; readonly spaceIds: readonly string[] }[] {
  return devices.map((device) => ({
    device,
    spaceIds: [...new Set(device.bindings.flatMap((binding) =>
      binding.hwSpaceId !== undefined && knownSpaceIds.has(binding.hwSpaceId) ? [binding.hwSpaceId] : []))]
      .sort((left, right) => left.localeCompare(right)),
  }));
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

function compareDisplay(leftName: string, leftId: string, rightName: string, rightId: string): number {
  const leftKey = leftName.normalize("NFKC").toLocaleLowerCase("en-US");
  const rightKey = rightName.normalize("NFKC").toLocaleLowerCase("en-US");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftId.localeCompare(rightId);
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
