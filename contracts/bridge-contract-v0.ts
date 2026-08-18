/**
 * Stable identity supplied by an external bridge.
 * Contract expansion is deliberately deferred until the first non-HA bridge.
 */
export interface BridgeIdentity {
  bridgeId: string;
  contractVersion: "v0";
}
