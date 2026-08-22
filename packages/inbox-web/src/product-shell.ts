import type { AgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";

import { renderAgentLoopTimeline } from "./agent-loop-timeline.js";
import { compileProductViewRecipe, type ProductViewRecipeV1 } from "./product-view-recipe.js";

/**
 * The shell consumes a neutral, read-only presentation model. It emits links
 * and forms only; the host remains responsible for authentication, policy,
 * approval, execution, and audit.
 */
export type ProductShellRoute =
  | "overview"
  | "conversation"
  | "reviews"
  | "activity"
  | "control"
  | "automations"
  | "settings"
  | "onboarding";

export type ProductConnectionState = "connected" | "quiet" | "disconnected" | "connecting" | "unknown";

export interface ProductShellHousehold {
  readonly name?: string;
  readonly agentName?: string;
  readonly memberName?: string;
  readonly memberRole?: string;
}

export interface ProductViewState {
  readonly activeId: string;
  readonly defaultId?: string;
  readonly currentPath: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly canSetDeviceDefault?: boolean;
  readonly preferences?: readonly ProductViewPreferenceState[];
  readonly recoveryMessage?: string;
}

export interface ProductViewPreferenceState {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}

export interface ProductShellConnection {
  readonly state: ProductConnectionState;
  readonly lastContact?: string;
  readonly lastChanged?: string;
  readonly detail?: string;
}

export interface ProductRuntimeConfirmation {
  readonly id: string;
  readonly title: string;
  readonly effect?: string;
  readonly source?: string;
  readonly eligibleActor?: string;
  readonly expiresIn?: string;
  readonly expiresAt?: string;
  readonly expiresLabel?: string;
  readonly policyClass?: "direct" | "confirmation" | "administrator" | "admin" | string;
  readonly canApprove?: boolean;
  readonly status?: "pending" | "expired" | "decided" | "superseded";
  /** Household-readable closing line for a decided confirmation. */
  readonly decisionSummary?: string;
  /** Where the expired action can be re-initiated with a fresh window. */
  readonly reissueHref?: string;
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
}

export type ProductProposalKind = "automation-draft" | "household-insight";

export type ProductProposalLifecycle = "preparing" | "needs_info" | "ready";

/** A prepared plan the household decides on once. */
export interface ProductProposal {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly kind?: ProductProposalKind;
  readonly lifecycle?: ProductProposalLifecycle;
  readonly summary?: string;
  /** What preparation already settled, shown before the decision. */
  readonly readiness?: readonly string[];
  readonly why?: readonly string[];
  readonly willDo?: readonly string[];
  readonly willNotDo?: readonly string[];
  readonly evidence?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly dependency?: string;
  /** Present when the plan touches confirmation-class devices (DR-015 disclosure). */
  readonly gateClasses?: readonly ("direct" | "confirmation")[];
  /** Household names of the confirmation-class devices, for concrete disclosure. */
  readonly confirmationDeviceNames?: readonly string[];
  readonly risk?: string;
  readonly afterEnable?: string;
  readonly snoozeCount?: number;
  readonly status?: "pending" | "snoozed" | "expired" | "rejected" | "approved";
  readonly expiresAt?: string;
  readonly newEvidence?: boolean;
  readonly trace?: AgentLoopTrace;
}

export type ProductAutomationLifecycle = "enabling" | "active" | "paused" | "closed" | "enable_failed";

/** A household automation after the decision. Running means a verified deployment. */
export interface ProductAutomation {
  readonly id: string;
  readonly title: string;
  readonly lifecycle: ProductAutomationLifecycle;
  readonly version?: number;
  readonly lastResult?: string;
  readonly failureReason?: string;
  /** The native system holds a different behavior than the approved plan. */
  readonly drifted?: boolean;
  readonly recentActivity?: readonly string[];
}

export interface ProductSpace {
  readonly id: string;
  readonly name: string;
  readonly deviceCount?: number;
  readonly peopleCount?: number;
  readonly state?: string;
  readonly metrics?: readonly { readonly label: string; readonly value: string }[];
  readonly devices?: readonly string[];
}

/** A real finding relayed from a completed household conversation. */
export interface ProductConcern {
  readonly adviceId: string;
  readonly title: string;
  readonly facts: readonly string[];
  readonly unknowns?: readonly string[];
  readonly suggestion?: string;
}

export interface ProductEnergySummary {
  readonly value?: string;
  readonly change?: string;
  readonly note?: string;
}

export type ProductTurnStatus =
  | "idle"
  | "unknown"
  | "accepted"
  | "inspecting"
  | "streaming"
  | "background"
  | "completed"
  | "cancelled"
  | "failed";

export type ProductTurnStage = "received" | "checking_home" | "reading_inventory" | "checking_rules" | "composing";

export interface ProductTurn {
  readonly id: string;
  readonly question: string;
  readonly status: ProductTurnStatus;
  readonly stage?: ProductTurnStage;
  readonly statusMessage?: string;
  readonly elapsedSeconds?: number;
  readonly streamText?: string;
  readonly answer?: string;
  readonly verifiedFacts?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly correctionAck?: string;
  readonly correctionDestination?: string;
  readonly correctionProposalId?: string;
  readonly correctionProposalCount?: number;
  readonly error?: string;
  readonly canStop?: boolean;
  readonly canBackground?: boolean;
}

export interface ProductAdviceCompletionNotification {
  readonly adviceId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly completedAt: string;
}

export interface ProductUndo {
  readonly id: string;
  readonly label: string;
  readonly inverseLabel?: string;
  readonly remainingSeconds: number;
  readonly status: "available" | "expired" | "unknown" | "unavailable";
}

export type ProductActivityAttribution = "physical" | "member" | "hob" | "external-rule" | "system" | "unknown";

export interface ProductActivityRecord {
  readonly id: string;
  readonly dateGroup?: "today" | "yesterday" | string;
  readonly dateLabel?: string;
  readonly time: string;
  readonly title: string;
  readonly space?: string;
  readonly actor?: string;
  readonly attribution: ProductActivityAttribution;
  readonly cause?: readonly string[];
  readonly verification?: string;
}

export interface ProductSafetyAlert {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly source?: string;
  readonly status: "active" | "acknowledged" | "contained" | "resolved";
  readonly severity?: "safety";
  readonly snoozeAllowed?: false;
  readonly actionLabel?: string;
  readonly actionHref?: string;
  readonly acknowledgeHref?: string;
  readonly canAcknowledge?: boolean;
}

export interface ProductControlItem {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly result?: "verified" | "failed" | "unknown";
  readonly actionLabel?: string;
  readonly policyClass?: "direct" | "confirmation" | "administrator";
}

export interface ProductControlSpace extends ProductSpace {
  readonly controls?: readonly ProductControlItem[];
}

export type ProductBatchPolicyClass = "direct" | "confirmation" | "administrator";
export type ProductBatchActionStatus = "verified" | "pending_confirmation" | "failed" | "unknown";

export interface ProductBatchControlItem {
  readonly capabilityId: string;
  readonly label: string;
  readonly actionLabel?: string;
  readonly policyClass: ProductBatchPolicyClass;
}

export interface ProductBatchControlPreview {
  readonly total: number;
  readonly direct: number;
  readonly confirmation: number;
  readonly administrator: number;
  readonly items: readonly ProductBatchControlItem[];
}

export interface ProductBatchActionResultItem {
  readonly capabilityId: string;
  readonly requestId: string;
  readonly policyClass: ProductBatchPolicyClass;
  readonly status: ProductBatchActionStatus;
  readonly ticketId?: string;
  readonly reason: string;
  readonly verification: ProductBatchActionStatus;
  readonly label?: string;
}

export interface ProductBatchActionResult {
  readonly requestId: string;
  readonly items: readonly ProductBatchActionResultItem[];
  readonly counts: {
    readonly total: number;
    readonly verified: number;
    readonly pending_confirmation: number;
    readonly failed: number;
    readonly unknown: number;
  };
}

export interface ProductBatchControl {
  readonly preview: ProductBatchControlPreview;
  readonly result?: ProductBatchActionResult;
}

export interface ProductControlFeedback {
  readonly capabilityId: string;
  readonly ticketId?: string;
  readonly status: "verified" | "pending_confirmation" | "failed" | "unknown";
  readonly label: string;
  readonly detail: string;
  readonly expiresAt?: string;
  readonly expiresIn?: string;
  readonly undo?: ProductUndo;
}

export type ProductOnboardingFieldType = "text" | "time" | "url" | "textarea" | "select" | "radio" | "checkbox";

export interface ProductOnboardingFieldOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
}

export interface ProductOnboardingField {
  readonly name: string;
  readonly type: ProductOnboardingFieldType;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly options?: readonly ProductOnboardingFieldOption[];
}

export type ProductOnboardingPolicySuggestion = "direct" | "confirmation" | "administrator";

export interface ProductOnboardingBridgeChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly selectable: boolean;
}

export interface ProductOnboardingCapabilityChoice {
  readonly id: string;
  readonly label: string;
  readonly bridgeId: string;
  readonly bridgeLabel: string;
  readonly schema?: string;
  readonly suggestedPolicyClass: ProductOnboardingPolicySuggestion;
}

export interface ProductOnboardingChoices {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly bridges: readonly ProductOnboardingBridgeChoice[];
  readonly capabilities: readonly ProductOnboardingCapabilityChoice[];
}

export interface ProductOnboardingItem {
  readonly id?: string;
  readonly label: string;
  readonly detail?: string;
  readonly status?: string;
  readonly tone?: "verified" | "warning" | "danger" | "neutral";
}

/** A serializable projection for one step. The host may replace any default. */
export interface ProductOnboardingStepData {
  readonly step: number;
  readonly key?: string;
  readonly label: string;
  readonly title: string;
  readonly body?: string;
  readonly fields?: readonly ProductOnboardingField[];
  readonly items?: readonly ProductOnboardingItem[];
  readonly submitLabel?: string;
  readonly note?: string;
  readonly action?: string;
  readonly submitDisabled?: boolean;
}

export interface ProductOnboardingState {
  readonly step?: number;
  readonly complete?: boolean;
  readonly status?: "ready" | "blocked" | "complete";
  readonly blockedReason?: string;
  readonly title?: string;
  readonly body?: string;
  readonly fields?: readonly ProductOnboardingField[];
  readonly items?: readonly ProductOnboardingItem[];
  readonly steps?: readonly ProductOnboardingStepData[];
  readonly submitLabel?: string;
  readonly note?: string;
  readonly action?: string;
  readonly household?: { readonly householdName: string; readonly agentName: string };
  readonly choices?: ProductOnboardingChoices;
}

export interface ProductShellModel {
  readonly route?: ProductShellRoute;
  readonly household?: ProductShellHousehold;
  readonly view?: ProductViewState;
  readonly connection?: ProductShellConnection;
  readonly safetyAlerts?: readonly ProductSafetyAlert[];
  readonly runtimeConfirmations?: readonly ProductRuntimeConfirmation[];
  readonly runtimeConfirmationCount?: number;
  readonly proposals?: readonly ProductProposal[];
  readonly selectedProposal?: ProductProposal;
  readonly automations?: readonly ProductAutomation[];
  readonly proposalCapacityUsed?: number;
  readonly proposalCapacity?: number;
  readonly expiredSummary?: string;
  readonly spaces?: readonly ProductSpace[];
  readonly energy?: ProductEnergySummary;
  readonly concern?: ProductConcern;
  readonly agentNote?: string;
  readonly activeTurn?: ProductTurn;
  readonly completionNotification?: ProductAdviceCompletionNotification;
  readonly undo?: ProductUndo;
  readonly controlFeedback?: ProductControlFeedback;
  readonly activity?: readonly ProductActivityRecord[];
  readonly selectedProposalId?: string;
  readonly selectedActivityId?: string;
  readonly controlSpaces?: readonly ProductControlSpace[];
  readonly batchControl?: ProductBatchControl;
  readonly onboarding?: ProductOnboardingState;
}

export interface ProductShellRenderOptions {
  readonly cssHref?: string;
  readonly documentTitle?: string;
  readonly includeStyles?: boolean;
  readonly hrefs?: Partial<Record<ProductShellRoute, string>>;
}

const ROUTES: readonly ProductShellRoute[] = ["overview", "conversation", "reviews", "automations", "activity", "control", "settings", "onboarding"];

const DEFAULT_HREFS: Readonly<Record<ProductShellRoute, string>> = {
  overview: "/",
  conversation: "/conversation",
  reviews: "/review-center",
  automations: "/automations",
  activity: "/activity",
  control: "/control",
  settings: "/settings",
  onboarding: "/onboarding",
};

