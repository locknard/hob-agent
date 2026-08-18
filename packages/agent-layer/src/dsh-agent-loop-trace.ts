import { Context, Service } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-compaction";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

export interface AgentLoopTraceTurn {
  readonly turn: number;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
}

export interface AgentLoopTraceStep {
  readonly turn: number;
  readonly step: number;
  readonly status: "running" | "completed";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
}

export interface AgentLoopTraceTool {
  readonly id: string;
  readonly turn: number;
  readonly step: number;
  readonly name: string;
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
}

export interface AgentLoopTraceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface AgentLoopTraceCompaction {
  readonly status: "running" | "completed" | "failed";
  readonly ownerTurn: number | null;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly shadowedEventCount?: number;
  readonly shadowedTokenCount?: number;
  readonly usage?: AgentLoopTraceUsage;
}

export interface AgentLoopTracePrune {
  readonly at: number;
  readonly shadowedEventCount: number;
  readonly shadowedTokenCount: number;
}

export interface AgentLoopTrace {
  readonly sessionId: string;
  readonly asOfSeq: number;
  readonly truncatedBeforeSeq?: number;
  readonly turns: readonly AgentLoopTraceTurn[];
  readonly steps: readonly AgentLoopTraceStep[];
  readonly tools: readonly AgentLoopTraceTool[];
  readonly compactions: readonly AgentLoopTraceCompaction[];
  readonly prunes: readonly AgentLoopTracePrune[];
  readonly usage: AgentLoopTraceUsage;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentLoopTrace: AgentLoopTraceService;
  }
}

export interface AgentLoopTraceServiceOptions {
  readonly maxEventsPerSession?: number;
}

type SafeTraceEvent =
  | { readonly type: "ignored"; readonly seq: number; readonly time: number }
  | { readonly type: "turn/start"; readonly seq: number; readonly time: number; readonly turn: number }
  | { readonly type: "turn/end"; readonly seq: number; readonly time: number; readonly turn: number; readonly status: string }
  | { readonly type: "step/start" | "step/end"; readonly seq: number; readonly time: number; readonly turn: number; readonly step: number }
  | { readonly type: "tool/call"; readonly seq: number; readonly time: number; readonly turn: number; readonly step: number; readonly id: string; readonly name: string }
  | { readonly type: "tool/result"; readonly seq: number; readonly time: number; readonly id: string; readonly failed: boolean }
  | { readonly type: "compaction/start"; readonly seq: number; readonly time: number; readonly id: string; readonly ownerTurn: number | null }
  | { readonly type: "compaction/summary"; readonly seq: number; readonly time: number; readonly id: string; readonly shadowedEventCount: number; readonly shadowedTokenCount: number; readonly usage?: AgentLoopTraceUsage }
  | { readonly type: "compaction/end"; readonly seq: number; readonly time: number; readonly id: string; readonly failed: boolean }
  | { readonly type: "compaction/prune"; readonly seq: number; readonly time: number; readonly shadowedEventCount: number; readonly shadowedTokenCount: number }
  | { readonly type: "assistant/usage"; readonly seq: number; readonly time: number; readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens: number };

interface SafeTraceLog {
  readonly events: SafeTraceEvent[];
  truncatedBeforeSeq?: number;
}

/** Read-only projection of DSH's canonical session event stream. */
export class AgentLoopTraceService extends Service {
  static inject = ["sessions"];
  private readonly logs = new Map<string, SafeTraceLog>();
  private readonly maxEvents: number;

  constructor(ctx: Context, options: AgentLoopTraceServiceOptions = {}) {
    super(ctx, "agentLoopTrace");
    this.maxEvents = Math.max(64, Math.min(options.maxEventsPerSession ?? 1_000, 10_000));
  }

  protected [Service.init](): void {
    for (const session of this.ctx.sessions.list()) this.adopt(session);
    this.ctx.on("session/created", (session) => this.adopt(session), { global: true });
    this.ctx.on("session/event", (session, event) => this.append(session, event), { global: true });
  }

  snapshot(sessionId: string): AgentLoopTrace | undefined {
    const log = this.logs.get(sessionId);
    if (log === undefined) return undefined;
    return projectSafeTrace(sessionId, log.events, log.truncatedBeforeSeq);
  }

  private adopt(session: Session): void {
    const events = session.events.map(sanitizeEvent);
    const overflow = Math.max(0, events.length - this.maxEvents);
    this.logs.set(String(session.id), {
      events: events.slice(overflow),
      ...(overflow === 0 ? {} : { truncatedBeforeSeq: events[overflow]?.seq }),
    });
  }

  private append(session: Session, event: SessionEvent): void {
    const key = String(session.id);
    const log = this.logs.get(key) ?? { events: [] };
    if (log.events.at(-1)?.seq === event.seq) return;
    log.events.push(sanitizeEvent(event));
    if (log.events.length > this.maxEvents) {
      const removed = log.events.shift();
      log.truncatedBeforeSeq = removed === undefined ? log.truncatedBeforeSeq : removed.seq + 1;
    }
    this.logs.set(key, log);
  }
}

export function projectAgentLoopTrace(
  sessionId: string,
  events: readonly SessionEvent[],
  truncatedBeforeSeq?: number,
): AgentLoopTrace {
  return projectSafeTrace(sessionId, events.map(sanitizeEvent), truncatedBeforeSeq);
}

