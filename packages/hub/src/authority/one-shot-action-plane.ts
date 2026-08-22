import { randomUUID } from "node:crypto";

import type { BridgeActionResult } from "@hob/bridge-contract";
import {
  InMemoryOneShotActionStore,
  SqliteOneShotActionStore,
  type OneShotActionStore,
  type OneShotActionStoreState,
} from "./one-shot-action-store.js";

export { InMemoryOneShotActionStore, SqliteOneShotActionStore } from "./one-shot-action-store.js";
export type { OneShotActionStore, OneShotActionStoreState } from "./one-shot-action-store.js";

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const DEFAULT_CONFIRMATION_TTL_MS = 10_000;
const DEFAULT_ADMINISTRATOR_TTL_MS = 30_000;
const MAX_RUNTIME_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_VERIFICATION_WINDOW_MS = 3_000;
const DEFAULT_VERIFICATION_POLL_MS = 50;
const DEFAULT_MAX_VERIFICATION_READS = 3;
const DEFAULT_UNDO_WINDOW_MS = 10_000;

export type OneShotAction =
  | { readonly kind: "set_boolean"; readonly value: boolean }
  | { readonly kind: "set_level"; readonly level: number }
  | {
      readonly kind: "play_media";
      readonly mediaRef: string;
      readonly queueMode: "replace_and_play" | "play_next" | "add_to_queue";
    }
  | { readonly kind: "stop_media" };

export type OneShotActionValue = boolean | number | string | null;

export interface OneShotActionActor {
  readonly principalId: string;
  readonly role: "admin" | "adult_member" | "member" | "child" | "guest";
  readonly present: boolean;
  readonly device: {
    readonly kind: "private" | "shared";
    readonly boundPrincipalId?: string;
  };
}

export type OneShotActionRead =
  | {
      readonly status: "available";
      readonly value: OneShotActionValue;
      readonly observedAt: string;
      /** A state without a fresh marker is accepted as fresh by the gateway seam. */
      readonly fresh?: boolean;
    }
  | {
      readonly status: "unavailable" | "unknown";
      readonly reason: string;
    };

export interface OneShotActionGateway {
  readState(input: {
    readonly capabilityId: string;
    readonly signal: AbortSignal;
    readonly action?: OneShotAction;
  }): Promise<OneShotActionRead>;
  execute(input: {
    readonly ticketId: string;
    readonly requestId: string;
    readonly capabilityId: string;
    readonly action: OneShotAction;
    readonly signal: AbortSignal;
  }): Promise<BridgeActionResult>;
}

export interface OneShotActionPolicyInput {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly action: OneShotAction;
  readonly actor: OneShotActionActor;
  readonly before?: OneShotActionRead & { readonly status: "available" };
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
  readonly undoOf?: string;
}

export type OneShotActionPolicyDecision =
  | {
      readonly status: "allowed";
      readonly policyClass: "direct" | "confirmation" | "administrator";
      readonly reversible: boolean;
      readonly ttlMs?: number;
    }
  | {
      readonly status: "denied";
      readonly policyClass: "direct" | "confirmation" | "administrator";
      readonly reversible?: boolean;
      readonly reason: string;
    };

export interface OneShotActionPolicy {
  evaluate(input: OneShotActionPolicyInput): OneShotActionPolicyDecision | Promise<OneShotActionPolicyDecision>;
}

export type OneShotActionTicketStatus =
  | "pending_confirmation"
  | "approved"
  | "executing"
  | "verified"
  | "failed"
  | "unknown"
  | "rejected"
  | "expired";

export type OneShotActionUndoStatus = "available" | "pending" | "consumed" | "failed" | "expired";

export interface OneShotActionTicket {
  readonly id: string;
  readonly requestId: string;
  readonly capabilityId: string;
  readonly summary?: string;
  readonly action: OneShotAction;
  readonly policyClass: "direct" | "confirmation" | "administrator";
  readonly reversible: boolean;
  readonly status: OneShotActionTicketStatus;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly initiator: OneShotActionActor;
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
  readonly beforeValue?: OneShotActionValue;
  readonly afterValue?: OneShotActionValue;
  readonly inverseAction?: OneShotAction;
  readonly resultReason?: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  /** The kind of device the deciding member used, for the audit trail. */
  readonly decidedVia?: "private" | "shared";
  readonly rejectedAt?: string;
  readonly rejectedBy?: string;
  readonly undoExpiresAt?: string;
  readonly undoStatus?: OneShotActionUndoStatus;
  readonly undoOf?: string;
  readonly undoTicketId?: string;
}