const ROUTE_LABELS: Readonly<Record<ProductShellRoute, string>> = {
  overview: "总览",
  conversation: "对话",
  reviews: "处理中心",
  automations: "自动化",
  activity: "活动",
  control: "控制",
  settings: "设置",
  onboarding: "首次设置",
};

const MOBILE_ROUTE_LABELS: Readonly<Record<ProductShellRoute, string>> = {
  overview: "家",
  conversation: "对话",
  reviews: "处理",
  automations: "自动化",
  activity: "活动",
  control: "空间",
  settings: "设置",
  onboarding: "首次设置",
};

const STEP_LABELS = ["认识与起名", "只读接桥", "家庭地图", "成员与管理员", "分档操作权限", "安全预演", "第一周期待", "第一问"] as const;

const DEFAULT_ONBOARDING_STEPS: readonly ProductOnboardingStepData[] = [
  {
    step: 1,
    key: "name",
    label: STEP_LABELS[0],
    title: "认识一下你家的 hob",
    body: "一只住在家里的小管家 · 先看、后建议，从不擅动。",
    fields: [
      { name: "agentName", type: "text", label: "给它起个名字", placeholder: "比如：阿灶", required: true, help: "名字会成为它自我认知的一部分，以后随时可以改。" },
      { name: "householdName", type: "text", label: "给家起个名字", placeholder: "比如：小海的家" },
    ],
    submitLabel: "继续",
    note: "先跳过，叫它 hob 就好。",
  },
  {
    step: 2,
    key: "bridge",
    label: STEP_LABELS[1],
    title: "把已有的家接进来",
    body: "hob 通过中立桥读取你已经在用的家庭系统。",
    fields: [
      {
        name: "bridgeMode",
        type: "radio",
        label: "接入方式",
        required: true,
        options: [{ value: "read_only", label: "只读接入", description: "以后要不要动，由你在第 5 步单独决定。", checked: true }],
      },
    ],
    submitLabel: "继续只读同步",
    note: "家庭连接列表会从当前只读同步中出现。",
  },
  {
    step: 3,
    key: "map",
    label: STEP_LABELS[2],
    title: "确认现在的家",
    body: "我只把看见的房间和设备列出来；拿不准的地方先问你。",
    fields: [
      {
        name: "mapConfirmed",
        type: "checkbox",
        label: "家庭地图",
        required: true,
        options: [{ value: "confirmed", label: "我确认先按这个只读地图开始。" }],
      },
      { name: "mapCorrection", type: "textarea", label: "需要调整的房间或设备", placeholder: "比如：插座-xk3 应该在厨房。" },
    ],
    submitLabel: "确认，继续",
    note: "拿不准的只会一条条问，不会替你合并。",
  },
  {
    step: 4,
    key: "members",
    label: STEP_LABELS[3],
    title: "家里都有谁",
    body: "请让一位在场的成年成员使用已绑定的私人设备完成设置，这个身份负责家庭级确认。",
    fields: [
      { name: "memberName", type: "text", label: "这位成员怎么称呼", placeholder: "比如：小雨", required: true },
      {
        name: "memberRole",
        type: "select",
        label: "成员身份",
        required: true,
        options: [{ value: "adult_admin", label: "成年成员 · 家庭确认" }],
      },
    ],
    submitLabel: "继续",
    note: "先绑定一位成年成员，其他成员随后在设置中加入。",
  },
  {
    step: 5,
    key: "permissions",
    label: STEP_LABELS[4],
    title: "设置操作权限",
    body: "逐项选择真实设备能力的权限级别；这里的建议只帮助你开始，最终权限以你的选择为准。",
    fields: [],
    submitLabel: "保存操作权限",
    note: "家庭能力列表会在只读同步完成后出现。",
  },
  {
    step: 6,
    key: "safety",
    label: STEP_LABELS[5],
    title: "先说好红色的规矩",
    body: "红色只留给真正的危险，平时你几乎看不到它。",
    items: [
      { id: "surface", label: "穿透一切", detail: "不管你在哪个页面，危险提醒都在最顶上。", tone: "danger" },
      { id: "ack", label: "看到 ≠ 解除", detail: "知道了只停止提示，横幅要等传感器确认恢复才撤下。", tone: "danger" },
      { id: "admin", label: "紧急不等于无政府", detail: "处置动作会到你手边，但照样要管理员在手机上点头。", tone: "danger" },
    ],
    fields: [
      {
        name: "safetyAcknowledged",
        type: "checkbox",
        label: "安全预演",
        required: true,
        options: [{ value: "understood", label: "我明白这三条规矩。" }],
      },
    ],
    submitLabel: "明白了",
    note: "完整处置流程见“安全”章节，也可以随时演练。",
  },
  {
    step: 7,
    key: "expectations",
    label: STEP_LABELS[6],
    title: "设定第一周的观察节奏",
    body: "你可以选择观察频率和安静时段；hob 按这份节奏整理第一份家庭建议。",
    items: [
      { label: "今天起", detail: "建立家庭状态基线。", tone: "neutral" },
      { label: "三五天后", detail: "观察家庭节奏，回答你关于家里变化的问题。", tone: "neutral" },
      { label: "两周左右", detail: "证据充足时提交给家的建议，最多 5 条。", tone: "neutral" },
      { label: "任何时候", detail: "你决定每项权限，动作可撤销并记录。", tone: "verified" },
    ],
    fields: [
      {
        name: "observationEnabled",
        type: "checkbox",
        label: "观察许可",
        required: true,
        options: [{ value: "enabled", label: "按这份节奏观察家庭", checked: true }],
      },
      {
        name: "observationInterval",
        type: "select",
        label: "观察频率",
        required: true,
        options: [
          { value: "720", label: "每 12 小时" },
          { value: "1440", label: "每天" },
          { value: "10080", label: "每周" },
        ],
      },
      { name: "quietHoursStart", type: "time", label: "安静时段开始", placeholder: "22:00", help: "使用 HH:MM" },
      { name: "quietHoursEnd", type: "time", label: "安静时段结束", placeholder: "08:00", help: "使用 HH:MM" },
    ],
    submitLabel: "保存观察节奏",
    note: "保存后，观察会按你的许可和时间安排运行。",
  },
  {
    step: 8,
    key: "first-question",
    label: STEP_LABELS[7],
    title: "都好了 · 跟 hob 说句话吧",
    body: "吩咐一件小事，或随便问一个问题。",
    fields: [
      { name: "firstQuestion", type: "textarea", label: "问问家里的情况", placeholder: "比如：现在家里怎么样？", required: true },
    ],
    submitLabel: "进入家庭对话",
    note: "影响面大的动作会先问一句，门锁和水阀永远要管理员在手机上点头。",
  },
];

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localHref(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  if (candidate.startsWith("/") && !candidate.startsWith("//") && !candidate.includes("\\")) return candidate;
  return fallback;
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value);
}

