import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderProductContent,
  renderProductHost,
  renderProductShell,
  renderProductViewRecipeContent,
  PRODUCT_OPERATIONAL_MODEL_JS,
  PRODUCT_PRIVATE_VOICE_JS,
  type ProductAdviceTurn,
  type ProductConnectionState,
  type ProductControlFeedback,
  type ProductMediaActionTurn,
  type ProductShellModel,
} from "./product-shell.js";
import { PRODUCT_SHELL_CSS } from "./product-shell-styles.js";

const PRODUCT_OPERATIONAL_MODEL_CSS = readFileSync(new URL("./product.css", import.meta.url), "utf8");

type ProductShellFixture = Omit<Partial<ProductShellModel>, "activeTurn"> & {
  readonly activeTurn?: Omit<ProductAdviceTurn, "kind"> & { readonly kind?: "advice" } | ProductMediaActionTurn;
};

function model(overrides: ProductShellFixture = {}): ProductShellModel {
  const { activeTurn: rawActiveTurn, ...rest } = overrides;
  const activeTurn = rawActiveTurn === undefined
    ? undefined
    : rawActiveTurn.kind === "media_action"
      ? rawActiveTurn
      : { ...rawActiveTurn, kind: "advice" as const };
  return {
    route: "overview",
    household: { name: "小海的家", agentName: "阿灶", memberName: "小海" },
    connection: { state: "quiet", lastChanged: "刚刚" },
    runtimeConfirmations: [
      {
        id: "water-valve",
        title: "关闭厨房总水阀",
        effect: "厨房漏水处置中",
        source: "安全警报处置",
        eligibleActor: "需要管理员",
        expiresIn: "3 分钟",
        expiresAt: "2026-08-21T13:03:00.000Z",
        expiresLabel: "今天 21:03",
        policyClass: "administrator",
      },
    ],
    proposals: [
      {
        id: "media-power",
        revision: 1,
        title: "睡前自动关掉多媒体室电源",
        summary: "观察了 12 天 · 14 天后自然过期",
        why: ["连续 12 天，你在 23:00 之后手动关掉多媒体室的插线板"],
        willDo: ["每天 23:30，若多媒体室 30 分钟无人且没有播放，关闭插线板"],
        dependency: "需要「插座」授权（当前未开）",
        snoozeCount: 0,
      },
    ],
    spaces: [
      {
        id: "living-room",
        name: "客厅",
        deviceCount: 8,
        peopleCount: 2,
        metrics: [{ label: "温度", value: "24.5°" }, { label: "湿度", value: "52%" }],
        devices: ["顶灯 · 开", "灯带 · 开", "空调 26°"],
      },
    ],
    activity: [
      {
        id: "activity-1",
        dateGroup: "today",
        time: "21:12",
        title: "客厅顶灯 已打开 · 空调调到 26°",
        attribution: "hob",
        actor: "阿灶",
        cause: ["门磁传感器打开", "触发场景「回家」v3", "执行客厅顶灯与空调动作"],
      },
    ],
    ...rest,
    ...(activeTurn === undefined ? {} : { activeTurn }),
  };
}

test("renders a responsive shell with independent runtime and proposal badges", () => {
  const html = renderProductShell(model());

  assert.match(html, /<aside[^>]+aria-label="家庭导航"/);
  assert.match(html, /<nav[^>]+aria-label="家庭导航"/);
  assert.match(html, /等待你放行/);
  assert.match(html, /给家的建议/);
  assert.match(html, /data-badge="runtime"/);
  assert.match(html, /data-badge="proposal"/);
  assert.match(html, /data-count="1"/);
  assert.match(html, /data-count="1\/5"/);
  assert.equal(html.includes("data-count=\"2\""), false);
  assert.match(html, /<main[^>]+id="product-main"/);
  assert.match(html, /小海的家/);
  assert.match(html, /placeholder="问问家，或说出你想做的事…"/);
});

test("keeps a host-owned safety banner above navigation and distinguishes quiet from disconnected", () => {
  const html = renderProductShell(model({
    connection: { state: "disconnected", lastContact: "3 小时前" },
    safetyAlerts: [{
      id: "leak",
      title: "厨房漏水传感器有水",
      body: "先关闭厨房总水阀，再确认现场。",
      source: "漏水传感器",
      status: "active",
      actionLabel: "查看处置",
    }],
  }));

  assert.match(html, /data-host-owned="true"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /href="\/review-center"/);
  assert.match(html, /action="\/safety\/leak\/acknowledge"/);
  assert.match(html, /我已看到/);
  assert.match(html, /data-snooze-allowed="false"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<a class="product-skip-link"')), /暂缓|稍后提醒/iu);
  assert.ok(html.indexOf("data-host-owned=\"true\"") < html.indexOf("家庭导航"));
  assert.match(html, /连接中断/);
  assert.match(html, /最后联系 3 小时前/);
  assert.equal(html.includes("连接正常 · 家中无变化"), false);
});

test("shows one Hub-owned background completion notice with the original conversation link", () => {
  const html = renderProductShell(model({
    route: "overview",
    completionNotification: {
      adviceId: "advice-background-1",
      status: "completed",
      completedAt: "2026-08-22T08:00:00.000Z",
    },
  }));

  assert.match(html, /data-background-completion="completed"/);
  assert.match(html, /后台问题已经有结果/);
  assert.match(html, /href="\/conversation\/advice-background-1"/);
});

test("shows a separate low-disruption media completion notice without media details", () => {
  const clarification = renderProductShell({
    ...model(),
    mediaActionCompletionNotification: {
      turnId: "media-clarification-1",
      status: "clarification",
      completedAt: "2026-08-24T08:00:00.000Z",
    },
  } as ProductShellModel);

  assert.match(clarification, /data-media-completion="clarification"/);
  assert.match(clarification, /媒体命令需要补充/);
  assert.match(clarification, /href="\/conversation\/media-clarification-1"/);
  const clarificationBanner = clarification.match(/<section class="product-media-completion-notification"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(clarificationBanner, /(?:question|ticket|mediaRef|opaque-ref)=/iu);
  assert.doesNotMatch(clarificationBanner, /2026-08-24T08:00:00\.000Z/);

  const failed = renderProductShell({
    ...model(),
    mediaActionCompletionNotification: {
      turnId: "media-failed-1",
      status: "failed",
      completedAt: "2026-08-24T08:01:00.000Z",
    },
  } as ProductShellModel);
  assert.match(failed, /data-media-completion="failed"/);
  assert.match(failed, /媒体命令没有完成/);
  assert.match(failed, /href="\/conversation\/media-failed-1"/);
});

test("keeps an acknowledged safety fact visible while lowering the announcement level", () => {
  const html = renderProductShell(model({
    safetyAlerts: [{
      id: "smoke:1",
      title: "烟雾传感器触发",
      source: "走廊烟雾传感器",
      status: "acknowledged",
      severity: "safety",
      snoozeAllowed: false,
      canAcknowledge: false,
    }],
  }));
  assert.match(html, /已看到 · 事实仍在持续/);
  assert.match(html, /data-safety-status="acknowledged"/);
  assert.match(html, /aria-live="polite"/);
  assert.equal(html.includes("我已看到"), false);
});

test("projects unknown household facts and connection states without inventing a configured home", () => {
  const unknown = renderProductShell(model({
    household: {},
    connection: { state: "unknown" },
    spaces: [],
    activity: [],
    route: "overview",
  }));

  assert.match(unknown, /家庭名称待设置/);
  assert.match(unknown, /正在确认家庭连接/);
  assert.match(unknown, /正在确认家里的状态/);
  assert.match(unknown, /家庭空间会在连接完成后显示/);
  assert.doesNotMatch(unknown, /家庭状态稳定|小海|管理员/);

  const connecting = renderProductShell(model({
    household: {},
    connection: { state: "connecting" },
    spaces: [],
  }));
  assert.match(connecting, /正在连接家里/);
  assert.match(connecting, /正在读取家里的当前状态/);

  const settings = renderProductShell(model({
    route: "settings",
    household: {},
  }));
  assert.match(settings, /当前成员.*待设置/s);
  assert.match(settings, /高影响动作.*在绑定本人的私人手机上确认/s);
  assert.doesNotMatch(settings, /身份|管理员|成年成员/, "the settings surface names no member ranks");
  assert.doesNotMatch(settings, /连接详情|查看连接/);
  assert.doesNotMatch(settings, /小海|管理员手机确认/);

  const conversation = renderProductShell(model({
    route: "conversation",
    household: {},
  }));
  assert.match(conversation, /和家庭助手对话/);
  assert.match(conversation, /href="\/voice"/);
  assert.match(conversation, />语音<\/a>/);
  assert.match(conversation, /家庭名称待设置/);
  assert.doesNotMatch(conversation, /阿灶|小海的家/);
  assert.match(conversation, /这台 Hub 尚未启用媒体命令/);
  assert.doesNotMatch(conversation, /可撤销窗口|告诉你已完成的动作|10 秒/);
});

test("keeps conversation entry honest while the household model reconnects", () => {
  const conversation = renderProductShell(model({
    route: "conversation",
    conversationAvailability: "model_unavailable",
    conversationDraft: "窗帘为什么今天开得太早？",
  }));
  assert.match(conversation, /家庭助手模型正在恢复/);
  assert.match(conversation, /href="\/settings#operational-model"/);
  assert.match(conversation, /value="窗帘为什么今天开得太早？"/);
  assert.match(conversation, /id="conversation-question"[^>]*disabled/);
  assert.doesNotMatch(conversation, /我在这里，告诉我家里的情况/);
  assert.doesNotMatch(conversation, /href="\/voice"/);

  const overview = renderProductShell(model({
    route: "overview",
    conversationAvailability: "model_unavailable",
  }));
  assert.match(overview, /家庭助手模型正在恢复/);
  assert.match(overview, /href="\/settings#operational-model"/);
  assert.match(overview, /id="overview-question"[^>]*disabled/);
  assert.match(overview, />问问家里<\/button>/);
  assert.match(overview, /作为媒体命令<\/button>/);
  assert.doesNotMatch(overview, /现在家里怎么样？|今晚有什么要注意的吗？/);
});

test("renders the bounded activity projection without inert filter controls", () => {
  const html = renderProductShell(model({
    route: "activity",
    activity: [{
      id: "external-rule-1",
      dateGroup: "today",
      time: "21:12",
      title: "客厅灯已打开",
      attribution: "external-rule",
    }],
  }));

  assert.doesNotMatch(html, /class="product-filters"/);
  assert.doesNotMatch(html, /<select[^>]+activity-/);
  assert.match(html, /家里发生了什么/);
  assert.match(html, />外部规则<\/span>/);
  assert.doesNotMatch(html, /HA 外部规则/);
});

test("renders streaming stop/background states and only offers a ten-second undo for verified work", () => {
  const overview = renderProductShell(model({
    activeTurn: {
      id: "turn-1",
      question: "把客厅灯打开",
      status: "inspecting",
      stage: "checking_home",
      statusMessage: "正在查看客厅灯",
      canStop: true,
    },
  }));
  assert.match(overview, /正在查看客厅灯/);
  assert.match(overview, /href="\/conversation\/turn-1"/);

  const html = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      id: "turn-1",
      question: "把客厅灯打开",
      status: "streaming",
      stage: "checking_home",
      elapsedSeconds: 12,
      streamText: "我正在核对客厅灯的当前状态。",
      canStop: true,
      canBackground: true,
    },
    undo: {
      id: "undo-1",
      label: "客厅顶灯已打开",
      inverseLabel: "撤销这次打开",
      remainingSeconds: 8,
      status: "available",
    },
  }));

  assert.match(html, /我正在核对客厅灯的当前状态/);
  assert.match(html, />停止</);
  assert.match(html, /稍后处理/);
  assert.match(html, /撤销/);
  assert.match(html, /10 秒内/);
  assert.match(html, /remaining-seconds="8"/);

  const failed = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "turn-2", question: "关灯", status: "failed", error: "家中连接正在恢复" },
    undo: { id: "undo-2", label: "关灯", inverseLabel: "撤销", remainingSeconds: 9, status: "unknown" },
  }));
  assert.match(failed, /家中连接正在恢复/);
  assert.equal(failed.includes("10 秒内"), false);
});