export interface OneShotActionUndo {
  readonly status: "available";
  readonly ticketId: string;
  readonly expiresAt: string;
  readonly inverseAction: OneShotAction;
}

export interface OneShotActionResult {
  readonly status: OneShotActionTicketStatus;
  readonly ticket: OneShotActionTicket;
  readonly reason?: string;
  readonly undo?: OneShotActionUndo;
}

export type OneShotActionDecisionResult =
  | OneShotActionResult
  | {
      readonly status: "denied";
      readonly reason: "not_found" | "expired" | "unauthorized" | "already_decided";
      readonly ticket?: OneShotActionTicket;
    };

export type OneShotActionActivityKind =
  | "action_requested"
  | "confirmation_created"
  | "confirmation_approved"
  | "confirmation_rejected"
  | "confirmation_expired"
  | "action_executing"
  | "action_verified"
  | "action_failed"
  | "action_unknown"
  | "undo_requested"
  | "undo_completed"
  | "undo_failed";

export interface OneShotActionActivity {
  readonly id: string;
  readonly kind: OneShotActionActivityKind;
  readonly at: string;
  readonly ticketId: string;
  readonly requestId: string;
  readonly capabilityId: string;
  readonly outcome?: OneShotActionTicketStatus;
  readonly reason?: string;
  readonly actorId?: string;
  /** The kind of device the decision came from, when the activity is a decision. */
  readonly via?: "private" | "shared";
  readonly relatedTicketId?: string;
}

export interface OneShotActionRequest {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly summary?: string;
  readonly action: OneShotAction;
  readonly actor: OneShotActionActor;
  readonly signal?: AbortSignal;
  readonly source?: "member" | "hob" | "system" | "external-rule" | "unknown";
  readonly undoOf?: string;
}

export interface OneShotActionPlaneOptions {
  readonly gateway: OneShotActionGateway;
  readonly policy: OneShotActionPolicy;
  readonly store?: OneShotActionStore;
  readonly now?: () => string | number | Date;
  readonly idFactory?: () => string;
  readonly verificationWindowMs?: number;
  readonly verificationPollMs?: number;
  readonly maxVerificationReads?: number;
  readonly undoWindowMs?: number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface MutableState {
  tickets: OneShotActionTicket[];
  activities: OneShotActionActivity[];
  expirySummaryCursor: number;
}

/**
 * Hub-owned state machine for short-lived, one-shot household actions.
 *
 * The gateway is deliberately neutral: a HomeWorld adapter can forward its
 * execute call to `executeOneShotAction`, while a read-side projection supplies
 * a fresh value for the bounded postcondition check. The plane owns every
 * authority transition and persists a ticket before any remote write starts.
 */
export class OneShotActionPlane {
  private readonly gateway: OneShotActionGateway;
  private readonly policy: OneShotActionPolicy;
  private readonly store: OneShotActionStore;
  private readonly now: () => string | number | Date;
  private readonly idFactory: () => string;
  private readonly verificationWindowMs: number;
  private readonly verificationPollMs: number;
  private readonly maxVerificationReads: number;
  private readonly undoWindowMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly inFlightByRequestId = new Map<string, Promise<OneShotActionResult>>();
  private state: MutableState;