function list(items: readonly string[] | undefined, className = "product-list"): string {
  if (items === undefined || items.length === 0) return "";
  return `<ul class="${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function normalizedModel(source: ProductShellModel): NormalizedProductShellModel {
  const runtimeConfirmations = source.runtimeConfirmations ?? [];
  const runtimeConfirmationCount = source.runtimeConfirmationCount ?? runtimeConfirmations.length;
  const proposals = source.proposals ?? [];
  const spaces = source.spaces ?? [];
  const household = source.household ?? {};
  const connection = source.connection ?? { state: "unknown" as const };
  const activeTurn = source.activeTurn;
  const energy = source.energy;
  const proposalCapacity = source.proposalCapacity ?? 5;
  const proposalCapacityUsed = source.proposalCapacityUsed ?? proposals.length;
  const safetyAlert = source.safetyAlerts?.find((alert) => alert.status !== "resolved");
  return {
    ...source,
    route: source.route ?? "overview",
    household,
    connection,
    runtimeConfirmations,
    runtimeConfirmationCount,
    proposals,
    spaces,
    activeTurn,
    energy,
    proposalCapacity,
    proposalCapacityUsed,
    safetyAlert,
    expiredSummary: source.expiredSummary,
  };
}

interface NormalizedProductShellModel extends ProductShellModel {
  readonly route: ProductShellRoute;
  readonly household: ProductShellHousehold;
  readonly connection: ProductShellConnection;
  readonly runtimeConfirmations: readonly ProductRuntimeConfirmation[];
  readonly runtimeConfirmationCount: number;
  readonly proposals: readonly ProductProposal[];
  readonly spaces: readonly ProductSpace[];
  readonly activeTurn?: ProductTurn;
  readonly energy?: ProductEnergySummary;
  readonly proposalCapacity: number;
  readonly proposalCapacityUsed: number;
  readonly safetyAlert?: ProductSafetyAlert;
}

function connectionLabel(connection: ProductShellConnection): string {
  switch (connection.state) {
    case "quiet": return "连接正常 · 家庭状态稳定";
    case "connected": return connection.detail ?? "连接正常 · 家庭状态已更新";
    case "connecting": return connection.detail ?? "正在连接家里 · 状态很快更新";
    case "disconnected": return `连接中断 · 最后联系 ${connection.lastContact ?? "稍前"}`;
    case "unknown": return connection.detail ?? "正在确认家庭连接";
  }
}

function routeHref(route: ProductShellRoute, options: ProductShellRenderOptions): string {
  const configured = options.hrefs?.[route];
  return escapeHtml(localHref(configured, DEFAULT_HREFS[route]));
}

function navigationLink(route: ProductShellRoute, current: ProductShellRoute, model: NormalizedProductShellModel, options: ProductShellRenderOptions, mobile = false): string {
  const currentAttribute = route === current ? ' aria-current="page"' : "";
  const className = mobile ? "product-mobile-nav-link" : "product-nav-link";
  const label = mobile ? MOBILE_ROUTE_LABELS[route] : ROUTE_LABELS[route];
  const mobileRouteAttribute = mobile ? ` data-mobile-route="${escapeHtml(route)}"` : "";
  const badges = route === "reviews"
    ? `<span class="${mobile ? "product-mobile-nav-badges" : "product-nav-badges"}" aria-label="${model.runtimeConfirmationCount} 项等待你放行，${model.proposalCapacityUsed}/${model.proposalCapacity} 条建议"><span class="product-badge product-badge--runtime" data-badge="runtime" data-count="${model.runtimeConfirmationCount}">${model.runtimeConfirmationCount}</span><span class="product-badge product-badge--proposal" data-badge="proposal" data-count="${model.proposalCapacityUsed}/${model.proposalCapacity}">${model.proposalCapacityUsed}</span></span>`
    : "";
  return `<a class="${className}"${mobileRouteAttribute} href="${routeHref(route, options)}"${currentAttribute}><span class="${mobile ? "" : "product-nav-label"}">${label}</span>${badges}</a>`;
}

function renderHostViewSwitcher(view: ProductViewState | undefined, options: ProductShellRenderOptions): string {
  if (view === undefined || view.choices.length < 2) return "";
  const links = view.choices.map((choice) => {
    const current = choice.id === view.activeId ? ' aria-current="true"' : "";
    const currentPath = localHref(view.currentPath, "/home");
    const separator = currentPath.includes("?") ? "&" : "?";
    const href = `${currentPath}${separator}view=${encodeURIComponent(choice.id)}`;
    const state = choice.id === view.activeId ? `<span>当前</span>` : "";
    return `<a href="${escapeHtml(href)}"${current}><strong>${escapeHtml(choice.label)}</strong>${state}</a>`;
  }).join("");
  const recovery = view.recoveryMessage === undefined
    ? ""
    : `<p class="product-view-recovery" role="status">${escapeHtml(view.recoveryMessage)}</p>`;
  if (view.choices.length === 2) {
    return `<section class="product-host-view-switcher" data-host-owned="true" aria-label="切换家庭视图"><nav data-host-view-shortcuts aria-label="可用家庭视图">${links}</nav>${recovery}</section>`;
  }
  const activeLabel = view.choices.find((choice) => choice.id === view.activeId)?.label ?? "选择视图";
  const menu = `<details class="product-host-view-menu" data-host-view-menu><summary data-host-view-menu-trigger><span>当前视图</span><strong>${escapeHtml(activeLabel)}</strong></summary><div class="product-host-view-menu-panel"><header><div><strong>选择家庭视图</strong><span>切换会保留当前对话和家庭状态</span></div><a href="${routeHref("settings", options)}">管理视图</a></header><nav aria-label="可用家庭视图">${links}</nav></div></details>`;
  return `<section class="product-host-view-switcher" data-host-owned="true" aria-label="切换家庭视图">${menu}${recovery}</section>`;
}

function renderSafetyBanner(alert: ProductSafetyAlert): string {
  if (alert.status === "resolved") return "";
  const actionHref = localHref(alert.actionHref, "/review-center");
  const acknowledgeHref = localHref(alert.acknowledgeHref, `/safety/${encodedPathSegment(alert.id)}/acknowledge`);
  const liveMode = alert.status === "active" ? "assertive" : "polite";
  const attentionLabel = alert.status === "acknowledged" ? "已看到 · 事实仍在持续" : "安全提醒";
  const acknowledge = alert.status === "active" && alert.canAcknowledge !== false
    ? `<form class="product-safety-acknowledge" method="post" action="${escapeHtml(acknowledgeHref)}"><button type="submit">我已看到</button></form>`
    : "";
  return `<section class="product-safety-banner" data-host-owned="true" data-safety-status="${escapeHtml(alert.status)}" data-snooze-allowed="false" role="alert" aria-live="${liveMode}"><div class="product-safety-copy"><strong>${attentionLabel} · ${escapeHtml(alert.title)}</strong>${alert.body === undefined ? "" : `<span>${escapeHtml(alert.body)}</span>`}</div><div class="product-safety-meta">${alert.source === undefined ? "" : `<span class="product-safety-source">来源：${escapeHtml(alert.source)}</span>`}<a class="product-safety-action" href="${escapeHtml(actionHref)}">${escapeHtml(alert.actionLabel ?? "查看处置")}</a>${acknowledge}</div></section>`;
}

function renderAdviceCompletionNotification(notification: ProductAdviceCompletionNotification | undefined): string {
  if (notification === undefined) return "";
  const message = notification.status === "completed"
    ? "后台问题已经有结果"
    : notification.status === "cancelled"
      ? "后台问题已经停止"
      : "后台问题需要重新处理";
  return `<section class="product-completion-notification" data-host-owned="true" data-background-completion="${escapeHtml(notification.status)}" role="status" aria-live="polite"><strong>${message}</strong><a href="/conversation/${encodedPathSegment(notification.adviceId)}">查看这条对话</a></section>`;
}

function renderShellFrame(model: NormalizedProductShellModel, page: string, options: ProductShellRenderOptions): string {
  const route = model.route;
  const agentName = model.household.agentName ?? "家庭助手";
  const householdName = model.household.name;
  const memberName = model.household.memberName ?? "当前成员";
  const memberRole = model.household.memberRole ?? "身份待确认";
  const safety = model.safetyAlert === undefined ? "" : renderSafetyBanner(model.safetyAlert);
  const completion = renderAdviceCompletionNotification(model.completionNotification);
  const viewSwitcher = renderHostViewSwitcher(model.view, options);
  const desktopNav = ROUTES.map((item) => navigationLink(item, route, model, options)).join("");
  const mobileRoutes: readonly ProductShellRoute[] = ["overview", "reviews", "control", "activity", "settings"];
  const mobileCurrentRoute = route === "conversation" ? "overview" : route === "onboarding" ? "settings" : route;
  const mobileNav = mobileRoutes.map((item) => navigationLink(item, mobileCurrentRoute, model, options, true)).join("");
  return `<div class="product-shell" data-route="${escapeHtml(route)}" data-connection-state="${escapeHtml(model.connection.state)}"${model.view === undefined ? "" : ` data-view-provider="${escapeHtml(model.view.activeId)}"`}>${safety}${completion}${viewSwitcher}<a class="product-skip-link" href="#product-main">跳到主要内容</a><div class="product-layout"><aside class="product-sidebar" aria-label="家庭导航"><a class="product-brand" href="${routeHref("overview", options)}"><span class="product-brand-mark" aria-hidden="true">h</span><span class="product-brand-copy"><strong>${escapeHtml(agentName)}</strong>${householdName === undefined ? "" : `<small>${escapeHtml(householdName)}</small>`}<small>HobAgent</small></span></a><nav aria-label="家庭导航">${desktopNav}</nav><div class="product-profile"><span class="product-profile-mark" aria-hidden="true">${escapeHtml(memberName.slice(0, 1))}</span><span class="product-profile-copy"><strong>${escapeHtml(memberName)}</strong><small>${escapeHtml(memberRole)}</small></span></div></aside><div class="product-content"><main class="product-main" id="product-main">${page}</main><nav class="product-mobile-nav" aria-label="移动家庭导航">${mobileNav}</nav></div></div></div>`;
}

function renderOverview(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  return `${renderOverviewHeader(model, options)}${renderOverviewStatus(model)}${renderOverviewConcern(model.concern)}${renderActiveTurnSummary(model.activeTurn)}<div class="product-overview-grid"><div class="product-space-grid">${renderOverviewSpaces(model)}</div><aside class="product-overview-aside">${renderOverviewReviewSummary(model, options)}${renderOverviewAgentNote(model)}${renderOverviewEnergy(model)}</aside></div>${renderOverviewComposer(model.connection.state === "disconnected")}`;
}

function renderOverviewHeader(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const householdName = model.household.name ?? "家庭名称待设置";
  const standaloneViewShortcut = model.view === undefined
    ? `<a class="product-view-switcher" href="${routeHref("control", options)}">控制视图</a>`
    : "";
  return `<header class="product-page-header"><div><p class="product-kicker">生活视图</p><h1>${escapeHtml(householdName)}</h1><p class="product-connection" data-connection-state="${escapeHtml(model.connection.state)}">${escapeHtml(connectionLabel(model.connection))}</p></div>${standaloneViewShortcut}</header>`;
}

function renderOverviewStatus(model: NormalizedProductShellModel): string {
  const status = overviewConnectionStatus(model.connection);
  const disconnected = model.connection.state === "disconnected";
  const safetyQuiet = model.safetyAlert === undefined && (model.connection.state === "connected" || model.connection.state === "quiet")
    ? " · 没有待处理的安全事项"
    : "";
  const detail = disconnected
    ? `${model.connection.lastContact === undefined ? "" : `最后联系 ${model.connection.lastContact} · `}连接中断期间不执行任何设备动作，也不把旧数据当作现在`
    : `${model.connection.lastChanged === undefined ? status.detail : `最近变化：${model.connection.lastChanged}`}${safetyQuiet}`;
  const recovery = disconnected ? `<a class="product-secondary-action" href="/settings">查看连接</a>` : "";
  return `<section class="product-status-card" data-status="${status.tone}" aria-label="家庭状态"><div class="product-status-copy"><p class="product-status-main">${escapeHtml(status.title)}</p><p class="product-subtle">${escapeHtml(detail)}</p></div>${recovery}</section>`;
}

function renderOverviewSpaces(model: NormalizedProductShellModel): string {
  const status = overviewConnectionStatus(model.connection);
  const stale = model.connection.state === "disconnected";
  return model.spaces.length === 0
    ? `<section class="product-card product-review-empty"><h2>家庭空间会在连接完成后显示</h2><p class="product-muted">${escapeHtml(status.emptySpaceDetail)}</p></section>`
    : model.spaces.map((space) => renderSpaceCard(space, stale)).join("");
}

/** The card only relays a completed finding; without one it does not exist. */
function renderOverviewConcern(concern: ProductConcern | undefined): string {
  if (concern === undefined) return "";
  const facts = concern.facts.length === 0 ? "" : `<section class="product-answer-layer product-answer-layer--verified"><h3>已验证的家庭事实</h3>${list(concern.facts)}</section>`;
  const unknowns = concern.unknowns?.length ? `<section class="product-answer-layer product-answer-layer--unknown"><h3>仍然不知道</h3>${list(concern.unknowns)}</section>` : "";
  const suggestion = concern.suggestion === undefined ? "" : `<p class="product-concern-suggestion">${escapeHtml(concern.suggestion)}</p>`;
  return `<section class="product-card product-concern" aria-labelledby="concern-heading"><span class="product-tag product-tag--pending">当前关注</span><h2 id="concern-heading">${escapeHtml(concern.title)}</h2>${facts}${unknowns}${suggestion}<div class="product-card-actions"><a class="product-primary-action" href="/conversation/${encodedPathSegment(concern.adviceId)}">看看怎么调整</a></div></section>`;
}

function renderOverviewReviewSummary(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const reviewItems = model.runtimeConfirmations.map((item) => `<li><span>${escapeHtml(item.title)}</span><span>${escapeHtml(item.expiresIn ?? "有时限")}</span></li>`).join("");
  const proposalItems = model.proposals.slice(0, 3).map((item) => `<li><span>${escapeHtml(item.title)}</span><span>${item.status === "snoozed" ? "已暂缓" : escapeHtml(item.expiresAt ?? "不着急")}</span></li>`).join("");
  return `<section class="product-card product-review-summary" aria-labelledby="overview-review-heading"><h2 id="overview-review-heading">需要你决定 <a href="${routeHref("reviews", options)}">查看处理中心</a></h2><div class="product-summary-section"><p class="product-summary-heading product-summary-heading--amber">等待你放行 · 有时限</p><ul class="product-summary-list">${reviewItems || `<li><span class="product-review-empty">当前没有等待你放行的动作</span></li>`}</ul></div><div class="product-summary-section"><p class="product-summary-heading product-summary-heading--blue">给家的建议 · ${model.proposalCapacityUsed}/${model.proposalCapacity} · 不着急</p><ul class="product-summary-list">${proposalItems || `<li><span class="product-review-empty">新的建议会显示在这里</span></li>`}</ul></div></section>`;
}

function renderOverviewAgentNote(model: NormalizedProductShellModel): string {
  const agentName = model.household.agentName ?? "家庭助手";
  return `<section class="product-card product-agent-note" aria-label="${escapeHtml(agentName)}的提醒"><span class="product-agent-mark" aria-hidden="true">h</span><p class="product-agent-bubble">${escapeHtml(model.agentNote ?? "需要你决定的事会出现在处理中心。")}</p></section>`;
}

function renderOverviewEnergy(model: NormalizedProductShellModel): string {
  const energy = model.energy;
  return energy === undefined ? "" : `<section class="product-card" aria-labelledby="energy-heading"><h2 id="energy-heading">今日能耗</h2><div class="product-energy-value"><strong>${escapeHtml(energy.value ?? "—")}</strong>${energy.change === undefined ? "" : `<span>${escapeHtml(energy.change)}</span>`}</div>${energy.note === undefined ? "" : `<p class="product-energy-note">${escapeHtml(energy.note)}</p>`}</section>`;
}

function renderOverviewComposer(disconnected = false): string {
  const placeholder = disconnected ? "可以提问；涉及设备的动作会等连接恢复" : "问问家，或说出你想做的事…";
  const helper = disconnected ? "设备动作会在连接恢复后回到这里。" : "快捷句会把这句话交给它：低风险直接做，其余走该走的闸门。";
  const phrase = (question: string) => `<form method="post" action="/conversation"><button type="submit" name="question" value="${escapeHtml(question)}">${escapeHtml(question)}</button></form>`;
  const phrases = disconnected ? "" : `<div class="product-quick-phrases">${phrase("现在家里怎么样？")}${phrase("今晚有什么要注意的吗？")}</div>`;
  return `${phrases}<form class="product-composer" method="post" action="/conversation"><label class="product-sr-only" for="overview-question">问问家里的情况</label><input id="overview-question" name="question" autocomplete="off" placeholder="${placeholder}" /><a class="product-voice-entry" href="/voice" aria-label="使用语音">语音</a><button type="submit">发送</button></form><p class="product-helper-copy">${helper}</p>`;
}

function overviewConnectionStatus(connection: ProductShellConnection): {
  readonly tone: "ready" | "attention" | "pending";
  readonly title: string;
  readonly detail: string;
  readonly emptySpaceDetail: string;
} {
  switch (connection.state) {
    case "connected":
      return { tone: "ready", title: "家庭状态已更新", detail: "连接正常", emptySpaceDetail: "当前连接还没有返回可显示的空间。" };
    case "quiet":
      return { tone: "ready", title: "家庭状态稳定", detail: "连接正常，家中没有新的变化", emptySpaceDetail: "连接正常，当前还没有可显示的空间。" };
    case "connecting":
      return { tone: "pending", title: "正在读取家里的当前状态", detail: "连接完成后自动更新", emptySpaceDetail: "正在读取房间和设备。" };
    case "disconnected":
      return { tone: "attention", title: "家里暂时离线", detail: "已保留最近状态，连接恢复后继续更新", emptySpaceDetail: "连接恢复后会重新读取房间和设备。" };
    case "unknown":
      return { tone: "pending", title: "正在确认家里的状态", detail: "正在检查家庭连接", emptySpaceDetail: "确认连接后会读取房间和设备。" };
  }
}

function renderActiveTurnSummary(turn: ProductTurn | undefined): string {
  if (turn === undefined || !["accepted", "inspecting", "streaming", "background"].includes(turn.status)) return "";
  return `<section class="product-card product-active-turn" aria-live="polite"><div><p class="product-kicker">正在处理</p><h2>${escapeHtml(turn.question)}</h2><p class="product-muted">${escapeHtml(turn.statusMessage ?? "正在查看家里的信息")}</p></div><a class="product-primary-action" href="/conversation/${encodedPathSegment(turn.id)}">查看进度</a></section>`;
}

function renderSpaceCard(space: ProductSpace, stale = false): string {
  const meta = [space.deviceCount === undefined ? "" : `${space.deviceCount} 个设备`, space.peopleCount === undefined ? "" : `${space.peopleCount} 人`].filter(Boolean).join(" · ");
  const metaText = `${meta || space.state || "家庭空间"}${stale ? " · 最后已知" : ""}`;
  const metricItems = space.metrics?.map((metric) => `<span class="product-metric"><span class="product-metric-label">${escapeHtml(metric.label)}</span><strong class="product-metric-value">${escapeHtml(metric.value)}</strong></span>`).join("") ?? "";
  const chips = space.devices?.map((device, index) => `<span class="product-chip${index < 2 ? " product-chip--active" : ""}">${escapeHtml(device)}</span>`).join("") ?? "";
  return `<section class="product-card product-space-card" aria-labelledby="space-${escapeHtml(space.id)}"><div class="product-space-heading"><h2 id="space-${escapeHtml(space.id)}">${escapeHtml(space.name)}</h2><span class="product-space-meta">${escapeHtml(metaText)}</span></div>${metricItems === "" ? "" : `<div class="product-metric-row">${metricItems}</div>`}${chips === "" ? `<p class="product-muted">空间状态持续更新</p>` : `<div class="product-chip-row">${chips}</div>`}</section>`;
}

function renderConversation(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const turn = model.activeTurn;
  const agentName = model.household.agentName ?? "家庭助手";
  const thread = turn === undefined
    ? `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><p>我在这里，告诉我家里的情况或想做的事。</p></div></div>`
    : `<div class="product-message product-message--user"><div class="product-message-bubble"><p>${escapeHtml(turn.question)}</p></div></div>${renderTurn(turn, agentName)}`;
  return `<header class="product-page-header product-conversation-header"><div><p class="product-kicker">对话</p><h1>和${escapeHtml(agentName)}对话</h1><p class="product-muted">问我家里的状态、刚刚发生的变化，或下一步怎么做。</p></div><a class="product-view-switcher" href="${routeHref("overview", options)}">回到总览</a></header><div class="product-conversation"><section class="product-card product-conversation-main" aria-label="对话内容"><div class="product-conversation-thread" aria-live="polite">${thread}</div><form class="product-conversation-composer" method="post" action="/conversation"><label class="product-sr-only" for="conversation-question">继续对话</label><input id="conversation-question" name="question" autocomplete="off" placeholder="继续吩咐，或问它为什么这样选…" /><a class="product-voice-entry" href="/voice" aria-label="使用语音">语音</a><button type="submit">发送</button></form><p class="product-helper-copy">处理进度和结果会显示在这里。</p>${renderUndo(model.undo)}</section><aside class="product-conversation-side"><section class="product-card" aria-labelledby="conversation-scope-heading"><h2 id="conversation-scope-heading">本次问题</h2><ul class="product-side-list"><li><span>家庭</span><strong>${escapeHtml(model.household.name ?? "家庭名称待设置")}</strong></li><li><span>来源</span><strong>家庭状态</strong></li></ul></section><section class="product-card product-card--flat"><h2>动作说明</h2><p class="product-muted">需要确认的动作会先等你同意；每次动作的验证和撤销入口会显示在结果里。</p></section></aside></div>`;
}

function renderTurn(turn: ProductTurn, agentName: string): string {
  const active = turn.status === "accepted" || turn.status === "inspecting" || turn.status === "streaming" || turn.status === "background";
  const stageOrder: readonly ProductTurnStage[] = ["received", "checking_home", "reading_inventory", "checking_rules", "composing"];
  const stageLabels: Readonly<Record<ProductTurnStage, string>> = { received: "已收到", checking_home: "查看家里的当前状态", reading_inventory: "查看房间和设备", checking_rules: "确认家里已有安排", composing: "整理回答" };
  const stage = turn.stage ?? "received";
  const currentIndex = stageOrder.indexOf(stage);
  const progress = active ? `<section class="product-progress" aria-label="${escapeHtml(agentName)}正在处理"><div class="product-progress-heading"><h2>${escapeHtml(active ? (turn.statusMessage ?? stageLabels[stage]) : "")}</h2><span class="product-progress-status" role="status" aria-live="polite">${turn.status === "background" ? "稍后告诉你" : turn.elapsedSeconds !== undefined && turn.elapsedSeconds > 10 ? "仍在处理" : "正在处理"}</span></div><ol class="product-stage-list">${stageOrder.map((item, index) => `<li data-state="${index < currentIndex ? "complete" : index === currentIndex ? "current" : "pending"}"><span class="product-stage-marker" aria-hidden="true">${index + 1}</span>${stageLabels[item]}</li>`).join("")}</ol>${turn.streamText === undefined ? "" : `<p class="product-stream-text">${escapeHtml(turn.streamText)}</p>`}<div class="product-conversation-actions">${turn.canStop === false ? "" : `<form class="product-action-form product-action-form--stop" method="post" action="/conversation/${encodedPathSegment(turn.id)}/stop"><button class="product-quiet-action" type="submit">停止</button></form>`}${turn.status !== "background" && (turn.canBackground === true || (turn.elapsedSeconds ?? 0) > 10) ? `<form class="product-action-form" method="post" action="/conversation/${encodedPathSegment(turn.id)}/background"><button class="product-quiet-action" type="submit">稍后处理</button></form>` : ""}</div>${turn.status === "background" ? `<p class="product-muted">完成后我会通知你，结果会回到这条对话。</p>` : ""}</section>` : "";
  if (turn.status === "failed") return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><div class="product-turn-error" role="alert"><p>${escapeHtml(turn.error ?? "家里的连接正在恢复，我会保留你的问题，恢复后可以继续。")}</p></div><div class="product-conversation-actions"><form class="product-action-form" method="post" action="/conversation/${encodedPathSegment(turn.id)}/retry"><button class="product-quiet-action" type="submit">重新开始</button></form></div></div></div>`;
  if (turn.status === "cancelled") return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><p>已停止这次请求，家里的状态保持原样。</p></div></div>`;
  if (active) return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble">${progress}</div></div>`;
  if (turn.status === "idle") return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><p>等待你继续提问。</p></div></div>`;
  if (turn.status === "unknown") return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><p>正在确认这次问题的状态。</p></div></div>`;
  const answer = turn.answer === undefined ? "已经完成。" : turn.answer;
  const layers = `${turn.verifiedFacts?.length ? `<section class="product-answer-layer product-answer-layer--verified"><h3>已确认</h3>${list(turn.verifiedFacts)}</section>` : ""}${turn.unknowns?.length ? `<section class="product-answer-layer product-answer-layer--unknown"><h3>仍待确认</h3>${list(turn.unknowns)}</section>` : ""}${turn.suggestions?.length ? `<section class="product-answer-layer product-answer-layer--suggestion"><h3>给家的建议</h3>${list(turn.suggestions)}</section>` : ""}`;
  const correction = turn.correctionAck === undefined ? "" : `<div class="product-correction"><strong>${escapeHtml(turn.correctionAck)}</strong>${turn.correctionDestination === undefined ? "" : `<span> · ${escapeHtml(turn.correctionDestination)}</span>`}${turn.correctionProposalCount === undefined ? "" : `<span> · 当前 ${Math.max(0, Math.floor(turn.correctionProposalCount))} 条建议</span>`}</div>`;
  const proposalTrail = turn.correctionProposalId === undefined || turn.correctionAck !== undefined
    ? ""
    : `<div class="product-turn-proposal"><p>已按此创建一条建议（后台准备中，方案备好后一次点头即启用），不会自动执行。</p><a href="/review-center?proposal=${encodeURIComponent(turn.correctionProposalId)}">在处理中心查看</a></div>`;
  const correctionForm = turn.status === "completed" ? renderCorrectionForm(turn.id) : "";
  return `<div class="product-message"><span class="product-message-mark" aria-hidden="true">h</span><div class="product-message-bubble"><section class="product-answer"><h2>已完成</h2><p>${escapeHtml(answer)}</p>${layers}${correction}${proposalTrail}${correctionForm}</section></div></div>`;
}