test("renders an explicit media command separately from read-only household advice", () => {
  const entry = renderProductShell(model({ route: "conversation" }));
  assert.match(entry, /播放媒体时，明确选择媒体命令/);
  assert.doesNotMatch(entry, /播放或停止/);

  const clarification = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      kind: "media_action",
      id: "media-clarification-1",
      question: "在多媒体室放 Jazz Evening",
      status: "clarification",
      clarification: {
        slot: "playerCapabilityId",
        reason: "ambiguous",
        options: [{ title: "多媒体室音响", sourceLabel: "家庭音响" }],
      },
    },
  }));

  assert.match(clarification, /还需要确认播放位置/);
  assert.match(clarification, /有多个合适的候选/);
  assert.match(clarification, /多媒体室音响/);
  assert.match(clarification, /请重新明确输入/);
  assert.doesNotMatch(clarification, /已完成/);

  const queueClarification = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "ready",
    mediaActionIdempotencyKey: "a".repeat(32),
    activeTurn: {
      kind: "media_action",
      id: "media-queue-1",
      question: "在多媒体室放 Jazz Evening",
      status: "clarification",
      clarification: {
        slot: "queueMode",
        reason: "missing",
        options: [
          { title: "现在播放", suggestion: "现在播放" },
          { title: "下一首播放", suggestion: "下一首播放" },
          { title: "加入队列", suggestion: "加入队列" },
        ],
      },
    },
  }));
  assert.match(queueClarification, /还需要确认播放方式/);
  assert.match(queueClarification, /现在播放/);
  assert.match(queueClarification, /下一首播放/);
  assert.match(queueClarification, /加入队列/);
  assert.match(queueClarification, /data-media-clarification-suggestion="在多媒体室放 Jazz Evening，下一首播放"/);
  assert.match(queueClarification, />填入这项选择<\/button>/);
  assert.match(queueClarification, /formaction="\/conversation\/media" name="mediaActionIdempotencyKey" value="a{32}">作为媒体命令/);
  assert.doesNotMatch(queueClarification, /replace_and_play|play_next|add_to_queue/);

  const pending = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      kind: "media_action",
      id: "media-ticket-1",
      question: "在多媒体室放 Jazz Evening",
      status: "ticket",
      ticket: { id: "ticket-private", status: "pending_confirmation" },
    },
  }));

  assert.match(pending, /等待你确认/);
  assert.match(pending, /href="\/review-center"/);
  assert.doesNotMatch(pending, /批准|拒绝|ticket-private/);

  const unavailable = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      kind: "media_action",
      id: "media-unavailable-1",
      question: "在多媒体室放 Jazz Evening",
      status: "unavailable",
    },
  }));
  assert.match(unavailable, /动作状态暂不可用/);
  assert.doesNotMatch(unavailable, /已完成/);
  const unavailableCard = unavailable.match(/<section class="product-media-action-turn[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(unavailableCard, /href="\/review-center"/);

  for (const status of ["corrupted", "failed", "cancelled"] as const) {
    const html = renderProductShell(model({
      route: "conversation",
      activeTurn: {
        kind: "media_action",
        id: `media-${status}-1`,
        question: "在多媒体室放 Jazz Evening",
        status,
      },
    }));
    const card = html.match(/<section class="product-media-action-turn[\s\S]*?<\/section>/)?.[0] ?? "";
    if (status === "corrupted") assert.match(card, /href="\/review-center"/);
    else assert.doesNotMatch(card, /href="\/review-center"/);
  }

  const running = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      kind: "media_action",
      id: "media-running-1",
      question: "在多媒体室放 Jazz Evening",
      status: "running",
      elapsedSeconds: 11,
      canStop: true,
    },
  }));
  assert.match(running, /你可以离开这页/);
  assert.match(running, /action="\/conversation\/media-running-1\/stop"/);
});

test("offers a separate media command submit with a server-issued retry key", () => {
  const html = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "ready",
    mediaActionIdempotencyKey: "a".repeat(32),
  }));

  assert.match(html, /action="\/conversation"/);
  assert.match(html, /formaction="\/conversation\/media"/);
  assert.doesNotMatch(html, /<input type="hidden" name="mediaActionIdempotencyKey"/);
  assert.match(html, /<button class="product-media-command-action" type="submit" formaction="\/conversation\/media" name="mediaActionIdempotencyKey" value="a{32}">作为媒体命令<\/button>/);
  assert.match(html, /<button type="submit">问问家里<\/button>/);
  assert.match(html, />作为媒体命令</);
  assert.match(html, />问问家里</);
  assert.match(html, /普通问答只读取和解释家庭状态/);

  const invalidKey = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "ready",
    mediaActionIdempotencyKey: "A".repeat(32),
  }));
  assert.doesNotMatch(invalidKey, /name="mediaActionIdempotencyKey"/);
  assert.match(invalidKey, /formaction="\/conversation\/media" disabled/);
});

test("keeps the media command submit touch-safe at the 390px layout", () => {
  const mobileStyles = PRODUCT_SHELL_CSS.slice(PRODUCT_SHELL_CSS.indexOf("@media (max-width: 28rem)"));

  assert.match(
    mobileStyles,
    /\.product-composer \.product-media-command-action, \.product-conversation-composer \.product-media-command-action \{[^}]*min-height:\s*2\.75rem;/,
  );
});

test("keeps media clarification choices touch-safe at the 390px layout", () => {
  const mobileStyles = PRODUCT_SHELL_CSS.slice(PRODUCT_SHELL_CSS.indexOf("@media (max-width: 28rem)"));

  assert.match(
    mobileStyles,
    /\.product-media-clarification-options \.product-quiet-action \{[^}]*min-height:\s*2\.75rem;/,
  );
});

test("states the Hub-owned media availability before enabling a command", () => {
  const key = "a".repeat(32);
  const unavailable = renderProductShell(model({
    route: "conversation",
    mediaActionIdempotencyKey: key,
  }));
  assert.match(unavailable, /这台 Hub 尚未启用媒体命令/);
  assert.match(unavailable, /formaction="\/conversation\/media" disabled/);

  const busy = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "agent_busy",
    mediaActionIdempotencyKey: key,
  }));
  assert.match(busy, /助手正在处理另一件事/);
  assert.match(busy, /formaction="\/conversation\/media" disabled/);

  for (const [availability, notice] of [
    ["active_turn", "当前一条媒体命令完成后"],
    ["model_unavailable", "家庭助手模型正在恢复"],
    ["stopped", "媒体命令暂不可用"],
    ["unavailable", "媒体命令暂不可用"],
  ] as const) {
    const html = renderProductShell(model({
      route: "conversation",
      mediaActionAvailability: availability,
      mediaActionIdempotencyKey: key,
    }));
    assert.match(html, new RegExp(notice));
    assert.match(html, /formaction="\/conversation\/media" disabled/);
  }

  const readyWithoutKey = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "ready",
  }));
  assert.match(readyWithoutKey, /请刷新此页后重试/);
  assert.match(readyWithoutKey, /formaction="\/conversation\/media" disabled/);

  const ready = renderProductShell(model({
    route: "conversation",
    mediaActionAvailability: "ready",
    mediaActionIdempotencyKey: key,
  }));
  assert.match(ready, /formaction="\/conversation\/media" name="mediaActionIdempotencyKey" value="a{32}">作为媒体命令/);
  assert.match(ready, /普通问答只读取和解释家庭状态/);
});

test("renders only completed answers as completion and keeps idle or unknown turns waiting", () => {
  const idle = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "idle-1", question: "现在家里怎么样？", status: "idle" },
  }));
  assert.match(idle, /等待你继续提问|等待处理/);
  assert.doesNotMatch(idle, /已完成|已经完成/);

  const unknown = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "unknown-1", question: "现在家里怎么样？", status: "unknown" },
  }));
  assert.match(unknown, /正在确认这次问题的状态|等待处理/);
  assert.doesNotMatch(unknown, /已完成|已经完成/);

  const completed = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "completed-1", question: "现在家里怎么样？", status: "completed", answer: "家里状态稳定。" },
  }));
  assert.match(completed, /家里状态稳定/);
  assert.match(completed, /已完成/);
});

test("states missing proposal evidence and actions without inventing recent context or a seven-day trial", () => {
  const html = renderProductShell(model({
    route: "reviews",
    selectedProposalId: "proposal-empty",
    proposals: [{
      id: "proposal-empty",
      revision: 1,
      title: "一项待补充的家庭建议",
      status: "pending",
    }],
    selectedProposal: {
      id: "proposal-empty",
      revision: 1,
      title: "一项待补充的家庭建议",
      status: "pending",
    },
  }));
  assert.match(html, /暂无已记录证据/);
  assert.match(html, /待补充/);
  assert.doesNotMatch(html, /最近家里的情况/);
  assert.doesNotMatch(html, /试运行 7 天/);
});

test("offers explicit correction choices only on a completed conversation turn", () => {
  const completed = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      id: "advice-1",
      question: "窗帘为什么有时开得太早？",
      status: "completed",
      answer: "最近两周有几次手动调整。",
    },
  }));
  assert.match(completed, /action="\/conversation\/advice-1\/correction"/);
  assert.match(completed, /name="correctionType" value="household_fact"/);
  assert.match(completed, /name="correctionType" value="household_preference"/);
  assert.match(completed, /name="correctionType" value="future_behavior"/);
  assert.match(completed, /name="idempotencyKey" value="advice-1:correction"/);
  assert.match(completed, /name="correction"[^>]*autocomplete="off"/);
  assert.match(completed, /placeholder="告诉我需要记住什么…"/);
  assert.doesNotMatch(completed, /action="\/conversation\/advice-1\/correction"[^>]*>[^]*name="correctionType" value="other"/);

  const failed = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "advice-failed", question: "刚才发生了什么？", status: "failed" },
  }));
  assert.doesNotMatch(failed, /correctionType/);
});

test("shows correction acknowledgement only when the Hub projection supplies it", () => {
  const ordinary = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      id: "advice-ordinary",
      question: "家里现在安静吗？",
      status: "completed",
      answer: "连接正常，家中没有新的变化。",
    },
  }));
  assert.doesNotMatch(ordinary, /已更新/);
  const acknowledged = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      id: "advice-1",
      question: "窗帘为什么有时开得太早？",
      status: "completed",
      answer: "最近两周有几次手动调整。",
      correctionAck: "已更新",
      correctionDestination: "处理中心 · 给家的建议",
      correctionProposalId: "proposal-1",
      correctionProposalCount: 1,
    },
  }));
  assert.match(acknowledged, /已更新/);
  assert.match(acknowledged, /处理中心 · 给家的建议/);
  assert.match(acknowledged, /当前 1 条建议/);
});

