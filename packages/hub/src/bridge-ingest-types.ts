export type {
  AdapterCapabilityRef,
  BridgeAdapter,
  BridgeControl,
  BridgeEvent,
  BridgeInfo,
  ControlResult,
  CoreReasonCode,
  DeviceDescriptor,
  Envelope,
  ExtensionDeclaration,
  ExtensionHandleRegistry,
  IngestRecord,
  JsonValue,
  ResourceBudget,
  SnapshotManifest,
  StateEvent,
} from "../../../contracts/bridge-contract.js";

export interface JournalWatermark {
  epochId: string;
  lastSeq: number;
}

export interface RejectionRecord {
  bridgeId: string;
  epochId: string;
  seq: number;
  reason: string;
  nativeId?: string;
}

export interface HistoryGapRecord {
  bridgeId: string;
  epochId: string;
  fromSeq: number;
  toSeq: number;
  reason: string;
}

export interface HeartbeatIntervalRecord {
  bridgeId: string;
  epochId: string;
  fromSeq: number;
  toSeq: number;
  count: number;
}
