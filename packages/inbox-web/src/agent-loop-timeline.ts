import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";

const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  create_home_proposal: "整理这条家庭建议",
  get_home_activity: "查看最近的家庭活动",
  get_home_calibration: "核对你告诉我的偏好",
  get_home_evidence: "核对相关家庭记录",
  get_home_inventory: "查看房间与设备",
  get_home_media_players: "查看可用的播放设备",
  get_home_rules: "核对家里已有的安排",
  get_home_snapshot: "查看家庭概况",
  home_media_conversation: "准备媒体播放请求",
  prepare_home_media_playback: "准备待确认的播放动作",
  search_home_media: "查找可播放内容",
});

/** Renders bounded DSH metadata as a household-readable, review-safe journey. */
export function renderAgentLoopTimeline(trace: AgentLoopTrace): string {
  const summary = `${trace.turns.length} 轮分析 · ${trace.steps.length} 个步骤 · ${trace.tools.length} 项检查`;
  const turns = trace.turns.map((turn) => {
    const steps = trace.steps.filter((step) => step.turn === turn.turn).map((step) => {
      const tools = trace.tools.filter((tool) => tool.turn === step.turn && tool.step === step.step).map((tool) =>
        `<li class="agent-loop-tool" data-state="${escapeHtml(tool.status)}"><span>${escapeHtml(toolLabel(tool.name))}</span><time>${duration(tool.durationMs)}</time></li>`,
      ).join("");
      return `<li class="agent-loop-step" data-state="${escapeHtml(step.status)}"><div><span>步骤 ${step.step}</span><time>${duration(step.durationMs)}</time></div>${tools.length === 0 ? "" : `<ul>${tools}</ul>`}</li>`;
    }).join("");
    return `<li class="agent-loop-turn" data-state="${escapeHtml(turn.status)}"><header><strong>第 ${turn.turn} 轮分析</strong><time>${duration(turn.durationMs)}</time></header><ol>${steps}</ol></li>`;
  }).join("");
  const maintenance = [
    ...trace.compactions.map((compaction) => compaction.shadowedTokenCount === undefined
      ? "整理了一次上下文"
      : `整理过 ${compaction.shadowedTokenCount} 个上下文单位`),
    ...trace.prunes.map((prune) => `移除过 ${prune.shadowedTokenCount} 个过期上下文单位`),
  ];
  const maintenanceList = maintenance.length === 0
    ? ""
    : `<ul>${maintenance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  return `<section class="agent-loop-timeline" aria-label="建议形成过程"><p class="agent-loop-summary">${summary}</p><ol class="agent-loop-turns">${turns}</ol><details class="agent-loop-runtime"><summary>运行信息</summary><p>输入 ${trace.usage.inputTokens} · 输出 ${trace.usage.outputTokens} · 推理 ${trace.usage.reasoningTokens}</p>${maintenanceList}</details></section>`;
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? "完成一项受控检查";
}

function duration(value: number | undefined): string {
  if (value === undefined) return "进行中";
  if (value < 1_000) return `${Math.max(0, Math.round(value))} 毫秒`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
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
