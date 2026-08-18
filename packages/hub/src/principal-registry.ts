import { createHash } from "node:crypto";

/** Opaque, hub-local actor reference. The underlying value is never a platform id. */
export type PrincipalRef = string & { readonly __principalRef: unique symbol };

export class PrincipalRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalRegistryError";
  }
}

/**
 * Resolves platform actors into bridge-domain salted references. The registry
 * deliberately keeps no reverse map: callers can compare refs, but cannot
 * enumerate or recover platform user identifiers through this seam.
 */
export class PrincipalRegistry {
  resolve(bridgeId: string, platformUserId: string): PrincipalRef {
    const bridge = normalizeInput(bridgeId, "bridge");
    const user = normalizeInput(platformUserId, "principal");
    const bridgeSalt = digest(`hob-principal-bridge-v1\n${bridge}`);
    return `pr:${digest(`hob-principal-ref-v1\n${bridgeSalt}\n${user}`)}` as PrincipalRef;
  }
}

function normalizeInput(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PrincipalRegistryError(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new PrincipalRegistryError(`${label} is invalid`);
  return normalized;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
