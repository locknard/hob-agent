import { Context, Service } from "@deepseek-ai/cordis";

import type { HomeWorldSnapshot } from "./home-world-service.js";
import {
  type HomeSafetyStore,
  type HomeSafetyAlertRecord,
  type HomeSafetyKind,
  SqliteHomeSafetyStore,
} from "./home-safety-store.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeSafety: HomeSafetyService;
  }
}

export type HomeSafetyScalar = string | number | boolean | null;

/** Explicit Hub-owned binding. Device names and adapter labels have no role. */
export interface HomeSafetyBinding {
  readonly id: string;
  readonly hwCapabilityId: string;
  readonly kind: HomeSafetyKind;
  readonly title: string;
  readonly body?: string;
  readonly sourceLabel: string;
  readonly actionLabel?: string;
  readonly actionHref?: string;
  readonly stateAttribute: string;
  readonly activeValues: readonly HomeSafetyScalar[];
  readonly clearValues: readonly HomeSafetyScalar[];
}

export interface HomeSafetyWorldSource {
  snapshot(): HomeWorldSnapshot;
}

export interface HomeSafetyAlertProjection extends HomeSafetyAlertRecord {
  readonly title: string;
  readonly body?: string;
  readonly source: string;
  readonly actionLabel?: string;
  readonly actionHref?: string;
  readonly severity: "safety";
  readonly snoozeAllowed: false;
}

export interface HomeSafetySnapshot {
  readonly generatedAt: string;
  readonly alerts: readonly HomeSafetyAlertProjection[];
}

export interface HomeSafetyServiceOptions {
  readonly bindings?: readonly HomeSafetyBinding[];
  readonly path?: string;
  readonly store?: HomeSafetyStore & { close?: () => void };
  readonly now?: () => string | number | Date;
  readonly stateFreshnessMaxAgeMs?: number;
}

/**
 * Hub safety authority. It owns the incident lifecycle and only resolves an
 * incident after the explicitly bound capability reports a configured clear
 * value while its bridge has a ready, current connection.
 */
export class HomeSafetyService extends Service {
  static inject = ["homeWorld"];

  private readonly world: HomeSafetyWorldSource;
  private readonly bindings: readonly HomeSafetyBinding[];
  private readonly bindingById: ReadonlyMap<string, HomeSafetyBinding>;
  private readonly store: HomeSafetyStore & { close?: () => void };
  private readonly now: () => Date;
  private readonly stateFreshnessMaxAgeMs: number;