function renderCorrectionForm(adviceId: string): string {
  const action = `/conversation/${encodedPathSegment(adviceId)}/correction`;
  return `<form class="product-correction-form" method="post" action="${escapeHtml(action)}"><fieldset><legend>这次回答需要调整吗？</legend><label><input type="radio" name="correctionType" value="household_fact" required>家庭事实</label><label><input type="radio" name="correctionType" value="household_preference">家庭偏好</label><label><input type="radio" name="correctionType" value="future_behavior">未来行为</label></fieldset><label class="product-sr-only" for="correction-${escapeHtml(adviceId)}">告诉我需要记住什么</label><textarea id="correction-${escapeHtml(adviceId)}" name="correction" autocomplete="off" rows="2" maxlength="2000" required placeholder="告诉我需要记住什么…"></textarea><input type="hidden" name="idempotencyKey" value="${escapeHtml(`${adviceId}:correction`)}"><button class="product-secondary-action" type="submit">提交纠正</button><p class="product-muted">事实和偏好会写入家庭知识；未来行为会进入给家的建议。</p></form>`;
}

function renderUndo(undo: ProductUndo | undefined): string {
  if (undo === undefined || undo.status !== "available" || undo.remainingSeconds <= 0) return "";
  return `<section class="product-undo" role="status" aria-live="polite" data-undo-id="${escapeHtml(undo.id)}" remaining-seconds="${Math.max(0, Math.floor(undo.remainingSeconds))}"><div><p><strong>${escapeHtml(undo.label)}</strong></p><p class="product-undo-note">10 秒内可以撤销这次动作。</p></div><form method="post" action="/actions/${encodedPathSegment(undo.id)}/undo"><button type="submit">撤销</button></form></section>`;
}

function renderReviews(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const detail = model.selectedProposal?.id === model.selectedProposalId
    ? model.selectedProposal
    : model.selectedProposalId === undefined ? undefined : model.proposals.find((proposal) => proposal.id === model.selectedProposalId);
  const selected = detail === undefined && model.selectedProposalId !== undefined ? model.proposals[0] : detail;
  return `<header class="product-page-header"><div><p class="product-kicker">处理中心</p><h1>需要你决定的事</h1><p class="product-muted">有时限的动作会先提醒你；其他建议可以稍后决定。</p></div><a class="product-view-switcher" href="${routeHref("automations", options)}">它替你做的事</a></header>${model.expiredSummary === undefined ? "" : `<p class="product-card product-card--flat product-muted">${escapeHtml(model.expiredSummary)}</p>`}<div class="product-review-page"><div class="product-review-list"><section aria-labelledby="runtime-heading"><div class="product-review-list-heading"><h2 id="runtime-heading">等待你放行</h2><p>有时限 · 到期自动取消</p></div><div class="product-review-list">${model.runtimeConfirmations.length === 0 ? `<p class="product-card product-review-empty">当前没有等待你放行的动作。</p>` : model.runtimeConfirmations.map(renderRuntimeCard).join("")}</div></section><section aria-labelledby="proposal-heading"><div class="product-review-list-heading"><h2 id="proposal-heading">给家的建议</h2><p>${model.proposalCapacityUsed}/${model.proposalCapacity} · 不着急</p></div><div class="product-review-list">${model.proposals.length === 0 ? `<p class="product-card product-review-empty">新的建议会显示在这里。</p>` : model.proposals.map((proposal) => renderProposalCard(proposal, selected?.id === proposal.id, options)).join("")}</div><p class="product-muted">先放一放的建议会在过期前回来一次；有新证据也会叫醒它。</p></section></div><section class="product-proposal-detail" aria-labelledby="proposal-detail-heading">${selected === undefined ? `<div class="product-card"><h2 id="proposal-detail-heading">先选一条建议</h2><p class="product-muted">查看证据、仍待确认的事和一次决定。</p></div>` : renderProposalDetail(selected)}</section></div>`;
}

