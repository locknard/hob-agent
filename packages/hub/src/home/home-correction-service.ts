import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  FileHomeCorrectionStore,
  type HomeCorrectionAuditRecord,
  type HomeCorrectionReservation,
  type HomeCorrectionStore,
  type HomeCorrectionType,
} from "./home-correction-store.js";
import type { ProposalCreationResult } from "./proposal-store.js";
import type { CreateHomeProposalDraftInput } from "./home-proposal-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeCorrection: HomeCorrectionService;
  }
}

export type { HomeCorrectionAuditRecord, HomeCorrectionType } from "./home-correction-store.js";
export { FileHomeCorrectionStore, InMemoryHomeCorrectionStore } from "./home-correction-store.js";

export type HomeCorrectionActorRole = "admin" | "adult_member" | "member" | "child" | "guest";

export interface HomeCorrectionActor {
  readonly principalId: string;
  readonly role: HomeCorrectionActorRole;
  readonly present: boolean;
  readonly device: {
    readonly kind: "private" | "shared";
    readonly boundPrincipalId?: string;
  };
}

export interface HomeCorrectionCommand {
  readonly adviceId: string;
  readonly actor: HomeCorrectionActor;
  readonly correctionType: HomeCorrectionType;
  readonly correction: string;
  readonly idempotencyKey: string;
}

export interface HomeCorrectionAdvicePort {
  get(id: string): { readonly status: string } | undefined;
}

export interface HomeCorrectionProposalPort {
  createDraftGoverned(input: CreateHomeProposalDraftInput): Promise<ProposalCreationResult>;
  list?(): readonly unknown[];
  proposalCapacity?(): { readonly used: number; readonly max: number; readonly available: number };
}

export interface HomeCorrectionUpdatedResult {
  readonly status: "updated";
  readonly correctionId: string;
  readonly adviceId: string;
  readonly correctionType: "household_fact" | "household_preference";
  readonly message: "已更新";
  readonly destination: "MEMORY.md#household-facts" | "SOUL.md#household-preferences";
}

export interface HomeCorrectionProposalResult {
  readonly status: "proposal_created";
  readonly correctionId: string;
  readonly adviceId: string;
  readonly correctionType: "future_behavior";
  readonly message: "已更新";
  readonly destination: "处理中心 · 给家的建议";
  readonly proposalId: string;
  readonly proposalCount: number;
}

export type HomeCorrectionResult = HomeCorrectionUpdatedResult | HomeCorrectionProposalResult;

const RESERVATION_LEASE_MS = 60_000;

export interface HomeCorrectionServiceOptions {
  readonly path?: string;
  readonly store?: HomeCorrectionStore & { close?: () => void };
  /** Explicit local home-template directory. The service never guesses this path. */
  readonly householdDirectory?: string;
  readonly advice?: HomeCorrectionAdvicePort;
  readonly proposalOwner?: HomeCorrectionProposalPort;
  readonly now?: () => string;
}

export class HomeCorrectionError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_type"
      | "not_found"
      | "not_completed"
      | "permission_denied"
      | "workspace_unavailable"
      | "proposal_unavailable"
      | "conflict"
      | "persistence_failed",
    message: string,
  ) {
    super(message);
    this.name = "HomeCorrectionError";
  }
}

/** Hub owner for explicit post-conversation knowledge corrections. */
export class HomeCorrectionService extends Service {
  private readonly store: HomeCorrectionStore & { close?: () => void };
  private readonly householdDirectory: string | undefined;
  private readonly advice: HomeCorrectionAdvicePort | undefined;
  private readonly proposalOwner: HomeCorrectionProposalPort | undefined;
  private readonly now: () => string;
  private readonly reservationOwnerId = `correction-owner-${randomUUID()}`;
  private readonly inFlight = new Map<string, { readonly command: HomeCorrectionCommand; readonly promise: Promise<HomeCorrectionResult> }>();

  constructor(ctx: Context, options: HomeCorrectionServiceOptions) {
    super(ctx, "homeCorrection");
    if (options.store !== undefined && options.path !== undefined) {
      throw new TypeError("Home correction accepts a store or path, not both");
    }
    if (options.store === undefined && options.path === undefined) {
      throw new TypeError("Home correction requires a durable store path or explicit store");
    }
    this.store = options.store ?? new FileHomeCorrectionStore({ path: options.path! });
    this.householdDirectory = options.householdDirectory;
    this.advice = options.advice ?? asAdvice(ctx.get("homeAdvice"));
    this.proposalOwner = options.proposalOwner ?? asProposalOwner(ctx.get("homeProposals"));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-correction.close");
  }

