import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  FileHomeOnboardingStore,
  HOME_ONBOARDING_STEP_COUNT,
  initialHomeOnboardingState,
  type HomeOnboardingState,
  type HomeOnboardingStep,
  type HomeOnboardingStepRecord,
  type HomeOnboardingStore,
} from "./home-onboarding-store.js";
import type { HomeAdviceRecord } from "./home-advice-store.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeOnboarding: HomeOnboardingCoordinatorService;
  }
}

export type OnboardingActorRole = "admin" | "adult_member" | "member" | "child" | "guest";
export type OnboardingDeviceKind = "private" | "shared";
export type OnboardingPolicySuggestion = "direct" | "confirmation" | "administrator";

/** Read-only choices projected from the current Hub world snapshot. */
export interface OnboardingBridgeChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly selectable: boolean;
}

/** A capability choice carries a UI suggestion; it never grants authority. */
export interface OnboardingCapabilityChoice {
  readonly id: string;
  readonly label: string;
  readonly bridgeId: string;
  readonly bridgeLabel: string;
  readonly schema?: string;
  readonly suggestedPolicyClass: OnboardingPolicySuggestion;
  /** The saved confirmation method, present only when actually configured. */
  readonly currentPolicyClass?: OnboardingPolicySuggestion;
  /** Persisted configuration state: the settings editor renders each honestly. */
  readonly configurationState?: "unconfigured" | "active" | "revoked" | "invalid";
}

export interface OnboardingChoiceProjection {
  readonly status: "available" | "unavailable";
  readonly reason?: "world_unavailable" | "snapshot_unavailable";
  readonly bridges: readonly OnboardingBridgeChoice[];
  readonly capabilities: readonly OnboardingCapabilityChoice[];
}

export interface OnboardingActor {
  readonly principalId: string;
  readonly role: OnboardingActorRole;
  readonly present: boolean;
  readonly device: {
    readonly kind: OnboardingDeviceKind;
    readonly boundPrincipalId?: string;
  };
}

export interface OnboardingWorldPort {
  /** Persisted configuration state, when the world owner provides it (HomeWorld does). */
  actionAuthorityConfigurationOf?(hwCapabilityId: string): {
    readonly status: "configured" | "not_configured" | "invalid";
    readonly approved: boolean;
    readonly policyClass?: "direct" | "confirmation" | "administrator";
  };
  snapshot(): {
    readonly generatedAt?: string;
    readonly bridges: Readonly<Record<string, {
      readonly bridgeId?: string;
      readonly adapterType?: string;
      readonly diagnostics?: { readonly connectionState?: string };
      readonly watermark?: unknown;
    }>>;
    readonly spaces: readonly { readonly hwSpaceId?: string; readonly name?: string }[];
    readonly devices: readonly {
      readonly hwId?: string;
      readonly bridgeId?: string;
      readonly name?: string;
      readonly validity?: string;
      readonly bindings?: readonly { readonly bridgeId?: string }[];
      readonly capabilities: readonly {
        readonly hwCapabilityId?: string;
        readonly schema?: string;
        readonly schemaVersion?: string;
        readonly semanticKind?: string;
        readonly bindings?: readonly { readonly bridgeId?: string }[];
      }[];
    }[];
  };
}

export interface OnboardingActionAuthorityPort {
  configure(input: {
    readonly directCapabilityIds: readonly string[];
    readonly confirmationCapabilityIds: readonly string[];
    readonly administratorCapabilityIds: readonly string[];
  }): { readonly status: "configured"; readonly configurationRevision: number }
    | { readonly status: "blocked"; readonly reason: string };
  /** Delta write over the persisted configuration; the owner preserves the rest. */
  configureDelta?(
    changes: readonly { readonly hwCapabilityId: string; readonly policyClass: "direct" | "confirmation" | "administrator" }[],
  ): { readonly status: "configured"; readonly configurationRevision: number; readonly changedCount: number }
    | { readonly status: "blocked"; readonly reason: string };
}

export interface OnboardingObservationPort {
  configure(input: {
    readonly enabled: boolean;
    readonly intervalMinutes?: number;
    readonly quietHours?: { readonly start: string; readonly end: string };
  }): { readonly status: "configured" } | { readonly status: "blocked"; readonly reason: string };
}

export type OnboardingAdviceStart = Pick<HomeAdviceRecord, "id" | "status">;