function renderRuntimeCard(item: ProductRuntimeConfirmation): string {
  const status = item.status ?? "pending";
  const canApprove = item.canApprove !== false && status === "pending";
  const administrator = item.policyClass === "administrator" || item.policyClass === "admin";
  const tags = `${item.eligibleActor === undefined ? "" : `<span class="product-tag ${administrator ? "product-tag--red" : "product-tag--neutral"}">${escapeHtml(item.eligibleActor)}</span>`}${item.source === undefined ? "" : `<span class="product-tag product-tag--amber">来自：${escapeHtml(item.source)}</span>`}`;
  const actions = status !== "pending" ? renderRuntimeOutcome(item, status) : canApprove ? `<div class="product-card-actions"><form class="product-action-form" method="post" action="/runtime-confirmations/${encodedPathSegment(item.id)}/reject"><button class="product-secondary-action" type="submit">${escapeHtml(item.rejectLabel ?? "拒绝")}</button></form><form class="product-action-form" method="post" action="/runtime-confirmations/${encodedPathSegment(item.id)}/approve"><button class="product-primary-action" type="submit">${escapeHtml(item.approveLabel ?? (administrator ? "放行（管理员）" : "放行"))}</button></form></div>` : `<p class="product-muted">${escapeHtml(item.eligibleActor ?? "请在可批准的设备上完成放行")} · 已推送到管理员手机</p>`;
  return `<article class="product-card product-card--amber product-review-card" data-review-kind="runtime" data-review-id="${escapeHtml(item.id)}"><div class="product-card-tags">${tags}</div><h3>${escapeHtml(item.title)}</h3>${item.effect === undefined ? "" : `<p>${escapeHtml(item.effect)}</p>`}${renderRuntimeWindow(item)}${actions}</article>`;
}

function renderRuntimeOutcome(item: ProductRuntimeConfirmation, status: "expired" | "decided" | "superseded"): string {
  if (status === "decided") {
    return `<p class="product-runtime-outcome product-runtime-outcome--done">${escapeHtml(item.decisionSummary ?? "这项动作已经完成并核对。")}</p>`;
  }
  if (status === "superseded") {
    return `<p class="product-muted">已在另一台设备上处理，这张卡不再需要你。</p>`;
  }
  const reissue = item.reissueHref === undefined
    ? ""
    : `<a class="product-secondary-action" href="${escapeHtml(localHref(item.reissueHref, "/review-center"))}">重新发起（重新计时）</a>`;
  return `<p class="product-muted">已取消 · 时限内无人批准 · 未执行，已留记录。</p>${reissue}`;
}

function renderRuntimeWindow(item: ProductRuntimeConfirmation): string {
  const deadline = item.expiresLabel ?? item.expiresAt;
  const consequence = `<span class="product-subtle">没人点头就不做${deadline === undefined ? "" : ` · 截止 ${escapeHtml(deadline)}`}</span>`;
  const label = item.expiresIn === undefined ? "等待时限确认" : item.expiresIn === "已到期" ? "已到期 · 未执行" : `${item.expiresIn}后自动取消`;
  const timed = item.expiresAt !== undefined && Number.isFinite(Date.parse(item.expiresAt));
  const countdown = timed
    ? `<strong class="product-runtime-countdown" data-runtime-countdown data-expires-at="${escapeHtml(item.expiresAt)}">${escapeHtml(label)}</strong>`
    : `<strong class="product-runtime-countdown">${escapeHtml(label)}</strong>`;
  return `<p class="product-runtime-window">${countdown}${consequence}</p>`;
}

function renderProposalCard(proposal: ProductProposal, selected: boolean, options: ProductShellRenderOptions): string {
  const statusLabel = proposal.newEvidence ? "新证据" : proposal.status === "snoozed" ? "已暂缓" : proposal.kind === "household-insight" ? "家庭洞察" : "方案已备好";
  return `<article class="product-card product-review-card${selected ? " product-card--selected" : ""}" data-review-kind="proposal" data-review-id="${escapeHtml(proposal.id)}"><div class="product-card-tags"><span class="product-tag">${statusLabel}</span></div><h3>${escapeHtml(proposal.title)}</h3>${proposal.summary === undefined ? "" : `<p class="product-muted">${escapeHtml(proposal.summary)}</p>`}<div class="product-card-actions"><a class="product-primary-action" href="${escapeHtml(`${localHref(options.hrefs?.reviews, DEFAULT_HREFS.reviews)}?proposal=${encodeURIComponent(proposal.id)}`)}">${proposal.kind === "household-insight" ? "查看" : "查看方案"}</a>${proposal.kind === "household-insight" ? renderInsightCardActions(proposal) : ""}${renderLaterForm(proposal)}</div></article>`;
}

function renderInsightCardActions(proposal: ProductProposal): string {
  return `<form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/helpful"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-secondary-action" type="submit">有帮助</button></form><form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/reject"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-secondary-action" type="submit">不需要</button></form>`;
}

