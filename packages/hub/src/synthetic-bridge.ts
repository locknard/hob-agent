import type {
  BridgeAdapter,
  BridgeControl,
  BridgeInfo,
  ControlResult,
  Envelope,
} from "./bridge-ingest-types.js";

export interface SyntheticBridgeOptions {
  bridgeId: string;
  remoteInstanceId?: string;
  ecosystem?: string;
  heartbeatIntervalMs?: number;
  extensions?: BridgeInfo["extensions"];
  requestResyncResult?: ControlResult;
  pauseResult?: ControlResult;
}

/** Small deterministic adapter used by ingest tests and local protocol demos. */
export class SyntheticBridge implements BridgeAdapter {
  readonly info: BridgeInfo;
  readonly control: BridgeControl;
  private readonly queue: Envelope[] = [];
  private open = true;
  private subscribed = false;
  private readonly requestResyncResult: ControlResult;
  private readonly pauseResult: ControlResult;

  constructor(options: SyntheticBridgeOptions) {
    this.info = {
      bridgeId: options.bridgeId,
      coreVersion: "6.3.0",
      ecosystem: options.ecosystem ?? "synthetic",
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
      extensions: options.extensions ?? [],
    };
    this.requestResyncResult = options.requestResyncResult ?? { status: "completed" };
    this.pauseResult = options.pauseResult ?? { status: "completed" };
    this.control = {
      requestResync: async () => this.requestResyncResult,
      pause: async () => this.pauseResult,
      resume: async () => ({ status: "completed" }),
      dispose: async () => { this.open = false; },
    };
  }

  enqueue(envelope: Envelope): void {
    if (!this.open) throw new Error("synthetic bridge is disposed");
    this.queue.push(envelope);
  }

  closeStream(): void {
    this.open = false;
  }

  async *events(signal: AbortSignal): AsyncIterable<Envelope> {
    if (this.subscribed) throw new Error("synthetic bridge events() may only be subscribed once");
    this.subscribed = true;
    while (!signal.aborted && this.queue.length > 0) yield this.queue.shift()!;
  }

  extension(): undefined {
    return undefined;
  }
}

export function createSyntheticBridge(options: SyntheticBridgeOptions): SyntheticBridge {
  return new SyntheticBridge(options);
}