test("separates the later action from the one-decision detail and explains activity cause attribution", () => {
  const review = renderProductShell(model({ route: "reviews", selectedProposalId: "media-power" }));

  assert.match(review, /data-runtime-countdown/);
  assert.match(review, /data-expires-at="2026-08-21T13:03:00.000Z"/);
  assert.match(review, /今天 21:03/);
  assert.doesNotMatch(review, />2026-08-21T13:03:00.000Z</);
  assert.match(review, /查看方案/);
  assert.match(review, /以后再说/);
  assert.match(review, /name="until" value="later"/);
  assert.match(review, /action="\/review-center\/proposals\/media-power\/enable"/);
  assert.match(review, /name="expectedRevision" value="1"/);
  assert.doesNotMatch(review, /action="\/review-center\/proposals\/media-power\/advance"/);
  assert.match(review, />启用</);
  assert.match(review, /<ul class="product-readiness" aria-label="方案已备好">|方案已备好/);
  assert.match(review, /这是唯一一次点头/);
  assert.match(review, /href="\/automations"/);
  assert.match(review, /action="\/review-center\/proposals\/media-power\/reject"[^>]*>/);
  assert.match(review, /action="\/review-center\/proposals\/media-power\/reject-latch"[^>]*>/);
  assert.match(review, /需要「插座」授权/);

  const activity = renderProductShell(model({ route: "activity" }));
  assert.match(activity, /今天/);
  assert.match(activity, /为什么会这样/);
  assert.match(activity, /data-attribution="hob"/);
  assert.match(activity, /由阿灶完成/);
  assert.match(activity, /触发场景「回家」v3/);
});

test("reveals a household-readable agent journey for the selected proposal", () => {
  const trace = {
    sessionId: "private-session",
    asOfSeq: 9,
    turns: [{ turn: 1, status: "completed" as const, startedAt: 10, endedAt: 90, durationMs: 80 }],
    steps: [{ turn: 1, step: 1, status: "completed" as const, startedAt: 20, endedAt: 80, durationMs: 60 }],
    tools: [{ id: "call-1", turn: 1, step: 1, name: "get_home_snapshot", status: "completed" as const, startedAt: 30, endedAt: 50, durationMs: 20 }],
    compactions: [],
    prunes: [],
    usage: { inputTokens: 12, outputTokens: 4, reasoningTokens: 3 },
  };
  const html = renderProductShell(model({
    route: "reviews",
    selectedProposalId: "media-power",
    selectedProposal: { ...model().proposals![0]!, trace },
  }));

  assert.match(html, /<details class="product-agent-journey">/);
  assert.match(html, /这条建议怎么得来的/);
  assert.match(html, /查看家庭概况/);
  assert.match(html, /1 轮分析 · 1 个步骤 · 1 项检查/);
  assert.match(html, /运行信息/);
  assert.doesNotMatch(html, /private-session|get_home_snapshot/);
});

test("uses the household agent name for agent-attributed activity", () => {
  const activity = renderProductShell(model({
    route: "activity",
    household: { name: "山海的家", agentName: "小满" },
  }));

  assert.match(activity, /data-attribution="hob"[^>]*>小满</);
  assert.doesNotMatch(activity, />阿灶</);
});