function renderProposalDetail(proposal: ProductProposal): string {
  const insight = proposal.kind === "household-insight";
  const readiness = proposal.readiness?.length
    ? `<ul class="product-readiness" aria-label="方案已备好">${proposal.readiness.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  const why = proposal.why?.length ? proposal.why : proposal.evidence?.length ? proposal.evidence : ["暂无已记录证据"];
  const sections = [
    `<section><h3>为什么提这个</h3>${list(why, "product-cause-chain")}</section>`,
    proposal.willDo?.length ? `<section><h3>具体会改变什么</h3>${list(proposal.willDo, "product-cause-chain")}</section>` : "",
    proposal.willNotDo?.length ? `<section><h3>不会做</h3>${list(proposal.willNotDo, "product-cause-chain")}</section>` : "",
    proposal.unknowns?.length ? `<section><h3>仍待确认</h3>${list(proposal.unknowns)}</section>` : "",
  ].join("");
  const risk = proposal.risk === undefined ? "" : `<p class="product-detail-risk">风险与权限：${escapeHtml(proposal.risk)}</p>`;
  const gateDisclosure = proposal.gateClasses?.includes("confirmation")
    ? `<p class="product-gate-disclosure">需要确认的设备${proposal.confirmationDeviceNames?.length ? `（${proposal.confirmationDeviceNames.map(escapeHtml).join("、")}）` : ""}：这次启用就是你的授权，之后由自动化直接执行；随时可以暂停或关闭。</p>`
    : "";
  const dependency = proposal.dependency === undefined
    ? ""
    : `<p class="product-dependency">需要：${escapeHtml(proposal.dependency)}。</p>`;
  const after = `<p class="product-detail-after">启用后：${escapeHtml(proposal.afterEnable ?? "随时可以暂停，或关闭并移除；它从不改动你原有的规则。")}</p>`;
  const journey = proposal.trace === undefined
    ? ""
    : `<details class="product-agent-journey"><summary>这条建议怎么得来的</summary>${renderAgentLoopTimeline(proposal.trace)}</details>`;
  const preparing = proposal.lifecycle === "preparing" || proposal.lifecycle === "needs_info";
  const decide = insight
    ? renderInsightActions(proposal)
    : preparing
      ? `<p class="product-muted">正在后台准备：核对证据、检查冲突、确认权限。备好后它会来找你，现在不用做任何决定。</p>`
      : `<div class="product-card-actions">${enableForm(proposal)}${renderLaterForm(proposal)}${declineDisclosure(proposal)}</div><div class="product-card-actions">${conversationEntry(proposal)}</div><p>这是唯一一次点头：启用后自动化立刻开始真实运行，随时可以暂停，或关闭并移除；它从不改动你原有的规则。</p>`;
  return `<article class="product-card product-card--flat"><div class="product-detail-header"><div><p class="product-kicker">${insight ? "家庭洞察" : "方案已备好"}</p><h2 id="proposal-detail-heading">${escapeHtml(proposal.title)}</h2></div><span class="product-tag">建议 · 不着急</span></div>${readiness}<div class="product-detail-columns">${sections}</div>${risk}${gateDisclosure}${dependency}${insight ? "" : after}${journey}<div class="product-review-boundary">${decide}</div></article>`;
}

function enableForm(proposal: ProductProposal): string {
  return `<form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/enable"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-primary-action" type="submit">启用</button></form>`;
}

/** Changing a plan happens in conversation, where suggestions are born. */
function conversationEntry(proposal: ProductProposal): string {
  return `<form class="product-action-form" method="post" action="/conversation"><button class="product-quiet-action" type="submit" name="question" value="${escapeHtml(`我想调整建议「${proposal.title}」：`)}">在对话里改</button></form>`;
}

/** "不用了" opens the honest pair: dismiss once, or never suggest this again. */
function declineDisclosure(proposal: ProductProposal): string {
  const reject = `<form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/reject"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-secondary-action" type="submit">仅这次不要</button></form>`;
  const latch = `<form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/reject-latch"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-danger-action" type="submit">不再提这件事</button></form>`;
  return `<details class="product-snooze"><summary>不用了</summary><div class="product-snooze-options">${reject}${latch}</div><p class="product-snooze-note">「不再提」会当面承诺并永久遵守，可在设置里解除。</p></details>`;
}

/** A household insight has nothing to enable; it only collects usefulness. */
function renderInsightActions(proposal: ProductProposal): string {
  return `<div class="product-card-actions"><form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/helpful"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-primary-action" type="submit">有帮助</button></form><form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/reject"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-secondary-action" type="submit">不需要</button></form></div><p>这类建议只是让你知道；要不要动手由你决定。</p>`;
}

function renderLaterForm(proposal: Pick<ProductProposal, "id" | "revision">): string {
  return `<form class="product-action-form" method="post" action="/review-center/proposals/${encodedPathSegment(proposal.id)}/snooze"><input type="hidden" name="expectedRevision" value="${escapeHtml(proposal.revision)}"><button class="product-secondary-action" type="submit" name="until" value="later">以后再说</button></form>`;
}

const AUTOMATION_PRESENTATION = {
  enabling: { label: "正在启用", tone: "pending" },
  active: { label: "运行中", tone: "verified" },
  paused: { label: "已暂停", tone: "pending" },
  closed: { label: "已关闭", tone: "neutral" },
  enable_failed: { label: "没能启用", tone: "failed" },
} as const satisfies Readonly<Record<ProductAutomationLifecycle, { readonly label: string; readonly tone: string }>>;

function renderAutomations(model: NormalizedProductShellModel): string {
  const automations = model.automations ?? [];
  const cards = automations.length === 0
    ? `<section class="product-card product-review-empty"><h2>还没有运行中的自动化</h2><p class="product-muted">你在处理中心启用的自动化会出现在这里。</p></section>`
    : automations.map(renderAutomationCard).join("");
  return `<header class="product-page-header"><div><p class="product-kicker">自动化</p><h1>它替你做的事</h1><p class="product-muted">每一条都可以暂停或移除；它们从不改动你原有的规则。</p></div></header><div class="product-automation-list">${cards}</div>`;
}

function renderAutomationCard(automation: ProductAutomation): string {
  const presentation = AUTOMATION_PRESENTATION[automation.lifecycle];
  const version = automation.version === undefined ? "" : `<span class="product-subtle">版本 v${escapeHtml(automation.version)}</span>`;
  const drift = automation.drifted === true
    ? `<span class="product-tag product-tag--pending">已在原生系统被改动</span>`
    : "";
  const detail = automation.lifecycle === "enable_failed"
    ? `<p class="product-automation-failure">${escapeHtml(automation.failureReason ?? "启用没有完成，家里的设置保持原样。")}</p>`
    : automation.lastResult === undefined ? "" : `<p class="product-muted">最近一次：${escapeHtml(automation.lastResult)}</p>`;
  const activity = automation.recentActivity?.length
    ? `<ul class="product-automation-activity">${automation.recentActivity.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  const control = (action: string, label: string, className: string) => `<form class="product-action-form" method="post" action="/automations/${encodedPathSegment(automation.id)}/${action}"><button class="${className}" type="submit">${label}</button></form>`;
  const actions = automation.lifecycle === "active"
    ? `${control("pause", "暂停", "product-secondary-action")}${control("close", "关闭并移除", "product-danger-action")}`
    : automation.lifecycle === "paused"
      ? `${control("resume", "继续运行", "product-primary-action")}${control("close", "关闭并移除", "product-danger-action")}`
      : automation.lifecycle === "enable_failed"
        ? `${control("retry", "重试启用", "product-primary-action")}${control("close", "关闭并移除", "product-secondary-action")}`
        : "";
  return `<article class="product-card product-automation-card" data-automation-id="${escapeHtml(automation.id)}" data-automation-state="${escapeHtml(automation.lifecycle)}"><div class="product-card-tags"><span class="product-tag product-tag--${presentation.tone}">${presentation.label}</span>${drift}${version}</div><h2>${escapeHtml(automation.title)}</h2>${detail}${activity}${actions === "" ? "" : `<div class="product-card-actions">${actions}</div>`}</article>`;
}

function renderActivity(model: NormalizedProductShellModel): string {
  const records = model.activity ?? [];
  const agentName = model.household.agentName ?? "家庭助手";
  const groups = new Map<string, ProductActivityRecord[]>();
  for (const record of records) {
    const key = record.dateLabel ?? record.dateGroup ?? "today";
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const memberName = model.household.memberName;
  const grouped = [...groups.entries()].map(([key, items]) => `<section><h2 class="product-activity-date">${escapeHtml(key === "today" ? "今天" : key === "yesterday" ? "昨天" : key)}</h2><ul class="product-activity-list">${items.map((item) => renderActivityItem(item, agentName, memberName)).join("")}</ul></section>`).join("");
  const selected = records.find((record) => record.id === model.selectedActivityId) ?? records[0];
  const selectedActor = selected === undefined ? undefined : selected.attribution === "hob" ? agentName : selected.actor;
  const side = selected === undefined ? `<section class="product-card"><h2>先选一条活动</h2><p class="product-muted">查看时间、执行者、动作和结果。</p></section>` : `<section class="product-card product-cause-aside" aria-labelledby="activity-cause-heading"><h2 id="activity-cause-heading">为什么会这样</h2><div class="product-cause-highlight"><strong>${escapeHtml(selected.title)}</strong><p>${escapeHtml(selectedActor === undefined ? "家里发生的变化" : `由${selectedActor}完成`)}</p></div>${selected.cause === undefined || selected.cause.length === 0 ? `<p class="product-muted">原因还在确认中。</p>` : `<h3>为什么会这样</h3><ol class="product-cause-chain">${selected.cause.map((cause, index) => `<li class="${index === 0 ? "product-cause-trigger" : ""}">${escapeHtml(cause)}</li>`).join("")}</ol>`}${selected.verification === undefined ? "" : `<p class="product-muted">证据：${escapeHtml(selected.verification)}</p>`}</section>`;
  const filters: readonly { readonly key: string; readonly label: string }[] = [
    { key: "all", label: "全部" },
    { key: "member", label: "你" },
    { key: "hob", label: agentName },
    { key: "external-rule", label: "外部规则" },
    { key: "physical", label: "物理" },
  ];
  const filterStrip = `<div class="product-activity-filters" data-activity-filters role="group" aria-label="按来源筛选">${filters.map((filter, index) => `<button type="button" data-activity-filter="${filter.key}"${index === 0 ? ` aria-pressed="true"` : ` aria-pressed="false"`}>${escapeHtml(filter.label)}</button>`).join("")}</div>`;
  return `<header class="product-page-header"><div><p class="product-kicker">活动</p><h1>家里发生了什么</h1><p class="product-muted">查看家里的变化，了解原因和结果。</p></div></header>${filterStrip}<div class="product-activity"><div class="product-activity-main">${grouped || `<section class="product-card product-review-empty">今天暂时安静，新的家庭活动会显示在这里。</section>`}</div><aside class="product-cause-aside">${side}</aside></div>`;
}

function attributionLabel(record: Pick<ProductActivityRecord, "attribution" | "actor">, agentName: string, memberName: string | undefined): string {
  switch (record.attribution) {
    case "physical": return "物理";
    case "member": return record.actor !== undefined && record.actor === memberName ? "你" : record.actor ?? "家人";
    case "hob": return agentName;
    case "external-rule": return "外部规则";
    case "system": return "系统";
    case "unknown": return "来源待确认";
  }
}

function renderActivityItem(record: ProductActivityRecord, agentName: string, memberName: string | undefined): string {
  const cause = record.cause?.length ? `<details><summary>为什么会这样</summary><ol class="product-cause-chain">${record.cause.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></details>` : "";
  const verification = record.verification === undefined ? "" : `<p class="product-activity-verification">${escapeHtml(record.verification)}</p>`;
  return `<li class="product-activity-item" data-activity-id="${escapeHtml(record.id)}" data-activity-attribution="${escapeHtml(record.attribution)}"><time class="product-activity-time">${escapeHtml(record.time)}</time><div class="product-activity-copy"><strong>${escapeHtml(record.title)}</strong>${record.space === undefined ? "" : `<span class="product-subtle">${escapeHtml(record.space)}</span>`}${verification}${cause}</div><span class="product-attribution" data-attribution="${escapeHtml(record.attribution)}">${escapeHtml(attributionLabel(record, agentName, memberName))}</span></li>`;
}

function renderBatchControl(batch: ProductBatchControl): string {
  const policyLabels: Readonly<Record<ProductBatchPolicyClass, string>> = {
    direct: "直接完成",
    confirmation: "需要确认",
    administrator: "管理员确认",
  };
  const statusLabels: Readonly<Record<ProductBatchActionStatus, string>> = {
    verified: "已完成",
    pending_confirmation: "等待你放行",
    failed: "未完成",
    unknown: "结果待确认",
  };
  const items = batch.preview.items.map((item) => `<label class="product-batch-item"><input type="checkbox" name="capabilityId" value="${escapeHtml(item.capabilityId)}" data-batch-policy-class="${escapeHtml(item.policyClass)}"><span class="product-batch-item-copy"><strong>${escapeHtml(item.actionLabel ?? item.label)}</strong><small>${escapeHtml(item.label)} · ${policyLabels[item.policyClass]}</small></span></label>`).join("");
  const counts = `<div class="product-batch-summary" aria-label="选中动作的处理方式"><span class="product-batch-count"><strong data-batch-count="total">${batch.preview.total}</strong><small>项动作</small></span><span class="product-batch-count"><strong data-batch-count="direct">${batch.preview.direct}</strong><small>直接完成</small></span><span class="product-batch-count"><strong data-batch-count="confirmation">${batch.preview.confirmation}</strong><small>需要确认</small></span><span class="product-batch-count"><strong data-batch-count="administrator">${batch.preview.administrator}</strong><small>管理员确认</small></span></div>`;
  const result = batch.result === undefined ? "" : `<section class="product-batch-results" aria-labelledby="batch-results-heading"><h3 id="batch-results-heading">每项动作分别处理</h3><ul>${batch.result.items.map((item) => `<li class="product-batch-result product-batch-result--${escapeHtml(item.status)}" data-batch-result-status="${escapeHtml(item.status)}"${item.ticketId === undefined ? "" : ` data-ticket-id="${escapeHtml(item.ticketId)}"`}><div><strong>${escapeHtml(item.label ?? item.capabilityId)}</strong><span>${escapeHtml(statusLabels[item.status])}</span></div>${item.ticketId === undefined ? "" : `<small>票据 ${escapeHtml(item.ticketId)}</small>`}<p>${escapeHtml(item.reason)}</p></li>`).join("")}</ul></section>`;
  return `<section class="product-card product-batch-control" data-batch-control aria-labelledby="batch-control-heading"><div class="product-batch-header"><div><p class="product-kicker">批量控制</p><h2 id="batch-control-heading">一次选择多项动作</h2><p class="product-muted">先查看每项动作的处理方式，再提交选择。每项动作分别处理。</p></div></div>${counts}<form class="product-batch-form" method="post" action="/control/batch"><fieldset><legend class="product-sr-only">选择要处理的动作</legend><div class="product-batch-items">${items}</div></fieldset><button class="product-primary-action" type="submit" data-batch-submit disabled>执行选中的动作</button></form>${result}</section>`;
}

function controlPolicyLabel(policyClass: ProductControlItem["policyClass"]): string {
  if (policyClass === "administrator") return "管理员确认";
  if (policyClass === "confirmation") return "需要确认";
  return "直接完成";
}

const CONTROL_CONNECTION_PRESENTATION = {
  connected: {
    availability: "available",
    countLabel: "项可用动作",
    summary: "每项动作都会按成员权限处理，需要确认的会先等你同意。",
  },
  quiet: {
    availability: "available",
    countLabel: "项可用动作",
    summary: "每项动作都会按成员权限处理，需要确认的会先等你同意。",
  },
  connecting: {
    availability: "waiting",
    countLabel: "项待连接动作",
    summary: "正在连接家庭设备，状态准备好后即可操作。",
  },
  disconnected: {
    availability: "waiting",
    countLabel: "项待连接动作",
    summary: "家庭连接正在恢复，状态保留为上次已知值。",
  },
  unknown: {
    availability: "waiting",
    countLabel: "项待连接动作",
    summary: "正在确认家庭连接，状态准备好后即可操作。",
  },
} as const satisfies Readonly<Record<ProductConnectionState, {
  readonly availability: "available" | "waiting";
  readonly countLabel: string;
  readonly summary: string;
}>>;

function renderWallApprovals(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const confirmations = model.runtimeConfirmations;
  if (confirmations.length === 0) return "";
  const rows = confirmations.slice(0, 3).map((item) => `<li><strong>${escapeHtml(item.title)}</strong>${item.expiresIn === undefined ? "" : `<span>${escapeHtml(item.expiresIn)}后自动取消</span>`}</li>`).join("");
  return `<section class="product-card product-wall-approvals" aria-labelledby="wall-approvals-heading"><h2 id="wall-approvals-heading">等待放行 · ${model.runtimeConfirmationCount} 条</h2><ul>${rows}</ul><p class="product-muted">共享屏不替人点头 —— 已推送到管理员的手机，任一人批准即可；这里只看，不能放行。</p><a class="product-secondary-action" href="${routeHref("reviews", options)}">查看全部 ${model.runtimeConfirmationCount} 条 →</a></section>`;
}

function renderDenseControl(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const spaces = model.controlSpaces ?? [];
  const controlCount = spaces.reduce((total, space) => total + (space.controls?.length ?? 0), 0);
  const connectionPresentation = CONTROL_CONNECTION_PRESENTATION[model.connection.state];
  const controlsAvailable = connectionPresentation.availability === "available";
  const rowDensity = model.view?.preferences?.find((preference) => preference.key === "rowDensity")?.value === "compact"
    ? "compact"
    : "comfortable";
  const feedback = model.controlFeedback === undefined ? "" : renderControlFeedback(model.controlFeedback);
  const batch = model.batchControl === undefined ? "" : renderBatchControl(model.batchControl);
  const standaloneViewShortcut = model.view === undefined
    ? `<a class="product-view-switcher" href="${routeHref("overview", options)}">生活视图</a>`
    : "";
  const rows = spaces.map((space) => {
    const controls = (space.controls ?? []).map((control) => {
      const policyLabel = controlPolicyLabel(control.policyClass);
      const stateLabel = controlsAvailable ? policyLabel : `${policyLabel} · 连接恢复后可用`;
      const currentValue = controlsAvailable || control.value === undefined
        ? control.value ?? "状态待确认"
        : `上次：${control.value}`;
      const disabled = controlsAvailable ? "" : " disabled aria-disabled=\"true\"";
      return `<form class="product-control-row" method="post" action="/control/${encodedPathSegment(control.id)}" data-control-capability="${escapeHtml(control.id)}"><span class="product-control-identity"><strong>${escapeHtml(control.label)}</strong><small>${escapeHtml(stateLabel)}</small></span><span class="product-control-current-value">${escapeHtml(currentValue)}</span><button class="product-control-action${control.result === "unknown" ? " product-result--unknown" : control.result === "failed" ? " product-result--failed" : ""}" type="submit"${disabled}>${escapeHtml(control.actionLabel ?? control.label)}</button></form>`;
    }).join("");
    const metrics = space.metrics?.map((metric) => `<span class="product-control-metric"><small>${escapeHtml(metric.label)}</small><strong>${escapeHtml(metric.value)}</strong></span>`).join("") ?? "";
    return `<section class="product-control-space" data-control-space="${escapeHtml(space.id)}" aria-labelledby="control-${escapeHtml(space.id)}"><header><div><h2 id="control-${escapeHtml(space.id)}">${escapeHtml(space.name)}</h2><span class="product-control-state">${escapeHtml(space.state ?? `${space.deviceCount ?? 0} 个设备`)}</span></div>${metrics === "" ? "" : `<div class="product-control-metrics">${metrics}</div>`}</header><div class="product-control-rows">${controls || `<p class="product-control-empty">这个空间的动作仍在准备，当前状态会继续更新。</p>`}</div></section>`;
  }).join("");
  return `<header class="product-page-header"><div><p class="product-kicker">控制视图</p><h1>家里的状态</h1><p class="product-connection" data-connection-state="${escapeHtml(model.connection.state)}">${escapeHtml(connectionLabel(model.connection))}</p></div>${standaloneViewShortcut}</header>${feedback}${batch}<section class="product-control-workspace" data-control-density="dense" data-control-row-density="${rowDensity}" data-control-availability="${connectionPresentation.availability}" aria-label="家庭控制概览"><div class="product-control-summary"><span><strong>${spaces.length}</strong><small>个空间</small></span><span><strong>${controlCount}</strong><small>${connectionPresentation.countLabel}</small></span><p>${connectionPresentation.summary}</p></div><div class="product-control-spaces">${rows || `<section class="product-control-space"><h2>家里状态正在准备</h2><p class="product-muted">连接恢复后，这里会显示房间和设备。</p></section>`}</div></section>${renderWallApprovals(model, options)}`;
}

function renderControl(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  if (model.controlSpaces !== undefined) return renderDenseControl(model, options);
  const spaces: readonly ProductControlSpace[] = model.controlSpaces ?? model.spaces.map((space): ProductControlSpace => ({
    ...space,
    controls: [],
  }));
  const feedback = model.controlFeedback === undefined ? "" : renderControlFeedback(model.controlFeedback);
  const batch = model.batchControl === undefined ? "" : renderBatchControl(model.batchControl);
  const standaloneViewShortcut = model.view === undefined
    ? `<a class="product-view-switcher" href="${routeHref("overview", options)}">生活视图</a>`
    : "";
  return `<header class="product-page-header"><div><p class="product-kicker">控制</p><h1>家里的状态</h1><p class="product-muted">查看房间状态，需要时请求一项动作。</p></div>${standaloneViewShortcut}</header>${feedback}${batch}<div class="product-control-grid">${spaces.length === 0 ? `<section class="product-card"><h2>家里状态正在准备</h2><p class="product-muted">连接恢复后，这里会显示房间和设备。</p></section>` : spaces.map((space) => `<section class="product-card product-control-card" aria-labelledby="control-${escapeHtml(space.id)}"><header><h2 id="control-${escapeHtml(space.id)}">${escapeHtml(space.name)}</h2><span class="product-control-state">${escapeHtml(space.state ?? `${space.deviceCount ?? 0} 个设备`)}</span></header>${space.metrics?.length ? `<div class="product-metric-row">${space.metrics.map((metric) => `<span class="product-metric"><span class="product-metric-label">${escapeHtml(metric.label)}</span><strong class="product-metric-value">${escapeHtml(metric.value)}</strong></span>`).join("")}</div>` : ""}<div class="product-control-actions">${(space.controls ?? []).map((control) => `<form class="product-action-form" method="post" action="/control/${encodedPathSegment(control.id)}"><button class="product-control-action${control.result === "unknown" ? " product-result--unknown" : control.result === "failed" ? " product-result--failed" : ""}" type="submit">${escapeHtml(control.actionLabel ?? control.label)}</button></form>`).join("") || `<span class="product-muted">正在更新这个空间的状态</span>`}</div></section>`).join("")}</div>`;
}

const CONTROL_FEEDBACK_PRESENTATION = {
  verified: { label: "已完成", showsExpiry: false, showsUndo: true },
  pending_confirmation: { label: "等待你放行", showsExpiry: true, showsUndo: false },
  failed: { label: "动作未完成", showsExpiry: false, showsUndo: false },
  unknown: { label: "正在确认结果", showsExpiry: false, showsUndo: false },
} as const satisfies Readonly<Record<ProductControlFeedback["status"], {
  readonly label: string;
  readonly showsExpiry: boolean;
  readonly showsUndo: boolean;
}>>;

function renderControlFeedback(feedback: ProductControlFeedback): string {
  const presentation = CONTROL_FEEDBACK_PRESENTATION[feedback.status];
  const expires = !presentation.showsExpiry || feedback.expiresAt === undefined
    ? ""
    : `<span class="product-control-feedback-expiry" data-control-expires-at="${escapeHtml(feedback.expiresAt)}">${escapeHtml(feedback.expiresIn ?? "有时限")}</span>`;
  const undo = presentation.showsUndo && feedback.undo !== undefined ? renderUndo(feedback.undo) : "";
  return `<section class="product-card product-control-feedback product-control-feedback--${escapeHtml(feedback.status)}" data-control-status="${escapeHtml(feedback.status)}" role="status" aria-live="polite"><div class="product-control-feedback-copy"><p class="product-kicker">${presentation.label}</p><h2>${escapeHtml(feedback.label)}</h2><p>${escapeHtml(feedback.detail)}</p>${expires}</div>${undo}</section>`;
}

function renderDeviceViewPreference(view: ProductViewState): string {
  const choices = view.choices.map((choice) => {
    const state = choice.id === view.activeId ? "active" : "available";
    const defaultState = choice.id === view.defaultId ? "default" : "available";
    const action = defaultState === "default"
      ? `<span class="product-view-default-status">设备默认</span>`
      : view.canSetDeviceDefault === true
        ? `<form method="post" action="/settings/view-default"><input type="hidden" name="mode" value="set"><button class="product-secondary-action" type="submit" name="viewId" value="${escapeHtml(choice.id)}">设为默认</button></form>`
        : "";
    const detail = state === "active"
      ? "当前会话正在使用"
      : defaultState === "default" ? "下次打开时使用" : "随时可以切换";
    return `<li data-view-choice="${escapeHtml(choice.id)}" data-state="${state}" data-default-state="${defaultState}"><span><strong>${escapeHtml(choice.label)}</strong><small>${detail}</small></span>${action}</li>`;
  }).join("");
  const management = view.canSetDeviceDefault === true
    ? `<form class="product-view-default-reset" method="post" action="/settings/view-default"><button class="product-secondary-action" type="submit" name="mode" value="reset">恢复产品默认</button></form>`
    : `<p class="product-muted">管理员可以设置这台共享设备的默认视图。</p>`;
  return `<section class="product-settings-section" aria-labelledby="device-view-heading"><div><h2 id="device-view-heading">这台设备的默认视图</h2><p class="product-muted">顶部切换只影响当前浏览会话；这里保存下一次打开时使用的视图。</p></div><ul class="product-view-default-list">${choices}</ul>${management}</section>`;
}

function renderViewPresentationPreferences(view: ProductViewState): string {
  if (view.preferences === undefined || view.preferences.length === 0) return "";
  const providerLabel = view.choices.find((choice) => choice.id === view.activeId)?.label ?? "当前视图";
  const fields = view.preferences.map((preference) => {
    const selected = preference.choices.find((choice) => choice.value === preference.value)?.label ?? preference.value;
    if (view.canSetDeviceDefault !== true) {
      return `<div class="product-presentation-preference"><div><h3>${escapeHtml(preference.label)}</h3><p class="product-muted">${escapeHtml(preference.description)}</p></div><strong>${escapeHtml(selected)}</strong></div>`;
    }
    const choices = preference.choices.map((choice, index) => {
      const id = `view-preference-${preference.key}-${index + 1}`;
      return `<label class="product-presentation-choice" for="${escapeHtml(id)}"><input id="${escapeHtml(id)}" type="radio" name="value" value="${escapeHtml(choice.value)}"${choice.value === preference.value ? " checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`;
    }).join("");
    return `<form class="product-presentation-preference" method="post" action="/settings/view-presentation"><input type="hidden" name="mode" value="set"><input type="hidden" name="providerId" value="${escapeHtml(view.activeId)}"><input type="hidden" name="key" value="${escapeHtml(preference.key)}"><fieldset><legend>${escapeHtml(preference.label)}</legend><p class="product-muted">${escapeHtml(preference.description)}</p><div class="product-presentation-choices">${choices}</div></fieldset><button class="product-secondary-action" type="submit">保存显示方式</button></form>`;
  }).join("");
  const reset = view.canSetDeviceDefault === true
    ? `<form class="product-presentation-reset" method="post" action="/settings/view-presentation"><input type="hidden" name="providerId" value="${escapeHtml(view.activeId)}"><button class="product-secondary-action" type="submit" name="mode" value="reset">恢复${escapeHtml(providerLabel)}默认</button></form>`
    : `<p class="product-muted">管理员可以设置这台共享设备的显示方式。</p>`;
  return `<section class="product-settings-section" aria-labelledby="view-presentation-heading"><div><h2 id="view-presentation-heading">${escapeHtml(providerLabel)}的显示方式</h2><p class="product-muted">这些选择只调整这台设备上的排版。</p></div><div class="product-presentation-preferences">${fields}${reset}</div></section>`;
}

function renderManagedSettings(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const memberName = model.household.memberName ?? "待设置";
  const memberRole = model.household.memberRole ?? "待确认";
  const changeLabel = model.connection.lastChanged ?? (model.connection.state === "quiet" ? "家中暂无变化" : "等待首次更新");
  return `<header class="product-page-header"><div><p class="product-kicker">设置</p><h1>家庭设置</h1><p class="product-muted">常用选择在前，连接和权限细节保持完整。</p></div><a class="product-view-switcher" href="${routeHref("onboarding", options)}">继续首次设置</a></header><div class="product-settings-sheet">${renderDeviceViewPreference(model.view!)}${renderViewPresentationPreferences(model.view!)}<section class="product-settings-section"><div><h2>家庭连接</h2><p class="product-muted">连接状态与家庭变化分别表达。</p></div><ul class="product-settings-list"><li><span>当前状态</span><strong>${escapeHtml(connectionLabel(model.connection))}</strong></li><li><span>数据变化</span><strong>${escapeHtml(changeLabel)}</strong></li></ul></section><section class="product-settings-section"><div><h2>成员与权限</h2><p class="product-muted">高影响动作继续按成员和设备身份确认。</p></div><ul class="product-settings-list"><li><span>当前成员</span><strong>${escapeHtml(memberName)}</strong></li><li><span>身份</span><strong>${escapeHtml(memberRole)}</strong></li><li><span>高影响动作</span><strong>${model.household.memberRole === undefined ? "完成身份设置后显示" : "按动作权限确认"}</strong></li></ul></section><section class="product-settings-section"><div><h2>数据与隐私</h2><p class="product-muted">家庭数据保存在本地。已完成的动作写入活动记录。</p></div></section></div>`;
}

function renderSettings(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  if (model.view !== undefined) return renderManagedSettings(model, options);
  const memberName = model.household.memberName ?? "待设置";
  const memberRole = model.household.memberRole ?? "待确认";
  const changeLabel = model.connection.lastChanged ?? (model.connection.state === "quiet" ? "家中暂无变化" : "等待首次更新");
  return `<header class="product-page-header"><div><p class="product-kicker">设置</p><h1>家庭设置</h1><p class="product-muted">管理家庭连接、成员权限和显示方式。</p></div><a class="product-view-switcher" href="${routeHref("onboarding", options)}">继续首次设置</a></header><div class="product-settings-grid"><section class="product-card"><h2>家庭连接</h2><ul class="product-settings-list"><li><span>当前状态</span><strong>${escapeHtml(connectionLabel(model.connection))}</strong></li><li><span>数据变化</span><strong>${escapeHtml(changeLabel)}</strong></li></ul></section><section class="product-card"><h2>成员与权限</h2><ul class="product-settings-list"><li><span>当前成员</span><strong>${escapeHtml(memberName)}</strong></li><li><span>身份</span><strong>${escapeHtml(memberRole)}</strong></li><li><span>高影响动作</span><strong>${model.household.memberRole === undefined ? "完成身份设置后显示" : "按动作权限确认"}</strong></li></ul></section><section class="product-card"><h2>数据与隐私</h2><p class="product-muted">家庭数据保存在本地。已完成的动作会写入活动记录。</p></section><section class="product-card"><h2>视图偏好</h2><p class="product-muted">手机优先显示生活视图，桌面和墙面屏可切换到控制视图。</p><a class="product-secondary-action" href="${routeHref("control", options)}">打开控制视图</a></section></div>`;
}

function onboardingSteps(model: NormalizedProductShellModel): readonly ProductOnboardingStepData[] {
  const spaces = model.spaces.map((space): ProductOnboardingItem => ({
    id: space.id,
    label: space.name,
    detail: `${space.deviceCount ?? 0} 个设备`,
    status: "已发现",
    tone: "neutral",
  }));
  const defaultMembers: readonly ProductOnboardingItem[] = model.household.memberName === undefined
    ? []
    : [{
        label: `${model.household.memberName}（当前成员）`,
        detail: model.household.memberRole ?? "身份待确认",
        status: "等待绑定私人设备",
        tone: "neutral",
      }];
  const choices = model.onboarding?.choices;
  const bridges = choices?.bridges ?? [];
  const capabilities = choices?.capabilities ?? [];
  return DEFAULT_ONBOARDING_STEPS.map((defaultStep) => {
    const step = defaultStep.step === 1
      ? {
          ...defaultStep,
          fields: defaultStep.fields?.map((field) => field.name === "agentName"
            ? { ...field, value: model.household.agentName ?? "" }
            : field.name === "householdName"
              ? { ...field, value: model.household.name ?? "" }
              : field),
        }
      : defaultStep.step === 3
        ? { ...defaultStep, items: spaces }
        : defaultStep.step === 2
          ? {
              ...defaultStep,
              fields: [
                {
                  name: "bridgeId",
                  type: "select" as const,
                  label: "选择家庭连接",
                  required: true,
                  disabled: choices?.status !== "available" || bridges.length === 0,
                  options: bridges.map((bridge) => ({
                    value: bridge.id,
                    label: bridge.label,
                    description: bridge.description,
                    disabled: !bridge.selectable,
                  })),
                },
                ...(defaultStep.fields ?? []),
              ],
              submitDisabled: choices?.status !== "available" || bridges.every((bridge) => !bridge.selectable),
              note: choices?.status === "unavailable"
                ? "家庭设置正在准备，连接完成后从这里继续。"
                : bridges.length === 0
                  ? "家庭连接列表正在准备，连接完成后从这里继续。"
                  : "先完成只读同步，家庭地图会随之更新。",
            }
          : defaultStep.step === 5
            ? {
                ...defaultStep,
                fields: capabilities.map((capability) => ({
                  name: `capability:${capability.id}`,
                  type: "select" as const,
                  label: capability.label,
                  required: true,
                  options: [
                    { value: capability.id, label: capability.label, disabled: true },
                    { value: "direct", label: "直接动作", checked: capability.suggestedPolicyClass === "direct" },
                    { value: "confirmation", label: "每次先确认", checked: capability.suggestedPolicyClass === "confirmation" },
                    { value: "administrator", label: "管理员确认", checked: capability.suggestedPolicyClass === "administrator" },
                  ],
                  help: `${capability.bridgeLabel} · 建议权限：${policySuggestionLabel(capability.suggestedPolicyClass)}（由你确认）`,
                })),
                submitDisabled: choices?.status !== "available" || capabilities.length === 0,
                note: choices?.status === "unavailable"
                  ? "家庭设置正在准备，连接完成后从这里继续。"
                  : capabilities.length === 0
                    ? "家庭能力列表正在准备，连接完成后从这里继续。"
                    : "每项能力都会按你选择的权限级别运行。",
              }
            : defaultStep.step === 4
              ? { ...defaultStep, items: defaultMembers }
              : defaultStep.step === 7
                ? defaultStep
                : defaultStep;
    const supplied = model.onboarding?.steps?.find((candidate) => candidate.step === defaultStep.step);
    return supplied === undefined ? step : {
      ...step,
      ...supplied,
      fields: supplied.fields ?? step.fields,
      items: supplied.items ?? step.items,
    };
  });
}

function policySuggestionLabel(value: ProductOnboardingPolicySuggestion): string {
  switch (value) {
    case "direct": return "直接动作";
    case "confirmation": return "每次先确认";
    case "administrator": return "管理员确认";
  }
}

function onboardingFieldId(name: string): string {
  return `onboarding-${name.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function onboardingOptionChecked(field: ProductOnboardingField, option: ProductOnboardingFieldOption): boolean {
  if (option.checked === true) return true;
  return field.value !== undefined && field.value.split(",").map((value) => value.trim()).includes(option.value);
}

function renderOnboardingField(field: ProductOnboardingField): string {
  const id = onboardingFieldId(field.name);
  const required = field.required === true ? " required" : "";
  const disabled = field.disabled === true ? " disabled" : "";
  const help = field.help === undefined ? "" : `<small class="product-onboarding-help">${escapeHtml(field.help)}</small>`;
  if (field.type === "select") {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option.value)}"${onboardingOptionChecked(field, option) ? " selected" : ""}${option.disabled === true ? " disabled" : ""}>${escapeHtml(option.label)}</option>`).join("");
    return `<label class="product-onboarding-field" for="${escapeHtml(id)}"><span class="product-onboarding-field-label">${escapeHtml(field.label)}</span><select id="${escapeHtml(id)}" name="${escapeHtml(field.name)}"${required}${disabled}>${options}</select>${help}</label>`;
  }
  if (field.type === "textarea") {
    return `<label class="product-onboarding-field" for="${escapeHtml(id)}"><span class="product-onboarding-field-label">${escapeHtml(field.label)}</span><textarea id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" autocomplete="off" placeholder="${escapeHtml(field.placeholder)}"${required}${disabled}>${escapeHtml(field.value)}</textarea>${help}</label>`;
  }
  if (field.type === "radio" || field.type === "checkbox") {
    const inputType = field.type === "radio" ? "radio" : "checkbox";
    const fieldOptions = field.options ?? [];
    const requiredOption = field.required === true && (inputType === "radio" || fieldOptions.length === 1) ? " required" : "";
    const options = fieldOptions.map((option, index) => {
      const optionId = `${id}-${index + 1}`;
      const description = option.description === undefined ? "" : `<small>${escapeHtml(option.description)}</small>`;
      return `<label class="product-onboarding-choice" for="${escapeHtml(optionId)}"><input id="${escapeHtml(optionId)}" type="${inputType}" name="${escapeHtml(field.name)}" value="${escapeHtml(option.value)}"${onboardingOptionChecked(field, option) ? " checked" : ""}${option.disabled === true || field.disabled === true ? " disabled" : ""}${requiredOption}><span><strong>${escapeHtml(option.label)}</strong>${description}</span></label>`;
    }).join("");
    return `<fieldset class="product-onboarding-field product-onboarding-fieldset"><legend class="product-onboarding-field-label">${escapeHtml(field.label)}</legend><div class="product-onboarding-choices">${options}</div>${help}</fieldset>`;
  }
  return `<label class="product-onboarding-field" for="${escapeHtml(id)}"><span class="product-onboarding-field-label">${escapeHtml(field.label)}</span><input id="${escapeHtml(id)}" type="${escapeHtml(field.type)}" name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}" placeholder="${escapeHtml(field.placeholder)}" autocomplete="off"${required}${disabled}>${help}</label>`;
}

