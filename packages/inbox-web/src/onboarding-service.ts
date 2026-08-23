/**
 * Inbox's narrow onboarding transport seam. The Hub owns the state machine,
 * persistence, and all step effects; this package only carries the allowlisted
 * command and renders the resulting state.
 */
export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type OnboardingCommand =
  | { readonly step: 1; readonly kind: "name_household"; readonly householdName: string; readonly agentName: string }
  | { readonly step: 2; readonly kind: "preflight_bridge"; readonly bridgeId: string }
  | { readonly step: 3; readonly kind: "confirm_map"; readonly confirmed: true; readonly correction?: string }
  | { readonly step: 4; readonly kind: "bind_private_device"; readonly memberName: string; readonly role: "adult_admin" }
  | { readonly step: 5; readonly kind: "set_action_policy"; readonly directCapabilityIds: readonly string[]; readonly confirmationCapabilityIds: readonly string[]; readonly administratorCapabilityIds: readonly string[] }
  | { readonly step: 6; readonly kind: "acknowledge_safety_rules"; readonly acknowledged: true }
  | { readonly step: 7; readonly kind: "set_observation_schedule"; readonly enabled: boolean; readonly intervalMinutes?: number; readonly quietHours?: { readonly start: string; readonly end: string } }
  | { readonly step: 8; readonly kind: "ask_first_question"; readonly question: string };

export type OnboardingActorRole = "admin" | "adult_member" | "member" | "child" | "guest";
export type OnboardingDeviceKind = "private" | "shared";
export type OnboardingPolicySuggestion = "direct" | "confirmation" | "administrator";

export interface OnboardingBridgeChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly selectable: boolean;
}

export interface OnboardingCapabilityChoice {
  readonly id: string;
  readonly label: string;
  readonly bridgeId: string;
  readonly bridgeLabel: string;
  readonly schema?: string;
  readonly suggestedPolicyClass: OnboardingPolicySuggestion;
  /** The saved confirmation method, present only when actually configured. */
  readonly currentPolicyClass?: OnboardingPolicySuggestion;
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

export interface OnboardingStepRecord {
  readonly status: "pending" | "completed" | "blocked";
  readonly updatedAt: string;
  readonly summary: string;
  readonly blockedReason?: string;
}

export interface OnboardingViewState {
  readonly step: OnboardingStep;
  readonly complete: boolean;
  readonly status: "ready" | "blocked" | "complete";
  readonly title: string;
  readonly body: string;
  readonly blockedReason?: string;
  readonly steps?: Readonly<Record<OnboardingStep, OnboardingStepRecord>>;
  readonly household?: { readonly householdName: string; readonly agentName: string };
  readonly choices?: OnboardingChoiceProjection;
}

export interface OnboardingContinuation {
  readonly state: OnboardingViewState;
  readonly outcome: "completed" | "blocked";
  readonly complete: boolean;
  readonly completedStep?: OnboardingStep;
}

export interface OnboardingPort {
  getState(): OnboardingViewState | Promise<OnboardingViewState>;
  submit(command: OnboardingCommand, actor?: OnboardingActor): OnboardingContinuation | Promise<OnboardingContinuation>;
  /** Step-5 capability choices, reused by the settings confirmation editor. */
  actionPolicyChoices?(): OnboardingViewState["choices"];
  /** Re-decides confirmation methods after onboarding, same rules as step 5. */
  configureActionPolicy?(
    selection: {
      readonly directCapabilityIds: readonly string[];
      readonly confirmationCapabilityIds: readonly string[];
      readonly administratorCapabilityIds: readonly string[];
    },
    actor?: OnboardingActor,
  ): { readonly status: "configured"; readonly changedCount?: number } | { readonly status: "blocked"; readonly reason: string };
  close?(): void;
}

/** Explicit unavailable seam used only when an embedding omits the Hub owner. */
export class UnavailableOnboardingService implements OnboardingPort {
  getState(): OnboardingViewState {
    return {
      step: 1,
      complete: false,
      status: "blocked",
      title: "首次设置暂不可用",
      body: "家庭设置正在准备，连接完成后从这里继续。",
      blockedReason: "家庭设置服务尚未连接",
    };
  }

  submit(): never {
    const error = new Error("onboarding_unavailable") as Error & { code: "onboarding_unavailable" };
    error.code = "onboarding_unavailable";
    throw error;
  }
}
