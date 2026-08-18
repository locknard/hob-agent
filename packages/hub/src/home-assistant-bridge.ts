import WebSocket from "ws";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface StateEvent {
  entityId: string;
  capability: string;
  attrs: Record<string, unknown>;
  ts: string;
}

export interface HomeAssistantSnapshot {
  states: HomeAssistantState[];
  entityRegistry: unknown[];
  deviceRegistry: unknown[];
  areaRegistry: unknown[];
  health: { bridge: "up"; devices: Record<string, "reachable" | "unreachable" | "unknown"> };
}

export interface HomeAssistantBridgeOptions {
  baseUrl: string;
  accessToken: string;
  socketFactory?: SocketFactory;
  onStateEvent?: (event: StateEvent) => void;
  connectTimeoutMs?: number;
}

export const DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS = 5_000;

export interface HomeAssistantEndpointProbeOptions {
  baseUrl: string;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
  clock?: () => number;
}

export interface HomeAssistantEndpointProbeResult {
  status: "auth_required";
  version?: string;
  latencyMs: number;
}

interface ResultMessage {
  id: number;
  type: "result";
  success: boolean;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCommand {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export function toHomeAssistantWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Home Assistant URL must use http or https");
  }
  url.pathname = "/api/websocket";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Confirms the HA WebSocket endpoint before the product asks for a token.
 * It consumes only HA's initial auth challenge and never sends socket data.
 */
export function probeHomeAssistantEndpoint(
  options: HomeAssistantEndpointProbeOptions,
): Promise<HomeAssistantEndpointProbeResult> {
  const socketFactory = options.socketFactory ?? createNodeSocket;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise((resolveProbe, rejectProbe) => {
    const socket = socketFactory(toHomeAssistantWebSocketUrl(options.baseUrl));
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      rejectProbe(new Error(message));
    };
    const timer = setTimeout(() => fail("Home Assistant preflight timed out"), timeoutMs);

    socket.onerror = () => fail("Home Assistant preflight failed");
    socket.onclose = () => fail("Home Assistant preflight connection closed");
    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        fail("Home Assistant preflight returned invalid JSON");
        return;
      }
      if (message.type !== "auth_required") {
        fail("Home Assistant preflight returned an unexpected response");
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result: HomeAssistantEndpointProbeResult = {
        status: "auth_required",
        ...(typeof message.ha_version === "string" ? { version: message.ha_version } : {}),
        latencyMs: Math.max(0, clock() - startedAt),
      };
      socket.close();
      resolveProbe(result);
    };
  });
}

export class HomeAssistantBridge {
  private readonly socketFactory: SocketFactory;
  private readonly pending = new Map<number, PendingCommand>();
  private socket: WebSocketLike | undefined;
  private nextCommandId = 1;

  constructor(private readonly options: HomeAssistantBridgeOptions) {
    this.socketFactory = options.socketFactory ?? createNodeSocket;
  }

  connect(): Promise<HomeAssistantSnapshot> {
    if (this.socket) throw new Error("Home Assistant bridge is already connected");

    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_HOME_ASSISTANT_CONNECT_TIMEOUT_MS;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settleResolve = (snapshot: HomeAssistantSnapshot): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(snapshot);
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.rejectPending(error);
        reject(error);
      };
      const socket = this.socketFactory(toHomeAssistantWebSocketUrl(this.options.baseUrl));
      this.socket = socket;
      let authenticated = false;
      socket.onerror = settleReject;
      socket.onclose = () => {
        const error = new Error(authenticated
          ? "Home Assistant WebSocket closed"
          : "Home Assistant connection closed before authentication");
        settleReject(error);
      };
      socket.onmessage = (event) => this.handleMessage(event.data, settleResolve, settleReject, () => {
        authenticated = true;
      });
      timer = setTimeout(() => {
        const error = new Error("Home Assistant connection timed out during startup");
        settleReject(error);
        socket.close();
      }, timeoutMs);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(
    data: string,
    resolveConnect: (snapshot: HomeAssistantSnapshot) => void,
    rejectConnect: (error: Error) => void,
    markAuthenticated: () => void,
  ): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      rejectConnect(new Error("Home Assistant sent invalid JSON"));
      return;
    }

    if (message.type === "auth_required") {
      this.send({ type: "auth", access_token: this.options.accessToken });
      return;
    }
    if (message.type === "auth_invalid") {
      rejectConnect(new Error("Home Assistant authentication failed"));
      return;
    }
    if (message.type === "auth_ok") {
      markAuthenticated();
      void this.bootstrap().then(resolveConnect, rejectConnect);
      return;
    }
    if (message.type === "result" && typeof message.id === "number") {
      this.resolveCommand(message as unknown as ResultMessage);
      return;
    }
    if (message.type === "event" && typeof message.id === "number") {
      this.forwardStateEvent(message);
    }
  }

  private async bootstrap(): Promise<HomeAssistantSnapshot> {
    const [states, entityRegistry, deviceRegistry, areaRegistry] = await Promise.all([
      this.command("get_states"),
      this.command("config/entity_registry/list"),
      this.command("config/device_registry/list"),
      this.command("config/area_registry/list"),
      this.command("subscribe_events", { event_type: "state_changed" }),
    ]);
    return {
      states: asArray<HomeAssistantState>(states),
      entityRegistry: asArray(entityRegistry),
      deviceRegistry: asArray(deviceRegistry),
      areaRegistry: asArray(areaRegistry),
      health: { bridge: "up", devices: {} },
    };
  }

  private command(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextCommandId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, type, ...payload });
    });
  }

  private resolveCommand(message: ResultMessage): void {
    const command = this.pending.get(message.id);
    if (!command) return;
    this.pending.delete(message.id);
    if (message.success) command.resolve(message.result);
    else command.reject(new Error(message.error?.message ?? "Home Assistant command failed"));
  }

  private forwardStateEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (!isRecord(event) || event.event_type !== "state_changed" || !isRecord(event.data)) return;
    const entityId = event.data.entity_id;
    const newState = event.data.new_state;
    if (typeof entityId !== "string" || !isRecord(newState) || !isRecord(newState.attributes) || typeof event.time_fired !== "string") return;
    this.options.onStateEvent?.({
      entityId,
      capability: entityId.split(".", 1)[0] ?? "unknown",
      attrs: newState.attributes,
      ts: event.time_fired,
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket) throw new Error("Home Assistant bridge is not connected");
    this.socket.send(JSON.stringify(message));
  }

  private rejectPending(error: Error): void {
    for (const command of this.pending.values()) command.reject(error);
    this.pending.clear();
  }
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createNodeSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  let onclose: (() => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onmessage: ((event: { data: string }) => void) | undefined;
  socket.onclose = () => onclose?.();
  socket.onerror = (event) => onerror?.(
    event.error instanceof Error ? event.error : new Error("Home Assistant WebSocket error"),
  );
  socket.onmessage = (event) => onmessage?.({ data: String(event.data) });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    get onclose() { return onclose; },
    set onclose(handler) { onclose = handler; },
    get onerror() { return onerror; },
    set onerror(handler) { onerror = handler; },
    get onmessage() { return onmessage; },
    set onmessage(handler) { onmessage = handler; },
  };
}
