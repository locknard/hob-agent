import { Context, Service } from "@deepseek-ai/cordis";

import type { StateEvent } from "@hob/bridge-contract";
import type { BridgeActionDescriptor, BridgeActionResult } from "@hob/bridge-contract";
import type { ActionAuthorityPolicyClass, ActionAuthorityResolution } from "./authority/authority-coordinator.js";
import type { HomeWorldOneShotActionInput, HomeWorldSnapshot } from "./world/home-world-service.js";
import {
  OneShotActionPlane,
  SqliteOneShotActionStore,
  type OneShotAction,
  type OneShotActionActivity,
  type OneShotActionActor,
  type OneShotActionDecisionResult,
  type OneShotActionGateway,
  type OneShotActionPolicy,
  type OneShotActionResult,
  type OneShotActionStore,
  type OneShotActionTicket,
} from "./authority/one-shot-action-plane.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeReviewCenter: HouseholdReviewCenterService;
  }
}

export interface RuntimeConfirmationProjection {
  readonly id: string;
  readonly dedupKey: string;
  readonly actionSummary: string;
  readonly approvalLevel: "member" | "admin";
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "approved" | "rejected" | "expired";
  readonly decision?: {
    readonly kind: "approved" | "rejected" | "expired";
    readonly at: string;
    readonly actorId?: string;
  };
}

export type RuntimeDecisionProjection =
  | { readonly status: "approved" | "rejected"; readonly confirmation: RuntimeConfirmationProjection }
  | {
      readonly status: "denied";
      readonly reason: "unauthorized" | "expired" | "already_decided" | "not_found" | "unavailable";
      readonly confirmation?: RuntimeConfirmationProjection;
    };

export interface HouseholdActionActivityProjection {
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly actor: "家庭成员" | "家庭助手" | "外部规则" | "家庭服务" | "来源待确认";
  readonly attribution: "member" | "hob" | "external-rule" | "system" | "unknown";
  readonly cause: readonly string[];
  readonly verification?: string;
}

interface HomeWorldActionPort {
  snapshot(): HomeWorldSnapshot;
  resolveActionAuthority(hwCapabilityId: string): ActionAuthorityResolution;
  actionDescriptorFor(capabilityId: string): BridgeActionDescriptor | undefined;
  executeOneShotAction(input: HomeWorldOneShotActionInput): Promise<BridgeActionResult>;
}

interface HomeMediaPlaybackPort {
  readonly gateway: OneShotActionGateway;
}

export interface HouseholdReviewCenterServiceOptions {
  readonly path?: string;
  readonly store?: OneShotActionStore & { close?: () => void };
  readonly gateway?: OneShotActionGateway;
  readonly policy?: OneShotActionPolicy;
  readonly now?: () => string | number | Date;
  readonly idFactory?: () => string;
  readonly verificationWindowMs?: number;
  readonly verificationPollMs?: number;
  readonly maxVerificationReads?: number;
  readonly undoWindowMs?: number;
  /** Maximum age of the authoritative bridge contact used for a device read. */
  readonly stateFreshnessMaxAgeMs?: number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /**
   * Explicit neutral action contract supplied by the bridge adapter layer.
   * The review center validates and exposes this catalog only after the
   * capability has a reviewed action-authority configuration.
   */
  readonly actionDescriptorSource?: HouseholdActionDescriptorSource;
}

export interface HouseholdActionDescriptor {
  readonly action: OneShotAction;
  readonly reversible?: boolean;
  readonly label?: string;
  readonly actionLabel?: string;
  readonly summary?: string;
  readonly value?: string;
  readonly policyClass: ActionAuthorityPolicyClass;
}

export interface HouseholdActionDescriptorSource {
  actionDescriptorFor(capabilityId: string): Omit<HouseholdActionDescriptor, "policyClass"> | undefined;
}

export interface RequestHouseholdActionInput {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly summary: string;
  readonly action: OneShotAction;
  readonly actor: OneShotActionActor;
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
  readonly signal?: AbortSignal;
}

/** One durable owner for one-shot execution and its confirmation cards. */
export class HouseholdReviewCenterService extends Service {
  private readonly plane: OneShotActionPlane;
  private readonly store: OneShotActionStore & { close?: () => void };
  private readonly executionAvailable: boolean;
  private readonly actionDescriptorSource?: HouseholdActionDescriptorSource;