/** The Hub starts the durable advice turn; the Agent owns its execution. */
export interface OnboardingAdvicePort {
  ask(question: string, actor?: OnboardingActor): Promise<OnboardingAdviceStart>;
}

/**
 * Household names accepted in the paired product setup before the Hub is
 * mounted. They advance only a brand-new onboarding record past its naming step.
 */
export interface OnboardingBootstrapHousehold {
  readonly householdName: string;
  readonly agentName: string;
}

export type OnboardingCommand =
  | { readonly step: 1; readonly kind: "name_household"; readonly householdName: string; readonly agentName: string }
  | { readonly step: 2; readonly kind: "preflight_bridge"; readonly bridgeId: string }
  | { readonly step: 3; readonly kind: "confirm_map"; readonly confirmed: true; readonly correction?: string }
  | { readonly step: 4; readonly kind: "bind_private_device"; readonly memberName: string; readonly role: "adult_admin" }
  | { readonly step: 5; readonly kind: "set_action_policy"; readonly directCapabilityIds: readonly string[]; readonly confirmationCapabilityIds: readonly string[]; readonly administratorCapabilityIds: readonly string[] }
  | { readonly step: 6; readonly kind: "acknowledge_safety_rules"; readonly acknowledged: true }
  | { readonly step: 7; readonly kind: "set_observation_schedule"; readonly enabled: boolean; readonly intervalMinutes?: number; readonly quietHours?: { readonly start: string; readonly end: string } }
  | { readonly step: 8; readonly kind: "ask_first_question"; readonly question: string };

export interface OnboardingViewState {
  readonly step: HomeOnboardingStep;
  readonly complete: boolean;
  readonly status: "ready" | "blocked" | "complete";
  readonly title: string;
  readonly body: string;
  readonly blockedReason?: string;
  readonly choices: OnboardingChoiceProjection;
  readonly household?: HomeOnboardingState["household"];
  readonly bridge?: HomeOnboardingState["bridge"];
  readonly map?: HomeOnboardingState["map"];
  readonly member?: HomeOnboardingState["member"];
  readonly safety?: HomeOnboardingState["safety"];
  readonly observation?: HomeOnboardingState["observation"];
  readonly firstQuestion?: HomeOnboardingState["firstQuestion"];
  readonly steps: HomeOnboardingState["steps"];
}

export interface OnboardingContinuation {
  readonly state: OnboardingViewState;
  readonly snapshot: HomeOnboardingState;
  readonly outcome: "completed" | "blocked";
  readonly completedStep?: HomeOnboardingStep;
  readonly complete: boolean;
  /** The durable advice turn created by the accepted Step 8 first question. */
  readonly adviceId?: string;
}

export interface HomeOnboardingCoordinatorOptions {
  readonly path?: string;
  readonly store?: HomeOnboardingStore & { close?: () => void };
  readonly householdDirectory?: string;
  readonly bootstrapHousehold?: OnboardingBootstrapHousehold;
  readonly world?: OnboardingWorldPort;
  readonly actionAuthority?: OnboardingActionAuthorityPort;
  readonly observation?: OnboardingObservationPort;
  readonly advice?: OnboardingAdvicePort;
  readonly now?: () => string;
}

export class HomeOnboardingCoordinatorError extends Error {
  constructor(
    readonly code: "invalid_input" | "invalid_step" | "stale_step" | "already_complete" | "permission_denied" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "HomeOnboardingCoordinatorError";
  }
}

const STEP_TITLES = [
  "认识一下你家的 hob",
  "把已有的家接进来",
  "确认现在的家",
  "家里都有谁",
  "决定我怎样帮忙",
  "先约定安全边界",
  "告诉我第一周怎么做",
  "从第一个问题开始",
] as const;

const STEP_BODIES = [
  "你好，我会帮这个家看着点儿。开始时我只会看；每项动作都按你设定的权限执行。",
  "我先以只读方式查看已有家庭，再请你确认发现的内容。",
  "请确认房间和设备地图；待确认的地方会清楚标出。",
  "请绑定一位家人的私人手机；需要确认的动作以后都会推送到这台手机。",
  "请分别设置直接动作、需要确认的动作和高影响保护动作。",
  "请确认三条安全规矩；安全级动作始终执行最高确认要求。",
  "请设定第一周的观察频率、安静时段和期待结果。",
  "请带着一个真实问题进入家庭对话。",
] as const;