  async submit(command: HomeCorrectionCommand): Promise<HomeCorrectionResult> {
    validateCommand(command);
    const advice = this.advice?.get(command.adviceId);
    if (advice === undefined) throw new HomeCorrectionError("not_found", "这条家庭对话不存在");
    if (advice.status !== "completed") throw new HomeCorrectionError("not_completed", "只有已完成的家庭对话可以提交纠正");
    assertActor(command.actor);

    const key = reservationKey(command.actor.principalId, command.idempotencyKey);
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      if (!sameCommand(running.command, command)) {
        throw new HomeCorrectionError("conflict", "这个幂等键已经绑定到另一条家庭纠正");
      }
      return running.promise;
    }
    const promise = this.submitReserved(command);
    this.inFlight.set(key, { command, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  private async submitReserved(command: HomeCorrectionCommand): Promise<HomeCorrectionResult> {
    const correctionId = correctionIdFor(command);
    const createdAt = timestamp(this.now);
    const claim = this.store.reserve({
      id: correctionId,
      adviceId: command.adviceId,
      actorId: command.actor.principalId,
      correctionType: command.correctionType,
      correction: command.correction,
      idempotencyKey: command.idempotencyKey,
      createdAt,
    }, this.reservationOwnerId, createdAt, RESERVATION_LEASE_MS);
    if (claim.status === "committed") return replayResult(claim.record, command);
    if (claim.status === "busy") {
      if (!sameReservation(claim.reservation, command)) {
        throw new HomeCorrectionError("conflict", "这个幂等键已经绑定到另一条家庭纠正");
      }
      throw new HomeCorrectionError("persistence_failed", "另一项相同纠正正在保存，稍后重试即可恢复");
    }
    const reservedCreatedAt = claim.reservation.createdAt;

    if (command.correctionType === "future_behavior") {
      const result = await this.createProposal(command, correctionId);
      const record: HomeCorrectionAuditRecord = {
        id: correctionId,
        adviceId: command.adviceId,
        actorId: command.actor.principalId,
        correctionType: command.correctionType,
        correction: command.correction,
        idempotencyKey: command.idempotencyKey,
        outcome: "proposal_created",
        destination: "处理中心 · 给家的建议",
        proposalId: result.proposalId,
        proposalCount: result.proposalCount,
        createdAt: reservedCreatedAt,
      };
      return this.completeAudit(record, command);
    }

    if (this.householdDirectory === undefined || this.householdDirectory.trim() === "") {
      throw new HomeCorrectionError("workspace_unavailable", "家庭知识目录尚未配置，纠正保持未写入");
    }

    const destination = command.correctionType === "household_fact"
      ? "MEMORY.md#household-facts" as const
      : "SOUL.md#household-preferences" as const;
    const file = command.correctionType === "household_fact" ? "MEMORY.md" : "SOUL.md";
    const section = command.correctionType === "household_fact" ? "household-facts" : "household-preferences";
    writeCorrectionSection(this.householdDirectory, file, section, correctionId, command.correction, reservedCreatedAt, command.adviceId);
    const record: HomeCorrectionAuditRecord = {
      id: correctionId,
      adviceId: command.adviceId,
      actorId: command.actor.principalId,
      correctionType: command.correctionType,
      correction: command.correction,
      idempotencyKey: command.idempotencyKey,
      outcome: "updated",
      destination,
      createdAt: reservedCreatedAt,
    };
    return this.completeAudit(record, command);
  }

  acknowledgementForAdvice(adviceId: string, actorId: string): HomeCorrectionResult | undefined {
    if (!boundedId(adviceId) || !boundedId(actorId)) return undefined;
    const record = this.store.findLatestForAdvice(adviceId, actorId);
    return record === undefined ? undefined : resultFromRecord(record);
  }

  listAudit(): readonly HomeCorrectionAuditRecord[] {
    return this.store.listAudit();
  }

  close(): void {
    this.store.close?.();
  }

  private async createProposal(command: HomeCorrectionCommand, correctionId: string): Promise<{ proposalId: string; proposalCount: number }> {
    if (this.proposalOwner === undefined) {
      throw new HomeCorrectionError("proposal_unavailable", "家庭建议服务尚未就绪，纠正保持未提交");
    }
    const capacity = this.proposalOwner.proposalCapacity?.();
    if (capacity !== undefined && (!Number.isSafeInteger(capacity.available) || capacity.available <= 0)) {
      throw new HomeCorrectionError("proposal_unavailable", "给家的建议已经达到处理上限，纠正保持未提交");
    }
    const input: CreateHomeProposalDraftInput = {
      kind: "household-insight",
      title: `家庭行为偏好：${command.correction.slice(0, 96)}`,
      summary: command.correction,
      dedupKey: `correction:${hash(command.correction)}`,
      idempotencyKey: `conversation-correction:${command.adviceId}:${command.idempotencyKey}`,
      provenance: { producer: "hob-conversation-correction", sessionId: command.actor.principalId },
      selectedHwIds: [],
      risk: { level: "low", reasons: ["纠正只创建持久建议，不直接改变家庭行为。"] },
      intent: {
        type: "future_behavior",
        description: command.correction,
        rollback: "在处理中心拒绝或让建议自然过期。",
      },
      rationale: {
        householdValue: "让后续建议符合家庭成员明确表达的偏好。",
        whyNow: "家庭成员刚刚在已完成对话中提交了明确纠正。",
        uncertainties: ["这项偏好仍需家庭在处理中心确认后才会形成长期行为。"],
      },
    };
    let created: ProposalCreationResult;
    try {
      created = await this.proposalOwner.createDraftGoverned(input);
    } catch {
      throw new HomeCorrectionError("proposal_unavailable", "家庭建议没有完成保存，家庭行为保持原样");
    }
    if (created.kind === "suppressed") {
      throw new HomeCorrectionError("proposal_unavailable", "这类家庭建议已被家庭成员停止提示");
    }
    if (created.kind === "capacity_full") {
      throw new HomeCorrectionError("proposal_unavailable", "给家的建议已经达到处理上限，纠正保持未提交");
    }
    const proposalCount = this.proposalOwner.proposalCapacity?.().used
      ?? this.proposalOwner.list?.().length
      ?? 1;
    return { proposalId: created.proposal.id, proposalCount };
  }

  private completeAudit(record: HomeCorrectionAuditRecord, command: HomeCorrectionCommand): HomeCorrectionResult {
    try {
      return replayResult(this.store.complete(this.reservationOwnerId, record), command);
    } catch (error) {
      if (error instanceof HomeCorrectionError) throw error;
      throw new HomeCorrectionError("persistence_failed", "纠正记录没有完成保存，家庭状态保持原样");
    }
  }
}

function validateCommand(command: HomeCorrectionCommand): void {
  if (!command || typeof command !== "object") throw invalidInput();
  if (!boundedId(command.adviceId) || !boundedId(command.idempotencyKey)) throw invalidInput();
  if (!isCorrectionType(command.correctionType)) throw new HomeCorrectionError("invalid_type", "请选择家庭事实、家庭偏好或未来行为");
  if (!boundedCorrection(command.correction)) throw invalidInput();
}

function assertActor(actor: HomeCorrectionActor): void {
  if (!actor || typeof actor !== "object"
    || !boundedId(actor.principalId)
    || actor.present !== true
    || (actor.role !== "admin" && actor.role !== "adult_member")
    || actor.device?.kind !== "private"
    || actor.device.boundPrincipalId !== actor.principalId) {
    throw new HomeCorrectionError("permission_denied", "纠正需要在场的成年成员和已绑定私人设备");
  }
}

function replayResult(record: HomeCorrectionAuditRecord, command: HomeCorrectionCommand): HomeCorrectionResult {
  if (record.adviceId !== command.adviceId
    || record.correctionType !== command.correctionType
    || record.correction !== command.correction) {
    throw new HomeCorrectionError("conflict", "这个幂等键已经绑定到另一条家庭纠正");
  }
  return resultFromRecord(record);
}

function reservationKey(actorId: string, idempotencyKey: string): string {
  return `${actorId}\u0000${idempotencyKey}`;
}

function sameCommand(left: HomeCorrectionCommand, right: HomeCorrectionCommand): boolean {
  return left.adviceId === right.adviceId
    && left.correctionType === right.correctionType
    && left.correction === right.correction;
}

function sameReservation(reservation: HomeCorrectionReservation, command: HomeCorrectionCommand): boolean {
  return reservation.adviceId === command.adviceId
    && reservation.actorId === command.actor.principalId
    && reservation.correctionType === command.correctionType
    && reservation.correction === command.correction
    && reservation.idempotencyKey === command.idempotencyKey;
}

function resultFromRecord(record: HomeCorrectionAuditRecord): HomeCorrectionResult {
  if (record.outcome === "proposal_created" && record.proposalId !== undefined && record.proposalCount !== undefined) {
    return {
      status: "proposal_created",
      correctionId: record.id,
      adviceId: record.adviceId,
      correctionType: "future_behavior",
      message: "已更新",
      destination: "处理中心 · 给家的建议",
      proposalId: record.proposalId,
      proposalCount: record.proposalCount,
    };
  }
  if (record.correctionType !== "household_fact" && record.correctionType !== "household_preference") {
    throw new HomeCorrectionError("persistence_failed", "纠正记录缺少有效的家庭建议结果");
  }
  return {
    status: "updated",
    correctionId: record.id,
    adviceId: record.adviceId,
    correctionType: record.correctionType,
    message: "已更新",
    destination: record.destination as HomeCorrectionUpdatedResult["destination"],
  };
}

function writeCorrectionSection(
  directory: string | undefined,
  filename: "MEMORY.md" | "SOUL.md",
  section: string,
  correctionId: string,
  correction: string,
  createdAt: string,
  adviceId: string,
): void {
  if (directory === undefined || directory.trim() === "") {
    throw new HomeCorrectionError("workspace_unavailable", "家庭知识目录尚未配置，纠正保持未写入");
  }
  let directoryStat: ReturnType<typeof lstatSync>;
  try {
    directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("directory");
  } catch {
    throw new HomeCorrectionError("workspace_unavailable", "家庭知识目录当前不可用，纠正保持未写入");
  }
  const path = join(directory, filename);
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("symlink");
  } catch {
    throw new HomeCorrectionError("workspace_unavailable", "家庭知识文件当前不可用，纠正保持未写入");
  }
  let original = "";
  try {
    original = existsSync(path) ? readFileSync(path, "utf8") : `# ${filename.slice(0, -3)}\n`;
  } catch {
    throw new HomeCorrectionError("workspace_unavailable", "家庭知识文件当前不可读，纠正保持未写入");
  }
  if (original.length > 256_000) throw new HomeCorrectionError("workspace_unavailable", "家庭知识文件超出可安全更新的范围");
  const start = `<!-- hob-corrections:${section} -->`;
  const end = `<!-- /hob-corrections:${section} -->`;
  const marker = `<!-- hob-correction-id:${correctionId} -->`;
  if (original.includes(marker)) return;
  const entry = `${marker}\n- ${createdAt} · 对话 ${adviceId} · ${correction.replace(/\r?\n/g, " ")}\n`;
  const startIndex = original.indexOf(start);
  const endIndex = original.indexOf(end, startIndex < 0 ? 0 : startIndex + start.length);
  const next = startIndex >= 0 && endIndex > startIndex
    ? `${original.slice(0, endIndex)}${entry}${original.slice(endIndex)}`
    : `${original.trimEnd()}\n\n${start}\n${entry}${end}\n`;
  const temporary = `${path}.${correctionId}.hob-tmp`;
  try {
    writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    try { unlinkSync(temporary); } catch { /* preserve the write failure */ }
    throw new HomeCorrectionError("workspace_unavailable", "家庭知识文件没有完成原子更新，纠正保持未写入");
  }
}

function asAdvice(value: unknown): HomeCorrectionAdvicePort | undefined {
  return isRecord(value) && typeof value.get === "function" ? value as unknown as HomeCorrectionAdvicePort : undefined;
}

function asProposalOwner(value: unknown): HomeCorrectionProposalPort | undefined {
  return isRecord(value) && typeof value.createDraftGoverned === "function" ? value as unknown as HomeCorrectionProposalPort : undefined;
}

function correctionIdFor(command: HomeCorrectionCommand): string {
  return `correction-${hash(`${command.actor.principalId}\u0000${command.adviceId}\u0000${command.idempotencyKey}`)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function timestamp(now: () => string): string {
  const value = now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new HomeCorrectionError("persistence_failed", "纠正时间不可用，纠正保持未保存");
  }
  return value;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 200;
}

function boundedCorrection(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length >= 1
    && value.length <= 2_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isCorrectionType(value: unknown): value is HomeCorrectionType {
  return value === "household_fact" || value === "household_preference" || value === "future_behavior";
}

function invalidInput(): HomeCorrectionError {
  return new HomeCorrectionError("invalid_input", "纠正内容需要包含对话、分类、说明和幂等键");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