function renderOnboardingItems(items: readonly ProductOnboardingItem[] | undefined): string {
  if (items === undefined || items.length === 0) return "";
  return `<ul class="product-onboarding-items">${items.map((item, index) => `<li class="product-onboarding-item" data-tone="${escapeHtml(item.tone ?? "neutral")}"><span class="product-onboarding-item-index" aria-hidden="true">${index + 1}</span><span class="product-onboarding-item-copy"><strong>${escapeHtml(item.label)}</strong>${item.detail === undefined ? "" : `<span>${escapeHtml(item.detail)}</span>`}</span>${item.status === undefined ? "" : `<span class="product-onboarding-item-status">${escapeHtml(item.status)}</span>`}</li>`).join("")}</ul>`;
}

function personalizeOnboardingCopy(text: string | undefined, agentName: string | undefined, step: number): string | undefined {
  if (text === undefined || agentName === undefined || agentName.length === 0 || step < 2) return text;
  return text.replace(/\s*\bhob\b\s*/g, agentName);
}

function renderOnboarding(model: NormalizedProductShellModel, options: ProductShellRenderOptions): string {
  const rawStep = model.onboarding?.step ?? 1;
  const step = Math.min(8, Math.max(1, rawStep));
  const steps = onboardingSteps(model);
  const current = steps[step - 1] ?? steps[0]!;
  const state = model.onboarding;
  const agentName = state?.household?.agentName ?? model.household.agentName;
  const title = personalizeOnboardingCopy(state?.title ?? current.title, agentName, step)!;
  const body = personalizeOnboardingCopy(state?.body ?? current.body ?? "每一步都由你确认。", agentName, step)!;
  const fields = state?.fields ?? current.fields ?? [];
  const items = state?.items ?? current.items;
  const action = localHref(state?.action ?? current.action, "/onboarding/continue");
  const submitLabel = state?.submitLabel ?? current.submitLabel ?? "继续";
  const note = state?.note ?? current.note;
  const submitDisabled = state?.status === "blocked" || current.submitDisabled === true;
  const stepState = (index: number): "complete" | "current" | "pending" => state?.complete === true || index + 1 < step
    ? "complete"
    : index + 1 === step
      ? "current"
      : "pending";
  return `<header class="product-page-header"><div><p class="product-kicker">首次设置 · 第 ${step} 步，共 8 步</p><h1>${escapeHtml(title)}</h1><p class="product-muted">${escapeHtml(body)}</p></div></header><div class="product-onboarding" data-onboarding-step="${step}" data-onboarding-key="${escapeHtml(current.key)}"><div class="product-onboarding-progress" role="progressbar" aria-valuenow="${step}" aria-valuemin="1" aria-valuemax="8" aria-valuetext="第 ${step} 步，共 8 步" aria-label="首次设置进度">${steps.map((_, index) => `<span class="product-onboarding-step" data-state="${stepState(index)}" aria-hidden="true"></span>`).join("")}</div><div class="product-onboarding-content"><ol class="product-onboarding-list" aria-label="首次设置步骤">${steps.map((item, index) => `<li data-state="${stepState(index)}"><span class="product-onboarding-index">${index + 1}</span><span>${escapeHtml(item.label)}</span></li>`).join("")}</ol><section class="product-card product-card--blue product-onboarding-form-panel" aria-labelledby="onboarding-form-heading"><h2 id="onboarding-form-heading">${escapeHtml(current.label)}</h2>${renderOnboardingItems(items)}<form class="product-onboarding-form" method="post" action="${escapeHtml(action)}"><input type="hidden" name="step" value="${step}">${fields.map(renderOnboardingField).join("")}<button class="product-primary-action product-onboarding-submit" type="submit"${submitDisabled ? " disabled" : ""}>${escapeHtml(submitLabel)}</button></form>${note === undefined ? "" : `<p class="product-onboarding-note">${escapeHtml(note)}</p>`}</section></div></div>`;
}