  constructor(ctx: Context, options: HouseholdReviewCenterServiceOptions = {}) {
    super(ctx, "homeReviewCenter");
    const world = ctx.get("homeWorld") as unknown as HomeWorldActionPort | undefined;
    const mediaPlayback = ctx.get("homeMediaPlayback") as unknown as HomeMediaPlaybackPort | undefined;
    this.executionAvailable = options.gateway !== undefined || world !== undefined;
    this.actionDescriptorSource = options.actionDescriptorSource;
    this.store = options.store ?? new SqliteOneShotActionStore({ path: options.path ?? ":memory:" });
    const stateFreshnessMaxAgeMs = options.stateFreshnessMaxAgeMs ?? 60_000;
    if (!Number.isSafeInteger(stateFreshnessMaxAgeMs) || stateFreshnessMaxAgeMs < 1 || stateFreshnessMaxAgeMs > 300_000) {
      throw new TypeError("household action state freshness must be between 1 and 300000 milliseconds");
    }
    this.plane = new OneShotActionPlane({
      gateway: options.gateway ?? (world === undefined
        ? unavailableGateway()
        : homeWorldGateway(world, mediaPlayback, options.now ?? (() => new Date()), stateFreshnessMaxAgeMs)),
      policy: options.policy ?? (world === undefined ? unavailablePolicy() : homeWorldPolicy(world, mediaPlayback !== undefined)),
      store: this.store,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.verificationWindowMs === undefined ? {} : { verificationWindowMs: options.verificationWindowMs }),
      ...(options.verificationPollMs === undefined ? {} : { verificationPollMs: options.verificationPollMs }),
      ...(options.maxVerificationReads === undefined ? {} : { maxVerificationReads: options.maxVerificationReads }),
      ...(options.undoWindowMs === undefined ? {} : { undoWindowMs: options.undoWindowMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-one-shot-actions.close");
  }

  requestAction(input: RequestHouseholdActionInput): Promise<OneShotActionResult> {
    return this.plane.request({
      requestId: input.requestId,
      capabilityId: input.capabilityId,
      summary: input.summary,
      action: input.action,
      actor: input.actor,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  undoAction(input: { readonly ticketId: string; readonly actor: OneShotActionActor; readonly signal?: AbortSignal }): Promise<OneShotActionResult> {
    return this.plane.undo(input);
  }

  counts(): { readonly runtimeConfirmations: number } {
    return { runtimeConfirmations: this.listRuntimeConfirmations().length };
  }

  snapshot(): {
    readonly runtimeConfirmations: readonly RuntimeConfirmationProjection[];
    readonly expiredRuntimeSummary?: { readonly count: number; readonly confirmationIds: readonly string[] };
  } {
    const runtimeConfirmations = this.listRuntimeConfirmations();
    const expired = this.plane.consumeExpiredSummary();
    return {
      runtimeConfirmations,
      ...(expired === undefined
        ? {}
        : { expiredRuntimeSummary: { count: expired.count, confirmationIds: expired.ticketIds } }),
    };
  }

  open() { return this.snapshot(); }

  getRuntimeConfirmation(id: string): RuntimeConfirmationProjection | undefined {
    const ticket = this.plane.getTicket(id);
    return ticket === undefined || ticket.policyClass === "direct" ? undefined : projectConfirmation(ticket);
  }

  listRuntimeConfirmations(): readonly RuntimeConfirmationProjection[] {
    return this.plane.listTickets()
      .filter((ticket) => ticket.status === "pending_confirmation")
      .map(projectConfirmation);
  }

  /**
   * Returns a concrete action only when both sides of the authority boundary
   * are present: the adapter supplies the neutral action contract and the
   * Hub has a reviewed, currently available policy binding. Semantic hints
   * and device names remain display-only in this lookup.
   */
  actionDescriptorFor(capabilityId: string): HouseholdActionDescriptor | undefined {
    if (!isBoundedCapabilityId(capabilityId) || this.actionDescriptorSource === undefined) return undefined;
    const world = this.ctx.get("homeWorld") as unknown as HomeWorldActionPort | undefined;
    if (world === undefined) return undefined;
    let authority: ActionAuthorityResolution;
    try {
      authority = world.resolveActionAuthority(capabilityId);
    } catch {
      return undefined;
    }
    if (authority.status !== "available") return undefined;
    let descriptor: Omit<HouseholdActionDescriptor, "policyClass"> | undefined;
    try {
      descriptor = this.actionDescriptorSource.actionDescriptorFor(capabilityId);
    } catch {
      return undefined;
    }
    const normalized = normalizeActionDescriptor(descriptor);
    return normalized === undefined
      ? undefined
      : { ...normalized, policyClass: authority.policyClass };
  }

  expireDueRuntimeConfirmations(): readonly RuntimeConfirmationProjection[] {
    return this.plane.expireDue().map(projectConfirmation);
  }

  canApproveRuntimeConfirmation(confirmationId: string, actor: OneShotActionActor): boolean {
    return this.executionAvailable && this.plane.canApprove(confirmationId, actor);
  }

  async approveRuntimeConfirmation(input: {
    readonly confirmationId: string;
    readonly actor: OneShotActionActor;
  }): Promise<RuntimeDecisionProjection> {
    if (!this.executionAvailable) {
      const confirmation = this.getRuntimeConfirmation(input.confirmationId);
      return {
        status: "denied",
        reason: confirmation === undefined ? "not_found" : "unavailable",
        ...(confirmation === undefined ? {} : { confirmation }),
      };
    }
    const result = await this.plane.approve({ ticketId: input.confirmationId, actor: input.actor });
    return projectDecision(result, "approved");
  }

  rejectRuntimeConfirmation(input: {
    readonly confirmationId: string;
    readonly actor: OneShotActionActor;
  }): RuntimeDecisionProjection {
    return projectDecision(this.plane.reject({ ticketId: input.confirmationId, actor: input.actor }), "rejected");
  }

  activities(): readonly HouseholdActionActivityProjection[] {
    return this.plane.activities()
      .slice(-200)
      .reverse()
      .flatMap((activity) => {
        const ticket = this.plane.getTicket(activity.ticketId);
        return ticket === undefined ? [] : [projectActionActivity(activity, ticket)];
      });
  }

  actionActivities() { return this.plane.activities(); }
  listActionTickets() { return this.plane.listTickets(); }
}

function unavailableGateway(): OneShotActionGateway {
  return {
    readState: async () => ({ status: "unavailable", reason: "home_world_unavailable" }),
    execute: async () => ({ status: "unknown", reason: "upstream_unavailable" }),
  };
}

function unavailablePolicy(): OneShotActionPolicy {
  return {
    evaluate: () => ({
      status: "denied",
      policyClass: "administrator",
      reason: "home_world_unavailable",
    }),
  };
}

function homeWorldGateway(
  world: HomeWorldActionPort,
  mediaPlayback: HomeMediaPlaybackPort | undefined,
  now: () => string | number | Date,
  stateFreshnessMaxAgeMs: number,
): OneShotActionGateway {
  return {
    readState: async ({ capabilityId, signal, action }) => {
      if (signal.aborted) return { status: "unavailable", reason: "cancelled" };
      if ((action?.kind === "play_media" || action?.kind === "stop_media") && mediaPlayback !== undefined) {
        // The media owner is the sole source for opaque media identity and playback state.
        return mediaPlayback.gateway.readState({ capabilityId, signal });
      }
      return locateCapabilityState(world.snapshot(), capabilityId, now, stateFreshnessMaxAgeMs)
        ?? { status: "unavailable", reason: "state_unavailable" };
    },
    execute: ({ requestId, capabilityId, action, signal, ticketId }) => {
      if ((action.kind === "play_media" || action.kind === "stop_media") && mediaPlayback !== undefined) {
        return mediaPlayback.gateway.execute({ ticketId, requestId, capabilityId, action, signal });
      }
      if (action.kind === "play_media" || action.kind === "stop_media") {
        return Promise.resolve({ status: "rejected" as const, reason: "unsupported" as const });
      }
      return world.executeOneShotAction({ requestId, hwCapabilityId: capabilityId, action, signal });
    },
  };
}

function homeWorldPolicy(world: HomeWorldActionPort, mediaPlaybackAvailable: boolean): OneShotActionPolicy {
  return {
    evaluate(input) {
      const authority = world.resolveActionAuthority(input.capabilityId);
      if (authority.status !== "available") {
        return { status: "denied", policyClass: "administrator", reason: "action_authority_unavailable" };
      }
      if ((input.action.kind === "play_media" || input.action.kind === "stop_media") && !mediaPlaybackAvailable) {
        return { status: "denied", policyClass: authority.policyClass, reason: "media_playback_unavailable" };
      }
      return {
        status: "allowed",
        policyClass: authority.policyClass,
        reversible: input.action.kind !== "stop_media",
        ...(authority.policyClass === "confirmation" ? { ttlMs: 10_000 } : {}),
        ...(authority.policyClass === "administrator" ? { ttlMs: 300_000 } : {}),
      };
    },
  };
}

function locateCapabilityState(
  snapshot: HomeWorldSnapshot,
  capabilityId: string,
  now: () => string | number | Date,
  stateFreshnessMaxAgeMs: number,
): { readonly status: "available"; readonly value: boolean | number | string | null; readonly observedAt: string; readonly fresh: boolean } | undefined {
  for (const device of snapshot.devices) {
    const capability = device.capabilities.find((item) => item.hwCapabilityId === capabilityId);
    if (capability === undefined || device.validity !== "valid") continue;
    const bindingKeys = new Set(capability.bindings.map((binding) => `${binding.nativeId}\u0000${binding.nativeInstanceId}`));
    const state = device.states.filter((candidate) => bindingKeys.has(`${candidate.nativeId}\u0000${candidate.nativeInstanceId}`)).at(-1);
    if (state === undefined) return undefined;
    const readyContacts = capability.bindings.flatMap((binding) => {
      const bridge = snapshot.bridges[binding.bridgeId];
      const contact = bridge?.diagnostics.lastSuccessfulContactAt;
      return bridge?.metrics.connection === "up"
        && bridge.metrics.consistency === "ready"
        && typeof contact === "string"
        && Number.isFinite(Date.parse(contact))
        ? [contact]
        : [];
    });
    if (readyContacts.length === 0) return undefined;
    const value = stateValue(state);
    if (value === undefined) return undefined;
    const observedAt = readyContacts.sort().at(-1)!;
    const currentMs = dateValue(now());
    const fresh = Number.isFinite(currentMs)
      && currentMs >= Date.parse(observedAt)
      && currentMs - Date.parse(observedAt) <= stateFreshnessMaxAgeMs;
    return { status: "available", value, observedAt, fresh };
  }
  return undefined;
}

function dateValue(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function stateValue(state: StateEvent): boolean | number | string | null | undefined {
  const value = state.attrs.value;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string" || value === null) return value;
  const level = state.attrs.level;
  if (typeof level === "number") return level;
  const raw = state.attrs.state;
  if (raw === "on" || raw === "open" || raw === "playing" || raw === "locked") return true;
  if (raw === "off" || raw === "closed" || raw === "idle" || raw === "unlocked") return false;
  return typeof raw === "string" ? raw : undefined;
}

function isBoundedCapabilityId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function normalizeActionDescriptor(
  value: unknown,
): Omit<HouseholdActionDescriptor, "policyClass"> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const action = normalizeDescriptorAction(source.action);
  if (action === undefined) return undefined;
  const reversible = typeof source.reversible === "boolean" ? source.reversible : undefined;
  const label = boundedDescriptorText(source.label, 512);
  const actionLabel = boundedDescriptorText(source.actionLabel, 256);
  const summary = boundedDescriptorText(source.summary, 1_024);
  const displayValue = boundedDescriptorText(source.value, 256);
  return {
    action,
    ...(reversible === undefined ? {} : { reversible }),
    ...(label === undefined ? {} : { label }),
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(summary === undefined ? {} : { summary }),
    ...(displayValue === undefined ? {} : { value: displayValue }),
  };
}

function normalizeDescriptorAction(value: unknown): OneShotAction | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const action = value as Record<string, unknown>;
  if (action.kind === "set_boolean" && typeof action.value === "boolean") {
    return { kind: "set_boolean", value: action.value };
  }
  if (action.kind === "set_level"
    && typeof action.level === "number"
    && Number.isFinite(action.level)
    && action.level >= 0
    && action.level <= 1) {
    return { kind: "set_level", level: action.level };
  }
  if (action.kind === "play_media"
    && typeof action.mediaRef === "string"
    && /^[A-Za-z0-9_-]{16,256}$/u.test(action.mediaRef)
    && (action.queueMode === "replace_and_play" || action.queueMode === "play_next" || action.queueMode === "add_to_queue")) {
    return { kind: "play_media", mediaRef: action.mediaRef, queueMode: action.queueMode };
  }
  if (action.kind === "stop_media") return { kind: "stop_media" };
  return undefined;
}

function boundedDescriptorText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return /[\u0000-\u001F\u007F]/u.test(value) ? undefined : value;
}

function projectConfirmation(ticket: OneShotActionTicket): RuntimeConfirmationProjection {
  const status = ticket.status === "pending_confirmation"
    ? "pending"
    : ticket.status === "expired" ? "expired" : ticket.status === "rejected" ? "rejected" : "approved";
  const decidedAt = ticket.approvedAt ?? (status === "expired" || status === "rejected" ? ticket.expiresAt ?? ticket.requestedAt : undefined);
  return {
    id: ticket.id,
    dedupKey: ticket.requestId,
    actionSummary: ticket.summary ?? "家庭动作",
    approvalLevel: ticket.policyClass === "administrator" ? "admin" : "member",
    requestedAt: ticket.requestedAt,
    expiresAt: ticket.expiresAt ?? ticket.requestedAt,
    status,
    ...(decidedAt === undefined ? {} : {
      decision: {
        kind: status === "expired" ? "expired" : status === "rejected" ? "rejected" : "approved",
        at: decidedAt,
        ...(ticket.approvedBy === undefined ? {} : { actorId: ticket.approvedBy }),
      },
    }),
  };
}

function projectDecision(result: OneShotActionDecisionResult, accepted: "approved" | "rejected"): RuntimeDecisionProjection {
  if (result.status === "denied") {
    return {
      status: "denied",
      reason: result.reason,
      ...(result.ticket === undefined ? {} : { confirmation: projectConfirmation(result.ticket) }),
    };
  }
  return { status: accepted, confirmation: projectConfirmation(result.ticket) };
}

function projectActionActivity(
  activity: OneShotActionActivity,
  ticket: OneShotActionTicket,
): HouseholdActionActivityProjection {
  const attribution = ticket.source === "hob"
    ? "hob"
    : ticket.source === "external-rule"
      ? "external-rule"
      : ticket.source === "system"
        ? "system"
        : ticket.source === "unknown"
          ? "unknown"
          : "member";
  const actor = attribution === "hob"
    ? "家庭助手"
    : attribution === "external-rule"
      ? "外部规则"
      : attribution === "system"
        ? "家庭服务"
        : attribution === "unknown"
          ? "来源待确认"
          : "家庭成员";
  const summary = ticket.summary ?? "家庭动作";
  const event = activityPresentation(activity.kind, ticket.policyClass);
  return {
    id: activity.id,
    at: activity.at,
    title: `${summary} · ${event.status}`,
    actor,
    attribution,
    cause: event.cause,
    ...(event.verification === undefined ? {} : { verification: event.verification }),
  };
}

function activityPresentation(
  kind: OneShotActionActivity["kind"],
  policyClass: OneShotActionTicket["policyClass"],
): { readonly status: string; readonly cause: readonly string[]; readonly verification?: string } {
  const policy = policyClass === "administrator" ? "管理员权限" : policyClass === "confirmation" ? "成员确认权限" : "直接执行权限";
  switch (kind) {
    case "action_requested": return { status: "已请求", cause: ["家庭动作已发起", `动作进入${policy}检查`] };
    case "confirmation_created": return { status: "等待放行", cause: [`${policy}要求放行`, "动作正在等待决定"] };
    case "confirmation_approved": return { status: "已放行", cause: ["符合权限的家庭成员完成放行", "动作进入执行阶段"] };
    case "confirmation_rejected": return { status: "已拒绝", cause: ["家庭成员拒绝了本次动作", "动作已结束"], verification: "未执行" };
    case "confirmation_expired": return { status: "已过期", cause: ["等待放行达到时限", "安全规则取消了这项动作"], verification: "未执行" };
    case "action_executing": return { status: "执行中", cause: [`${policy}检查通过`, "家庭连接正在执行动作"] };
    case "action_verified": return { status: "已完成", cause: ["家庭连接接受了动作", "当前状态读回完成验证"], verification: "状态已验证" };
    case "action_failed": return { status: "未完成", cause: ["家庭连接完成了动作尝试", "当前状态与目标不一致"], verification: "状态未达到目标" };
    case "action_unknown": return { status: "结果待确认", cause: ["家庭连接完成了动作尝试", "当前状态正在重新确认"], verification: "结果待确认" };
    case "undo_requested": return { status: "正在撤销", cause: ["家庭成员在撤销窗口内发起撤销", "反向动作进入权限检查"] };
    case "undo_completed": return { status: "已撤销", cause: ["反向动作执行完成", "当前状态读回完成验证"], verification: "撤销已验证" };
    case "undo_failed": return { status: "撤销未完成", cause: ["反向动作完成了执行尝试", "当前状态与撤销目标不一致"], verification: "撤销结果未验证" };
  }
}