  constructor(ctx: Context, options: HomeSafetyServiceOptions = {}) {
    super(ctx, "homeSafety");
    const world = ctx.get("homeWorld") as unknown as HomeSafetyWorldSource | undefined;
    if (world === undefined || typeof world.snapshot !== "function") {
      throw new TypeError("HomeSafetyService requires the Hub HomeWorld service");
    }
    this.world = world;
    this.bindings = parseHomeSafetyBindings(options.bindings ?? []);
    this.bindingById = new Map(this.bindings.map((binding) => [binding.id, binding] as const));
    this.store = options.store
      ?? new SqliteHomeSafetyStore({ path: options.path ?? ":memory:" });
    this.stateFreshnessMaxAgeMs = options.stateFreshnessMaxAgeMs ?? 60_000;
    if (!Number.isSafeInteger(this.stateFreshnessMaxAgeMs)
      || this.stateFreshnessMaxAgeMs < 1
      || this.stateFreshnessMaxAgeMs > 300_000) {
      throw new TypeError("home safety state freshness must be between 1 and 300000 milliseconds");
    }
    this.now = () => {
      const value = options.now?.() ?? new Date();
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) throw new TypeError("Home safety clock returned an invalid time");
      return date;
    };
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-safety.close");
  }

  snapshot(): HomeSafetySnapshot {
    const records = this.reconcile();
    const alerts = records
      .filter((record) => record.status !== "resolved")
      .flatMap((record) => {
        const binding = this.bindingById.get(record.bindingId);
        return binding === undefined ? [] : [projectAlert(record, binding)];
      })
      .sort((left, right) => safetyRank(left.kind) - safetyRank(right.kind)
        || left.firstObservedAt.localeCompare(right.firstObservedAt)
        || left.id.localeCompare(right.id));
    return { generatedAt: this.now().toISOString(), alerts };
  }

  alerts(): readonly HomeSafetyAlertProjection[] {
    return this.snapshot().alerts;
  }

  records(): readonly HomeSafetyAlertRecord[] {
    return this.reconcile();
  }

  acknowledge(alertId: string, actorId: string): HomeSafetyAlertProjection {
    if (!boundedText(alertId, 200)) throw new TypeError("Home safety alert id is invalid");
    if (!boundedText(actorId, 200)) throw new TypeError("Home safety acknowledgement actor is invalid");
    const records = this.reconcile();
    const index = latestOpenRecordIndex(records, alertId);
    if (index < 0) throw new Error("home_safety_alert_not_found");
    const record = records[index]!;
    if (record.status === "active") {
      const acknowledgedAt = this.now().toISOString();
      records[index] = {
        ...record,
        status: "acknowledged",
        acknowledgedAt,
        acknowledgedBy: actorId,
      };
      this.store.save(records);
    }
    const binding = this.bindingById.get(record.bindingId);
    if (binding === undefined) throw new Error("home_safety_alert_not_found");
    return projectAlert(records[index]!, binding);
  }

  private reconcile(): HomeSafetyAlertRecord[] {
    const records = [...this.store.load()];
    const world = this.world.snapshot();
    const now = this.now().toISOString();
    let changed = false;
    for (const binding of this.bindings) {
      const current = readBindingState(world, binding, Date.parse(now), this.stateFreshnessMaxAgeMs);
      const openIndex = latestOpenRecordIndex(records, binding.id);
      if (current === "active") {
        if (openIndex < 0) {
          const count = records.filter((record) => record.bindingId === binding.id).length + 1;
          records.push({
            id: `${binding.id}:${count}`,
            bindingId: binding.id,
            hwCapabilityId: binding.hwCapabilityId,
            kind: binding.kind,
            status: "active",
            firstObservedAt: now,
            lastObservedAt: now,
          });
          changed = true;
        } else {
          const currentRecord = records[openIndex]!;
          if (currentRecord.lastObservedAt !== now) {
            records[openIndex] = { ...currentRecord, lastObservedAt: now };
            changed = true;
          }
        }
      } else if (current === "clear" && openIndex >= 0) {
        const currentRecord = records[openIndex]!;
        records[openIndex] = {
          ...currentRecord,
          status: "resolved",
          lastObservedAt: now,
          resolvedAt: now,
        };
        changed = true;
      }
    }
    if (changed) this.store.save(records);
    return records;
  }
}

export function parseHomeSafetyBindings(value: unknown): readonly HomeSafetyBinding[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("Home safety bindings are invalid");
  const ids = new Set<string>();
  const capabilityIds = new Set<string>();
  const allowed = new Set(["id", "hwCapabilityId", "kind", "title", "body", "sourceLabel", "actionLabel", "actionHref", "stateAttribute", "activeValues", "clearValues"]);
  const bindings = value.map((candidate): HomeSafetyBinding => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("Home safety binding is invalid");
    }
    const input = candidate as Record<string, unknown>;
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Home safety binding has an unknown field");
    if (!boundedText(input.id, 200)) throw new TypeError("Home safety binding id is invalid");
    if (ids.has(input.id)) throw new TypeError("Home safety binding id is duplicated");
    ids.add(input.id);
    if (!boundedText(input.hwCapabilityId, 256)) throw new TypeError("Home safety capability id is invalid");
    if (capabilityIds.has(input.hwCapabilityId)) throw new TypeError("Home safety bindings use the same hwCapabilityId");
    capabilityIds.add(input.hwCapabilityId);
    if (!isSafetyKind(input.kind)) throw new TypeError("Home safety kind is invalid");
    if (!boundedText(input.title, 500) || !boundedText(input.sourceLabel, 500)) {
      throw new TypeError("Home safety labels are invalid");
    }
    if (input.body !== undefined && !boundedText(input.body, 2_000)) throw new TypeError("Home safety body is invalid");
    if (input.actionLabel !== undefined && !boundedText(input.actionLabel, 200)) throw new TypeError("Home safety action label is invalid");
    if (input.actionHref !== undefined && (!boundedText(input.actionHref, 512) || !input.actionHref.startsWith("/"))) {
      throw new TypeError("Home safety action href must be local");
    }
    if (typeof input.stateAttribute !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(input.stateAttribute)) throw new TypeError("Home safety state attribute is invalid");
    if (!Array.isArray(input.activeValues) || input.activeValues.length === 0 || input.activeValues.length > 20 || !input.activeValues.every(isSafetyScalar)) {
      throw new TypeError("Home safety active values are invalid");
    }
    if (!Array.isArray(input.clearValues) || input.clearValues.length === 0 || input.clearValues.length > 20 || !input.clearValues.every(isSafetyScalar)) {
      throw new TypeError("Home safety clear values are invalid");
    }
    const activeValues = input.activeValues as HomeSafetyScalar[];
    const clearValues = input.clearValues as HomeSafetyScalar[];
    if (activeValues.some((item) => clearValues.some((clear) => sameScalar(item, clear)))) {
      throw new TypeError("Home safety active and clear values must differ");
    }
    return Object.freeze({
      id: input.id,
      hwCapabilityId: input.hwCapabilityId,
      kind: input.kind,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      sourceLabel: input.sourceLabel,
      ...(input.actionLabel === undefined ? {} : { actionLabel: input.actionLabel }),
      ...(input.actionHref === undefined ? {} : { actionHref: input.actionHref }),
      stateAttribute: input.stateAttribute,
      activeValues: Object.freeze([...activeValues]),
      clearValues: Object.freeze([...clearValues]),
    });
  });
  return Object.freeze(bindings);
}