  constructor(options: OneShotActionPlaneOptions) {
    this.gateway = options.gateway;
    this.policy = options.policy;
    this.store = options.store ?? new InMemoryOneShotActionStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.verificationWindowMs = positiveInteger(options.verificationWindowMs ?? DEFAULT_VERIFICATION_WINDOW_MS, "verification window");
    this.verificationPollMs = positiveInteger(options.verificationPollMs ?? DEFAULT_VERIFICATION_POLL_MS, "verification poll");
    this.maxVerificationReads = positiveInteger(options.maxVerificationReads ?? DEFAULT_MAX_VERIFICATION_READS, "verification reads");
    this.undoWindowMs = positiveInteger(options.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS, "undo window");
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("action cancelled"));
        return;
      }
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("action cancelled"));
      }, { once: true });
    }));
    const stored = this.store.load();
    this.state = stored === undefined
      ? { tickets: [], activities: [], expirySummaryCursor: 0 }
      : {
          tickets: stored.tickets as unknown as OneShotActionTicket[],
          activities: stored.activities as unknown as OneShotActionActivity[],
          expirySummaryCursor: stored.expirySummaryCursor ?? 0,
        };
    if (this.state.tickets.some((ticket) => ticket.status === "approved" || ticket.status === "executing")) {
      this.commit((draft) => {
        for (let index = 0; index < draft.tickets.length; index += 1) {
          const ticket = draft.tickets[index]!;
          if (ticket.status !== "approved" && ticket.status !== "executing") continue;
          const interrupted: OneShotActionTicket = {
            ...ticket,
            status: "unknown",
            resultReason: "interrupted_before_verification",
          };
          draft.tickets[index] = interrupted;
          this.recordActivity(draft, interrupted, "action_unknown");
        }
      });
    }
  }

  async request(input: OneShotActionRequest): Promise<OneShotActionResult> {
    const requestId = boundedText(input?.requestId, "action request id", MAX_ID_LENGTH);
    const capabilityId = boundedText(input?.capabilityId, "action capability id", MAX_ID_LENGTH);
    const summary = input.summary === undefined ? undefined : boundedText(input.summary, "action summary", MAX_TEXT_LENGTH);
    const action = validateAction(input?.action);
    const actor = validateActor(input?.actor);
    this.expireDue();
    const existing = this.state.tickets.find((ticket) => ticket.requestId === requestId);
    if (existing !== undefined) return this.resultFor(existing);

    const inFlight = this.inFlightByRequestId.get(requestId);
    if (inFlight !== undefined) return inFlight;
    const run = this.requestNew({
      ...input,
      requestId,
      capabilityId,
      ...(summary === undefined ? {} : { summary }),
      action,
      actor,
    });
    this.inFlightByRequestId.set(requestId, run);
    try {
      return await run;
    } finally {
      if (this.inFlightByRequestId.get(requestId) === run) this.inFlightByRequestId.delete(requestId);
    }
  }

  private async requestNew(
    input: OneShotActionRequest,
  ): Promise<OneShotActionResult> {
    const requestId = input.requestId;
    const capabilityId = input.capabilityId;
    const action = input.action;
    const actor = input.actor;
    const signal = input.signal ?? new AbortController().signal;
    const before = await this.readFresh(capabilityId, signal, action);
    const decision = await this.evaluatePolicy({
      requestId,
      capabilityId,
      action,
      actor,
      ...(before === undefined ? {} : { before }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.undoOf === undefined ? {} : { undoOf: input.undoOf }),
    });
    const requestedAt = this.timestamp();
    const inverseAction = before === undefined ? undefined : deriveInverse(action, before.value);
    const ticket: OneShotActionTicket = {
      id: this.nextId("action ticket"),
      requestId,
      capabilityId,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      action,
      policyClass: decision.policyClass,
      reversible: decision.status === "allowed" && decision.reversible && inverseAction !== undefined,
      status: "approved",
      requestedAt,
      initiator: actor,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(before === undefined ? {} : { beforeValue: before.value }),
      ...(inverseAction === undefined ? {} : { inverseAction }),
      ...(input.undoOf === undefined ? {} : { undoOf: input.undoOf }),
    };
    this.commit((draft) => {
      draft.tickets.push(ticket);
      this.recordActivity(draft, ticket, "action_requested");
    });

    if (before === undefined) {
      return this.finish(ticket.id, "unknown", "initial_state_unavailable");
    }
    if (decision.status === "denied") {
      return this.finish(ticket.id, "failed", decision.reason);
    }
    if (decision.policyClass === "direct" && !actor.present) {
      return this.finish(ticket.id, "failed", "present_person_required");
    }
    if (decision.policyClass !== "direct") {
      const ttlMs = decision.ttlMs
        ?? (decision.policyClass === "administrator" ? DEFAULT_ADMINISTRATOR_TTL_MS : DEFAULT_CONFIRMATION_TTL_MS);
      const expiresAt = new Date(Date.parse(requestedAt) + boundedDuration(ttlMs, "confirmation TTL")).toISOString();
      const pending = this.updateTicket(ticket.id, (current) => ({
        ...current,
        status: "pending_confirmation",
        expiresAt,
      }));
      this.appendActivity(ticket.id, "confirmation_created");
      return this.resultFor(pending);
    }
    return this.executeTicket(ticket.id, signal);
  }

  async approve(input: {
    readonly ticketId: string;
    readonly actor: OneShotActionActor;
    readonly signal?: AbortSignal;
  }): Promise<OneShotActionDecisionResult> {
    const ticketId = boundedText(input?.ticketId, "action ticket id", MAX_ID_LENGTH);
    const actor = validateActor(input?.actor);
    const ticket = this.state.tickets.find((item) => item.id === ticketId);
    if (ticket === undefined) return { status: "denied", reason: "not_found" };
    if (ticket.status === "pending_confirmation" && this.isExpired(ticket)) {
      const expired = this.expireTicket(ticket.id);
      return { status: "denied", reason: "expired", ticket: expired };
    }
    if (ticket.status !== "pending_confirmation") {
      return {
        status: "denied",
        reason: ticket.status === "expired" ? "expired" : "already_decided",
        ticket: this.cloneTicket(ticket),
      };
    }
    if (!isEligible(actor)) {
      return { status: "denied", reason: "unauthorized", ticket: this.cloneTicket(ticket) };
    }
    const approved = this.decideTicket(ticket.id, actor, "approved");
    return this.executeTicket(approved.id, input.signal ?? new AbortController().signal);
  }

  canApprove(ticketId: string, actor: OneShotActionActor): boolean {
    const normalizedTicketId = boundedText(ticketId, "action ticket id", MAX_ID_LENGTH);
    const normalizedActor = validateActor(actor);
    const ticket = this.state.tickets.find((item) => item.id === normalizedTicketId);
    return ticket?.status === "pending_confirmation"
      && !this.isExpired(ticket)
      && isEligible(normalizedActor);
  }

  reject(input: {
    readonly ticketId: string;
    readonly actor: OneShotActionActor;
  }): OneShotActionDecisionResult {
    const ticketId = boundedText(input?.ticketId, "action ticket id", MAX_ID_LENGTH);
    const actor = validateActor(input?.actor);
    const ticket = this.state.tickets.find((item) => item.id === ticketId);
    if (ticket === undefined) return { status: "denied", reason: "not_found" };
    if (ticket.status === "pending_confirmation" && this.isExpired(ticket)) {
      const expired = this.expireTicket(ticket.id);
      return { status: "denied", reason: "expired", ticket: expired };
    }
    if (ticket.status !== "pending_confirmation") {
      return {
        status: "denied",
        reason: ticket.status === "expired" ? "expired" : "already_decided",
        ticket: this.cloneTicket(ticket),
      };
    }
    if (!canRejectFrom(actor)) {
      return { status: "denied", reason: "unauthorized", ticket: this.cloneTicket(ticket) };
    }
    const rejected = this.decideTicket(ticket.id, actor, "rejected");
    return this.resultFor(rejected, "rejected_by_actor");
  }

  expireDue(): readonly OneShotActionTicket[] {
    const due = this.state.tickets.filter((ticket) => ticket.status === "pending_confirmation" && this.isExpired(ticket));
    return due.map((ticket) => this.expireTicket(ticket.id));
  }

  async undo(input: {
    readonly ticketId: string;
    readonly actor: OneShotActionActor;
    readonly signal?: AbortSignal;
  }): Promise<OneShotActionResult> {
    const ticketId = boundedText(input?.ticketId, "action ticket id", MAX_ID_LENGTH);
    const actor = validateActor(input?.actor);
    const ticket = this.state.tickets.find((item) => item.id === ticketId);
    if (ticket === undefined) return this.syntheticResult(ticketId, "failed", "not_found");
    if (ticket.status !== "verified" || ticket.inverseAction === undefined || ticket.undoExpiresAt === undefined) {
      return this.resultFor(ticket, "undo_unavailable");
    }
    if (ticket.undoStatus !== "available" || Date.parse(ticket.undoExpiresAt) <= this.currentTimeMs()) {
      if (ticket.undoStatus === "available") this.updateTicket(ticket.id, (current) => ({ ...current, undoStatus: "expired" }));
      return this.resultFor(
        this.state.tickets.find((item) => item.id === ticket.id) ?? ticket,
        "undo_expired",
        "failed",
      );
    }
    this.appendActivity(ticket.id, "undo_requested", actor.principalId);
    const signal = input.signal ?? new AbortController().signal;
    const latest = await this.readFresh(ticket.capabilityId, signal, ticket.inverseAction);
    if (latest === undefined) {
      const failedUndo = this.updateTicket(ticket.id, (current) => ({ ...current, undoStatus: "failed" }));
      this.appendActivity(ticket.id, "undo_failed", actor.principalId, "latest_state_unavailable");
      return this.resultFor(failedUndo, "latest_state_unavailable", "unknown");
    }
    if (ticket.afterValue !== undefined && !valuesMatch(latest.value, ticket.afterValue, ticket.action)) {
      const failedUndo = this.updateTicket(ticket.id, (current) => ({ ...current, undoStatus: "failed" }));
      this.appendActivity(ticket.id, "undo_failed", actor.principalId, "state_changed");
      return this.resultFor(failedUndo, "state_changed", "failed");
    }
    const inverseRequestId = this.nextId("undo request");
    const result = await this.request({
      requestId: inverseRequestId,
      capabilityId: ticket.capabilityId,
      action: ticket.inverseAction,
      actor,
      signal,
      source: "member",
      undoOf: ticket.id,
    });
    if (result.status === "verified") {
      this.updateTicket(ticket.id, (current) => ({
        ...current,
        undoStatus: "consumed",
        undoTicketId: result.ticket.id,
      }));
      this.appendActivity(ticket.id, "undo_completed", actor.principalId, undefined, result.ticket.id);
    } else if (result.status === "pending_confirmation") {
      this.updateTicket(ticket.id, (current) => ({
        ...current,
        undoStatus: "pending",
        undoTicketId: result.ticket.id,
      }));
    } else {
      this.updateTicket(ticket.id, (current) => ({ ...current, undoStatus: "failed", undoTicketId: result.ticket.id }));
      this.appendActivity(ticket.id, "undo_failed", actor.principalId, result.reason ?? result.status, result.ticket.id);
    }
    return result;
  }

  getTicket(id: string): OneShotActionTicket | undefined {
    const ticket = this.state.tickets.find((item) => item.id === boundedText(id, "action ticket id", MAX_ID_LENGTH));
    return ticket === undefined ? undefined : this.cloneTicket(ticket);
  }

  listTickets(): readonly OneShotActionTicket[] {
    this.expireDue();
    return this.state.tickets.map((ticket) => this.cloneTicket(ticket));
  }

  activities(): readonly OneShotActionActivity[] {
    this.expireDue();
    return this.state.activities.map((activity) => ({ ...activity }));
  }

  consumeExpiredSummary(): { readonly count: number; readonly ticketIds: readonly string[] } | undefined {
    this.expireDue();
    const expired = this.state.activities
      .slice(this.state.expirySummaryCursor)
      .filter((activity) => activity.kind === "confirmation_expired");
    if (this.state.expirySummaryCursor !== this.state.activities.length) {
      this.commit((draft) => { draft.expirySummaryCursor = draft.activities.length; });
    }
    return expired.length === 0
      ? undefined
      : { count: expired.length, ticketIds: expired.map((activity) => activity.ticketId) };
  }

  private async executeTicket(ticketId: string, signal: AbortSignal): Promise<OneShotActionResult> {
    const current = this.state.tickets.find((item) => item.id === ticketId);
    if (current === undefined) return this.syntheticResult(ticketId, "failed", "not_found");
    if (current.status !== "approved") return this.resultFor(current);
    if (await this.readFresh(current.capabilityId, signal, current.action) === undefined) {
      return this.finish(ticketId, "unknown", "execution_state_unavailable");
    }
    const executing = this.updateTicket(ticketId, (ticket) => ({ ...ticket, status: "executing" }));
    this.appendActivity(executing.id, "action_executing");
    let bridgeResult: BridgeActionResult;
    try {
      bridgeResult = await this.gateway.execute({
        ticketId: executing.id,
        requestId: executing.requestId,
        capabilityId: executing.capabilityId,
        action: executing.action,
        signal,
      });
    } catch {
      return this.finish(ticketId, "unknown", "bridge_execution_unknown");
    }
    if (bridgeResult.status === "rejected") return this.finish(ticketId, "failed", "bridge_rejected");
    if (bridgeResult.status === "unknown") return this.finish(ticketId, "unknown", "bridge_acknowledgement_unknown");
    const verification = await this.verify(executing, signal);
    return this.finish(ticketId, verification.status, verification.reason);
  }

  private async verify(
    ticket: OneShotActionTicket,
    signal: AbortSignal,
  ): Promise<{ readonly status: "verified" | "failed" | "unknown"; readonly reason: string }> {
    const expected = expectedValue(ticket.action);
    const deadline = this.currentTimeMs() + this.verificationWindowMs;
    let reads = 0;
    while (reads < this.maxVerificationReads) {
      if (reads > 0 && this.currentTimeMs() >= deadline) break;
      reads += 1;
      if (signal.aborted) return { status: "unknown", reason: "verification_cancelled" };
      let read: OneShotActionRead;
      try {
        read = await this.gateway.readState({ capabilityId: ticket.capabilityId, signal, action: ticket.action });
      } catch {
        read = { status: "unknown", reason: "read_back_failed" };
      }
      if (read.status === "available" && read.fresh !== false) {
        if (valuesMatch(read.value, expected, ticket.action)) return { status: "verified", reason: "verified" };
        return { status: "failed", reason: "postcondition_mismatch" };
      }
      if (reads >= this.maxVerificationReads || this.currentTimeMs() >= deadline) break;
      try {
        await this.sleep(Math.min(this.verificationPollMs, Math.max(1, deadline - this.currentTimeMs())), signal);
      } catch {
        return { status: "unknown", reason: "verification_cancelled" };
      }
    }
    return { status: "unknown", reason: "read_back_unavailable" };
  }

  private async readFresh(
    capabilityId: string,
    signal: AbortSignal,
    action?: OneShotAction,
  ): Promise<(OneShotActionRead & { readonly status: "available" }) | undefined> {
    if (signal.aborted) return undefined;
    try {
      const read = await this.gateway.readState({ capabilityId, signal, ...(action === undefined ? {} : { action }) });
      if (read.status !== "available" || read.fresh === false) return undefined;
      if (!Number.isFinite(Date.parse(read.observedAt))) return undefined;
      return read;
    } catch {
      return undefined;
    }
  }

  private async evaluatePolicy(input: OneShotActionPolicyInput): Promise<OneShotActionPolicyDecision> {
    try {
      const decision = await this.policy.evaluate(input);
      if (decision.status === "allowed") {
        if (decision.policyClass === "direct"
          && decision.reversible !== true
          && input.action.kind !== "play_media"
          && input.action.kind !== "stop_media") {
          return { status: "denied", policyClass: decision.policyClass, reason: "reversibility_policy_invalid" };
        }
        return decision;
      }
      return decision;
    } catch {
      return { status: "denied", policyClass: "direct", reason: "policy_unavailable" };
    }
  }

  private finish(ticketId: string, status: "verified" | "failed" | "unknown", reason: string): OneShotActionResult {
    const ticket = this.updateTicket(ticketId, (current) => ({
      ...current,
      status,
      resultReason: reason,
      ...(status === "verified"
        ? {
            afterValue: expectedValue(current.action),
            ...(current.reversible
              ? {
                  undoExpiresAt: new Date(this.currentTimeMs() + this.undoWindowMs).toISOString(),
                  undoStatus: "available" as const,
                }
              : {}),
          }
        : {}),
    }));
    this.appendActivity(ticket.id, status === "verified" ? "action_verified" : status === "failed" ? "action_failed" : "action_unknown", undefined, reason);
    return this.resultFor(ticket, reason);
  }

  private expireTicket(ticketId: string): OneShotActionTicket {
    const ticket = this.updateTicket(ticketId, (current) => ({
      ...current,
      status: "expired",
      resultReason: "confirmation_ttl_expired",
    }));
    this.appendActivity(ticket.id, "confirmation_expired", undefined, "confirmation_ttl_expired");
    return ticket;
  }

  private resultFor(ticket: OneShotActionTicket, reason?: string, forcedStatus?: OneShotActionTicketStatus): OneShotActionResult {
    const status = forcedStatus ?? ticket.status;
    const undo = status === "verified"
      && ticket.undoStatus === "available"
      && ticket.inverseAction !== undefined
      && ticket.undoExpiresAt !== undefined
      && Date.parse(ticket.undoExpiresAt) > this.currentTimeMs()
      ? {
          status: "available" as const,
          ticketId: ticket.id,
          expiresAt: ticket.undoExpiresAt,
          inverseAction: ticket.inverseAction,
        }
      : undefined;
    return {
      status,
      ticket: this.cloneTicket(ticket),
      ...(reason === undefined ? (ticket.resultReason === undefined ? {} : { reason: ticket.resultReason }) : { reason }),
      ...(undo === undefined ? {} : { undo }),
    };
  }

  private syntheticResult(ticketId: string, status: OneShotActionTicketStatus, reason: string): OneShotActionResult {
    return {
      status,
      ticket: {
        id: ticketId,
        requestId: ticketId,
        capabilityId: "unknown",
        action: { kind: "set_boolean", value: false },
        policyClass: "direct",
        reversible: false,
        status,
        requestedAt: this.timestamp(),
        initiator: {
          principalId: "unknown",
          role: "guest",
          present: false,
          device: { kind: "shared" },
        },
        resultReason: reason,
      },
      reason,
    };
  }

  private commit(mutator: (draft: MutableState) => void): void {
    const draft = cloneState(this.state);
    mutator(draft);
    this.persist(draft);
    this.state = draft;
  }

  /**
   * A decision and its activity are one fact: they commit in the same
   * persistence write and share one timestamp, so a crash can never leave a
   * decided ticket whose timeline is missing the decision.
   */
  private decideTicket(id: string, actor: OneShotActionActor, decision: "approved" | "rejected"): OneShotActionTicket {
    const current = this.state.tickets.find((ticket) => ticket.id === id);
    if (current === undefined) throw new Error("one-shot action ticket not found");
    const at = this.timestamp();
    const next: OneShotActionTicket = decision === "approved"
      ? { ...this.cloneTicket(current), status: "approved", approvedAt: at, approvedBy: actor.principalId, decidedVia: actor.device.kind }
      : { ...this.cloneTicket(current), status: "rejected", resultReason: "rejected_by_actor", rejectedAt: at, rejectedBy: actor.principalId, decidedVia: actor.device.kind };
    const activity: OneShotActionActivity = {
      id: this.nextId("action activity"),
      kind: decision === "approved" ? "confirmation_approved" : "confirmation_rejected",
      at,
      ticketId: next.id,
      requestId: next.requestId,
      capabilityId: next.capabilityId,
      outcome: next.status,
      actorId: actor.principalId,
      via: actor.device.kind,
      ...(decision === "rejected" ? { reason: "rejected_by_actor" } : {}),
    };
    this.commit((draft) => {
      const index = draft.tickets.findIndex((ticket) => ticket.id === id);
      if (index < 0) throw new Error("one-shot action ticket not found");
      draft.tickets[index] = next;
      draft.activities.push(activity);
    });
    return this.cloneTicket(next);
  }

  private updateTicket(id: string, update: (ticket: OneShotActionTicket) => OneShotActionTicket): OneShotActionTicket {
    const current = this.state.tickets.find((ticket) => ticket.id === id);
    if (current === undefined) throw new Error("one-shot action ticket not found");
    const next = update(this.cloneTicket(current));
    this.commit((draft) => {
      const index = draft.tickets.findIndex((ticket) => ticket.id === id);
      if (index < 0) throw new Error("one-shot action ticket not found");
      draft.tickets[index] = next;
    });
    return this.cloneTicket(next);
  }

  private appendActivity(
    ticketId: string,
    kind: OneShotActionActivityKind,
    actorId?: string,
    reason?: string,
    relatedTicketId?: string,
    via?: "private" | "shared",
  ): OneShotActionActivity {
    const ticket = this.state.tickets.find((item) => item.id === ticketId);
    if (ticket === undefined) throw new Error("one-shot action ticket not found");
    const activity: OneShotActionActivity = {
      id: this.nextId("action activity"),
      kind,
      at: this.timestamp(),
      ticketId: ticket.id,
      requestId: ticket.requestId,
      capabilityId: ticket.capabilityId,
      ...(ticket.status === "pending_confirmation" ? {} : { outcome: ticket.status }),
      ...(actorId === undefined ? {} : { actorId }),
      ...(via === undefined ? {} : { via }),
      ...(reason === undefined ? {} : { reason }),
      ...(relatedTicketId === undefined ? {} : { relatedTicketId }),
    };
    this.commit((draft) => {
      draft.activities.push(activity);
    });
    return { ...activity };
  }

  private recordActivity(draft: MutableState, ticket: OneShotActionTicket, kind: OneShotActionActivityKind): void {
    draft.activities.push({
      id: this.nextIdFromDraft(draft, "action activity"),
      kind,
      at: this.timestamp(),
      ticketId: ticket.id,
      requestId: ticket.requestId,
      capabilityId: ticket.capabilityId,
      ...(ticket.status === "pending_confirmation" ? {} : { outcome: ticket.status }),
    });
  }

  private nextId(label: string): string {
    return this.nextUniqueId(label, this.state);
  }

  private nextIdFromDraft(draft: MutableState, label: string): string {
    return this.nextUniqueId(label, draft);
  }

  private nextUniqueId(label: string, state: MutableState): string {
    const id = boundedText(this.idFactory(), `${label} id`, MAX_ID_LENGTH);
    const used = new Set([...state.tickets.map((ticket) => ticket.id), ...state.activities.map((activity) => activity.id)]);
    if (used.has(id)) throw new Error(`${label} id is already in use`);
    return id;
  }

  private isExpired(ticket: OneShotActionTicket): boolean {
    return ticket.expiresAt !== undefined && Date.parse(ticket.expiresAt) <= this.currentTimeMs();
  }

  private timestamp(): string {
    const value = this.now();
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("one-shot action clock returned an invalid timestamp");
    return date.toISOString();
  }

  private currentTimeMs(): number {
    return Date.parse(this.timestamp());
  }

  private cloneTicket(ticket: OneShotActionTicket): OneShotActionTicket {
    return JSON.parse(JSON.stringify(ticket)) as OneShotActionTicket;
  }

  private persist(state: MutableState): void {
    this.store.save({
      tickets: state.tickets as unknown as Record<string, unknown>[],
      activities: state.activities as unknown as Record<string, unknown>[],
      expirySummaryCursor: state.expirySummaryCursor,
    });
  }
}