test("ships responsive and preference-aware presentation tokens without decorative assets", () => {
  const html = renderProductShell(model());
  assert.match(PRODUCT_SHELL_CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(PRODUCT_SHELL_CSS, /prefers-reduced-motion/);
  assert.match(PRODUCT_SHELL_CSS, /prefers-reduced-transparency/);
  assert.match(PRODUCT_SHELL_CSS, /prefers-contrast/);
  assert.match(PRODUCT_SHELL_CSS, /max-width: 56rem/);
  assert.match(PRODUCT_SHELL_CSS, /-apple-system/);
  assert.match(PRODUCT_SHELL_CSS, /touch-action:\s*manipulation/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-skip-link\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-view-switcher\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(PRODUCT_SHELL_CSS, /nav\[data-host-view-shortcuts\]\s+a\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-host-view-menu summary\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-primary-action, \.product-secondary-action, \.product-danger-action\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.doesNotMatch(PRODUCT_SHELL_CSS, /-webkit-tap-highlight-color:\s*transparent/);
  assert.equal(PRODUCT_SHELL_CSS.includes("gradient"), false);
  assert.equal(PRODUCT_SHELL_CSS.includes("<svg"), false);
  assert.doesNotMatch(html, /[⌄✓●→↗⚙⌂◷≋▱□]/);
  assert.equal(html.includes('class="product-mobile-header"'), false);
  assert.match(PRODUCT_SHELL_CSS, /\.product-main > \.product-composer \{ position: fixed;/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-composer, \.product-conversation-composer \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-conversation-composer \.product-media-command-action \{[^}]*background: var\(--shell-surface\)/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-shell\[data-route="onboarding"\] \.product-mobile-nav \{ display: none;/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-shell\[data-route="onboarding"\] \.product-onboarding-list \{ display: none;/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-presentation-choice:has\(input:checked\)/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-presentation-choice:has\(input:focus-visible\)/);
  assert.match(PRODUCT_SHELL_CSS, /data-control-row-density="compact"/);
  assert.match(PRODUCT_SHELL_CSS, /\.product-host-view-menu-panel\s*\{[^}]*position:\s*absolute/);
  assert.match(PRODUCT_SHELL_CSS, /@media\s*\(max-width:\s*56rem\)[\s\S]*\.product-host-view-menu-panel\s*\{[^}]*position:\s*fixed/);
});

test("keeps muted copy AA-readable when dark mode requests more contrast", () => {
  const override = PRODUCT_SHELL_CSS.match(
    /@media \(prefers-color-scheme: dark\) and \(prefers-contrast: more\) \{\s*:root \{[^}]*--shell-muted:\s*(#[0-9a-f]{6});[^}]*--shell-subtle:\s*(#[0-9a-f]{6});/i,
  );
  assert.ok(override);

  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
    const [red = 0, green = 0, blue = 0] = channels.map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (foreground: string, background: string): number => {
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };

  assert.ok(contrast(override[1]!, "#202522") >= 4.5);
  assert.ok(contrast(override[2]!, "#202522") >= 4.5);
});

test("keeps two views as direct shortcuts and presents larger catalogs in a Host menu", () => {
  const twoViews = renderProductShell(model({
    view: {
      activeId: "builtin.life",
      currentPath: "/home",
      choices: [
        { id: "builtin.life", label: "生活视图" },
        { id: "builtin.control", label: "控制视图" },
      ],
    },
  }));
  assert.match(twoViews, /data-host-view-shortcuts/);
  assert.doesNotMatch(twoViews, /data-host-view-menu/);

  const manyViews = renderProductShell(model({
    view: {
      activeId: "community.wall-panel",
      currentPath: "/home",
      choices: [
        { id: "builtin.life", label: "生活视图" },
        { id: "builtin.control", label: "控制视图" },
        { id: "community.calm-home", label: "安静家庭" },
        { id: "community.wall-panel", label: "墙面面板" },
      ],
    },
  }));
  assert.match(manyViews, /<details class="product-host-view-menu" data-host-view-menu>/);
  assert.match(manyViews, /<summary[^>]*data-host-view-menu-trigger[^>]*><span>当前视图<\/span><strong>墙面面板<\/strong><\/summary>/);
  assert.match(manyViews, /class="product-host-view-menu-panel"/);
  assert.match(manyViews, /aria-label="可用家庭视图"/);
  assert.match(manyViews, /href="\/settings">管理视图<\/a>/);
  assert.match(manyViews, /href="\/home\?view=community\.wall-panel" aria-current="true"/);
  assert.doesNotMatch(manyViews, /data-host-view-scroll/);
});

test("arranges declarative recipes from Host-rendered slots and preserves canonical fallback routes", () => {
  const recipe = {
    apiVersion: "hob.view.recipe/v1",
    id: "community.review-first",
    title: "先看决定",
    pages: [{
      route: "overview",
      layout: "split",
      slots: [
        { slot: "overview.header", width: "full" },
        { slot: "overview.review-summary", width: "half" },
        { slot: "overview.spaces", width: "half" },
        { slot: "overview.composer", width: "full" },
      ],
    }],
  };
  const source = model();
  const content = renderProductViewRecipeContent(recipe, source);
  const html = renderProductHost(source, content);

  assert.match(html, /data-recipe-provider="community\.review-first"/);
  assert.match(html, /data-recipe-layout="split"/);
  assert.match(html, /data-recipe-slot="overview\.review-summary" data-recipe-width="half"/);
  assert.ok(content.indexOf("需要你决定") < content.indexOf("客厅"));
  assert.match(content, /action="\/conversation"/);
  assert.match(content, /小海的家/);
  assert.equal((content.match(/<h1/g) ?? []).length, 1);
  assert.doesNotMatch(content, /先看决定/);

  const controlSource = model({ route: "control" });
  assert.equal(
    renderProductViewRecipeContent(recipe, controlSource),
    renderProductContent(controlSource),
  );
  assert.match(PRODUCT_SHELL_CSS, /\.product-recipe-layout\s*\{[^}]*grid-template-columns:\s*repeat\(6,/);
  assert.match(PRODUCT_SHELL_CSS, /data-recipe-width="third"/);
  assert.match(PRODUCT_SHELL_CSS, /data-recipe-width="half"\] \.product-space-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("keeps control, settings, and onboarding as reachable server-rendered destinations", () => {
  const control = renderProductShell(model({ route: "control" }));
  const settings = renderProductShell(model({ route: "settings" }));
  const onboarding = renderProductShell(model({ route: "onboarding", onboarding: { step: 5 } }));

  assert.match(control, /<h1>家里的状态<\/h1>/);
  assert.match(control, /正在更新这个空间的状态/);
  assert.doesNotMatch(control, /action="\/control\/living-room-0"/);
  assert.match(settings, /家庭设置/);
  assert.match(settings, /继续首次设置/);
  assert.match(onboarding, /第 5 步，共 8 步/);
  assert.match(onboarding, /这些动作怎么确认/);
  assert.match(onboarding, /action="\/onboarding\/continue"/);
});

test("bounds the layout preview track independently of its digest and iframe", () => {
  assert.match(PRODUCT_SHELL_CSS, /\.product-layout-preview\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(PRODUCT_SHELL_CSS, /\.product-layout-preview > header\s*\{[^}]*min-width:\s*0/s);
  assert.match(PRODUCT_SHELL_CSS, /\.product-layout-preview code\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
});

test("renders Host-owned device view defaults with an explicit permission boundary", () => {
  const manageableView = {
    activeId: "builtin.control",
    currentPath: "/settings",
    choices: [
      { id: "builtin.life", label: "生活视图" },
      { id: "builtin.control", label: "控制视图" },
    ],
    defaultId: "builtin.life",
    canSetDeviceDefault: true,
    preferences: [{
      key: "rowDensity",
      label: "设备行距",
      description: "选择控制列表的行距。",
      value: "comfortable",
      choices: [
        { value: "comfortable", label: "舒展" },
        { value: "compact", label: "紧凑" },
      ],
    }],
  } as NonNullable<ProductShellModel["view"]>;
  const settings = renderProductShell(model({ route: "settings", view: manageableView }));

  assert.match(settings, /<h2[^>]*>这台设备的默认视图<\/h2>/);
  assert.match(settings, /method="post" action="\/settings\/view-default"/);
  assert.match(settings, /name="viewId" value="builtin\.control"/);
  assert.match(settings, /data-view-choice="builtin\.control" data-state="active"/);
  assert.match(settings, /data-view-choice="builtin\.life"[^>]*data-default-state="default"/);
  assert.match(settings, /生活视图<\/strong><small>下次打开时使用<\/small>/);
  assert.match(settings, /控制视图<\/strong><small>当前会话正在使用<\/small>/);
  assert.match(settings, /class="product-view-default-status">设备默认<\/span>/);
  assert.match(settings, /name="mode" value="reset"/);
  assert.match(settings, /<h2[^>]*>控制视图的显示方式<\/h2>/);
  assert.match(settings, /method="post" action="\/settings\/view-presentation"/);
  assert.match(settings, /name="providerId" value="builtin\.control"/);
  assert.match(settings, /name="key" value="rowDensity"/);
  assert.match(settings, /name="value" value="comfortable" checked/);
  assert.match(settings, /舒展/);
  assert.match(settings, /紧凑/);

  const readOnlyView = renderProductShell(model({
    route: "settings",
    view: { ...manageableView, canSetDeviceDefault: false } as NonNullable<ProductShellModel["view"]>,
  }));
  assert.doesNotMatch(readOnlyView, /action="\/settings\/view-default"/);
  assert.doesNotMatch(readOnlyView, /action="\/settings\/view-presentation"/);
  assert.match(readOnlyView, /在绑定到本人的私人手机上可以设置这台共享设备的默认视图/);
});

test("renders neutral control forms and explicit action feedback with a ten-second undo", () => {
  const html = renderProductShell(model({
    route: "control",
    view: {
      activeId: "builtin.control",
      currentPath: "/control",
      choices: [
        { id: "builtin.life", label: "生活视图" },
        { id: "builtin.control", label: "控制视图" },
      ],
      preferences: [{
        key: "rowDensity",
        label: "设备行距",
        description: "选择控制列表的行距。",
        value: "compact",
        choices: [
          { value: "comfortable", label: "舒展" },
          { value: "compact", label: "紧凑" },
        ],
      }],
    },
    controlSpaces: [{
      id: "living-room",
      name: "客厅",
      deviceCount: 1,
      devices: ["顶灯 · 开"],
      controls: [{ id: "cap-light", label: "顶灯", value: "开", actionLabel: "关闭" }],
    }],
    controlFeedback: {
      capabilityId: "cap-light",
      ticketId: "action-ticket-1",
      status: "verified",
      label: "关闭顶灯",
      detail: "关闭顶灯已完成。",
      undo: {
        id: "action-ticket-1",
        label: "关闭顶灯已完成",
        inverseLabel: "恢复打开",
        remainingSeconds: 9,
        status: "available",
      },
    },
  }));

  assert.match(html, /action="\/control\/cap-light"/);
  assert.match(html, /data-control-density="dense"/);
  assert.match(html, /data-control-row-density="compact"/);
  assert.match(html, /class="product-host-view-switcher"/);
  assert.match(html, /data-host-view-shortcuts/);
  assert.match(html, /aria-label="可用家庭视图"/);
  assert.doesNotMatch(html, /class="product-view-switcher"[^>]*>生活视图<\/a>/);
  assert.match(html, /aria-label="家庭控制概览"/);
  assert.match(html, /data-control-space="living-room"/);
  assert.match(html, /data-control-capability="cap-light"/);
  assert.match(html, /class="product-control-current-value">开<\/span>/);
  assert.match(html, /每项动作都按影响程度处理，需要确认的会先等你同意/);
  assert.doesNotMatch(html, />[^<]*Hub[^<]*</);
  assert.doesNotMatch(html, /product-card product-control-card/);
  assert.match(html, /data-control-status="verified"/);
  assert.match(html, /关闭顶灯已完成/);
  assert.match(html, /action="\/actions\/action-ticket-1\/undo"/);
  assert.match(html, /10 秒内/);
  assert.doesNotMatch(html, /light\.living/);

  const pending = renderProductShell(model({
    route: "control",
    controlFeedback: {
      capabilityId: "cap-lock",
      ticketId: "confirmation-1",
      status: "pending_confirmation",
      label: "锁上入户门",
      detail: "锁上入户门正在等待你放行。",
      expiresAt: "2026-08-20T10:00:10.000Z",
    },
  }));
  assert.match(pending, /data-control-status="pending_confirmation"/);
  assert.match(pending, /等待你放行/);
  assert.match(pending, /data-control-expires-at="2026-08-20T10:00:10.000Z"/);

  const failed = renderProductShell(model({
    route: "control",
    controlFeedback: {
      capabilityId: "cap-light",
      ticketId: "action-ticket-2",
      status: "failed",
      label: "关闭顶灯",
      detail: "关闭顶灯没有完成，家里保持原状。",
    },
  }));
  assert.match(failed, /data-control-status="failed"/);
  assert.match(failed, /家里保持原状/);
});

test("models control availability across every household connection state", () => {
  const expectations: Readonly<Record<ProductConnectionState, {
    readonly availability: "available" | "waiting";
    readonly summary: string;
    readonly disabled: boolean;
    readonly value: string;
  }>> = {
    connected: { availability: "available", summary: "每项动作都按影响程度处理", disabled: false, value: "开" },
    quiet: { availability: "available", summary: "每项动作都按影响程度处理", disabled: false, value: "开" },
    connecting: { availability: "waiting", summary: "正在连接家庭设备", disabled: true, value: "上次：开" },
    disconnected: { availability: "waiting", summary: "家庭连接正在恢复", disabled: true, value: "上次：开" },
    unknown: { availability: "waiting", summary: "正在确认家庭连接", disabled: true, value: "上次：开" },
  };

  for (const [state, expected] of Object.entries(expectations) as Array<[ProductConnectionState, typeof expectations[ProductConnectionState]]>) {
    const html = renderProductShell(model({
      route: "control",
      connection: { state },
      controlSpaces: [{
        id: "living-room",
        name: "客厅",
        controls: [{ id: "cap-light", label: "顶灯", value: "开", actionLabel: "关闭", policyClass: "direct" }],
      }],
    }));

    assert.match(html, new RegExp(`data-control-availability="${expected.availability}"`), state);
    assert.match(html, new RegExp(expected.summary), state);
    assert.match(html, new RegExp(`class="product-control-current-value">${expected.value}<\\/span>`), state);
    assert.equal(/<button[^>]+disabled/.test(html), expected.disabled, state);
    if (expected.disabled) assert.match(html, /连接恢复后可用/, state);
  }
});

test("keeps every control feedback state in a valid interaction shape", () => {
  const expectations: Readonly<Record<ProductControlFeedback["status"], {
    readonly label: string;
    readonly undo: boolean;
    readonly expiry: boolean;
  }>> = {
    verified: { label: "已完成", undo: true, expiry: false },
    pending_confirmation: { label: "等待你放行", undo: false, expiry: true },
    failed: { label: "动作未完成", undo: false, expiry: false },
    unknown: { label: "正在确认结果", undo: false, expiry: false },
  };

  for (const [status, expected] of Object.entries(expectations) as Array<[ProductControlFeedback["status"], typeof expectations[ProductControlFeedback["status"]]]>) {
    const html = renderProductShell(model({
      route: "control",
      controlSpaces: [],
      controlFeedback: {
        capabilityId: "cap-light",
        ticketId: "ticket-1",
        status,
        label: "关闭顶灯",
        detail: "动作状态已经更新。",
        expiresAt: "2026-08-22T08:10:00.000Z",
        expiresIn: "2 分钟",
        undo: {
          id: "ticket-1",
          label: "关闭顶灯已完成",
          inverseLabel: "恢复打开",
          remainingSeconds: 8,
          status: "available",
        },
      },
    }));

    assert.match(html, new RegExp(`data-control-status="${status}"`), status);
    assert.match(html, new RegExp(expected.label), status);
    assert.equal(html.includes('/actions/ticket-1/undo'), expected.undo, status);
    assert.equal(html.includes('data-control-expires-at='), expected.expiry, status);
  }
});

test("renders bounded batch selection, policy preview, and per-item outcomes", () => {
  const html = renderProductShell(model({
    route: "control",
    batchControl: {
      preview: {
        total: 3,
        direct: 1,
        confirmation: 1,
        administrator: 1,
        items: [
          { capabilityId: "cap-light", label: "顶灯", actionLabel: "关闭", policyClass: "direct" },
          { capabilityId: "cap-fan", label: "风扇", actionLabel: "调到二档", policyClass: "confirmation" },
          { capabilityId: "cap-lock", label: "门锁", actionLabel: "锁门", policyClass: "administrator" },
        ],
      },
      result: {
        requestId: "batch-request-1",
        counts: { total: 3, verified: 1, pending_confirmation: 1, failed: 1, unknown: 0 },
        items: [
          {
            capabilityId: "cap-light",
            requestId: "batch-request-1",
            policyClass: "direct",
            status: "verified",
            ticketId: "ticket-light",
            reason: "动作已完成并验证。",
            verification: "verified",
            label: "顶灯",
          },
          {
            capabilityId: "cap-fan",
            requestId: "batch-request-1",
            policyClass: "confirmation",
            status: "pending_confirmation",
            ticketId: "ticket-fan",
            reason: "等待现有确认所有者处理。",
            verification: "pending_confirmation",
            label: "风扇",
          },
          {
            capabilityId: "cap-lock",
            requestId: "batch-request-1",
            policyClass: "administrator",
            status: "failed",
            reason: "管理员确认未完成。",
            verification: "failed",
            label: "门锁",
          },
        ],
      },
    },
  }));

  assert.match(html, /data-batch-control/);
  assert.match(html, /action="\/control\/batch"/);
  assert.match(html, /name="capabilityId" value="cap-light"/);
  assert.match(html, /name="capabilityId" value="cap-fan"/);
  assert.match(html, /name="capabilityId" value="cap-lock"/);
  assert.match(html, /data-batch-policy-class="direct"/);
  assert.match(html, /data-batch-policy-class="confirmation"/);
  assert.match(html, /data-batch-policy-class="administrator"/);
  assert.match(html, /data-batch-count="total"[^>]*>3/);
  assert.match(html, /data-batch-count="direct"[^>]*>1/);
  assert.match(html, /data-batch-count="confirmation"[^>]*>1/);
  assert.match(html, /data-batch-count="administrator"[^>]*>1/);
  assert.match(html, /data-batch-result-status="verified"[^>]*data-ticket-id="ticket-light"/);
  assert.match(html, /data-batch-result-status="pending_confirmation"[^>]*data-ticket-id="ticket-fan"/);
  assert.match(html, /data-batch-result-status="failed"/);
  assert.match(html, /每项动作分别处理/);
  assert.doesNotMatch(html, /整批.*成功|batch.*success/i);
});

test("does not render a batch action surface when the owner omits it", () => {
  const html = renderProductShell(model({ route: "control" }));
  assert.doesNotMatch(html, /data-batch-control/);
});

test("renders all eight onboarding steps with clear server-postable fields", () => {
  const expectations: readonly [number, RegExp, RegExp][] = [
    [1, /认识与起名|给家起个名字/, /name="agentName"/],
    [2, /只读接桥|接入已有的家|只读/, /name="bridgeId"/],
    [3, /家庭地图|确认现在的家/, /name="mapConfirmed"/],
    [4, /家人与手机|家里都有谁/, /name="memberName"/],
    [5, /动作怎么确认|这些动作怎么确认/, /家庭能力列表正在准备|name="capability:/],
    [6, /安全预演|红色的规矩/, /name="safetyAcknowledged"/],
    [7, /第一周期待|第一周/, /name="observationInterval"/],
    [8, /第一问|跟阿灶说句话/, /name="firstQuestion"/],
  ];

  for (const [step, content, field] of expectations) {
    const html = renderProductShell(model({
      route: "onboarding",
      onboarding: { step },
    }));
    assert.match(html, new RegExp(`data-onboarding-step="${step}"`));
    assert.match(html, new RegExp(`role="progressbar"[^>]*aria-valuenow="${step}"[^>]*aria-valuemin="1"[^>]*aria-valuemax="8"`));
    assert.match(html, new RegExp(`aria-valuetext="第 ${step} 步，共 8 步"`));
    assert.match(html, content);
    assert.match(html, field);
    assert.match(html, new RegExp(`name="step" value="${step}"`));
    assert.match(html, /method="post" action="\/onboarding\/continue"/);
    assert.match(html, /<button[^>]+type="submit"/);
  }

  const safety = renderProductShell(model({ route: "onboarding", onboarding: { step: 6 } }));
  assert.match(safety, /name="safetyAcknowledged"[^>]+required/);

  const identity = renderProductShell(model({ route: "onboarding", onboarding: { step: 1 } }));
  assert.match(identity, /type="text" name="agentName"[^>]*autocomplete="off"/);
  assert.match(identity, /type="text" name="householdName"[^>]*autocomplete="off"/);

  const observation = renderProductShell(model({ route: "onboarding", onboarding: { step: 7 } }));
  assert.match(observation, /type="time" name="quietHoursStart"[^>]*autocomplete="off"/);
  assert.match(observation, /type="time" name="quietHoursEnd"[^>]*autocomplete="off"/);
});

test("renders only projected bridge and capability ids, with a blocked read-only state when choices are absent", () => {
  const dynamic = {
    route: "onboarding" as const,
    onboarding: {
      step: 2,
      choices: {
        status: "available" as const,
        bridges: [
          { id: "xiaomi-main", label: "小米家庭", description: "已完成只读同步", selectable: true },
        ],
        capabilities: [
          { id: "cap-lamp", label: "客厅主灯 · 灯光", bridgeId: "xiaomi-main", bridgeLabel: "小米家庭", suggestedPolicyClass: "direct" as const },
        ],
      },
    },
  } as unknown as ProductShellModel;
  const bridgeHtml = renderProductShell(model(dynamic));
  assert.match(bridgeHtml, /value="xiaomi-main"/);
  assert.match(bridgeHtml, /小米家庭/);
  assert.doesNotMatch(bridgeHtml, /home-assistant/);

  const permissionHtml = renderProductShell(model({
    route: "onboarding",
    onboarding: {
      step: 5,
      choices: dynamic.onboarding.choices,
    } as unknown as ProductShellModel["onboarding"],
  }));
  assert.match(permissionHtml, /value="cap-lamp"/);
  assert.match(permissionHtml, /name="capability:cap-lamp"/);
  assert.doesNotMatch(permissionHtml, /lights_curtains|media_playback|ordinary_switches|climate|cross_space_batch/);

  const unavailableHtml = renderProductShell(model({
    route: "onboarding",
    onboarding: { step: 2, choices: { status: "unavailable", reason: "world_unavailable", bridges: [], capabilities: [] } } as unknown as ProductShellModel["onboarding"],
  }));
  assert.match(unavailableHtml, /家庭设置正在准备|连接完成后从这里继续/);
  assert.match(unavailableHtml, /disabled/);
  assert.doesNotMatch(unavailableHtml, /value="home-assistant"/);
});

test("uses affirmative copy that matches the adult binding and observation schedule commands", () => {
  const member = renderProductShell(model({ route: "onboarding", onboarding: { step: 4 } }));
  assert.match(member, /绑定到本人的私人手机/);
  assert.doesNotMatch(member, /默认都是管理员|不用建账号|不会拿到审批权/);

  const schedule = renderProductShell(model({ route: "onboarding", onboarding: { step: 7 } }));
  assert.match(schedule, /name="observationInterval"/);
  assert.match(schedule, /name="observationEnabled"/);
  assert.doesNotMatch(schedule, /firstWeekExpectation/);
  assert.doesNotMatch(schedule, /不会突然|只看、不动手/);
});

test("accepts neutral step data while keeping household fields escaped and independently named", () => {
  const html = renderProductShell(model({
    route: "onboarding",
    onboarding: {
      step: 2,
      steps: [
        {
          step: 2,
          key: "bridge",
          label: "只读接桥",
          title: "把已有的家接进来",
          body: "先读，不改变现有设备。",
          fields: [
            {
              name: "bridgeId",
              type: "select",
              label: "选择家庭连接",
              value: "ha-local",
              options: [{ value: "ha-local", label: "Home Assistant（只读）" }],
            },
            {
              name: "bridgeNote",
              type: "textarea",
              label: "需要说明的事",
              value: "<本地>",
            },
          ],
          submitLabel: "只读连接",
        },
      ],
    },
  }));

  assert.match(html, /把已有的家接进来/);
  assert.match(html, /name="bridgeId"/);
  assert.match(html, /Home Assistant（只读）/);
  assert.match(html, /name="bridgeNote"/);
  assert.match(html, /&lt;本地&gt;/);
  assert.match(html, />只读连接</);
});

test("uses product mobile destinations and keeps runtime and proposal badges separate", () => {
  const html = renderProductShell(model({ route: "control" }));

  assert.match(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="overview"[^>]*>[\s\S]*?家/);
  assert.match(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="reviews"[^>]*>[\s\S]*?处理/);
  assert.match(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="control"[^>]*>[\s\S]*?空间/);
  assert.match(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="activity"[^>]*>[\s\S]*?活动/);
  assert.match(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="settings"[^>]*>[\s\S]*?设置/);
  assert.doesNotMatch(html, /class="product-mobile-nav-link"[^>]+data-mobile-route="conversation"/);

  const mobileNav = html.slice(html.indexOf('<nav class="product-mobile-nav"'));
  assert.match(mobileNav, /data-badge="runtime"/);
  assert.match(mobileNav, /data-badge="proposal"/);
  assert.match(mobileNav, /aria-label="1 项等待你放行，1\/5 条建议"/);
});

test("keeps internal framing and implementation vocabulary out of household copy", () => {
  const pages = [
    renderProductShell(model()),
    renderProductShell(model({ route: "conversation" })),
    renderProductShell(model({ route: "reviews" })),
    renderProductShell(model({ route: "activity" })),
    renderProductShell(model({ route: "control" })),
    renderProductShell(model({ route: "settings" })),
    renderProductShell(model({ route: "onboarding" })),
  ];

  for (const html of pages) {
    assert.doesNotMatch(html, /家庭上下文|同一份家庭事实|来源与权限|Enter 发送|建议位|提案进度|转后台|策略/);
  }
});

test("uses one canonical ProductShell projection and ignores legacy aliases", () => {
  const legacy = {
    route: "overview" as const,
    household: { name: "小海的家", agentName: "阿灶" },
    connection: { state: "quiet" as const },
    confirmations: [{ id: "legacy-runtime", title: "legacy-runtime" }],
    reviews: {
      runtimeConfirmations: [{ id: "legacy-review-runtime", title: "legacy-review-runtime" }],
      proposals: [{ id: "legacy-review-proposal", revision: 1, title: "legacy-review-proposal" }],
    },
    home: { spaces: [{ id: "legacy-space", name: "legacy-space" }] },
    turn: { id: "legacy-turn", question: "legacy-turn", status: "completed" as const },
    safetyAlert: { id: "legacy-safety", title: "legacy-safety", status: "active" as const },
  } as unknown as ProductShellModel;
  const legacyHtml = renderProductShell(legacy);
  assert.doesNotMatch(legacyHtml, /legacy-runtime|legacy-review|legacy-space|legacy-turn|legacy-safety/);

  const canonicalHtml = renderProductShell(model({
    runtimeConfirmations: [{ id: "canonical-runtime", title: "canonical-runtime" }],
    spaces: [{ id: "canonical-space", name: "canonical-space" }],
    activeTurn: { id: "canonical-turn", question: "canonical-turn", status: "completed" },
    safetyAlerts: [{ id: "canonical-safety", title: "canonical-safety", status: "active" }],
  }));
  assert.match(canonicalHtml, /canonical-runtime|canonical-space|canonical-safety/);
});

test("runtime cards keep gate colors, natural countdown, and reject before approve", () => {
  const future = new Date(Date.now() + 3 * 60_000).toISOString();
  const html = renderProductShell(model({
    route: "reviews",
    runtimeConfirmations: [
      { id: "water-valve", title: "关闭厨房总水阀", eligibleActor: "需要管理员", source: "安全警报处置", expiresIn: "3 分钟", expiresAt: future, expiresLabel: "今天 21:03", policyClass: "administrator", canApprove: true },
      { id: "mijia-update", title: "今晚 03:00 更新米家桥接程序", eligibleActor: "任一成员可放行", source: "系统维护", expiresIn: "40 分钟", expiresAt: future, policyClass: "confirmation", canApprove: true },
    ],
  }));
  const adminCard = html.slice(html.indexOf('data-review-id="water-valve"'), html.indexOf('data-review-id="mijia-update"'));
  assert.match(adminCard, /product-tag product-tag--red">需要管理员/);
  assert.match(adminCard, /3 分钟后自动取消/);
  assert.match(adminCard, /没人点头就不做 · 截止 今天 21:03/);
  assert.ok(adminCard.indexOf(">拒绝<") < adminCard.indexOf("放行（手机确认）"));
  const memberCard = html.slice(html.indexOf('data-review-id="mijia-update"'), html.lastIndexOf("</article>"));
  assert.match(memberCard, /product-tag product-tag--neutral">任一成员可放行/);
  assert.doesNotMatch(memberCard, /product-tag--red/);
});

test("disconnected overview marks last-known data and keeps one recovery entry", () => {
  const html = renderProductShell(model({
    connection: { state: "disconnected", lastContact: "3 小时前" },
  }));
  assert.match(html, /最后已知/);
  assert.match(html, /查看连接/);
  assert.match(html, /不执行任何设备动作/);
  assert.match(html, /placeholder="可以提问；涉及设备的动作会等连接恢复"/);

  const connected = renderProductShell(model());
  assert.doesNotMatch(connected, /最后已知|查看连接/);
});

test("action buttons keep their decision hierarchy inside action forms", () => {
  assert.equal(PRODUCT_SHELL_CSS.includes(".product-action-form button {"), false);
  assert.equal(PRODUCT_SHELL_CSS.includes(".product-action-form button:hover"), false);
  assert.ok(PRODUCT_SHELL_CSS.includes(".product-quiet-action"));
  const streaming = renderProductShell(model({
    route: "conversation",
    activeTurn: { id: "turn-1", question: "窗帘为什么开得晚？", status: "streaming", canStop: true, canBackground: true },
  }));
  assert.match(streaming, /class="product-quiet-action" type="submit">停止/);
});

test("renders private voice setup in both settings layouts without exposing credentials", () => {
  const privateVoice = {
    status: "disabled" as const,
    generation: 7,
    configured: false,
  };
  const fallback = renderProductShell(model({ route: "settings", privateVoice }));
  const managed = renderProductShell(model({
    route: "settings",
    privateVoice,
    view: { activeId: "builtin.life", currentPath: "/settings", choices: [{ id: "builtin.life", label: "生活视图" }] },
  }));

  for (const html of [fallback, managed]) {
    assert.match(html, /id="private-voice"/);
    assert.match(html, /<h2[^>]*>私有语音<\/h2>/);
    assert.match(html, /语音暂未开启，文字对话始终可用/);
    assert.match(html, /由你选择的私有服务处理/);
    assert.match(html, /action="\/settings\/private-voice\/configure"/);
    assert.match(html, /name="expectedGeneration" value="7"/);
    assert.match(html, /<select[^>]+name="asrTransport"/);
    assert.match(html, /name="asrTransport" required/);
    assert.match(html, /<option value="" selected>请选择服务类型<\/option>/);
    assert.match(html, /<option value="openai_http">OpenAI 兼容接口<\/option>/);
    assert.match(html, /<option value="wyoming">Wyoming 本地语音<\/option>/);
    assert.match(html, /name="asrEndpoint"/);
    assert.match(html, /name="asrEndpoint" type="url"[^>]* required/);
    assert.match(html, /name="asrModel"/);
    assert.match(html, /name="asrCredential" type="password"/);
    assert.match(html, /<select[^>]+name="ttsTransport"/);
    assert.match(html, /name="ttsEndpoint"/);
    assert.match(html, /name="ttsModel"/);
    assert.match(html, /name="ttsLocale"/);
    assert.match(html, /name="ttsVoice"/);
    assert.match(html, /name="ttsCredential" type="password"/);
    assert.doesNotMatch(html, /name="(?:asr|tts)Credential"[^>]*value=/);
    assert.match(html, />检查并保存</);
    assert.match(html, /href="\/conversation"/);
  }
});

test("keeps the household model and private voice together at the start of settings", () => {
  const operationalModel = {
    status: "active" as const,
    generation: 4,
    configured: true as const,
    provider: "custom" as const,
    modelId: "household-model",
    baseURL: "https://models.example.test/v1",
    credentialConfigured: true,
  };
  const privateVoice = {
    status: "active" as const,
    generation: 4,
    configured: true as const,
    asr: { transport: "openai_http", endpoint: "https://voice.example.test/v1", credentialConfigured: true },
    tts: { transport: "wyoming", endpoint: "wyoming://127.0.0.1:10200", locale: "zh-CN", credentialConfigured: false },
  };
  const fallback = renderProductShell(model({ route: "settings", operationalModel, privateVoice }));
  const managed = renderProductShell(model({
    route: "settings",
    operationalModel,
    privateVoice,
    view: { activeId: "builtin.life", currentPath: "/settings", choices: [{ id: "builtin.life", label: "生活视图" }] },
  }));

  for (const html of [fallback, managed]) {
    const modelHeading = html.indexOf("家庭助手模型</h2>");
    const voiceHeading = html.indexOf("私有语音</h2>");
    const connectionHeading = html.indexOf("家庭连接</h2>");
    assert.ok(modelHeading >= 0);
    assert.ok(voiceHeading > modelHeading);
    assert.ok(connectionHeading > voiceHeading);
  }
});

test("renders configured private voice service state, change controls, and an explicit close confirmation", () => {
  const html = renderProductShell(model({
    route: "settings",
    privateVoice: {
      status: "active",
      generation: 12,
      configured: true,
      asr: { transport: "openai_http", endpoint: "http://voice.local/asr", model: "small", credentialConfigured: true },
      tts: { transport: "wyoming", endpoint: "http://voice.local/tts", model: "zh_CN-huayan-medium", locale: "zh-CN", voice: "花宴", credentialConfigured: true },
      notice: "语音服务已准备好。",
    },
  }));

  assert.match(html, /data-private-voice-status="active"/);
  assert.match(html, /语音可用/);
  assert.match(html, /<strong>OpenAI 兼容接口<\/strong>/);
  assert.match(html, /<strong>Wyoming 本地语音<\/strong>/);
  assert.doesNotMatch(html, /<strong>openai_http<\/strong>/);
  assert.match(html, /<option value="openai_http" selected>OpenAI 兼容接口<\/option>/);
  assert.match(html, /<option value="wyoming" selected>Wyoming 本地语音<\/option>/);
  assert.match(html, /地址不变时可留空；更换地址请重新输入凭据/);
  assert.match(html, /value="http:\/\/voice\.local\/asr"/);
  assert.match(html, /value="http:\/\/voice\.local\/tts"/);
  assert.doesNotMatch(html, /value="[^" ]*(?:secret|token|credential)[^" ]*"/i);
  assert.match(html, /action="\/settings\/private-voice\/disable"/);
  assert.match(html, /name="confirmDisable" value="confirmed"/);
  assert.match(html, /关闭只会停用家庭语音入口，不会停止外部服务。/);
  assert.match(html, />关闭语音</);
  assert.match(html, /语音服务已准备好。/);
});

test("renders current-process voice health with honest zero-sample copy", () => {
  const measured = renderProductShell(model({
    route: "settings",
    privateVoice: {
      status: "active",
      generation: 12,
      configured: true,
      asr: { transport: "openai_http", endpoint: "http://voice.local/asr", credentialConfigured: false },
      tts: { transport: "wyoming", endpoint: "http://voice.local/tts", locale: "zh-CN", credentialConfigured: false },
      health: {
        scope: "current_process",
        asr: { sampleCount: 2, successCount: 1, lastLatencyMs: 37, lastMeasuredAt: 1_700_000_000_037 },
        tts: { sampleCount: 1, successCount: 1, lastLatencyMs: 19, lastMeasuredAt: 1_700_000_000_019 },
      },
    } as unknown as ProductShellModel["privateVoice"],
  }));
  assert.match(measured, /本次运行测量/);
  assert.match(measured, /语音识别/);
  assert.match(measured, /语音播报/);
  assert.match(measured, /1\/2 成功/);
  assert.match(measured, /37 ms/);
  assert.match(measured, /1\/1 成功/);
  assert.match(measured, /19 ms/);
  assert.doesNotMatch(measured, /1_700_000_000/);

  const empty = renderProductShell(model({
    route: "settings",
    privateVoice: {
      status: "active",
      generation: 12,
      configured: true,
      asr: { transport: "openai_http", endpoint: "http://voice.local/asr", credentialConfigured: false },
      tts: { transport: "wyoming", endpoint: "http://voice.local/tts", locale: "zh-CN", credentialConfigured: false },
      health: {
        scope: "current_process",
        asr: { sampleCount: 0, successCount: 0 },
        tts: { sampleCount: 0, successCount: 0 },
      },
    } as unknown as ProductShellModel["privateVoice"],
  }));
  assert.match(empty, /本次运行测量/);
  assert.equal((empty.match(/尚无实际请求/g) ?? []).length, 2);
  assert.match(empty, /<dt>最近耗时<\/dt><dd>—<\/dd>/);
});

test("renders private voice recovery states with an immediate text exit", () => {
  const degraded = renderProductShell(model({
    route: "settings",
    privateVoice: { status: "degraded", generation: 3, configured: true, asr: { transport: "whisper-compatible", endpoint: "http://voice.local/asr", credentialConfigured: false }, tts: { transport: "piper", endpoint: "http://voice.local/tts", locale: "zh-CN", credentialConfigured: false } },
  }));
  assert.match(degraded, /语音需要恢复/);
  assert.match(degraded, /action="\/settings\/private-voice\/retry"/);
  assert.match(degraded, />再次连接</);
  assert.match(degraded, />编辑设置</);
  assert.match(degraded, /href="\/conversation"/);

  const retrying = renderProductShell(model({
    route: "settings",
    privateVoice: { status: "retrying", generation: 4, configured: true, asr: { transport: "whisper-compatible", endpoint: "http://voice.local/asr", credentialConfigured: false }, tts: { transport: "piper", endpoint: "http://voice.local/tts", locale: "zh-CN", credentialConfigured: false } },
  }));
  assert.match(retrying, /data-private-voice-status="retrying"/);
  assert.match(retrying, /正在重新连接语音/);
  assert.match(retrying, /action="\/settings\/private-voice\/cancel-retry"/);
  assert.match(retrying, />停止连接</);
  assert.match(retrying, /role="progressbar"/);

  const switching = renderProductShell(model({
    route: "settings",
    privateVoice: { status: "switching", generation: 5, configured: true, asr: { transport: "whisper-compatible", endpoint: "http://voice.local/asr", credentialConfigured: false }, tts: { transport: "piper", endpoint: "http://voice.local/tts", locale: "zh-CN", credentialConfigured: false } },
  }));
  assert.match(switching, /正在应用新的语音设置/);
  assert.match(switching, /aria-live="polite"/);
  assert.match(switching, /href="\/conversation"/);
});

test("renders a cancellable background private voice check without treating it as a provider state", () => {
  const pending = renderProductShell(model({
    route: "settings",
    privateVoice: {
      status: "disabled",
      generation: 6,
      configured: false,
      configurationPending: { id: "d".repeat(32), startedAt: 1_777_777_777_000 },
    } as unknown as ProductShellModel["privateVoice"],
  }));

  assert.match(pending, /data-private-voice-configuration-pending/);
  assert.match(pending, /正在检查语音识别与回复服务/);
  assert.match(pending, /action="\/settings\/private-voice\/cancel-configure"/);
  assert.match(pending, /name="configurationId" value="d{32}"/);
  assert.match(pending, /可以离开此页，我会继续检查。/);
  assert.match(pending, /使用文字对话/);
  assert.doesNotMatch(pending, /action="\/settings\/private-voice\/configure"/);
  assert.match(pending, /data-private-voice-configuration-status-url="\/settings\/private-voice\/configuration-status"/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /fetch\(taskStatusUrl/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /searchParams\.set\("configurationId", configurationId\)/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /searchParams\.set\("recoveryId", recoveryId\)/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /10_000/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /location\.replace/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /result\.configurationId !== configurationId\)\s*\{\s*window\.clearInterval\(pollTimer\)/s);
});

test("keeps a private voice recovery visible with text, household, and activity exits", () => {
  const html = renderProductShell(model({
    route: "settings",
    privateVoice: {
      status: "retrying",
      generation: 9,
      configured: true,
      asr: { transport: "wyoming", endpoint: "tcp://voice.local:10300", credentialConfigured: false },
      tts: { transport: "wyoming", endpoint: "tcp://voice.local:10200", locale: "zh-CN", credentialConfigured: false },
      recoveryPending: { id: "e".repeat(32), startedAt: 1_777_777_777_000 },
    },
  }));

  assert.match(html, /data-private-voice-recovery-pending/);
  assert.match(html, /正在恢复私有语音/);
  assert.match(html, /action="\/settings\/private-voice\/cancel-retry"/);
  assert.match(html, />使用文字对话</);
  assert.match(html, />查看家庭状态</);
  assert.match(html, />查看活动记录</);
  assert.match(html, /可以离开此页，我会继续恢复。/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /data-private-voice-recovery-pending/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /result\.recoveryId !== recoveryId/);
});

test("styles private voice forms as touch-safe, responsive settings rows", () => {
  assert.match(PRODUCT_SHELL_CSS, /\.product-private-voice-configuration summary\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(PRODUCT_SHELL_CSS, /\.product-private-voice-form input\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(PRODUCT_SHELL_CSS, /\.product-private-voice-form select\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(PRODUCT_SHELL_CSS, /\.product-private-voice-actions\s*\{[^}]*display:\s*flex/s);
  assert.match(PRODUCT_SHELL_CSS, /data-private-voice-status="retrying"/);
  assert.match(PRODUCT_SHELL_CSS, /@media \(max-width: 56rem\)[\s\S]*\.product-private-voice-actions/s);
  assert.match(PRODUCT_SHELL_CSS, /@media \(prefers-color-scheme: dark\)[\s\S]*--shell-bg/s);
});

test("ships progressive private voice submission feedback without replacing server forms", () => {
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /data-private-voice-form/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /addEventListener\("submit"/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /submit\.disabled = true/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /正在检查并保存/);
  assert.match(PRODUCT_PRIVATE_VOICE_JS, /正在重新连接语音/);
  assert.doesNotMatch(PRODUCT_PRIVATE_VOICE_JS, /preventDefault/);
});

test("renders operational model settings without ever reflecting the password", () => {
  const secret = "model-password-must-not-render";
  const html = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "active",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
    },
  }));

  assert.match(html, /<h2[^>]*>家庭助手模型<\/h2>/);
  assert.match(html, /OpenAI 兼容接口/);
  assert.match(html, /action="\/settings\/model\/configure"/);
  assert.match(html, /name="apiKey" type="password"/);
  assert.match(html, /地址不变时可留空/);
  assert.match(html, /<details[^>]*>.*连接或更换模型服务/s);
  assert.match(html, /name="expectedGeneration" value="7"/);
  assert.doesNotMatch(html, new RegExp(secret));
  assert.doesNotMatch(html, /secretRef|keychain:/i);
});

test("renders degraded operational model recovery with a household-status-preserving exit", () => {
  const html = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "degraded",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
    },
  }));

  assert.match(html, /新建议暂时不可用/);
  assert.match(html, /action="\/settings\/model\/retry"/);
  assert.match(html, /href="\/home"/);
  assert.match(html, /href="\/activity"/);
});

test("opens the model configuration beside a failed configuration or recovery", () => {
  const configurationFailure = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "active",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
      notice: {
        kind: "configuration_attention",
        message: "模型服务未接受访问密钥，请更新后再试。",
      },
    },
  }));
  const recoveryFailure = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "degraded",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
      notice: {
        kind: "status",
        message: "家庭助手模型仍不可用。家庭状态、活动记录和设置仍然可用。",
      },
    },
  }));

  assert.match(configurationFailure, /<details[^>]*open[^>]*>[\s\S]*模型服务未接受访问密钥[\s\S]*检查并启用/);
  assert.match(recoveryFailure, /家庭助手模型仍不可用[\s\S]*再次连接[\s\S]*<details[^>]*open/s);
});

test("keeps model settings touch-safe and adapts their detail surface to every display preference", () => {
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /\.product-operational-model-configuration > summary\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /\.product-operational-model-configuration input\s*\{[^}]*min-height:\s*2\.75rem/s);
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /@media \(max-width:\s*56rem\)[\s\S]*\.product-operational-model-configuration > summary/s);
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /@media \(prefers-color-scheme:\s*dark\)[\s\S]*\.product-operational-model-configuration/s);
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /@media \(prefers-contrast:\s*more\)[\s\S]*\.product-operational-model-configuration/s);
  assert.match(PRODUCT_OPERATIONAL_MODEL_CSS, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.product-operational-model/s);
});

