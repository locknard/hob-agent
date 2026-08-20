import type {
  InboxObservationStatus,
  InboxProposalQualitySummary,
} from "./proposal-inbox.js";

export type ControlCenterCardStatus = "ready" | "attention" | "busy" | "unavailable";

export interface ControlCenterWorldSnapshot {
  readonly bridges: Readonly<Record<string, {
    readonly adapterType: string;
    readonly diagnostics: {
      readonly connectionState: string;
      readonly lastSyncCompleteAt?: string;
      readonly lastSuccessfulContactAt?: string;
      readonly currentProcessReadyAt?: string;
    };
    readonly watermark: { readonly epochId: string; readonly lastSeq: number } | null;
    readonly metrics?: { readonly consistency: string };
  }>>;
  readonly bridgeWatermarks: readonly { readonly bridgeId: string }[];
  readonly diagnostics: readonly {
    readonly bridgeId: string;
    readonly connectionState: string;
    readonly currentProcessReadyAt?: string;
  }[];
  readonly spaces: readonly { readonly hwSpaceId?: string }[];
  readonly devices: readonly {
    readonly spatialDisposition?: "non_spatial";
    readonly bindings?: readonly { readonly hwSpaceId?: string }[];
    readonly capabilities: readonly unknown[];
    readonly states: readonly unknown[];
  }[];
}

export interface ControlCenterWorldSource {
  snapshot(): ControlCenterWorldSnapshot;
  identity?: {
    proposals(): readonly { readonly kind: string; readonly status: string }[];
  };
}

export type ControlCenterRetentionCoverageStatus = "complete" | "partial" | "degraded" | "unavailable";

export interface ControlCenterRetentionCapacity {
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly remainingBytes: number;
}

export interface ControlCenterRetentionBridgeStatus {
  readonly bridgeId: string;
  readonly status: ControlCenterCardStatus;
  readonly capacity?: ControlCenterRetentionCapacity;
  readonly coverage: {
    readonly status: ControlCenterRetentionCoverageStatus;
    readonly coverageFloor?: string;
  };
  readonly lastRetention?: {
    readonly appliedAt: string;
    readonly result: "complete" | "partial";
    readonly bytesDeleted: number;
  };
}

export interface ControlCenterRetentionSnapshot {
  readonly status: ControlCenterCardStatus;
  readonly capacity: ControlCenterRetentionCapacity;
  readonly bridges: readonly ControlCenterRetentionBridgeStatus[];
}

export interface ControlCenterRetentionSource {
  snapshot(): ControlCenterRetentionSnapshot;
}

export interface ControlCenterAgentSource {
  /** Optional human-facing label; absent means the runtime route is shown plainly. */
  readonly productLabel?: string;
  readonly agent?: {
    readonly options?: { readonly provider?: string; readonly model?: string };
    readonly status?: string;
  };
  readonly observationStatus?: "idle" | "running";
}

export interface ControlCenterObservationSource {
  snapshot(): InboxObservationStatus;
}

export interface ControlCenterProposalSource {
  qualitySummary(): InboxProposalQualitySummary;
}

export interface ControlCenterArtifactSnapshot {
  readonly status: "ready" | "unavailable";
  readonly schemaVersion?: "1";
  readonly lifecycleStates: readonly ("draft" | "superseded")[];
  readonly hasRecords: boolean;
  readonly canCompile: false;
  readonly canSimulate: false;
  readonly canExecute: false;
}

export interface ControlCenterArtifactSource {
  diagnostics(): ControlCenterArtifactSnapshot;
}

export interface ControlCenterSources {
  readonly world?: ControlCenterWorldSource;
  readonly retention?: ControlCenterRetentionSource;
  readonly agent?: ControlCenterAgentSource;
  readonly observation?: ControlCenterObservationSource;
  readonly proposals?: ControlCenterProposalSource;
  readonly artifacts?: ControlCenterArtifactSource;
}

export interface ControlCenterBridgeStatus {
  readonly bridgeId: string;
  readonly adapterType: string;
  readonly connectionState: string;
  readonly status: ControlCenterCardStatus;
  readonly consistency: "ready" | "not_ready" | "degraded";
  readonly epochId?: string;
  readonly lastSeq?: number;
  readonly lastSyncCompleteAt?: string;
  readonly lastSuccessfulContactAt?: string;
}

