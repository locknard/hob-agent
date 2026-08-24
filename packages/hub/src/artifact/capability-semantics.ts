import type { JsonValue } from "@hob/bridge-contract";
import type { ArtifactAction } from "./neutral-artifact.js";

const MAX_SCHEMA_BYTES = 256;
const MAX_VERSION_BYTES = 64;
const MAX_NEUTRAL_STRING_BYTES = 16 * 1024;
const MAX_NEUTRAL_STRING_LENGTH = 512;
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu;

const equalityOperators = Object.freeze(["equals", "not_equals"] as const);
const numericOperators = Object.freeze(["equals", "not_equals", "greater_than", "less_than"] as const);

/** Exact schema/version pairs reviewed by the Hub-private M3c resolver. */
export const CAPABILITY_SEMANTICS_ALLOWLIST = Object.freeze([
  "ha.entity@1.0.0",
  "ha.cover@1.0.0",
  "ha.boolean-actuator@1.0.0",
  "miot.property@1.0.0",
] as const);

export type CapabilitySemanticsSchemaKey = typeof CAPABILITY_SEMANTICS_ALLOWLIST[number];
export type CapabilityPredicateOperator = typeof numericOperators[number];
export type CapabilityNeutralScalar = string | number | boolean | null;
export type CapabilityNeutralValueType = "string" | "number" | "boolean" | "null";
export type CapabilityDeviceAction = Extract<ArtifactAction, { kind: "set_level" | "set_boolean" }>;

export type CapabilityStateValidity =
  | "valid"
  | "stale"
  | "invalid"
  | "invalid-source"
  | "present-but-invalid"
  | "unavailable";

export type CapabilityStateFreshness = "fresh" | "stale-gap";

export interface CapabilitySemanticsCapability {
  readonly schema: string;
  readonly schemaVersion: string;
}

export interface CapabilitySemanticsState {
  readonly attrs: Readonly<Record<string, JsonValue>>;
  readonly validity: CapabilityStateValidity;
  readonly freshness?: CapabilityStateFreshness;
}

export interface CapabilitySemanticsInput {
  readonly capability: CapabilitySemanticsCapability;
  readonly state?: CapabilitySemanticsState;
}

export interface CapabilityPredicateInput extends CapabilitySemanticsInput {
  readonly operator: CapabilityPredicateOperator;
  readonly value: CapabilityNeutralScalar;
}

export interface CapabilityActionInput extends CapabilitySemanticsInput {
  readonly action: CapabilityDeviceAction;
}

export type CapabilitySemanticsReason =
  | "schema_unsupported"
  | "state_missing"
  | "state_stale"
  | "state_invalid"
  | "value_unsupported"
  | "value_invalid"
  | "operator_unsupported"
  | "predicate_type_mismatch"
  | "set_level_unsupported"
  | "action_mapping_unreviewed"
  | "not_writable"
  | "action_invalid";

export type CapabilityReadResult =
  | {
      readonly status: "available";
      readonly value: CapabilityNeutralScalar;
      readonly valueType: CapabilityNeutralValueType;
      readonly operators: readonly CapabilityPredicateOperator[];
    }
  | {
      readonly status: "unsupported";
      readonly reason: "schema_unsupported" | "value_unsupported" | "value_invalid";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "state_missing" | "state_stale" | "state_invalid";
    };

export type CapabilityPredicateResult =
  | {
      readonly status: "compatible";
      readonly operator: CapabilityPredicateOperator;
      readonly valueType: CapabilityNeutralValueType;
    }
  | {
      readonly status: "incompatible";
      readonly reason: CapabilitySemanticsReason;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "state_missing" | "state_stale" | "state_invalid";
    };

export type CapabilityActionResult =
  | {
      readonly status: "compatible";
      readonly kind: "set_boolean";
      readonly before: boolean;
      readonly after: boolean;
    }
  | {
      readonly status: "compatible";
      readonly kind: "set_level";
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly status: "incompatible";
      readonly kind: "set_level" | "set_boolean";
      readonly reason: CapabilitySemanticsReason;
    }
  | {
      readonly status: "incompatible";
      readonly reason: "action_invalid";
    }
  | {
      readonly status: "unavailable";
      readonly kind: "set_level" | "set_boolean";
      readonly reason: "state_missing" | "state_stale" | "state_invalid";
    };

type StateAvailability = "ready" | "state_missing" | "state_stale" | "state_invalid";
type ReadScalarResult =
  | { readonly status: "available"; readonly value: CapabilityNeutralScalar }
  | { readonly status: "unsupported"; readonly reason: "value_unsupported" | "value_invalid" };

/**
 * Resolves read semantics only. `semanticKind` is intentionally absent from
 * the input type: a read hint cannot become an action or authority claim.
 */