test("renders a cancellable model recovery that continues in the background", () => {
  const html = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "retrying",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
      recoveryPending: { id: "a".repeat(32), startedAt: 0 },
    },
  }));

  assert.match(html, /模型用于理解问题，并生成答复和新建议。/);
  assert.match(html, /data-operational-model-recovery-pending/);
  assert.match(html, /action="\/settings\/model\/cancel-retry"/);
  assert.match(html, /停止这次恢复/);
  assert.match(html, /可以离开此页，我会继续恢复。/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /data-operational-model-cancel-configure-form/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /正在停止这次检查…/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /data-operational-model-recovery-pending/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /recoveryId !== recoveryId/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /searchParams\.set\("configurationId", configurationId\)/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /searchParams\.set\("recoveryId", recoveryId\)/);
  assert.match(PRODUCT_OPERATIONAL_MODEL_JS, /10_000/);
});

test("labels the model-service form by its household purpose", () => {
  const html = renderProductShell(model({
    route: "settings",
    operationalModel: {
      status: "active",
      generation: 7,
      configured: true,
      provider: "custom",
      modelId: "household-model",
      baseURL: "https://models.example.test/v1",
      credentialConfigured: true,
    },
  }));

  assert.match(html, /连接或更换模型服务/);
  assert.doesNotMatch(html, /<summary>高级设置<\/summary>/);
});