type ProductViewRecipeSlot = ProductViewRecipeV1["pages"][number]["slots"][number]["slot"];

/** Arrange only Host-rendered slots from a validated declarative recipe. */
export function renderProductViewRecipeContent(
  recipeInput: unknown,
  source: ProductShellModel = {},
  options: ProductShellRenderOptions = {},
): string {
  const recipe = compileProductViewRecipe(recipeInput);
  const model = normalizedModel(source);
  const page = recipe.pages.find((candidate) => candidate.route === model.route);
  if (page === undefined) return renderProductContent(source, options);
  const slots = page.slots.map((placement) => {
    const content = renderProductViewRecipeSlot(placement.slot, model, options);
    if (content.length === 0) return "";
    return `<div class="product-recipe-slot" data-recipe-slot="${placement.slot}" data-recipe-width="${placement.width}">${content}</div>`;
  }).join("");
  return `<div class="product-recipe-layout" data-recipe-provider="${escapeHtml(recipe.id)}" data-recipe-route="${page.route}" data-recipe-layout="${page.layout}">${slots}</div>`;
}

function renderProductViewRecipeSlot(
  slot: ProductViewRecipeSlot,
  model: NormalizedProductShellModel,
  options: ProductShellRenderOptions,
): string {
  switch (slot) {
    case "overview.header": return renderOverviewHeader(model, options);
    case "overview.status": return renderOverviewStatus(model);
    case "overview.active-turn": return renderActiveTurnSummary(model.activeTurn);
    case "overview.spaces": return `<div class="product-space-grid">${renderOverviewSpaces(model)}</div>`;
    case "overview.review-summary": return renderOverviewReviewSummary(model, options);
    case "overview.agent-note": return renderOverviewAgentNote(model);
    case "overview.energy": return renderOverviewEnergy(model);
    case "overview.composer": return renderOverviewComposer(model.connection.state === "disconnected");
    case "conversation.workspace": return renderConversation(model, options);
    case "reviews.workspace": return renderReviews(model, options);
    case "activity.workspace": return renderActivity(model);
    case "control.workspace": return renderControl(model, options);
    case "settings.workspace": return renderSettings(model, options);
    case "automations.workspace": return renderAutomations(model);
    case "onboarding.workspace": return renderOnboarding(model, options);
  }
}

/** Render the layout-owned page content inside the fixed Host Shell. */
export function renderProductContent(source: ProductShellModel = {}, options: ProductShellRenderOptions = {}): string {
  const model = normalizedModel(source);
  return model.route === "conversation"
    ? renderConversation(model, options)
    : model.route === "reviews"
      ? renderReviews(model, options)
      : model.route === "activity"
        ? renderActivity(model)
        : model.route === "control"
          ? renderControl(model, options)
          : model.route === "settings"
            ? renderSettings(model, options)
            : model.route === "onboarding"
              ? renderOnboarding(model, options)
              : model.route === "automations"
                ? renderAutomations(model)
                : renderOverview(model, options);
}

/** Render the non-overridable navigation, safety, review badges and content boundary. */
export function renderProductHost(
  source: ProductShellModel,
  content: string,
  options: ProductShellRenderOptions = {},
): string {
  return renderShellFrame(normalizedModel(source), content, options);
}

/** Render one complete SSR shell fragment. No browser state or side effects are used. */
export function renderProductShell(source: ProductShellModel = {}, options: ProductShellRenderOptions = {}): string {
  return renderProductHost(source, renderProductContent(source, options), options);
}

export { PRODUCT_SHELL_CSS } from "./product-shell-styles.js";
