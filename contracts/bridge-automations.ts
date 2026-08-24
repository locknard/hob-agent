import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";
import { bridgeActionTargetSchema } from "./bridge-actions.js";

const boundedId = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(512);
export const bridgeAutomationOperationIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export type BridgeAutomationOperationId = z.infer<typeof bridgeAutomationOperationIdSchema>;

export const AUTOMATIONS_EXTENSION = Object.freeze({
  id: "automations",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;

/** Versioned command surface with explicit operation replay identity. */
export const AUTOMATIONS_EXTENSION_V2 = Object.freeze({
  id: "automations",
  version: "2.0.0",
}) satisfies ExtensionDeclaration;

/**
 * A deployable automation the Hub compiled from an approved neutral artifact.
 * Every capability reference arrives with its resolved binding, so the adapter
 * never interprets neutral identity. The Hub owns the automation id and the
 * adapter deploys only automations the Hub created; foreign rules are never
 * modified or withdrawn through this extension.
 *
 * The artifact's rollback and postconditions deliberately stay out of this
 * spec: they govern Hub-side verification and the close-with-restore path, and
 * no ecosystem runtime is trusted to enforce them. The deployed behavior is
 * exactly trigger, conditions and actions.
 */
export const bridgeAutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    timezone: boundedText,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    at: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict(),
  z.object({
    kind: z.literal("capability_changed"),
    source: bridgeActionTargetSchema,
  }).strict(),
]);
export type BridgeAutomationTrigger = z.infer<typeof bridgeAutomationTriggerSchema>;

export const bridgeAutomationConditionSchema = z.object({
  kind: z.literal("capability_value"),
  source: bridgeActionTargetSchema,
  operator: z.enum(["equals", "not_equals", "greater_than", "less_than"]),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
}).strict();
export type BridgeAutomationCondition = z.infer<typeof bridgeAutomationConditionSchema>;

export const bridgeAutomationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_boolean"),
    target: bridgeActionTargetSchema,
    value: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("set_level"),
    target: bridgeActionTargetSchema,
    level: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    kind: z.literal("notify_local"),
    message: boundedText,
  }).strict(),
]);
export type BridgeAutomationAction = z.infer<typeof bridgeAutomationActionSchema>;

export const bridgeAutomationSpecSchema = z.object({
  /** Hub-owned stable identity; the adapter namespaces its native artifact with it. */
  automationId: z.string().regex(/^[a-z0-9][a-z0-9_]{2,120}$/),
  /** Household-readable title carried into the native description. */
  title: boundedText,
  trigger: bridgeAutomationTriggerSchema,
  conditions: z.array(bridgeAutomationConditionSchema).max(16),
  actions: z.array(bridgeAutomationActionSchema).min(1).max(16),
}).strict();
export type BridgeAutomationSpec = z.infer<typeof bridgeAutomationSpecSchema>;

export const bridgeAutomationDeployResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deployed"),
    /** Verified by read-back before the adapter reports it. */
    nativeAutomationId: boundedId,
    /** Stable fingerprint of the stored behavioral configuration. */
    configFingerprint: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["unsupported", "invalid_target", "unavailable", "failed"]),
    detail: boundedText.optional(),
  }).strict(),
]);
export type BridgeAutomationDeployResult = z.infer<typeof bridgeAutomationDeployResultSchema>;

export const bridgeAutomationDeployRequestSchema = z.object({
  operationId: bridgeAutomationOperationIdSchema,
  spec: bridgeAutomationSpecSchema,
}).strict();
export type BridgeAutomationDeployRequest = z.infer<typeof bridgeAutomationDeployRequestSchema>;

export const bridgeAutomationCommandResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("acknowledged") }).strict(),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["not_found", "unavailable", "failed"]),
    detail: boundedText.optional(),
  }).strict(),
]);
export type BridgeAutomationCommandResult = z.infer<typeof bridgeAutomationCommandResultSchema>;

const bridgeAutomationUnknownReasonSchema = z.enum(["unavailable", "not_confirmed"]);

export const bridgeAutomationDeployResultV2Schema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deployed"),
    operationId: bridgeAutomationOperationIdSchema,
    nativeAutomationId: boundedId,
    configFingerprint: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    operationId: bridgeAutomationOperationIdSchema,
    reason: z.enum(["unsupported", "invalid_target", "unavailable", "failed"]),
    detail: boundedText.optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    operationId: bridgeAutomationOperationIdSchema,
    reason: bridgeAutomationUnknownReasonSchema,
  }).strict(),
]);
export type BridgeAutomationDeployResultV2 = z.infer<typeof bridgeAutomationDeployResultV2Schema>;

export const bridgeAutomationSetEnabledRequestSchema = z.object({
  operationId: bridgeAutomationOperationIdSchema,
  nativeAutomationId: boundedId,
  enabled: z.boolean(),
}).strict();
export type BridgeAutomationSetEnabledRequest = z.infer<typeof bridgeAutomationSetEnabledRequestSchema>;

export const bridgeAutomationWithdrawRequestSchema = z.object({
  operationId: bridgeAutomationOperationIdSchema,
  nativeAutomationId: boundedId,
}).strict();
export type BridgeAutomationWithdrawRequest = z.infer<typeof bridgeAutomationWithdrawRequestSchema>;

export const bridgeAutomationCommandResultV2Schema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("acknowledged"),
    operationId: bridgeAutomationOperationIdSchema,
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    operationId: bridgeAutomationOperationIdSchema,
    reason: z.enum(["not_found", "unavailable", "failed"]),
    detail: boundedText.optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    operationId: bridgeAutomationOperationIdSchema,
    reason: bridgeAutomationUnknownReasonSchema,
  }).strict(),
]);
export type BridgeAutomationCommandResultV2 = z.infer<typeof bridgeAutomationCommandResultV2Schema>;

export const bridgeAutomationStatusResultSchema = z.object({
  status: z.enum(["running", "paused", "missing", "unknown"]),
  /** Present when the runtime can read the stored configuration back. */
  configFingerprint: z.string().min(1).max(128).optional(),
}).strict();
export type BridgeAutomationStatusResult = z.infer<typeof bridgeAutomationStatusResultSchema>;

export interface AutomationsExtension {
  /** The native runtime is the source of truth for whether an automation runs. */
  status(
    request: { readonly nativeAutomationId: string },
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationStatusResult>;
  deploy(
    spec: BridgeAutomationSpec,
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationDeployResult>;
  setEnabled(
    request: { readonly nativeAutomationId: string; readonly enabled: boolean },
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationCommandResult>;
  withdraw(
    request: { readonly nativeAutomationId: string },
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationCommandResult>;
}

/** Automations command surface with operation-level replay identity. */
export interface AutomationsExtensionV2 {
  status(
    request: { readonly nativeAutomationId: string },
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationStatusResult>;
  deploy(
    request: BridgeAutomationDeployRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationDeployResultV2>;
  setEnabled(
    request: BridgeAutomationSetEnabledRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationCommandResultV2>;
  withdraw(
    request: BridgeAutomationWithdrawRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<BridgeAutomationCommandResultV2>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "automations@1": AutomationsExtension;
    "automations@2": AutomationsExtensionV2;
  }
}