/** Hub owner for the eight-step onboarding state machine. */
export class HomeOnboardingCoordinatorService extends Service {
  private readonly store: HomeOnboardingStore & { close?: () => void };
  private readonly householdDirectory: string | undefined;
  private readonly world: OnboardingWorldPort | undefined;
  private readonly actionAuthority: OnboardingActionAuthorityPort | undefined;
  private readonly observation: OnboardingObservationPort | undefined;
  private readonly advice: OnboardingAdvicePort | undefined;
  private readonly now: () => string;
  private state: HomeOnboardingState;
  private firstQuestionInFlight: { readonly question: string; readonly promise: Promise<OnboardingContinuation> } | undefined;
  private acceptedFirstQuestion: { readonly question: string; readonly adviceId: string } | undefined;

  constructor(ctx: Context, options: HomeOnboardingCoordinatorOptions) {
    super(ctx, "homeOnboarding");
    if (options.store !== undefined && options.path !== undefined) throw new TypeError("Home onboarding accepts a store or path, not both");
    if (options.store === undefined && options.path === undefined) throw new TypeError("Home onboarding requires a durable store path or explicit store");
    this.store = options.store ?? new FileHomeOnboardingStore({ path: options.path! });
    const householdDirectory = options.householdDirectory;
    this.householdDirectory = typeof householdDirectory !== "string" || householdDirectory.trim() === ""
      ? undefined
      : householdDirectory;
    this.world = options.world ?? asWorld(ctx.get("homeWorld"));
    this.actionAuthority = options.actionAuthority;
    this.observation = options.observation;
    this.advice = options.advice ?? asAdvice(ctx.get("homeAdvice"));
    this.now = options.now ?? (() => new Date().toISOString());
    const persisted = this.store.load();
    this.state = persisted ?? initialHomeOnboardingState(this.timestamp());
    if (persisted === undefined && options.bootstrapHousehold !== undefined) {
      this.completeBootstrapHousehold(options.bootstrapHousehold);
    }
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-onboarding.close");
  }

  /**
   * The settings surface reuses the step-5 capability choices: the household
   * can re-decide confirmation methods at any time after onboarding.
   */
  actionPolicyChoices(): OnboardingChoiceProjection {
    return this.choiceProjection();
  }