function validateAction(value: unknown): OneShotAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("action is invalid");
  const action = value as Record<string, unknown>;
  if (action.kind === "set_boolean" && typeof action.value === "boolean") return { kind: "set_boolean", value: action.value };
  if (action.kind === "set_level" && typeof action.level === "number" && Number.isFinite(action.level) && action.level >= 0 && action.level <= 1) {
    return { kind: "set_level", level: action.level };
  }
  if (action.kind === "play_media"
    && typeof action.mediaRef === "string"
    && /^[A-Za-z0-9_-]{16,256}$/u.test(action.mediaRef)
    && (action.queueMode === "replace_and_play" || action.queueMode === "play_next" || action.queueMode === "add_to_queue")) {
    return { kind: "play_media", mediaRef: action.mediaRef, queueMode: action.queueMode };
  }
  if (action.kind === "stop_media") return { kind: "stop_media" };
  throw new TypeError("action is invalid");
}

function validateActor(value: OneShotActionActor): OneShotActionActor {
  const principalId = boundedText(value?.principalId, "actor principal", MAX_ID_LENGTH);
  if (!["admin", "adult_member", "member", "child", "guest"].includes(value?.role)) throw new TypeError("actor role is invalid");
  if (typeof value?.present !== "boolean") throw new TypeError("actor presence is invalid");
  if (value?.device?.kind !== "private" && value?.device?.kind !== "shared") throw new TypeError("actor device is invalid");
  const boundPrincipalId = value.device.boundPrincipalId === undefined
    ? undefined
    : boundedText(value.device.boundPrincipalId, "device binding", MAX_ID_LENGTH);
  return {
    principalId,
    role: value.role,
    present: value.present,
    device: { kind: value.device.kind, ...(boundPrincipalId === undefined ? {} : { boundPrincipalId }) },
  };
}

