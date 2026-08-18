/**
 * Stable identity supplied by an external bridge.
 * Contract expansion is deliberately deferred until the first non-HA bridge.
 */
export interface BridgeIdentity {
  bridgeId: string;
  contractVersion: "v0";
}

export interface BridgeInfo extends BridgeIdentity {
  ecosystem: string;
}

export interface CapabilityDescriptor {
  type: string;
  attrs: Record<string, AttrSpec>;
  actions: Record<string, ActionSpec>;
}

export interface AttrSpec {
  type: string;
  readOnly?: boolean;
}

export interface ActionSpec {
  parameters: Record<string, AttrSpec>;
}

export interface DeviceDescriptor {
  deviceId: string;
  provenance: { bridgeId: string; nativeId: string };
  name?: string;
  roomHint?: string;
  capabilities: CapabilityDescriptor[];
}

export interface StateEvent {
  deviceId: string;
  capability: string;
  attrs: Record<string, unknown>;
  ts: string;
}

export interface HealthReport {
  bridge: "up" | "degraded";
  devices: Record<string, "reachable" | "unreachable" | "unknown">;
}