test("presents a prepared plan as one decision with three honest choices", () => {
  const html = renderProductShell(model({
    route: "reviews",
    selectedProposalId: "media-power",
    selectedProposal: {
      id: "media-power",
      revision: 3,
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "ready",
      readiness: ["证据已核对", "与现有规则无冲突", "权限已确认", "试算未写入设备"],
      why: ["连续 12 天，你在 23:00 后手动关多媒体室插线板"],
      willDo: ["每天 23:30，若 30 分钟无人且没在播放，断开插线板"],
      willNotDo: ["不碰路由器和 NAS 所在插座"],
      gateClasses: ["confirmation"],
      confirmationDeviceNames: ["空调（客厅）"],
      risk: "低 · 可逆",
      afterEnable: "随时可以暂停，或关闭并移除这条自动化。",
    },
  }));

  assert.match(html, /方案已备好/);
  assert.match(html, />启用</);
  assert.match(html, /以后再说/);
  assert.match(html, /仅这次不要/);
  assert.match(html, /不再提这件事/);
  assert.match(html, /在对话里改/);
  assert.match(html, /需要确认的设备（空调（客厅））：这次启用就是你的授权/);
  assert.doesNotMatch(html, /修改…|试运行|两次确认|同意方向|确认方向/);
});

test("presents a Home Assistant migration as one recoverable household decision", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [{
      id: "migration-ready",
      revision: 4,
      title: "晚间灯光自动化",
      reviewLane: "migration",
      lifecycle: "ready",
      summary: "已准备好迁移到家里的新规则。",
    }],
    selectedProposalId: "migration-ready",
    selectedProposal: {
      id: "migration-ready",
      revision: 4,
      title: "晚间灯光自动化",
      reviewLane: "migration",
      lifecycle: "ready",
      summary: "已准备好迁移到家里的新规则。",
    },
    proposalCapacityUsed: 1,
  }));

  assert.match(html, /从 Home Assistant 搬来/);
  assert.match(html, /先暂停原来的规则，再核验新的规则/);
  assert.match(html, /出了问题可以恢复/);
  assert.equal((html.match(/action="\/review-center\/proposals\/migration-ready\/enable"/g) ?? []).length, 1);
  assert.match(html, /data-count="0\/5"/);
  assert.match(html, /data-review-lane="migration"/);
});