function projectSafeTrace(
  sessionId: string,
  events: readonly SafeTraceEvent[],
  truncatedBeforeSeq?: number,
): AgentLoopTrace {
  const turns = new Map<number, AgentLoopTraceTurn>();
  const steps = new Map<string, AgentLoopTraceStep>();
  const tools = new Map<string, AgentLoopTraceTool>();
  const compactions = new Map<string, AgentLoopTraceCompaction>();
  const prunes: AgentLoopTracePrune[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;

  for (const event of events) {
    switch (event.type) {
      case "ignored":
        break;
      case "turn/start":
        turns.set(event.turn, { turn: event.turn, status: "running", startedAt: event.time });
        break;
      case "turn/end": {
        const previous = turns.get(event.turn);
        if (previous !== undefined) {
          turns.set(event.turn, {
            ...previous,
            status: event.status,
            endedAt: event.time,
            durationMs: Math.max(0, event.time - previous.startedAt),
          });
        }
        break;
      }
      case "step/start":
        steps.set(stepKey(event.turn, event.step), {
          turn: event.turn,
          step: event.step,
          status: "running",
          startedAt: event.time,
        });
        break;
      case "step/end": {
        const key = stepKey(event.turn, event.step);
        const previous = steps.get(key);
        if (previous !== undefined) {
          steps.set(key, {
            ...previous,
            status: "completed",
            endedAt: event.time,
            durationMs: Math.max(0, event.time - previous.startedAt),
          });
        }
        break;
      }
      case "tool/call":
        tools.set(event.id, {
          id: event.id,
          turn: event.turn,
          step: event.step,
          name: event.name,
          status: "running",
          startedAt: event.time,
        });
        break;
      case "tool/result": {
        const previous = tools.get(event.id);
        if (previous !== undefined) {
          tools.set(event.id, {
            ...previous,
            status: event.failed ? "failed" : "completed",
            endedAt: event.time,
            durationMs: Math.max(0, event.time - previous.startedAt),
          });
        }
        break;
      }
      case "compaction/start":
        compactions.set(event.id, {
          status: "running",
          ownerTurn: event.ownerTurn,
          startedAt: event.time,
        });
        break;
      case "compaction/summary": {
        const previous = compactions.get(event.id);
        if (previous !== undefined) {
          compactions.set(event.id, {
            ...previous,
            shadowedEventCount: event.shadowedEventCount,
            shadowedTokenCount: event.shadowedTokenCount,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          });
        }
        break;
      }
      case "compaction/end": {
        const previous = compactions.get(event.id);
        if (previous !== undefined) {
          compactions.set(event.id, {
            ...previous,
            status: event.failed ? "failed" : "completed",
            endedAt: event.time,
            durationMs: Math.max(0, event.time - previous.startedAt),
          });
        }
        break;
      }
      case "compaction/prune":
        prunes.push({
          at: event.time,
          shadowedEventCount: event.shadowedEventCount,
          shadowedTokenCount: event.shadowedTokenCount,
        });
        break;
      case "assistant/usage":
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        reasoningTokens += event.reasoningTokens;
        break;
    }
  }

  return {
    sessionId,
    asOfSeq: events.at(-1)?.seq ?? -1,
    ...(truncatedBeforeSeq === undefined ? {} : { truncatedBeforeSeq }),
    turns: [...turns.values()].sort((left, right) => left.turn - right.turn),
    steps: [...steps.values()].sort((left, right) => left.turn - right.turn || left.step - right.step),
    tools: [...tools.values()].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id)),
    compactions: [...compactions.values()].sort((left, right) => left.startedAt - right.startedAt),
    prunes,
    usage: { inputTokens, outputTokens, reasoningTokens },
  };
}

function sanitizeEvent(event: SessionEvent): SafeTraceEvent {
  switch (event.type) {
    case "turn/start":
      return { type: event.type, seq: event.seq, time: event.time, turn: event.data.turn };
    case "turn/end":
      return { type: event.type, seq: event.seq, time: event.time, turn: event.data.turn, status: event.data.reason.kind };
    case "step/start":
    case "step/end":
      return { type: event.type, seq: event.seq, time: event.time, turn: event.data.turn, step: event.data.step };
    case "tool/call":
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        turn: event.data.turn,
        step: event.data.step,
        id: String(event.data.callId),
        name: boundedLabel(event.data.name),
      };
    case "tool/result": {
      const block = event.data.message.content[0];
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        id: block?.type === "tool-result" ? String(block.toolCallId) : String(event.data.message.source.callId),
        failed: event.data.error !== undefined || (block?.type === "tool-result" && block.isError === true),
      };
    }
    case "assistant/message":
      return {
        type: "assistant/usage",
        seq: event.seq,
        time: event.time,
        inputTokens: event.data.usage?.inputTokens ?? 0,
        outputTokens: event.data.usage?.outputTokens ?? 0,
        reasoningTokens: event.data.usage?.reasoningTokens ?? 0,
      };
    case "compaction/start":
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        id: String(event.data.compactionId),
        ownerTurn: event.data.turn,
      };
    case "compaction/summary":
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        id: String(event.data.compactionId),
        shadowedEventCount: event.data.shadowedSeqs.length,
        shadowedTokenCount: event.data.shadowedTokenCount,
        ...(event.data.usage === undefined ? {} : {
          usage: {
            inputTokens: event.data.usage.inputTokens,
            outputTokens: event.data.usage.outputTokens,
            reasoningTokens: event.data.usage.reasoningTokens ?? 0,
          },
        }),
      };
    case "compaction/end":
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        id: String(event.data.compactionId),
        failed: event.data.error !== undefined,
      };
    case "compaction/prune":
      return {
        type: event.type,
        seq: event.seq,
        time: event.time,
        shadowedEventCount: event.data.shadowedSeqs.length,
        shadowedTokenCount: event.data.shadowedTokenCount,
      };
    default:
      return { type: "ignored", seq: event.seq, time: event.time };
  }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function boundedLabel(value: string): string {
  return value.trim().slice(0, 128) || "unknown-tool";
}