export function resolveCapabilityRead(input: CapabilitySemanticsInput): CapabilityReadResult {
  const schemaKey = exactSchemaKey(input?.capability);
  if (schemaKey === undefined) return frozen({ status: "unsupported", reason: "schema_unsupported" });

  const availability = stateAvailability(input?.state, schemaKey === "ha.cover@1.0.0");
  if (availability !== "ready") return frozen({ status: "unavailable", reason: availability });

  const attrs = input.state!.attrs;
  if (schemaKey === "ha.cover@1.0.0" && isHaCoverUnavailable(attrs)) {
    return frozen({ status: "unavailable", reason: "state_invalid" });
  }
  if (schemaKey === "ha.boolean-actuator@1.0.0" && isHaBooleanActuatorUnavailable(attrs)) {
    return frozen({ status: "unavailable", reason: "state_invalid" });
  }
  const rawValue = schemaKey === "ha.entity@1.0.0"
    ? ownValue(attrs, "state")
    : schemaKey === "ha.cover@1.0.0"
      ? ownValue(attrs, "level")
      : ownValue(attrs, "value");
  if (rawValue === undefined) return frozen({ status: "unavailable", reason: "state_missing" });
  const scalar = schemaKey === "ha.entity@1.0.0"
    ? readHaState(rawValue)
    : schemaKey === "ha.cover@1.0.0"
      ? readCoverLevel(rawValue)
      : schemaKey === "ha.boolean-actuator@1.0.0"
        ? readBoolean(rawValue)
        : readScalar(rawValue);
  if (scalar.status !== "available") return frozen(scalar);

  const valueType = neutralValueType(scalar.value);
  return frozen({
    status: "available",
    value: scalar.value,
    valueType,
    operators: valueType === "number" ? numericOperators : equalityOperators,
  });
}

/** Checks condition/postcondition operator and operand compatibility only. */
export function checkCapabilityPredicate(input: CapabilityPredicateInput): CapabilityPredicateResult {
  const read = resolveCapabilityRead(input);
  if (read.status === "unavailable") return frozen(read);
  if (read.status === "unsupported") return frozen({ status: "incompatible", reason: read.reason });

  if (!read.operators.includes(input.operator)) {
    return frozen({ status: "incompatible", reason: "operator_unsupported" });
  }
  if (!isNeutralScalar(input.value) || neutralValueType(input.value) !== read.valueType) {
    return frozen({ status: "incompatible", reason: "predicate_type_mismatch" });
  }
  if (exactSchemaKey(input?.capability) === "ha.cover@1.0.0" && !isNormalizedLevel(input.value)) {
    return frozen({ status: "incompatible", reason: "value_invalid" });
  }
  return frozen({ status: "compatible", operator: input.operator, valueType: read.valueType });
}

/**
 * Checks neutral device-action compatibility. This function never resolves or
 * returns an authority candidate, route, credential, native ID, or provider
 * payload. A compatible result is not executable by itself.
 */
export function checkCapabilityAction(input: CapabilityActionInput): CapabilityActionResult {
  const kind = actionKind(input?.action);
  if (kind === undefined) return frozen({ status: "incompatible", reason: "action_invalid" });

  const schemaKey = exactSchemaKey(input?.capability);
  if (schemaKey === undefined) {
    return frozen({ status: "incompatible", kind, reason: "schema_unsupported" });
  }

  const availability = stateAvailability(
    input?.state,
    schemaKey === "ha.cover@1.0.0" || schemaKey === "ha.boolean-actuator@1.0.0",
  );
  if (availability !== "ready") return frozen({ status: "unavailable", kind, reason: availability });

  if (kind === "set_level") {
    if (schemaKey === "ha.cover@1.0.0") {
      const read = resolveCapabilityRead(input);
      if (read.status === "unavailable") return frozen({ status: "unavailable", kind, reason: read.reason });
      if (read.status === "unsupported") return frozen({ status: "incompatible", kind, reason: read.reason });

      const support = ownValue(input.state!.attrs, "setLevelSupported");
      if (support === false) return frozen({ status: "incompatible", kind, reason: "not_writable" });
      if (support !== true) {
        return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
      }

      const requested = input.action.value;
      if (!isNormalizedLevel(requested)) {
        return frozen({ status: "incompatible", kind, reason: "action_invalid" });
      }
      if (!isIntegerPercent(requested)) {
        return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
      }
      if (!isNormalizedLevel(read.value)) {
        return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
      }
      return frozen({ status: "compatible", kind, before: read.value, after: requested });
    }
    return frozen({ status: "incompatible", kind, reason: "set_level_unsupported" });
  }

  const read = resolveCapabilityRead(input);
  if (read.status === "unavailable") return frozen({ status: "unavailable", kind, reason: read.reason });
  if (read.status === "unsupported") return frozen({ status: "incompatible", kind, reason: read.reason });

  if (schemaKey === "ha.boolean-actuator@1.0.0") {
    const requested = input.action.value;
    if (typeof requested !== "boolean" || typeof read.value !== "boolean") {
      return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
    }
    return frozen({ status: "compatible", kind, before: read.value, after: requested });
  }

  if (schemaKey !== "miot.property@1.0.0" || read.valueType !== "boolean") {
    return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
  }

  const attrs = input.state!.attrs;
  if (ownValue(attrs, "format") !== "bool") {
    return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
  }
  const writable = ownValue(attrs, "writable");
  if (writable === false) return frozen({ status: "incompatible", kind, reason: "not_writable" });
  if (writable !== true) {
    return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
  }

  const requested = input.action.value;
  if (typeof requested !== "boolean" || typeof read.value !== "boolean") {
    return frozen({ status: "incompatible", kind, reason: "action_mapping_unreviewed" });
  }
  return frozen({ status: "compatible", kind, before: read.value, after: requested });
}