test("keeps migration cards out of the ordinary count while keeping both lanes reachable", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [
      { id: "standard-1", revision: 1, title: "普通建议", lifecycle: "ready" },
      { id: "migration-1", revision: 1, title: "从旧规则搬来的建议", reviewLane: "migration", lifecycle: "ready" },
    ],
    proposalCapacityUsed: 2,
  }));

  assert.match(html, /data-count="1\/5"/);
  assert.match(html, /data-review-id="standard-1"/);
  assert.match(html, /data-review-id="migration-1"/);
  assert.match(html, /从 Home Assistant 搬来的规则/);
});

test("keeps migration summaries out of the ordinary overview section", () => {
  const html = renderProductShell(model({
    proposals: [
      { id: "standard-overview", revision: 1, title: "普通建议", lifecycle: "ready" },
      { id: "migration-overview", revision: 1, title: "迁移来的规则", reviewLane: "migration", lifecycle: "ready" },
    ],
  }));
  const summary = html.slice(html.indexOf("product-review-summary"), html.indexOf("</section></main>"));
  const standardSection = summary.slice(summary.indexOf("给家的建议"), summary.indexOf("给家的建议") + 250);
  assert.match(standardSection, /普通建议/);
  assert.doesNotMatch(standardSection, /迁移来的规则/);
  assert.match(summary, /待迁移规则/);
  assert.match(summary, /href="\/review-center\?proposal=migration-overview"/);
});

test("makes migration automation recovery outcomes explicit", () => {
  const active = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "migration-active",
      title: "晚间灯光自动化",
      lifecycle: "active",
      reviewLane: "migration",
    }],
  }));
  assert.match(active, /已核验/);
  assert.match(active, /暂停/);
  assert.match(active, /恢复原规则/);

  const failed = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "migration-failed",
      title: "晚间灯光自动化",
      lifecycle: "enable_failed",
      reviewLane: "migration",
      failureReason: "新的规则没有完成核验。",
    }],
  }));
  assert.match(failed, /需要核对/);
  assert.match(failed, /迁移没有完成，系统已停止后续操作/);
  assert.match(failed, /重试迁移/);
  assert.match(failed, /恢复原规则/);
  assert.doesNotMatch(failed, /运行中/);
});

test("keeps an unknown migration outcome honest and offers the recovery lifecycle", () => {
  const unknown = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "migration-unknown",
      title: "晚间灯光自动化",
      lifecycle: "enable_failed",
      reviewLane: "migration",
      failureReason: "switch_unknown",
    }],
  }));
  assert.match(unknown, /迁移没有完成，系统已停止后续操作/);
  assert.match(unknown, /继续前会先核对两条规则/);
  assert.doesNotMatch(unknown, /新的规则没有开始运行|原来的规则保持不变|未运行/);

  const recovery = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "migration-recovery",
      title: "晚间灯光自动化",
      lifecycle: "recovery_required",
      reviewLane: "migration",
    }],
  }));
  assert.match(recovery, /需要恢复/);
  assert.match(recovery, /action="\/automations\/migration-recovery\/recover"/);
  assert.match(recovery, /继续恢复/);
  assert.doesNotMatch(recovery, /运行中|已关闭|暂停|关闭并恢复/);
});

test("renders migration selection rows before deployed automation cards with bounded household actions", () => {
  const html = renderProductShell(model({
    route: "automations",
    migrationSelections: [
      { name: "晚间灯光", status: "selectable", selectionToken: "a".repeat(32) },
      { name: "起床灯", status: "prepared", proposalId: "proposal-opaque" },
      { name: "旧规则", status: "unavailable" },
    ],
  } as never));

  const selectionStart = html.indexOf("晚间灯光");
  const automationStart = html.indexOf("data-automation-id=");
  assert.ok(selectionStart >= 0 && (automationStart < 0 || selectionStart < automationStart));
  assert.match(html, /准备迁移建议/);
  assert.match(html, /先查看并批准/);
  assert.match(html, new RegExp(`name="selectionToken" value="${"a".repeat(32)}"`));
  assert.match(html, /href="\/review-center\?proposal=proposal-opaque"/);
  assert.match(html, /旧规则/);
  assert.match(html, /暂时无法准备|稍后重新检查/);
  assert.doesNotMatch(html, /native-rule|sourceFingerprint|sha256:|ruleRef/);
  assert.equal((html.match(/name="selectionToken"/g) ?? []).length, 1);
});

test("keeps migration selection empty and failure copy calm without inventing a candidate", () => {
  const empty = renderProductShell(model({ route: "automations", migrationSelections: [] } as never));
  assert.doesNotMatch(empty, /准备迁移建议/);

  const unavailable = renderProductShell(model({
    route: "automations",
    migrationSelections: [{ name: "旧规则", status: "unavailable" }],
  } as never));
  assert.doesNotMatch(unavailable, /<button[^>]*>准备迁移建议/);
  assert.match(unavailable, /暂时无法准备|稍后重新检查/);
});

test("fails closed when a migration selection model contains an unsafe token or proposal identity", () => {
  const html = renderProductShell(model({
    route: "automations",
    migrationSelections: [
      { name: "坏令牌", status: "selectable", selectionToken: "<script>" },
      { name: "坏链接", status: "prepared", proposalId: "//attacker.invalid" },
    ],
  } as never));

  assert.doesNotMatch(html, /name="selectionToken"/);
  assert.doesNotMatch(html, /attacker\.invalid/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /暂时无法准备|稍后重新检查/);
});