  /**
   * Re-decides confirmation methods outside the step machine. The same rules
   * as step 5 apply: a present member on their own bound private device,
   * capabilities from the current home map, one method per action.
   */
  configureActionPolicy(
    selection: {
      readonly directCapabilityIds: readonly string[];
      readonly confirmationCapabilityIds: readonly string[];
      readonly administratorCapabilityIds: readonly string[];
    },
    actor?: OnboardingActor,
  ): { readonly status: "configured"; readonly changedCount: number } | { readonly status: "blocked"; readonly reason: string } {
    if (!actor || !actor.present || actor.device.kind !== "private" || actor.device.boundPrincipalId !== actor.principalId) {
      throw new HomeOnboardingCoordinatorError("permission_denied", "确认方式设置需要在场，并使用绑定到本人的私人设备");
    }
    const world = this.requireWorld();
    const all = [...selection.directCapabilityIds, ...selection.confirmationCapabilityIds, ...selection.administratorCapabilityIds];
    if (new Set(all).size !== all.length) {
      throw new HomeOnboardingCoordinatorError("invalid_input", "每个动作只能选择一种确认方式");
    }
    // No rows chosen is a truthful no-change, not an error.
    if (all.length === 0) return { status: "configured", changedCount: 0 };
    const available = capabilityIds(world.snapshot());
    if (all.some((id) => !available.has(id))) {
      return { status: "blocked", reason: "确认方式必须来自当前家庭地图中的真实能力。" };
    }
    if (this.actionAuthority === undefined) {
      return { status: "blocked", reason: "确认方式配置服务尚未就绪，家庭保持安全默认值。" };
    }
    // The submission is a delta of the rows the household actually chose.
    // The configuration owner merges it over the persisted facts and writes
    // the whole set back atomically — availability plays no part, so a
    // bridge-down or revoked entry the page never showed survives untouched.
    if (this.actionAuthority.configureDelta === undefined) {
      return { status: "blocked", reason: "当前配置暂时读取不到，为避免覆盖已有设置没有保存。" };
    }
    const changes: { hwCapabilityId: string; policyClass: "direct" | "confirmation" | "administrator" }[] = [
      ...selection.directCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "direct" as const })),
      ...selection.confirmationCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "confirmation" as const })),
      ...selection.administratorCapabilityIds.map((hwCapabilityId) => ({ hwCapabilityId, policyClass: "administrator" as const })),
    ];
    const configured = this.actionAuthority.configureDelta(changes);
    return configured.status === "configured"
      ? { status: "configured", changedCount: configured.changedCount }
      : { status: "blocked", reason: "确认方式配置没有完成，家庭保持安全默认值。" };
  }

  getState(): OnboardingViewState {
    const step = this.state.currentStep;
    const record = this.state.steps[step]!;
    return {
      step,
      complete: this.state.complete,
      status: this.state.complete ? "complete" : record.status === "blocked" ? "blocked" : "ready",
      title: STEP_TITLES[step - 1],
      body: STEP_BODIES[step - 1],
      ...(record.blockedReason === undefined ? {} : { blockedReason: record.blockedReason }),
      choices: this.choiceProjection(),
      ...(this.state.household === undefined ? {} : { household: this.state.household }),
      ...(this.state.bridge === undefined ? {} : { bridge: this.state.bridge }),
      ...(this.state.map === undefined ? {} : { map: this.state.map }),
      ...(this.state.member === undefined ? {} : { member: this.state.member }),
      ...(this.state.safety === undefined ? {} : { safety: this.state.safety }),
      ...(this.state.observation === undefined ? {} : { observation: this.state.observation }),
      ...(this.state.firstQuestion === undefined ? {} : { firstQuestion: this.state.firstQuestion }),
      steps: structuredClone(this.state.steps),
    };
  }

  private choiceProjection(): OnboardingChoiceProjection {
    if (this.world === undefined) {
      return { status: "unavailable", reason: "world_unavailable", bridges: [], capabilities: [] };
    }
    let snapshot: ReturnType<OnboardingWorldPort["snapshot"]>;
    try {
      snapshot = this.world.snapshot();
    } catch {
      return { status: "unavailable", reason: "snapshot_unavailable", bridges: [], capabilities: [] };
    }

    const bridges = Object.entries(snapshot.bridges)
      .map(([fallbackId, bridge]): OnboardingBridgeChoice | undefined => {
        const id = boundedId(bridge.bridgeId) ? bridge.bridgeId : boundedId(fallbackId) ? fallbackId : undefined;
        if (id === undefined) return undefined;
        const selectable = bridge.diagnostics?.connectionState === "ready" && bridge.watermark !== undefined && bridge.watermark !== null;
        const label = bridgeLabel(bridge.adapterType, id);
        return {
          id,
          label,
          selectable,
          description: selectable ? "已完成只读同步" : "等待只读同步完成",
        };
      })
      .filter((choice): choice is OnboardingBridgeChoice => choice !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
    const bridgeById = new Map(bridges.map((bridge) => [bridge.id, bridge]));
    const capabilities: OnboardingCapabilityChoice[] = [];
    for (const device of snapshot.devices) {
      if (device.validity !== "valid") continue;
      for (const capability of device.capabilities) {
        if (!boundedId(capability.hwCapabilityId)) continue;
        const bridgeIds = uniqueIds(
          (capability.bindings ?? []).map((binding) => binding.bridgeId)
            .concat(device.bindings?.map((binding) => binding.bridgeId) ?? [])
            .concat(device.bridgeId === undefined ? [] : [device.bridgeId]),
        );
        if (bridgeIds.length !== 1) continue;
        const bridge = bridgeById.get(bridgeIds[0]!);
        if (bridge === undefined || !bridge.selectable) continue;
        const semanticKind = capability.semanticKind;
        const persisted = this.world?.actionAuthorityConfigurationOf?.(capability.hwCapabilityId);
        const configurationState = persisted === undefined
          ? undefined
          : persisted.status === "invalid"
            ? "invalid" as const
            : persisted.status === "not_configured"
              ? "unconfigured" as const
              : persisted.approved ? "active" as const : "revoked" as const;
        capabilities.push({
          ...(persisted?.status === "configured" && persisted.policyClass !== undefined
            ? { currentPolicyClass: persisted.policyClass }
            : {}),
          ...(configurationState === undefined ? {} : { configurationState }),
          id: capability.hwCapabilityId,
          label: `${boundedText(device.name) ? device.name : "设备"} · ${semanticLabel(semanticKind)}`,
          bridgeId: bridge.id,
          bridgeLabel: bridge.label,
          ...(boundedText(capability.schema, 200) ? { schema: capability.schema } : {}),
          suggestedPolicyClass: suggestedPolicyClass(semanticKind),
        });
      }
    }
    capabilities.sort((left, right) => left.id.localeCompare(right.id) || left.bridgeId.localeCompare(right.bridgeId));
    return { status: "available", bridges, capabilities };
  }

  snapshot(): HomeOnboardingState {
    return structuredClone(this.state);
  }

  submit(command: Exclude<OnboardingCommand, { readonly step: 8 }>, actor?: OnboardingActor): OnboardingContinuation;
  submit(command: Extract<OnboardingCommand, { readonly step: 8 }>, actor?: OnboardingActor): Promise<OnboardingContinuation>;
  submit(command: OnboardingCommand, actor?: OnboardingActor): OnboardingContinuation | Promise<OnboardingContinuation>;
  submit(command: OnboardingCommand, actor?: OnboardingActor): OnboardingContinuation | Promise<OnboardingContinuation> {
    validateCommand(command);
    if (this.state.complete) {
      if (command.kind === "ask_first_question" && this.state.firstQuestion?.question === command.question) {
        return Promise.resolve(this.completedFirstQuestion(this.state.firstQuestion));
      }
      throw new HomeOnboardingCoordinatorError("already_complete", "Onboarding is already complete");
    }
    if (command.step !== this.state.currentStep) throw new HomeOnboardingCoordinatorError("stale_step", "Onboarding step is no longer current");
    const now = this.timestamp();
    const step = this.state.currentStep;
    switch (command.kind) {
      case "name_household": {
        const householdDirectory = this.householdDirectory;
        if (householdDirectory === undefined) return this.blockStep(step, now, "家庭资料目录尚未就绪，名称还没有保存。");
        try {
          this.persistHouseholdNames(householdDirectory, command.householdName, command.agentName);
        } catch {
          return this.blockStep(step, now, "家庭资料目录不可用，名称还没有保存。");
        }
        return this.completeStep(command, now, {
          household: { householdName: command.householdName, agentName: command.agentName },
        });
      }
      case "preflight_bridge": {
        const world = this.requireWorld();
        const bridge = world.snapshot().bridges[command.bridgeId];
        if (bridge?.diagnostics?.connectionState !== "ready" || bridge.watermark === null || bridge?.watermark === undefined) {
          return this.blockStep(step, now, "家庭连接还没有完成一次完整的只读同步。");
        }
        return this.completeStep(command, now, {
          bridge: { bridgeId: command.bridgeId, status: "ready", checkedAt: now },
        });
      }
      case "confirm_map": {
        if (command.confirmed !== true) throw new HomeOnboardingCoordinatorError("invalid_input", "家庭地图需要明确确认");
        const snapshot = this.requireWorld().snapshot();
        const ready = Object.values(snapshot.bridges).some((bridge) => bridge.diagnostics?.connectionState === "ready" && bridge.watermark !== undefined && bridge.watermark !== null);
        if (!ready) return this.blockStep(step, now, "先完成只读接桥，再确认家庭地图。");
        return this.completeStep(command, now, {
          map: { snapshotDigest: digestMap(snapshot), confirmedAt: now, ...(command.correction === undefined ? {} : { correction: command.correction }) },
        });
      }
      case "bind_private_device": {
        if (!actor || !actor.present || actor.device.kind !== "private" || actor.device.boundPrincipalId !== actor.principalId) {
          throw new HomeOnboardingCoordinatorError("permission_denied", "成员绑定需要在场，并使用绑定到本人的私人设备");
        }
        return this.completeStep(command, now, {
          member: { principalId: actor.principalId, memberName: command.memberName, role: "adult_admin", deviceKind: "private", boundAt: now },
        });
      }
      case "set_action_policy": {
        const world = this.requireWorld();
        const all = [...command.directCapabilityIds, ...command.confirmationCapabilityIds, ...command.administratorCapabilityIds];
        if (new Set(all).size !== all.length) throw new HomeOnboardingCoordinatorError("invalid_input", "每个动作只能选择一种确认方式");
        const available = capabilityIds(world.snapshot());
        if (all.some((id) => !available.has(id))) return this.blockStep(step, now, "操作权限必须来自当前家庭地图中的真实能力。");
        if (this.actionAuthority === undefined) return this.blockStep(step, now, "操作权限配置服务尚未就绪，家庭保持安全默认值。");
        const configured = this.actionAuthority.configure({
          directCapabilityIds: command.directCapabilityIds,
          confirmationCapabilityIds: command.confirmationCapabilityIds,
          administratorCapabilityIds: command.administratorCapabilityIds,
        });
        if (configured.status !== "configured") return this.blockStep(step, now, "操作权限配置没有完成，家庭保持安全默认值。");
        return this.completeStep(command, now, {});
      }
      case "acknowledge_safety_rules": {
        if (command.acknowledged !== true) throw new HomeOnboardingCoordinatorError("invalid_input", "安全规矩需要明确确认");
        return this.completeStep(command, now, { safety: { acknowledgedAt: now } });
      }
      case "set_observation_schedule": {
        if (command.enabled && (!Number.isSafeInteger(command.intervalMinutes) || command.intervalMinutes! < 60 || command.intervalMinutes! > 10_080)) {
          throw new HomeOnboardingCoordinatorError("invalid_input", "观察周期需要在 60 到 10080 分钟之间");
        }
        if (command.quietHours !== undefined && (!validClockTime(command.quietHours.start) || !validClockTime(command.quietHours.end))) {
          throw new HomeOnboardingCoordinatorError("invalid_input", "安静时段格式需要为 HH:MM");
        }
        if (this.observation === undefined) return this.blockStep(step, now, "观察计划服务尚未就绪，家庭保持安静默认值。");
        const configured = this.observation.configure({
          enabled: command.enabled,
          ...(command.intervalMinutes === undefined ? {} : { intervalMinutes: command.intervalMinutes }),
          ...(command.quietHours === undefined ? {} : { quietHours: command.quietHours }),
        });
        if (configured.status !== "configured") return this.blockStep(step, now, "观察计划没有完成，家庭保持安静默认值。");
        return this.completeStep(command, now, {
          observation: { enabled: command.enabled, ...(command.intervalMinutes === undefined ? {} : { intervalMinutes: command.intervalMinutes }), ...(command.quietHours === undefined ? {} : { quietHours: command.quietHours }), configuredAt: now },
        });
      }
      case "ask_first_question": return this.submitFirstQuestion(command, actor);
    }
  }

  close(): void { this.store.close?.(); }

  private completeStep(
    command: OnboardingCommand,
    now: string,
    patch: Partial<Pick<HomeOnboardingState, "household" | "bridge" | "map" | "member" | "safety" | "observation" | "firstQuestion">>,
    sideEffect?: () => void,
  ): OnboardingContinuation {
    sideEffect?.();
    const step = command.step as HomeOnboardingStep;
    const complete = step === HOME_ONBOARDING_STEP_COUNT;
    const nextStep = complete ? step : ((step + 1) as HomeOnboardingStep);
    const completedSteps = [...this.state.completedSteps, step] as HomeOnboardingStep[];
    const steps = { ...this.state.steps } as Record<HomeOnboardingStep, HomeOnboardingStepRecord>;
    steps[step] = { status: "completed", updatedAt: now, summary: STEP_TITLES[step - 1] + "已完成" };
    if (!complete) steps[nextStep] = { status: "pending", updatedAt: now, summary: "尚未完成" };
    const next: HomeOnboardingState = {
      ...this.state,
      ...patch,
      currentStep: nextStep,
      completedSteps,
      complete,
      updatedAt: now,
      steps,
    };
    this.store.save(next);
    this.state = next;
    return { state: this.getState(), snapshot: this.snapshot(), outcome: "completed", completedStep: step, complete };
  }

  private blockStep(step: HomeOnboardingStep, now: string, reason: string): OnboardingContinuation {
    const steps = { ...this.state.steps } as Record<HomeOnboardingStep, HomeOnboardingStepRecord>;
    steps[step] = { status: "blocked", updatedAt: now, summary: STEP_TITLES[step - 1] + "等待条件", blockedReason: reason };
    const next = { ...this.state, updatedAt: now, steps };
    this.store.save(next);
    this.state = next;
    return { state: this.getState(), snapshot: this.snapshot(), outcome: "blocked", complete: false };
  }

  private submitFirstQuestion(
    command: Extract<OnboardingCommand, { readonly step: 8 }>,
    actor?: OnboardingActor,
  ): Promise<OnboardingContinuation> {
    const existing = this.state.firstQuestion;
    if (existing !== undefined && existing.question === command.question) {
      return Promise.resolve(this.completedFirstQuestion(existing));
    }
    const inFlight = this.firstQuestionInFlight;
    if (inFlight !== undefined) {
      if (inFlight.question !== command.question) {
        return Promise.reject(new HomeOnboardingCoordinatorError("invalid_input", "首问正在创建，问题保持不变"));
      }
      return inFlight.promise;
    }
    const promise = this.createFirstQuestion(command, actor);
    this.firstQuestionInFlight = { question: command.question, promise };
    const clearInFlight = () => {
      if (this.firstQuestionInFlight?.promise === promise) this.firstQuestionInFlight = undefined;
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  private async createFirstQuestion(
    command: Extract<OnboardingCommand, { readonly step: 8 }>,
    actor?: OnboardingActor,
  ): Promise<OnboardingContinuation> {
    let accepted = this.acceptedFirstQuestion;
    if (accepted === undefined) {
      if (this.advice === undefined) return this.blockStep(this.state.currentStep, this.timestamp(), "家庭对话服务尚未就绪，完成首问后继续。");
      let started: OnboardingAdviceStart;
      try {
        started = await this.advice.ask(command.question, actor);
      } catch {
        return this.blockStep(this.state.currentStep, this.timestamp(), "首问没有创建成功，家庭设置保持在这一步。");
      }
      if (!isAcceptedAdvice(started)) {
        return this.blockStep(this.state.currentStep, this.timestamp(), "首问没有创建成功，家庭设置保持在这一步。");
      }
      accepted = { question: command.question, adviceId: started.id };
      this.acceptedFirstQuestion = accepted;
    }
    const now = this.timestamp();
    const next = this.completeStep(command, now, {
      firstQuestion: { question: accepted.question, adviceId: accepted.adviceId, acceptedAt: now },
    });
    this.acceptedFirstQuestion = undefined;
    return { ...next, adviceId: accepted.adviceId };
  }

  private completedFirstQuestion(firstQuestion: NonNullable<HomeOnboardingState["firstQuestion"]>): OnboardingContinuation {
    return {
      state: this.getState(),
      snapshot: this.snapshot(),
      outcome: "completed",
      completedStep: 8,
      complete: true,
      adviceId: firstQuestion.adviceId,
    };
  }

  private requireWorld(): OnboardingWorldPort {
    if (this.world === undefined) throw new HomeOnboardingCoordinatorError("unavailable", "家庭连接服务尚未就绪");
    return this.world;
  }

  private persistHouseholdNames(householdDirectory: string, householdName: string, agentName: string): void {
    writeMarkedFact(join(householdDirectory, "HOME.md"), "household-name", `家庭名称：${householdName}`);
    writeMarkedFact(join(householdDirectory, "SOUL.md"), "agent-name", `家庭助手：${agentName}`);
  }

  private completeBootstrapHousehold(household: OnboardingBootstrapHousehold): void {
    const command: Extract<OnboardingCommand, { readonly step: 1 }> = {
      step: 1,
      kind: "name_household",
      householdName: household.householdName,
      agentName: household.agentName,
    };
    validateCommand(command);
    const householdDirectory = this.householdDirectory;
    if (householdDirectory === undefined) {
      throw new TypeError("Household bootstrap requires a household directory");
    }
    this.persistHouseholdNames(householdDirectory, command.householdName, command.agentName);
    this.completeStep(command, this.timestamp(), {
      household: { householdName: command.householdName, agentName: command.agentName },
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError("Home onboarding clock must return an ISO timestamp");
    return value;
  }
}

function validateCommand(command: OnboardingCommand): void {
  if (!command || typeof command !== "object" || !isStep(command.step)) throw new HomeOnboardingCoordinatorError("invalid_step", "Onboarding step must be an integer from 1 to 8");
  if (typeof command.kind !== "string" || command.kind !== kindForStep(command.step)) throw new HomeOnboardingCoordinatorError("invalid_input", "Onboarding command does not match its step");
  switch (command.kind) {
    case "name_household": if (!boundedText(command.householdName, 200) || !boundedText(command.agentName, 200)) throw invalidInput(); break;
    case "preflight_bridge": if (!boundedId(command.bridgeId)) throw invalidInput(); break;
    case "confirm_map": if (command.confirmed !== true || (command.correction !== undefined && !boundedText(command.correction, 2_000))) throw invalidInput(); break;
    case "bind_private_device": if (!boundedText(command.memberName, 200) || command.role !== "adult_admin") throw invalidInput(); break;
    case "set_action_policy": for (const ids of [command.directCapabilityIds, command.confirmationCapabilityIds, command.administratorCapabilityIds]) if (!boundedIdArray(ids)) throw invalidInput(); break;
    case "acknowledge_safety_rules": if (command.acknowledged !== true) throw invalidInput(); break;
    case "set_observation_schedule": if (typeof command.enabled !== "boolean") throw invalidInput(); break;
    case "ask_first_question": if (!boundedText(command.question, 2_000)) throw invalidInput(); break;
  }
}

function kindForStep(step: HomeOnboardingStep): OnboardingCommand["kind"] {
  return ["name_household", "preflight_bridge", "confirm_map", "bind_private_device", "set_action_policy", "acknowledge_safety_rules", "set_observation_schedule", "ask_first_question"][step - 1] as OnboardingCommand["kind"];
}

function capabilityIds(snapshot: ReturnType<OnboardingWorldPort["snapshot"]>): Set<string> {
  return new Set(snapshot.devices.flatMap((device) => device.validity === "valid" ? device.capabilities.flatMap((capability) => capability.hwCapabilityId === undefined ? [] : [capability.hwCapabilityId]) : []));
}

function bridgeLabel(adapterType: string | undefined, bridgeId: string): string {
  if (adapterType === "home-assistant") return "Home Assistant";
  if (adapterType === "xiaomi" || adapterType === "xiaomi-home" || adapterType === "xiaomi-miot") return "小米";
  return boundedText(adapterType, 200) ? adapterType : bridgeId;
}

function semanticLabel(kind: string | undefined): string {
  switch (kind) {
    case "light": return "灯光";
    case "cover": return "窗帘";
    case "switch": return "开关";
    case "climate":
    case "thermostat": return "温控";
    case "lock": return "门锁";
    case "valve": return "水阀";
    case "alarm":
    case "security": return "安防";
    case "media_player":
    case "media": return "媒体";
    default: return boundedText(kind, 200) ? kind : "设备能力";
  }
}

function suggestedPolicyClass(kind: string | undefined): OnboardingPolicySuggestion {
  switch (kind) {
    case "lock":
    case "valve":
    case "alarm":
    case "security":
    case "door": return "administrator";
    case "climate":
    case "thermostat":
    case "temperature": return "confirmation";
    default: return "direct";
  }
}

function uniqueIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => boundedId(value)))];
}