function exactSchemaKey(capability: CapabilitySemanticsCapability | undefined): CapabilitySemanticsSchemaKey | undefined {
  if (!isPlainRecord(capability)) return undefined;
  if (!hasOwn(capability, "schema") || !hasOwn(capability, "schemaVersion")) return undefined;
  const schema = capability.schema;
  const schemaVersion = capability.schemaVersion;
  if (typeof schema !== "string" || typeof schemaVersion !== "string") return undefined;
  if (Buffer.byteLength(schema, "utf8") > MAX_SCHEMA_BYTES
    || Buffer.byteLength(schemaVersion, "utf8") > MAX_VERSION_BYTES) return undefined;
  const key = `${schema}@${schemaVersion}`;
  return (CAPABILITY_SEMANTICS_ALLOWLIST as readonly string[]).includes(key)
    ? key as CapabilitySemanticsSchemaKey
    : undefined;
}

function stateAvailability(state: CapabilitySemanticsState | undefined, requireFresh = false): StateAvailability {
  if (state === undefined) return "state_missing";
  if (!isPlainRecord(state) || !isPlainRecord(state.attrs)) return "state_invalid";
  if (state.freshness !== undefined && state.freshness !== "fresh" && state.freshness !== "stale-gap") {
    return "state_invalid";
  }
  if (state.validity === "stale" || state.freshness === "stale-gap") return "state_stale";
  if (state.validity !== "valid") return "state_invalid";
  if (requireFresh && state.freshness !== "fresh") return "state_stale";
  return "ready";
}

function readScalar(value: unknown): ReadScalarResult {
  if (value === null || typeof value === "boolean") return { status: "available", value };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { status: "available", value }
      : { status: "unsupported", reason: "value_invalid" };
  }
  if (typeof value === "string") {
    return isNeutralString(value)
      ? { status: "available", value }
      : { status: "unsupported", reason: "value_invalid" };
  }
  return { status: "unsupported", reason: "value_unsupported" };
}

function readHaState(value: unknown): ReadScalarResult {
  if (typeof value !== "string") return { status: "unsupported", reason: "value_invalid" };
  return isNeutralString(value)
    ? { status: "available", value }
    : { status: "unsupported", reason: "value_invalid" };
}

function readCoverLevel(value: unknown): ReadScalarResult {
  return isNormalizedLevel(value)
    ? { status: "available", value }
    : { status: "unsupported", reason: "value_invalid" };
}

function readBoolean(value: unknown): ReadScalarResult {
  return typeof value === "boolean"
    ? { status: "available", value }
    : { status: "unsupported", reason: "value_invalid" };
}

function isHaCoverUnavailable(attrs: Readonly<Record<string, JsonValue>>): boolean {
  const available = ownValue(attrs, "available");
  const state = ownValue(attrs, "state");
  return available === false || state === "unavailable" || state === "unknown";
}

function isHaBooleanActuatorUnavailable(attrs: Readonly<Record<string, JsonValue>>): boolean {
  const available = ownValue(attrs, "available");
  const state = ownValue(attrs, "state");
  return available === false || state === "unavailable" || state === "unknown";
}

function isNeutralScalar(value: unknown): value is CapabilityNeutralScalar {
  return readScalar(value).status === "available";
}

function isNormalizedLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isIntegerPercent(value: number): boolean {
  const scaled = value * 100;
  if (!Number.isFinite(scaled)) return false;
  return Math.round(scaled) / 100 === value;
}

function isNeutralString(value: string): boolean {
  return value.length <= MAX_NEUTRAL_STRING_LENGTH
    && Buffer.byteLength(value, "utf8") <= MAX_NEUTRAL_STRING_BYTES
    && !URL_LIKE.test(value);
}

function neutralValueType(value: CapabilityNeutralScalar): CapabilityNeutralValueType {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function ownValue(value: Readonly<Record<string, JsonValue>>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function actionKind(action: unknown): "set_level" | "set_boolean" | undefined {
  if (!isPlainRecord(action)) return undefined;
  if (!hasOwn(action, "kind")) return undefined;
  return action.kind === "set_level" || action.kind === "set_boolean" ? action.kind : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function frozen<T>(value: T): T {
  return deepFreeze(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return value;
}
