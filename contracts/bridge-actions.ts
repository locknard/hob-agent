import { z } from "zod";

import type { ExtensionDeclaration } from "./bridge-contract.js";

const boundedId = z.string().min(1).max(256);
const opaqueMediaRef = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const descriptorText = z.string().min(1).max(512).regex(/^[^\u0000-\u001F\u007F]+$/u);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const ACTIONS_EXTENSION = Object.freeze({
  id: "actions",
  version: "1.0.0",
}) satisfies ExtensionDeclaration;

export const bridgeActionTargetSchema = z.object({
  hwCapabilityId: boundedId,
  binding: z.object({
    bridgeId: boundedId,
    nativeId: boundedId,
    nativeInstanceId: boundedId,
  }).strict(),
}).strict();
export type BridgeActionTarget = z.infer<typeof bridgeActionTargetSchema>;

/**
 * An adapter-owned action intent without routing information.  The Hub adds
 * the exact target only after resolving one authoritative binding.  Adapters
 * return one concrete next action from their current state; they never return
 * a semantic category for another layer to interpret.
 */
export const bridgeActionIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_boolean"),
    value: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("set_level"),
    level: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    kind: z.literal("play_media"),
    mediaRef: opaqueMediaRef,
    queueMode: z.enum(["replace_and_play", "play_next", "add_to_queue"]),
  }).strict(),
  z.object({
    kind: z.literal("stop_media"),
  }).strict(),
]);
export type BridgeActionIntent = z.infer<typeof bridgeActionIntentSchema>;

/**
 * The concrete control an adapter has verified as supported and reversible
 * (or explicitly irreversible for an action such as stop_media).
 */
export const bridgeActionDescriptorSchema = z.object({
  action: bridgeActionIntentSchema,
  reversible: z.boolean(),
  label: descriptorText.optional(),
  actionLabel: descriptorText.optional(),
  summary: descriptorText.optional(),
  value: descriptorText.optional(),
}).strict();
export type BridgeActionDescriptor = z.infer<typeof bridgeActionDescriptorSchema>;

/**
 * Neutral current-state facts supplied to an adapter while asking it for an
 * action descriptor.  The list is deliberately small and contains no names
 * or semantic-kind hints, so unsupported or unknown state naturally yields no
 * descriptor.
 */
export const bridgeActionCurrentStateSchema = z.object({
  value: scalar.optional(),
  state: z.string().max(256).optional(),
  level: z.number().finite().min(0).max(1).optional(),
  brightness: z.number().finite().min(0).max(255).optional(),
  volumeLevel: z.number().finite().min(0).max(1).optional(),
  format: z.string().min(1).max(64).optional(),
  writable: z.boolean().optional(),
  setLevelSupported: z.boolean().optional(),
  available: z.boolean().optional(),
}).strict();
export type BridgeActionCurrentState = z.infer<typeof bridgeActionCurrentStateSchema>;

export const bridgeActionDescriptorRequestSchema = z.object({
  target: bridgeActionTargetSchema,
  current: bridgeActionCurrentStateSchema,
}).strict();
export type BridgeActionDescriptorRequest = z.infer<typeof bridgeActionDescriptorRequestSchema>;

export const bridgeActionSchema = z.discriminatedUnion("kind", [
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
    kind: z.literal("play_media"),
    target: bridgeActionTargetSchema,
    mediaRef: opaqueMediaRef,
    queueMode: z.enum(["replace_and_play", "play_next", "add_to_queue"]),
  }).strict(),
  z.object({
    kind: z.literal("stop_media"),
    target: bridgeActionTargetSchema,
  }).strict(),
]);
export type BridgeAction = z.infer<typeof bridgeActionSchema>;

export const bridgeActionRequestSchema = z.object({
  requestId: boundedId,
  action: bridgeActionSchema,
}).strict();
export type BridgeActionRequest = z.infer<typeof bridgeActionRequestSchema>;

export const bridgeActionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("acknowledged") }).strict(),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["unsupported", "invalid_target", "unavailable", "failed"]),
    adapterCode: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum(["timeout", "cancelled", "upstream_unavailable"]),
  }).strict(),
]);
export type BridgeActionResult = z.infer<typeof bridgeActionResultSchema>;

export interface ActionsExtension {
  describe(request: BridgeActionDescriptorRequest): BridgeActionDescriptor | undefined;
  execute(request: BridgeActionRequest, options: { readonly signal: AbortSignal }): Promise<BridgeActionResult>;
}

declare module "./bridge-contract.js" {
  interface ExtensionHandleRegistry {
    "actions@1": ActionsExtension;
  }
}
