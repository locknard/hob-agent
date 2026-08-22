export const MAX_CANONICAL_INPUT_BYTES = 64 * 1024;
export const MAX_CANONICAL_DEPTH = 16;
export const MAX_CANONICAL_ARRAY_LENGTH = 64;
export const MAX_CANONICAL_TOTAL_ARRAY_ITEMS = 256;
export const MAX_CANONICAL_OBJECT_FIELDS = 128;
export const MAX_CANONICAL_TOTAL_OBJECT_FIELDS = 512;
export const MAX_CANONICAL_STRING_BYTES = 16 * 1024;
export const MAX_CANONICAL_TOTAL_STRING_BYTES = 64 * 1024;

const forbiddenCanonicalKeys = new Set([
  "accessToken",
  "adapterType",
  "apiKey",
  "bridgeRoute",
  "certificatePem",
  "credential",
  "entityId",
  "installationId",
  "nativeRoute",
  "nativeId",
  "nativeInstanceId",
  "password",
  "piid",
  "privateKey",
  "provider",
  "providerPayload",
  "refreshToken",
  "remoteInstanceId",
  "remoteRoute",
  "route",
  "ruleId",
  "secret",
  "secretText",
  "service",
  "siid",
  "token",
  "url",
  "vendor",
]);

export type CanonicalJsonErrorCode = "invalid_input" | "resource_exhausted";

export class CanonicalJsonError extends Error {
  constructor(readonly code: CanonicalJsonErrorCode, message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

interface CanonicalBudget {
  arrayItems: number;
  objectFields: number;
  stringBytes: number;
}

/** Bounded canonical JSON for Hub-owned stable identity inputs. */
export function canonicalHubJson(input: unknown): string {
  const canonical = canonicalizeValue(input, new WeakSet<object>(), 0, {
    arrayItems: 0,
    objectFields: 0,
    stringBytes: 0,
  });
  const encoded = JSON.stringify(canonical);
  if (encoded === undefined) throw invalid("Canonical input is not JSON-serializable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_INPUT_BYTES) {
    throw exhausted("Canonical input exceeds the byte budget");
  }
  return encoded;
}

function canonicalizeValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: CanonicalBudget,
): unknown {
  if (depth > MAX_CANONICAL_DEPTH) throw exhausted("Canonical input nesting exceeds the budget");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_CANONICAL_STRING_BYTES) throw exhausted("Canonical input string exceeds the byte budget");
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_CANONICAL_TOTAL_STRING_BYTES) {
      throw exhausted("Canonical input strings exceed the total byte budget");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Canonical input contains a non-finite number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw invalid("Canonical input contains an unsafe integer");
    }
    return value;
  }
  if (typeof value !== "object") throw invalid("Canonical input contains an unsupported value");
  if (seen.has(value)) throw invalid("Canonical input contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_ARRAY_LENGTH) {
        throw exhausted("Canonical input array exceeds the item budget");
      }
      budget.arrayItems += value.length;
      if (budget.arrayItems > MAX_CANONICAL_TOTAL_ARRAY_ITEMS) {
        throw exhausted("Canonical input arrays exceed the total item budget");
      }
      return value.map((item) => canonicalizeValue(item, seen, depth + 1, budget));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid("Canonical input must contain plain objects");
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_CANONICAL_OBJECT_FIELDS) {
      throw exhausted("Canonical input object exceeds the field budget");
    }
    budget.objectFields += keys.length;
    if (budget.objectFields > MAX_CANONICAL_TOTAL_OBJECT_FIELDS) {
      throw exhausted("Canonical input objects exceed the total field budget");
    }
    const entries = keys.sort(compareUnicodeCodePoints).map((key) => {
      if (forbiddenCanonicalKeys.has(key)) throw invalid(`Canonical input contains forbidden field "${key}"`);
      return [key, canonicalizeValue((value as Record<string, unknown>)[key], seen, depth + 1, budget)] as const;
    });
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

function invalid(message: string): CanonicalJsonError {
  return new CanonicalJsonError("invalid_input", message);
}

function exhausted(message: string): CanonicalJsonError {
  return new CanonicalJsonError("resource_exhausted", message);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