function readBindingState(
  world: HomeWorldSnapshot,
  binding: HomeSafetyBinding,
  nowMs: number,
  freshnessMaxAgeMs: number,
): "active" | "clear" | "unavailable" {
  const capability = world.devices
    .flatMap((device) => device.validity === "valid" ? device.capabilities : [])
    .find((candidate) => candidate.hwCapabilityId === binding.hwCapabilityId);
  if (capability === undefined) return "unavailable";
  for (const capabilityBinding of capability.bindings) {
    const bridge = world.bridges[capabilityBinding.bridgeId];
    if (bridge?.metrics.connection !== "up" || bridge.metrics.consistency !== "ready") continue;
    const contactAt = bridge.diagnostics.lastSuccessfulContactAt;
    const contactMs = typeof contactAt === "string" ? Date.parse(contactAt) : Number.NaN;
    if (!Number.isFinite(contactMs) || contactMs > nowMs || nowMs - contactMs > freshnessMaxAgeMs) continue;
    const device = world.devices.find((candidate) => candidate.validity === "valid"
      && candidate.bindings.some((candidateBinding) => candidateBinding.bridgeId === capabilityBinding.bridgeId
        && candidateBinding.nativeId === capabilityBinding.nativeId
        && candidateBinding.nativeInstanceId === capabilityBinding.nativeInstanceId));
    if (device === undefined) continue;
    const state = [...device.states].reverse().find((candidate) => candidate.nativeId === capabilityBinding.nativeId
      && candidate.nativeInstanceId === capabilityBinding.nativeInstanceId);
    const value = state?.attrs[binding.stateAttribute];
    if (!isSafetyScalar(value)) continue;
    if (binding.activeValues.some((item) => sameScalar(item, value))) return "active";
    if (binding.clearValues.some((item) => sameScalar(item, value))) return "clear";
  }
  return "unavailable";
}

function projectAlert(record: HomeSafetyAlertRecord, binding: HomeSafetyBinding): HomeSafetyAlertProjection {
  return {
    ...record,
    title: binding.title,
    ...(binding.body === undefined ? {} : { body: binding.body }),
    source: binding.sourceLabel,
    ...(binding.actionLabel === undefined ? {} : { actionLabel: binding.actionLabel }),
    ...(binding.actionHref === undefined ? {} : { actionHref: binding.actionHref }),
    severity: "safety",
    snoozeAllowed: false,
  };
}

function latestOpenRecordIndex(records: readonly HomeSafetyAlertRecord[], bindingOrAlertId: string): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.status !== "resolved" && (record.bindingId === bindingOrAlertId || record.id === bindingOrAlertId)) return index;
  }
  return -1;
}

function safetyRank(kind: HomeSafetyKind): number {
  switch (kind) {
    case "smoke": return 0;
    case "gas": return 1;
    case "water_leak": return 2;
    case "lock_unlocked": return 3;
    case "door_open": return 4;
  }
}

function isSafetyKind(value: unknown): value is HomeSafetyKind {
  return value === "water_leak" || value === "smoke" || value === "gas" || value === "door_open" || value === "lock_unlocked";
}

function isSafetyScalar(value: unknown): value is HomeSafetyScalar {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function sameScalar(left: HomeSafetyScalar, right: HomeSafetyScalar): boolean {
  return Object.is(left, right);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}