test("a blocked plan stops honestly with only the revise and decline exits", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [{
      id: "media-power",
      revision: 4,
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "ready",
      enableBlockedReason: "方案里有设备的动作已进入高影响保护，暂时不能交给自动化。可以在对话里改方案，或不用了。",
    }],
    selectedProposalId: "media-power",
    selectedProposal: {
      id: "media-power",
      revision: 4,
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "ready",
      why: ["连续 12 天，你在 23:00 后手动关多媒体室插线板"],
      gateClasses: ["confirmation"],
      confirmationDeviceNames: ["插座（多媒体室）"],
      enableBlockedReason: "方案里有设备的动作已进入高影响保护，暂时不能交给自动化。可以在对话里改方案，或不用了。",
      enableBlockedKind: "protected" as const,
    },
  }));

  assert.match(html, /暂时无法启用/);
  assert.match(html, /方案里有设备的动作已进入高影响保护/);
  assert.match(html, /在对话里改/);
  assert.match(html, /仅这次不要/);
  assert.match(html, /不再提这件事/);
  assert.doesNotMatch(html, /去设置确认方式/, "a protected escalation never routes to the confirmation settings");

  const configGap = renderProductShell(model({
    route: "reviews",
    proposals: [],
    selectedProposalId: "curtain-lock",
    selectedProposal: {
      id: "curtain-lock",
      revision: 2,
      title: "起夜自动调暗走廊灯",
      lifecycle: "ready",
      enableBlockedReason: "方案里设备的确认方式还没有设置好，先在设置里为它选择确认方式；也可以在对话里改方案，或不用了。",
      enableBlockedKind: "not_configured" as const,
    },
  }));
  assert.match(configGap, /href="\/settings#action-policy">去设置确认方式/, "a configuration gap walks straight to the confirmation settings");
  assert.doesNotMatch(html, />启用</);
  assert.doesNotMatch(html, /以后再说/);
  assert.doesNotMatch(html, /启用后：/, "a blocked plan makes no after-enable promise");
  assert.doesNotMatch(html, /这次启用就是你的授权/, "a blocked plan makes no present-tense authorization promise");
});

test("a preparing card stays visible in the list without decision entries", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [{
      id: "media-power",
      revision: 2,
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "preparing",
    }],
  }));
  assert.match(html, /正在准备/, "the household sees the card is being prepared");
  assert.match(html, /睡前自动关掉多媒体室电源/);
  const listSection = html.slice(html.indexOf("给家的建议"));
  assert.doesNotMatch(listSection.slice(0, listSection.indexOf("先放一放")), /以后再说/, "a preparing card offers no snooze");
});

test("settings renders the confirmation-method editor when the seam is available", () => {
  const html = renderProductShell(model({
    route: "settings",
    actionPolicy: {
      capabilities: [
        { id: "hwc-1", label: "灯（客厅） · 灯", bridgeLabel: "Home Assistant", policyClass: "direct" },
        { id: "hwc-2", label: "门锁（入户） · 门锁", bridgeLabel: "Home Assistant", policyClass: "administrator" },
      ],
      savedNotice: "已保存确认方式，受影响的建议正在重新检查。",
    },
  }));
  assert.match(html, /id="action-policy"/);
  assert.match(html, /设备动作的确认方式/);
  assert.match(html, /name="capability:hwc-1"/);
  assert.match(html, /高影响 · 手机确认/);
  assert.match(html, /action="\/settings\/action-policy"/);
  assert.match(html, /保存确认方式/);
  assert.match(html, /已保存确认方式，受影响的建议正在重新检查。/);
  assert.doesNotMatch(html, /权限级别|管理员/);
});

test("keeps a preparing plan out of decision reach", () => {
  const html = renderProductShell(model({
    route: "reviews",
    selectedProposalId: "media-power",
    selectedProposal: {
      id: "media-power",
      revision: 1,
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "preparing",
    },
  }));
  assert.match(html, /正在后台准备/);
  assert.doesNotMatch(html.slice(html.indexOf("proposal-detail-heading")), /action="\/review-center\/proposals\/media-power\/enable"/);
});

test("reports a running automation only after the deployment is verified", () => {
  const running = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "media-power",
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "active",
      lastResult: "昨晚 23:30 已执行 · 已回读核实",
      version: 2,
    }],
  }));
  assert.match(running, /运行中/);
  assert.match(running, /暂停/);
  assert.match(running, /关闭并移除/);

  const failed = renderProductShell(model({
    route: "automations",
    automations: [{
      id: "media-power",
      title: "睡前自动关掉多媒体室电源",
      lifecycle: "enable_failed",
      failureReason: "这个家还没有可用的自动化部署通道。",
      version: 1,
    }],
  }));
  assert.match(failed, /没能启用/);
  assert.match(failed, /这个家还没有可用的自动化部署通道。/);
  assert.doesNotMatch(failed, /运行中/);
});

test("offers a household insight without an enable path", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [{
      id: "balcony-sensor",
      revision: 1,
      kind: "household-insight",
      title: "阳台加一个土壤湿度传感器会更准",
      summary: "现在只能按天数估计，装了就能按真实湿度浇水。",
      lifecycle: "ready",
    }],
  }));
  const card = html.slice(html.indexOf('data-review-id="balcony-sensor"'));
  assert.match(card, /有帮助/);
  assert.match(card, /不需要/);
  assert.doesNotMatch(card.slice(0, card.indexOf("</article>")), /启用/);
});


test("renders the concern card with fact, unknown and suggestion layers from a real finding", () => {
  const html = renderProductShell(model({
    concern: {
      adviceId: "advice-1",
      title: "窗帘今天开得比平时晚",
      facts: ["今天 09:42 才打开，平时约 07:15", "窗外光照从 09:00 起充足"],
      unknowns: ["周末作息是否不同"],
      suggestion: "可以先做一周的可逆调整试试，不改永久规则，随时撤回。",
    },
  }));
  assert.match(html, /当前关注/);
  assert.match(html, /窗帘今天开得比平时晚/);
  assert.match(html, /已验证的家庭事实/);
  assert.match(html, /仍然不知道/);
  assert.match(html, /href="\/conversation\/advice-1"/);
  assert.match(html, /看看怎么调整/);

  const quiet = renderProductShell(model());
  assert.doesNotMatch(quiet, /当前关注/);
});


test("closes a runtime confirmation with an honest outcome instead of a dead card", () => {
  const html = renderProductShell(model({
    route: "reviews",
    runtimeConfirmations: [
      {
        id: "door-lock",
        title: "锁上大门",
        status: "decided",
        decisionSummary: "已由小海批准 · 已执行并核对：前门已上锁（18:42）",
        policyClass: "administrator",
      },
      {
        id: "door-lock-expired",
        title: "锁上大门",
        status: "expired",
        reissueHref: "/control",
        policyClass: "administrator",
      },
    ],
  }));
  assert.match(html, /已由小海批准 · 已执行并核对：前门已上锁（18:42）/);
  assert.match(html, /时限内无人批准 · 未执行，已留记录/);
  assert.match(html, /重新发起（重新计时）/);
  assert.match(html, /href="\/control"/);
});

test("offers one later action without pressure copy", () => {
  const html = renderProductShell(model({
    route: "reviews",
    proposals: [{
      id: "curtain",
      revision: 1,
      title: "周末早晨窗帘慢速拉开",
      lifecycle: "ready",
      status: "snoozed",
      snoozeCount: 1,
    }],
  }));
  assert.match(html, /name="until" value="later"/);
  assert.match(html, /以后再说/);
  assert.doesNotMatch(html, /最多 2 次|明天晚上|周末(?!早晨)|这是第/);
});

test("activity carries full dates, the closed vocabulary and per-item verification", () => {
  const html = renderProductShell(model({
    route: "activity",
    activity: [
      {
        id: "a-physical",
        dateGroup: "today",
        dateLabel: "今天 · 8 月 21 日",
        time: "23:12",
        title: "顶灯被墙面开关关闭",
        attribution: "physical",
        verification: "阿灶：你动手了，我注意到了；相反的自动动作已取消并留记录。",
      },
      {
        id: "a-member",
        dateGroup: "today",
        dateLabel: "今天 · 8 月 21 日",
        time: "22:40",
        title: "客厅温度设为 24.5°C",
        attribution: "member",
        actor: "小海",
      },
      {
        id: "a-system",
        dateGroup: "today",
        dateLabel: "今天 · 8 月 21 日",
        time: "20:02",
        title: "米家桥接短暂断线 38 秒，已自动恢复",
        attribution: "system",
      },
    ],
  }));
  assert.match(html, /今天 · 8 月 21 日/);
  assert.match(html, /data-attribution="physical">物理</);
  assert.match(html, /data-attribution="member">你</);
  assert.match(html, /data-attribution="system">系统</);
  assert.match(html, /你动手了，我注意到了/);
  assert.match(html, /data-activity-filter="physical"/);
});

test("offers quick phrases that hand one sentence to the agent", () => {
  const html = renderProductShell(model({
    concern: {
      adviceId: "advice-1",
      title: "窗帘今天开得比平时晚",
      facts: ["今天 09:42 才打开"],
    },
  }));
  assert.match(html, /class="product-quick-phrases"/);
  assert.match(html, /现在家里怎么样？/);
  assert.match(html, /href="\/voice"/);
});

test("explains that an answer's suggestion is preparing toward one decision", () => {
  const html = renderProductShell(model({
    route: "conversation",
    activeTurn: {
      id: "turn-1",
      question: "窗帘为什么开得晚？",
      status: "completed",
      suggestions: ["先做一周可逆调整"],
      correctionProposalId: "curtain",
      correctionProposalCount: 3,
    },
  }));
  assert.match(html, /后台准备中，方案备好后一次点头即启用/);
  assert.match(html, /在处理中心查看/);
  assert.doesNotMatch(html, /试运行|同意方向/);
});

test("keeps an acknowledged safety fact as a condensed persistent bar", () => {
  const html = renderProductShell(model({
    safetyAlerts: [{
      id: "leak",
      title: "厨房漏水",
      status: "acknowledged",
      actionLabel: "查看处置",
    }],
  }));
  assert.match(html, /data-safety-status="acknowledged"/);
  assert.match(html, /已看到 · 事实仍在持续/);
  assert.doesNotMatch(html, /我已看到/);
});

test("speaks with the household's chosen name through onboarding", () => {
  const html = renderProductShell(model({
    route: "onboarding",
    onboarding: {
      step: 8,
      status: "ready",
      household: { householdName: "小海的家", agentName: "阿灶" },
    },
  }));
  assert.match(html, /跟阿灶说句话吧/);
  assert.doesNotMatch(html, /跟 hob 说句话吧/);
});

test("the wall control view shows approvals read-only and points to a private device", () => {
  const html = renderProductShell(model({
    route: "control",
    view: {
      activeId: "control",
      currentPath: "/control",
      choices: [{ id: "control", label: "控制视图" }],
    },
    controlSpaces: [{ id: "living", name: "客厅", controls: [] }],
  }));
  assert.match(html, /等待放行/);
  assert.match(html, /共享屏不替人点头/);
  assert.match(html, /查看全部/);
  assert.doesNotMatch(html.slice(html.indexOf("等待放行")), /放行（手机确认）/);
});

test("summarizes the home's status from real safety facts only", () => {
  const quiet = renderProductShell(model({}));
  assert.match(quiet, /没有待处理的安全事项/);

  const alerting = renderProductShell(model({
    safetyAlerts: [{ id: "leak", title: "厨房漏水", status: "active" }],
  }));
  assert.doesNotMatch(alerting, /没有待处理的安全事项/);
});