/**
 * DR-017: the household is one trust domain. Every pending confirmation —
 * confirmation class and the protected class (wire name `administrator`) —
 * is approved by a present member on a private device bound to themselves.
 * The policy class describes the action's consequence and disclosure; it
 * never changes who may confirm.
 */
function isEligible(actor: OneShotActionActor): boolean {
  return actor.present
    && actor.device.kind === "private"
    && actor.device.boundPrincipalId === actor.principalId;
}

/**
 * Rejection executes nothing and fails closed by itself, so any present
 * household entry — a shared wall panel included — may say no. The source
 * device still enters the record.
 */
function canRejectFrom(actor: OneShotActionActor): boolean {
  return actor.present;
}

function deriveInverse(action: OneShotAction, before: OneShotActionValue): OneShotAction | undefined {
  if (action.kind === "set_boolean" && typeof before === "boolean") return { kind: "set_boolean", value: before };
  if (action.kind === "set_level" && typeof before === "number" && Number.isFinite(before) && before >= 0 && before <= 1) {
    return { kind: "set_level", level: before };
  }
  if (action.kind === "play_media") return { kind: "stop_media" };
  return undefined;
}

function expectedValue(action: OneShotAction): OneShotActionValue {
  if (action.kind === "set_boolean") return action.value;
  if (action.kind === "set_level") return action.level;
  if (action.kind === "stop_media") return null;
  return action.mediaRef;
}

function valuesMatch(left: OneShotActionValue, right: OneShotActionValue, action: OneShotAction): boolean {
  if (action.kind === "set_level" && typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) <= 0.01;
  }
  return left === right;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function boundedDuration(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_RUNTIME_TTL_MS) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  return value;
}

function cloneState(state: MutableState): MutableState {
  const copy = JSON.parse(JSON.stringify(state)) as MutableState;
  return {
    tickets: [...copy.tickets],
    activities: [...copy.activities],
    expirySummaryCursor: copy.expirySummaryCursor,
  };
}
