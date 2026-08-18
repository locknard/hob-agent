import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";

/** Render the metadata-only DSH trajectory as a review-safe timeline fragment. */
export function renderAgentLoopTimeline(trace: AgentLoopTrace): string {
  const usage = `${trace.usage.inputTokens} input · ${trace.usage.outputTokens} output · ${trace.usage.reasoningTokens} reasoning`;
  const turns = trace.turns.map((turn) => {
    const steps = trace.steps.filter((step) => step.turn === turn.turn).map((step) => {
      const tools = trace.tools.filter((tool) => tool.turn === step.turn && tool.step === step.step).map((tool) =>
        `<li class="agent-loop-tool" data-status="${escapeHtml(tool.status)}"><span>${escapeHtml(tool.name)}</span><time>${duration(tool.durationMs)}</time></li>`,
      ).join("");
      return `<li class="agent-loop-step" data-status="${escapeHtml(step.status)}"><header><span>Step ${step.step}</span><time>${duration(step.durationMs)}</time></header><ul>${tools}</ul></li>`;
    }).join("");
    return `<li class="agent-loop-turn" data-status="${escapeHtml(turn.status)}"><header><strong>Turn ${turn.turn}</strong><time>${duration(turn.durationMs)}</time></header><ol>${steps}</ol></li>`;
  }).join("");
  const compactions = trace.compactions.length === 0 && trace.prunes.length === 0
    ? ""
    : `<section class="agent-loop-compactions" aria-label="Context maintenance"><h3>Context maintenance</h3><ol>${trace.prunes.map((prune) =>
      `<li data-status="completed"><span>${prune.shadowedEventCount} tool result${prune.shadowedEventCount === 1 ? "" : "s"} pruned · ${prune.shadowedTokenCount} tokens removed</span></li>`,
    ).join("")}${trace.compactions.map((compaction) => {
      const compacted = compaction.shadowedTokenCount === undefined
        ? "no checkpoint"
        : `${compaction.shadowedTokenCount} tokens compacted${compaction.shadowedEventCount === undefined ? "" : ` from ${compaction.shadowedEventCount} events`}`;
      const compactionUsage = compaction.usage === undefined
        ? ""
        : ` · ${compaction.usage.inputTokens} input · ${compaction.usage.outputTokens} output · ${compaction.usage.reasoningTokens} reasoning`;
      return `<li data-status="${escapeHtml(compaction.status)}"><span>${escapeHtml(compaction.status)} · ${compacted}${compactionUsage}</span><time>${duration(compaction.durationMs)}</time></li>`;
    }).join("")}</ol></section>`;
  return `<section class="agent-loop-timeline" aria-label="Agent loop timeline" data-session="${escapeHtml(trace.sessionId)}"><header><h2>Agent loop</h2><p>${usage}</p></header>${compactions}<ol>${turns}</ol></section>`;
}

function duration(value: number | undefined): string {
  return value === undefined ? "running" : `${value} ms`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}