function digestMap(snapshot: ReturnType<OnboardingWorldPort["snapshot"]>): `sha256:${string}` {
  const source = JSON.stringify({
    bridges: Object.entries(snapshot.bridges).map(([bridgeId, bridge]) => [bridgeId, bridge.diagnostics?.connectionState, bridge.watermark !== undefined && bridge.watermark !== null]).sort(),
    spaces: snapshot.spaces.map((space) => [space.hwSpaceId, space.name]).sort(),
    devices: snapshot.devices.map((device) => [device.hwId, device.validity, device.capabilities.map((capability) => [capability.hwCapabilityId, capability.schema, capability.schemaVersion]).sort()]).sort(),
  });
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function writeMarkedFact(path: string, key: string, value: string): void {
  const marker = `<!-- hob-onboarding:${key} -->`;
  let existing = "";
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024) throw new Error("household source is unsafe");
    existing = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message === "household source is unsafe") throw error;
  }
  const line = `${marker}\n${value}`;
  const pattern = new RegExp(`${escapeRegExp(marker)}\\n[^\\n]*`);
  const next = pattern.test(existing) ? existing.replace(pattern, line) : `${existing.trimEnd()}\n\n${line}\n`;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function asWorld(value: unknown): OnboardingWorldPort | undefined {
  return value && typeof value === "object" && typeof (value as { snapshot?: unknown }).snapshot === "function"
    ? value as OnboardingWorldPort
    : undefined;
}
function asAdvice(value: unknown): OnboardingAdvicePort | undefined {
  return value && typeof value === "object" && typeof (value as { ask?: unknown }).ask === "function"
    ? value as OnboardingAdvicePort
    : undefined;
}
function isAcceptedAdvice(value: OnboardingAdviceStart | undefined): value is OnboardingAdviceStart {
  return value !== undefined
    && boundedId(value.id)
    && (value.status === "running" || value.status === "background" || value.status === "completed");
}
function isStep(value: unknown): value is HomeOnboardingStep { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 8; }
function boundedText(value: unknown, max = 200): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function boundedId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function boundedIdArray(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length <= 256 && value.every((item) => boundedId(item)); }
function validClockTime(value: unknown): value is string { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function invalidInput(): HomeOnboardingCoordinatorError { return new HomeOnboardingCoordinatorError("invalid_input", "Onboarding command is invalid"); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