export interface ControlCenterHomeMapStatus {
  readonly status: "ready" | "not_ready" | "unavailable";
  readonly spaces: number;
  readonly devices: number;
  readonly devicesWithSingleSpace: number;
  readonly devicesWithoutSpace: number;
  readonly devicesNeedingSpaceReview: number;
  readonly devicesWithMultipleSpaces: number;
  readonly devicesNotRequiringSpace: number;
  readonly proposedIdentityLinks: number;
  readonly proposedCapabilityBindings: number;
}

export interface ControlCenterModelStatus {
  readonly status: "configured" | "unavailable";
  readonly productLabel?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface ControlCenterAgentStatus {
  readonly status: ControlCenterCardStatus;
  readonly lifecycle?: string;
  readonly observation: "idle" | "running" | "unavailable";
}

export interface ControlCenterObservationStatus {
  readonly status: "enabled" | "disabled" | "running" | "unavailable";
  readonly state?: InboxObservationStatus["state"];
  readonly lastOutcome?: string;
}

export interface ControlCenterInboxStatus {
  readonly status: ControlCenterCardStatus;
  readonly pendingReviewCount: number;
  readonly totalProposalCount: number;
}

export interface ControlCenterSystemCheck {
  readonly key: "bridges" | "model" | "homeMap" | "agent" | "observation" | "inbox" | "retention" | "artifacts";
  readonly status: ControlCenterCardStatus;
}

export interface ControlCenterSnapshot {
  readonly generatedAt: string;
  readonly status: ControlCenterCardStatus;
  readonly bridges: readonly ControlCenterBridgeStatus[];
  readonly model: ControlCenterModelStatus;
  readonly homeMap: ControlCenterHomeMapStatus;
  readonly agent: ControlCenterAgentStatus;
  readonly observation: ControlCenterObservationStatus;
  readonly inbox: ControlCenterInboxStatus;
  readonly retention: ControlCenterRetentionSnapshot;
  readonly artifacts: ControlCenterArtifactSnapshot;
  readonly systemChecks: readonly ControlCenterSystemCheck[];
}

/** Projects live local services into a bounded, metadata-only status model. */
export function projectControlCenter(
  sources: ControlCenterSources,
  generatedAt = new Date().toISOString(),
): ControlCenterSnapshot {
  const world = sources.world?.snapshot();
  const bridges = world === undefined ? [] : projectBridges(world);
  const homeMap = world === undefined
    ? unavailableHomeMap()
    : projectHomeMap(world, sources.world?.identity?.proposals() ?? []);
  const model = projectModel(sources.agent);
  const agent = projectAgent(sources.agent);
  const observation = projectObservation(sources.observation);
  const inbox = projectInbox(sources.proposals);
  const retention = projectRetention(sources.retention);
  const artifacts = projectArtifacts(sources.artifacts);
  const systemChecks: ControlCenterSystemCheck[] = [
    { key: "bridges", status: bridgeCheckStatus(bridges) },
    { key: "model", status: model.status === "configured" ? "ready" : "unavailable" },
    { key: "homeMap", status: homeMap.status === "ready" ? "ready" : homeMap.status === "unavailable" ? "unavailable" : "attention" },
    { key: "agent", status: agent.status },
    { key: "observation", status: observationCardStatus(observation.status) },
    { key: "inbox", status: inbox.status },
  ];
  if (sources.retention !== undefined) systemChecks.push({ key: "retention", status: retention.status });
  if (sources.artifacts !== undefined) systemChecks.push({ key: "artifacts", status: artifacts.status });
  return {
    generatedAt,
    status: systemStatus(systemChecks),
    bridges,
    model,
    homeMap,
    agent,
    observation,
    inbox,
    retention,
    artifacts,
    systemChecks,
  };
}

export function renderControlCenter(snapshot: ControlCenterSnapshot): string {
  const bridgeItems = snapshot.bridges.length === 0
    ? "<li class=\"control-empty\">No live bridge diagnostics are available in this process.</li>"
    : snapshot.bridges.map((bridge) => `<li class="control-list-item" data-status="${escapeHtml(bridge.status)}">
      <div><strong>${escapeHtml(bridge.bridgeId)}</strong><span class="muted">${escapeHtml(bridge.adapterType)}</span></div>
      <div class="control-list-meta"><span class="status-chip" data-status="${escapeHtml(bridge.status)}">${escapeHtml(statusLabel(bridge.status))}</span><span>connection ${escapeHtml(bridge.connectionState)}</span><span>consistency ${escapeHtml(bridge.consistency)}</span>${bridge.lastSeq === undefined ? "" : `<span>seq ${bridge.lastSeq}</span>`}</div>
    </li>`).join("");
  const checks = snapshot.systemChecks.map((check) => `<li><span>${escapeHtml(systemCheckLabel(check.key))}</span><span class="status-chip" data-status="${escapeHtml(check.status)}">${escapeHtml(statusLabel(check.status))}</span></li>`).join("");
  const retentionDetails = renderRetentionDetails(snapshot.retention);
  const artifactDetails = renderArtifactDetails(snapshot.artifacts);
  const connectionsStatus = bridgeCheckStatus(snapshot.bridges);
  const connectionsDescription = snapshot.bridges.length === 0
    ? "No live home connection is available"
    : connectionsStatus === "ready"
      ? `${snapshot.bridges.length} home connection${snapshot.bridges.length === 1 ? "" : "s"} ready`
      : "A home connection needs attention before the next observation";
  const modelDescription = snapshot.model.status === "configured"
    ? `${escapeHtml(snapshot.model.productLabel ?? modelConnectionLabel(snapshot.model.provider))} · ${escapeHtml(snapshot.model.model ?? "Selected model")}`
    : "No live model connection is available";
  const agentDescription = snapshot.agent.status === "unavailable"
    ? "The Home Agent is not running in this process"
    : snapshot.agent.status === "busy"
      ? "The Home Agent is reviewing household evidence now"
      : "Ready to inspect household evidence";
  const observationDescription = snapshot.observation.status === "unavailable"
    ? "Observation is unavailable until the full home runtime is started"
    : snapshot.observation.status === "disabled"
      ? "Runs only when you choose Observe now"
      : `${escapeHtml(snapshot.observation.status)}${snapshot.observation.lastOutcome === undefined ? "" : ` · last ${escapeHtml(snapshot.observation.lastOutcome)}`}`;
  const homeMapDescription = snapshot.homeMap.status === "unavailable"
    ? "The household map is unavailable until the home is connected"
    : `${snapshot.homeMap.spaces} spaces · ${snapshot.homeMap.devices} devices · ${snapshot.homeMap.devicesNeedingSpaceReview} need space review`;
  const reviewBanner = snapshot.inbox.pendingReviewCount > 0
    ? `<section class="control-review" aria-labelledby="control-review-heading"><div><p class="eyebrow">Household decision</p><h2 id="control-review-heading">${snapshot.inbox.pendingReviewCount} idea${snapshot.inbox.pendingReviewCount === 1 ? "" : "s"} ready for review</h2><p>See what the Agent noticed, inspect the evidence, and record what your household thinks.</p></div><a class="control-review-link" href="/proposals#reviews">Review now</a></section>`
    : "";
  const modelTechnical = snapshot.model.status === "configured"
    ? `<p class="control-technical-line"><strong>Model route</strong><span>${escapeHtml(snapshot.model.provider ?? "configured")} · ${escapeHtml(snapshot.model.model ?? "selected")}</span></p>`
    : "";
  return `<main id="main-content" class="control-center">
    <header class="page-header"><p class="eyebrow">Control Center</p><h1>Home at a glance</h1><p class="muted">See whether your home is connected, what needs a decision, and whether the Agent is ready. Secrets and raw device data never appear here.</p><div class="status-line"><span class="status-chip" data-status="${escapeHtml(snapshot.status)}">Home system ${escapeHtml(statusLabel(snapshot.status))}</span><span class="muted">Updated <time datetime="${escapeHtml(snapshot.generatedAt)}">${escapeHtml(displayTimestamp(snapshot.generatedAt))}</time></span></div></header>
    ${reviewBanner}
    <section class="control-section" aria-labelledby="control-services-heading"><div class="section-heading"><div><h2 id="control-services-heading">Household services</h2><p>Everyday status first; technical identifiers stay in diagnostics.</p></div></div><ul class="control-service-list">
      ${serviceRow("Home connections", connectionsStatus, connectionsDescription, connectionsGuidance(connectionsStatus))}
      ${serviceRow("Model connection", snapshot.model.status === "configured" ? "ready" : "unavailable", modelDescription, snapshot.model.status === "configured" ? "Credential values remain in secure storage." : "Configure a model credential and route in local setup, then restart the home runtime.")}
      ${serviceRow("Home map", snapshot.homeMap.status === "ready" ? "ready" : snapshot.homeMap.status === "unavailable" ? "unavailable" : "attention", homeMapDescription, snapshot.homeMap.status === "ready" ? `${snapshot.homeMap.devicesWithSingleSpace} devices have one confirmed space; ${snapshot.homeMap.proposedIdentityLinks} identity links await review.` : "Wait for a consistent home connection, then review unresolved spaces in local setup.")}
      ${serviceRow("Home Agent", snapshot.agent.status, agentDescription, snapshot.agent.status === "unavailable" ? "Start the full home runtime after connections and model setup are ready." : "The Agent can suggest review items but cannot apply household changes.")}
      ${serviceRow("Observation", observationCardStatus(snapshot.observation.status), observationDescription, "Observation is bounded, governed, and review-only.", observationStatusLabel(snapshot.observation.status))}
    </ul></section>
    <details class="control-diagnostics"><summary>Technical diagnostics</summary><div class="control-diagnostics-body">${modelTechnical}<h2>System checks</h2><ul class="control-check-list">${checks}</ul>${artifactDetails}${retentionDetails}<div class="section-heading"><div><h2>Bridge instances</h2></div><p>${snapshot.bridges.length} configured in the live world</p></div><ul class="control-list">${bridgeItems}</ul></div></details>
    <section class="control-section control-note" aria-label="Control center boundary"><h2>You remain in control</h2><p>Everything above is a report. This page cannot edit setup, call a model, approve an idea, or control a device. Any future household change will require its own exact review.</p></section>
  </main>`;
}

function projectBridges(world: ControlCenterWorldSnapshot): ControlCenterBridgeStatus[] {
  return Object.entries(world.bridges).sort(([left], [right]) => left.localeCompare(right)).map(([bridgeId, bridge]) => {
    const ready = bridge.diagnostics.connectionState === "ready"
      && bridge.watermark !== null
      && bridge.metrics?.consistency !== "degraded";
    const degraded = bridge.diagnostics.connectionState === "degraded"
      || bridge.diagnostics.connectionState === "paused"
      || bridge.diagnostics.connectionState === "quarantined"
      || bridge.diagnostics.connectionState === "down"
      || bridge.metrics?.consistency === "degraded";
    return {
      bridgeId,
      adapterType: bridge.adapterType,
      connectionState: bridge.diagnostics.connectionState,
      status: ready ? "ready" : degraded ? "attention" : "busy",
      consistency: bridge.metrics?.consistency === "degraded" ? "degraded" : ready ? "ready" : "not_ready",
      ...(bridge.watermark === null ? {} : { epochId: bridge.watermark.epochId, lastSeq: bridge.watermark.lastSeq }),
      ...(bridge.diagnostics.lastSyncCompleteAt === undefined ? {} : { lastSyncCompleteAt: bridge.diagnostics.lastSyncCompleteAt }),
      ...(bridge.diagnostics.lastSuccessfulContactAt === undefined ? {} : { lastSuccessfulContactAt: bridge.diagnostics.lastSuccessfulContactAt }),
    };
  });
}

function projectHomeMap(
  world: ControlCenterWorldSnapshot,
  proposals: readonly { readonly kind: string; readonly status: string }[],
): ControlCenterHomeMapStatus {
  const spaceIds = new Set(world.spaces.flatMap((space) => typeof space.hwSpaceId === "string" && space.hwSpaceId.length > 0 ? [space.hwSpaceId] : []));
  const spaceCounts = world.devices.map((device) => new Set((device.bindings ?? []).flatMap((binding) =>
    typeof binding.hwSpaceId === "string" && spaceIds.has(binding.hwSpaceId) ? [binding.hwSpaceId] : [])).size);
  const bridges = projectBridges(world);
  const status = bridges.length > 0 && bridges.every((bridge) => bridge.status === "ready")
    && world.diagnostics.every((diagnostic) => diagnostic.connectionState === "ready" && diagnostic.currentProcessReadyAt !== undefined)
    && world.bridgeWatermarks.length === bridges.length
    ? "ready" as const
    : "not_ready" as const;
  const devicesWithoutSpace = spaceCounts.filter((count) => count === 0).length;
  const devicesNotRequiringSpace = world.devices.filter(
    (device, index) => spaceCounts[index] === 0 && device.spatialDisposition === "non_spatial",
  ).length;
  return {
    status,
    spaces: world.spaces.length,
    devices: world.devices.length,
    devicesWithSingleSpace: spaceCounts.filter((count) => count === 1).length,
    devicesWithoutSpace,
    devicesNeedingSpaceReview: devicesWithoutSpace - devicesNotRequiringSpace,
    devicesWithMultipleSpaces: spaceCounts.filter((count) => count > 1).length,
    devicesNotRequiringSpace,
    proposedIdentityLinks: proposals.filter((proposal) => proposal.kind === "identity-link" && proposal.status === "proposed").length,
    proposedCapabilityBindings: proposals.filter((proposal) => proposal.kind === "capability-binding" && proposal.status === "proposed").length,
  };
}

function unavailableHomeMap(): ControlCenterHomeMapStatus {
  return {
    status: "unavailable",
    spaces: 0,
    devices: 0,
    devicesWithSingleSpace: 0,
    devicesWithoutSpace: 0,
    devicesNeedingSpaceReview: 0,
    devicesWithMultipleSpaces: 0,
    devicesNotRequiringSpace: 0,
    proposedIdentityLinks: 0,
    proposedCapabilityBindings: 0,
  };
}

function projectRetention(source: ControlCenterRetentionSource | undefined): ControlCenterRetentionSnapshot {
  if (source === undefined) return unavailableRetention();
  try {
    const status = source.snapshot();
    const bridges = status.bridges.map((bridge) => ({
      bridgeId: bridge.bridgeId,
      status: bridge.status,
      ...(bridge.capacity === undefined ? {} : { capacity: safeCapacity(bridge.capacity) }),
      coverage: {
        status: bridge.coverage.status,
        ...(bridge.coverage.coverageFloor === undefined ? {} : { coverageFloor: bridge.coverage.coverageFloor }),
      },
      ...(bridge.lastRetention === undefined ? {} : {
        lastRetention: {
          appliedAt: bridge.lastRetention.appliedAt,
          result: bridge.lastRetention.result,
          bytesDeleted: safeCount(bridge.lastRetention.bytesDeleted),
        },
      }),
    }));
    const ready = status.status === "ready"
      && bridges.length > 0
      && bridges.every((bridge) => bridge.status === "ready" && bridge.coverage.status === "complete");
    const projectedStatus = status.status === "unavailable"
      ? "unavailable"
      : ready ? "ready" : "attention";
    return {
      status: projectedStatus,
      capacity: safeCapacity(status.capacity),
      bridges,
    };
  } catch {
    return unavailableRetention();
  }
}

function unavailableRetention(): ControlCenterRetentionSnapshot {
  return {
    status: "unavailable",
    capacity: { usedBytes: 0, maxBytes: 0, remainingBytes: 0 },
    bridges: [],
  };
}

function projectArtifacts(source: ControlCenterArtifactSource | undefined): ControlCenterArtifactSnapshot {
  if (source === undefined) return unavailableArtifacts();
  try {
    const diagnostics = source.diagnostics();
    if (diagnostics.status !== "ready"
      || diagnostics.schemaVersion !== "1"
      || diagnostics.canCompile !== false
      || diagnostics.canSimulate !== false
      || diagnostics.canExecute !== false
      || diagnostics.lifecycleStates.some((state) => state !== "draft" && state !== "superseded")) {
      return unavailableArtifacts();
    }
    return {
      status: "ready",
      schemaVersion: "1",
      lifecycleStates: [...diagnostics.lifecycleStates],
      hasRecords: diagnostics.hasRecords === true,
      canCompile: false,
      canSimulate: false,
      canExecute: false,
    };
  } catch {
    return unavailableArtifacts();
  }
}

function unavailableArtifacts(): ControlCenterArtifactSnapshot {
  return {
    status: "unavailable",
    lifecycleStates: [],
    hasRecords: false,
    canCompile: false,
    canSimulate: false,
    canExecute: false,
  };
}

function safeCapacity(value: ControlCenterRetentionCapacity): ControlCenterRetentionCapacity {
  return {
    usedBytes: safeCount(value.usedBytes),
    maxBytes: safeCount(value.maxBytes),
    remainingBytes: safeCount(value.remainingBytes),
  };
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function projectModel(agent: ControlCenterAgentSource | undefined): ControlCenterModelStatus {
  const provider = agent?.agent?.options?.provider;
  const model = agent?.agent?.options?.model;
  const productLabel = typeof agent?.productLabel === "string" && agent.productLabel.trim().length > 0
    ? agent.productLabel.trim()
    : undefined;
  return typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0
    ? {
      status: "configured",
      ...(productLabel === undefined ? {} : { productLabel }),
      provider,
      model,
    }
    : { status: "unavailable" };
}

function projectAgent(agent: ControlCenterAgentSource | undefined): ControlCenterAgentStatus {
  if (agent?.agent === undefined) return { status: "unavailable", observation: "unavailable" };
  const observation = agent.observationStatus ?? "idle";
  const lifecycle = typeof agent.agent.status === "string" ? agent.agent.status : undefined;
  const busy = observation === "running" || (lifecycle !== undefined && lifecycle !== "idle");
  return {
    status: busy ? "busy" : "ready",
    ...(lifecycle === undefined ? {} : { lifecycle }),
    observation,
  };
}

function projectObservation(observation: ControlCenterObservationSource | undefined): ControlCenterObservationStatus {
  if (observation === undefined) return { status: "unavailable" };
  const snapshot = observation.snapshot();
  return {
    status: snapshot.state === "running" ? "running" : snapshot.enabled ? "enabled" : "disabled",
    state: snapshot.state,
    ...(snapshot.lastAttempt === undefined ? {} : { lastOutcome: snapshot.lastAttempt.outcome }),
  };
}

function observationCardStatus(status: ControlCenterObservationStatus["status"]): ControlCenterCardStatus {
  switch (status) {
    case "enabled":
    case "disabled":
      return "ready";
    case "running":
      return "busy";
    case "unavailable":
      return "unavailable";
  }
}

function observationStatusLabel(status: ControlCenterObservationStatus["status"]): string {
  switch (status) {
    case "disabled": return "Manual";
    case "enabled": return "Enabled";
    case "running": return "Running";
    case "unavailable": return "Unavailable";
  }
}

function projectInbox(proposals: ControlCenterProposalSource | undefined): ControlCenterInboxStatus {
  if (proposals === undefined) return { status: "unavailable", pendingReviewCount: 0, totalProposalCount: 0 };
  const summary = proposals.qualitySummary();
  return {
    status: "ready",
    pendingReviewCount: summary.statuses.pending_review,
    totalProposalCount: summary.total,
  };
}

function renderRetentionDetails(retention: ControlCenterRetentionSnapshot): string {
  const aggregate = `${formatCount(retention.capacity.usedBytes)} bytes used of ${formatCount(retention.capacity.maxBytes)} (${formatCount(retention.capacity.remainingBytes)} remaining)`;
  const bridges = retention.bridges.length === 0
    ? "<p class=\"muted\">Retention status is unavailable in this process.</p>"
    : `<ul class="control-list">${retention.bridges.map((bridge) => {
      const capacity = bridge.capacity === undefined
        ? "Capacity unavailable"
        : `${formatCount(bridge.capacity.usedBytes)} bytes used of ${formatCount(bridge.capacity.maxBytes)}`;
      const floor = bridge.coverage.coverageFloor === undefined
        ? "No coverage floor"
        : `Coverage floor ${timeElement(bridge.coverage.coverageFloor)}`;
      const lastRetention = bridge.lastRetention === undefined
        ? "Not run yet"
        : `Last retention ${timeElement(bridge.lastRetention.appliedAt)} · ${escapeHtml(bridge.lastRetention.result)} · ${formatCount(bridge.lastRetention.bytesDeleted)} bytes deleted`;
      return `<li class="control-list-item" data-status="${escapeHtml(bridge.status)}"><div><strong>${escapeHtml(bridge.bridgeId)}</strong><span class="muted">${escapeHtml(capacity)}</span></div><div class="control-list-meta"><span class="status-chip" data-status="${escapeHtml(bridge.status)}">${escapeHtml(statusLabel(bridge.status))}</span><span>coverage ${escapeHtml(bridge.coverage.status)}</span><span>${floor}</span><span>${lastRetention}</span></div></li>`;
    }).join("")}</ul>`;
  return `<section class="control-retention" aria-labelledby="control-retention-heading"><div class="section-heading"><div><h2 id="control-retention-heading">Evidence retention</h2><p>Read-only journal coverage and capacity; retention is never started here.</p></div><span class="status-chip" data-status="${escapeHtml(retention.status)}">${escapeHtml(statusLabel(retention.status))}</span></div><p class="control-retention-capacity">Aggregate capacity: ${escapeHtml(aggregate)}</p>${bridges}</section>`;
}

function renderArtifactDetails(artifacts: ControlCenterArtifactSnapshot): string {
  if (artifacts.status === "unavailable") return "";
  const records = artifacts.hasRecords ? "registry contains immutable records" : "registry is empty";
  return `<section class="control-retention" aria-labelledby="control-artifacts-heading"><div class="section-heading"><div><h2 id="control-artifacts-heading">Automation artifacts</h2><p>Read-only neutral registry; no behavior can be installed or run from this surface.</p></div><span class="status-chip" data-status="ready">Ready</span></div><p class="control-technical-line"><strong>Artifact boundary</strong><span>schema ${escapeHtml(artifacts.schemaVersion ?? "unavailable")} · ${escapeHtml(records)} · compile unavailable · simulation unavailable · execution unavailable</span></p></section>`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function timeElement(value: string): string {
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(displayTimestamp(value))}</time>`;
}

function bridgeCheckStatus(bridges: readonly ControlCenterBridgeStatus[]): ControlCenterCardStatus {
  if (bridges.length === 0) return "unavailable";
  return bridges.every((bridge) => bridge.status === "ready") ? "ready" : "attention";
}

function systemStatus(checks: readonly ControlCenterSystemCheck[]): ControlCenterCardStatus {
  if (checks.length === 0) return "unavailable";
  if (checks.every((check) => check.status === "ready")) return "ready";
  return checks.some((check) => check.status !== "unavailable") ? "attention" : "unavailable";
}

function serviceRow(title: string, status: ControlCenterCardStatus, description: string, detail: string, statusText = statusLabel(status)): string {
  return `<li class="control-service-row" data-status="${escapeHtml(status)}"><div><h3>${escapeHtml(title)}</h3><p>${description}</p><p class="muted">${escapeHtml(detail)}</p></div><span class="status-chip" data-status="${escapeHtml(status)}">${escapeHtml(statusText)}</span></li>`;
}

function connectionsGuidance(status: ControlCenterCardStatus): string {
  switch (status) {
    case "ready": return "Current state is consistent and ready for household evidence reads.";
    case "busy": return "The home connection is starting or synchronizing.";
    case "attention": return "Open technical diagnostics below and restore a consistent connection before observing.";
    case "unavailable": return "Configure a bridge in local setup, then start the full home runtime.";
  }
}

function modelConnectionLabel(provider: string | undefined): string {
  if (provider?.includes("custom") === true) return "Custom model connection";
  return "Model connection";
}

function displayTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function statusLabel(status: ControlCenterCardStatus): string {
  switch (status) {
    case "ready": return "Ready";
    case "attention": return "Needs attention";
    case "busy": return "Working";
    case "unavailable": return "Unavailable";
  }
}

function systemCheckLabel(key: ControlCenterSystemCheck["key"]): string {
  switch (key) {
    case "bridges": return "Bridge connectivity";
    case "model": return "Model setup";
    case "homeMap": return "Home map readiness";
    case "agent": return "Home Agent";
    case "observation": return "Observation scheduler";
    case "inbox": return "Review Inbox";
    case "retention": return "Evidence retention";
    case "artifacts": return "Automation artifact registry";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}
