/**
 * Version 6.4 of the neutral bridge contract.
 *
 * This module is the contract source of truth: runtime schemas are declared
 * first and the exported TypeScript value types are inferred from those
 * schemas wherever a runtime boundary exists.  Adapter implementations remain
 * trusted code, but everything crossing the bridge boundary is validated by
 * the schemas below.
 */

import { z, type ZodType } from "zod";

const nonEmptyString = z.string().min(1);
const boundedString = (max: number) => nonEmptyString.max(max);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const isSynchronousFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === "function" && value.constructor.name !== "AsyncFunction";

// ---- 基础值与时间 ---------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const timeMetaSchema = z
  .object({
    sourceTs: nonEmptyString.optional(),
    sourceTsQuality: z.enum(["device", "platform", "none"]),
  })
  .strict();
export type TimeMeta = z.infer<typeof timeMetaSchema>;

// ---- 身份 -----------------------------------------------------------------

export const identityClaimSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device_reported") }).strict(),
  z.object({ kind: z.literal("independent_registry"), registry: nonEmptyString }).strict(),
  z.object({ kind: z.literal("platform_registry"), platform: nonEmptyString }).strict(),
  z.object({ kind: z.literal("inferred"), method: nonEmptyString }).strict(),
]);

export const identityClaimSchema = z
  .object({
    type: z.enum(["mac", "ieee", "serial", "miotDid", "other"]),
    value: boundedString(512),
    source: identityClaimSourceSchema,
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();
export type IdentityClaim = z.infer<typeof identityClaimSchema>;
export type IdentityClaimSource = z.infer<typeof identityClaimSourceSchema>;

// ---- 扩展协商 -------------------------------------------------------------

const extensionIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Semantic version used by the core and extension declarations. */
export const semverSchema = z.string().regex(SEMVER_PATTERN);
export const semanticVersionSchema = semverSchema;

export const extensionDeclarationSchema = z
  .object({
    id: extensionIdSchema,
    version: semverSchema,
    metadata: jsonValueSchema.optional(),
  })
  .strict();
export type ExtensionDeclaration = z.infer<typeof extensionDeclarationSchema>;

/** The open module-augmentation seam for extension handles. */
export interface ExtensionHandleRegistry {}

export const canonicalExtensionKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}@[0-9]+$/);

export function canonicalExtensionKey(
  declaration: Pick<ExtensionDeclaration, "id" | "version">,
): string;
export function canonicalExtensionKey(id: string, version: string): string;
export function canonicalExtensionKey(
  declarationOrId: Pick<ExtensionDeclaration, "id" | "version"> | string,
  maybeVersion?: string,
): string {
  const id = typeof declarationOrId === "string" ? declarationOrId : declarationOrId.id;
  const version = typeof declarationOrId === "string" ? maybeVersion : declarationOrId.version;
  const parsedId = extensionIdSchema.safeParse(id);
  const parsedVersion = semverSchema.safeParse(version);
  if (!parsedId.success || !parsedVersion.success || version === undefined) {
    throw new Error("Invalid extension id or semantic version");
  }
  return `${id}@${Number.parseInt(version, 10)}`;
}

// Friendly aliases used by callers that prefer a verb for the conversion.
export const toCanonicalExtensionKey = canonicalExtensionKey;
export const extensionKey = canonicalExtensionKey;

// ---- 凭证(桥级受限视图) ----------------------------------------------------

export const credentialKindSchema = z.enum(["secret_text", "oauth", "certificate"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

export const credentialRequirementSchema = z
  .object({ alias: boundedString(128), kind: credentialKindSchema })
  .strict();
export type CredentialRequirement = z.infer<typeof credentialRequirementSchema>;

const secretTextMaterialSchema = z
  .object({ kind: z.literal("secret_text"), value: nonEmptyString })
  .strict();
const oauthMaterialSchema = z
  .object({
    kind: z.literal("oauth"),
    accessToken: nonEmptyString,
    refreshToken: nonEmptyString.optional(),
    expiresAt: nonEmptyString.optional(),
  })
  .strict();
const certificateMaterialSchema = z
  .object({
    kind: z.literal("certificate"),
    certificatePem: nonEmptyString,
    privateKeyPem: nonEmptyString,
    caPem: nonEmptyString.optional(),
  })
  .strict();

export const credentialMaterialSchema = z.discriminatedUnion("kind", [
  secretTextMaterialSchema,
  oauthMaterialSchema,
  certificateMaterialSchema,
]);
export type CredentialMaterial = z.infer<typeof credentialMaterialSchema>;

export interface BridgeCredentialProvider {
  /** Resolve only an alias declared by the owning adapter registration. */
  resolve(alias: string): Promise<CredentialMaterial | undefined>;
  /** Return non-secret availability metadata; never return the material here. */
  describe(alias: string): Promise<{ configured: boolean }>;
}

export const bridgeCredentialProviderSchema = z
  .object({
    resolve: z.custom<BridgeCredentialProvider["resolve"]>((value) => typeof value === "function"),
    describe: z.custom<BridgeCredentialProvider["describe"]>((value) => typeof value === "function"),
  })
  .strict();

// ---- schema 登记与资源预算 -----------------------------------------------

const zodTypeSchema = z.custom<ZodType<unknown>>(
  (value) => value instanceof z.ZodType,
  { message: "Expected a Zod schema" },
);

export const resourceBudgetSchema = z
  .object({
    maxFields: positiveInteger,
    maxStringLength: positiveInteger,
    maxDepth: positiveInteger,
    maxSerializedBytes: positiveInteger,
  })
  .strict();
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;

export const schemaRegistrationSchema = z
  .object({
    schema: boundedString(256),
    majorVersion: positiveInteger,
    attrsSchema: zodTypeSchema,
    canonicalHash: boundedString(256),
  })
  .strict();

export type SchemaRegistration<
  T extends Record<string, JsonValue> = Record<string, JsonValue>,
> = {
  schema: string;
  majorVersion: number;
  attrsSchema: ZodType<T>;
  canonicalHash: string;
};

/** Equivalence mapping is intentionally a placeholder until §7 is finalized. */
export interface EquivalenceMapping {}
export const equivalenceMappingSchema = z.object({}).strict();

/** Optional read-side classification; never implies equivalence or authority. */
export const capabilitySemanticKindSchema = z.enum([
  "light",
  "switch",
  "button",
  "sensor",
  "binary-sensor",
  "numeric-control",
  "choice-control",
  "text-control",
  "time-control",
  "event",
  "media",
  "cover",
  "lock",
  "presence",
  "fan",
  "camera",
  "vacuum",
  "climate",
  "weather",
  "automation",
]);
export type CapabilitySemanticKind = z.infer<typeof capabilitySemanticKindSchema>;

// ---- hub 分配的规范世界身份 ----------------------------------------------

const worldCapabilityBindingSchema = z
  .object({
    bridgeId: nonEmptyString,
    nativeId: nonEmptyString,
    nativeInstanceId: nonEmptyString,
  })
  .strict();

export const worldCapabilitySchema = z
  .object({
    hwCapabilityId: nonEmptyString,
    hwId: nonEmptyString,
    schema: boundedString(256),
    semanticKind: capabilitySemanticKindSchema.optional(),
    bindings: z.array(worldCapabilityBindingSchema).min(1),
  })
  .strict();
export type WorldCapability = z.infer<typeof worldCapabilitySchema>;
export type WorldCapabilityBinding = z.infer<typeof worldCapabilityBindingSchema>;

// ---- 读侧内核 -------------------------------------------------------------

export const adapterCapabilityRefSchema = z
  .object({
    nativeInstanceId: nonEmptyString,
    schema: boundedString(256),
    schemaVersion: boundedString(64),
    semanticKind: capabilitySemanticKindSchema.optional(),
  })
  .strict();
export type AdapterCapabilityRef = z.infer<typeof adapterCapabilityRefSchema>;

export const deviceDescriptorSchema = z
  .object({
    nativeId: nonEmptyString,
    name: boundedString(512).optional(),
    capabilities: z.array(adapterCapabilityRefSchema),
    via: z.array(nonEmptyString).optional(),
    identityClaims: z.array(identityClaimSchema).optional(),
  })
  .strict();
export type DeviceDescriptor = z.infer<typeof deviceDescriptorSchema>;

export const stateEventSchema = z
  .object({
    nativeId: nonEmptyString,
    nativeInstanceId: nonEmptyString,
    attrs: z.record(z.string(), jsonValueSchema),
    time: timeMetaSchema,
    origin: z.enum(["observed", "imported"]),
  })
  .strict();
export type StateEvent = z.infer<typeof stateEventSchema>;

export const snapshotManifestSchema = z
  .object({
    snapshotId: nonEmptyString,
    deviceEnvelopeCount: nonNegativeInteger,
    stateEnvelopeCount: nonNegativeInteger,
  })
  .strict();
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const syncStartEventSchema = z
  .object({
    kind: z.literal("sync-start"),
    snapshotId: nonEmptyString,
    remoteInstanceId: nonEmptyString,
    reason: z.enum(["initial", "resync", "resume", "upstream-reset"]),
  })
  .strict();
export type SyncStartEvent = z.infer<typeof syncStartEventSchema>;

export const deviceUpsertedEventSchema = z
  .object({ kind: z.literal("device-upserted"), device: deviceDescriptorSchema })
  .strict();
export type DeviceUpsertedEvent = z.infer<typeof deviceUpsertedEventSchema>;

export const deviceRemovedEventSchema = z
  .object({ kind: z.literal("device-removed"), nativeId: nonEmptyString })
  .strict();
export type DeviceRemovedEvent = z.infer<typeof deviceRemovedEventSchema>;

export const deviceHealthEventSchema = z
  .object({
    kind: z.literal("device-health"),
    nativeId: nonEmptyString,
    status: z.enum(["reachable", "unreachable", "unknown"]),
  })
  .strict();
export type DeviceHealthEvent = z.infer<typeof deviceHealthEventSchema>;

export const bridgeHealthEventSchema = z
  .object({
    kind: z.literal("bridge-health"),
    status: z.enum(["up", "degraded"]),
    clockOffsetEstimateMs: z.number().finite().optional(),
    extensionAvailability: z.record(z.string(), z.enum(["available", "unavailable"])).optional(),
  })
  .strict();
export type BridgeHealthEvent = z.infer<typeof bridgeHealthEventSchema>;

export const heartbeatEventSchema = z.object({ kind: z.literal("heartbeat") }).strict();
export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;

export const extensionEventSchema = z
  .object({ kind: z.literal("ext"), ext: canonicalExtensionKeySchema, payload: z.unknown() })
  .strict();
export type ExtensionEvent = z.infer<typeof extensionEventSchema>;

export const syncCompleteEventSchema = z
  .object({ kind: z.literal("sync-complete"), manifest: snapshotManifestSchema })
  .strict();
export type SyncCompleteEvent = z.infer<typeof syncCompleteEventSchema>;

export const stateEnvelopeEventSchema = z
  .object({ kind: z.literal("state"), state: stateEventSchema })
  .strict();
export type StateEnvelopeEvent = z.infer<typeof stateEnvelopeEventSchema>;

export const bridgeEventSchema = z.discriminatedUnion("kind", [
  syncStartEventSchema,
  deviceUpsertedEventSchema,
  deviceRemovedEventSchema,
  stateEnvelopeEventSchema,
  deviceHealthEventSchema,
  bridgeHealthEventSchema,
  heartbeatEventSchema,
  extensionEventSchema,
  syncCompleteEventSchema,
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

export const envelopeSchema = z
  .object({
    epochId: nonEmptyString,
    seq: positiveInteger,
    event: bridgeEventSchema,
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;

export const extensionAvailabilitySchema = z.enum(["available", "unavailable"]);

export const extensionDeclarationListSchema = z
  .array(extensionDeclarationSchema)
  .superRefine((declarations, context) => {
    const seen = new Map<string, number>();
    declarations.forEach((declaration, index) => {
      const key = canonicalExtensionKey(declaration);
      const previousIndex = seen.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `Duplicate extension declaration for canonical key "${key}" (first declared at index ${previousIndex})`,
        });
      } else {
        seen.set(key, index);
      }
    });
  })
  .readonly();

export const bridgeInfoSchema = z
  .object({
    bridgeId: nonEmptyString,
    coreVersion: semverSchema,
    ecosystem: nonEmptyString,
    heartbeatIntervalMs: positiveInteger,
    extensions: extensionDeclarationListSchema,
  })
  .strict();
export type BridgeInfo = z.infer<typeof bridgeInfoSchema>;

// ---- control and diagnostics ---------------------------------------------

export const coreReasonCodeSchema = z.enum([
  "timeout",
  "cancelled",
  "protocol_error",
  "invalid_payload",
  "unsupported",
  "not_ready",
  "resource_exhausted",
  "upstream_unavailable",
  "internal_error",
]);
export type CoreReasonCode = z.infer<typeof coreReasonCodeSchema>;

export const adapterCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*(?::|\/|\.)[A-Za-z0-9_.-]+$/);

export const controlResultSchema = z
  .object({
    status: z.enum(["completed", "unsupported", "failed"]),
    reason: coreReasonCodeSchema.optional(),
    adapterCode: adapterCodeSchema.optional(),
    detail: z.string().max(1024).optional(),
  })
  .strict();
export type ControlResult = z.infer<typeof controlResultSchema>;

export const bridgeConnectionStateSchema = z.enum([
  "starting",
  "syncing",
  "ready",
  "degraded",
  "paused",
  "quarantined",
  "down",
]);

export const historyGapSchema = z
  .object({ from: nonEmptyString, to: nonEmptyString, reason: boundedString(256) })
  .strict();

export const MAX_RECENT_HISTORY_GAPS = 32;
export const hubBridgeDiagnosticsSchema = z
  .object({
    connectionState: bridgeConnectionStateSchema,
    lastSyncCompleteAt: nonEmptyString.optional(),
    lastEventReceivedAt: nonEmptyString.optional(),
    lastSuccessfulContactAt: nonEmptyString.optional(),
    droppedInvalidCount: nonNegativeInteger,
    strippedFieldsCount: nonNegativeInteger,
    staleEpochDropCount: nonNegativeInteger,
    foldedStateCount: nonNegativeInteger,
    unsupportedSchemaCount: nonNegativeInteger,
    protocolViolationCount: nonNegativeInteger,
    historyGapCount: nonNegativeInteger,
    recentHistoryGaps: z.array(historyGapSchema).max(MAX_RECENT_HISTORY_GAPS),
  })
  .strict();
export type HubBridgeDiagnostics = z.infer<typeof hubBridgeDiagnosticsSchema>;
export type HistoryGap = z.infer<typeof historyGapSchema>;

// ---- adapter lifecycle ----------------------------------------------------

export interface BridgeControl {
  requestResync(signal: AbortSignal): Promise<ControlResult>;
  pause?(signal: AbortSignal): Promise<ControlResult>;
  resume?(signal: AbortSignal): Promise<ControlResult>;
  dispose(): Promise<void>;
}

export const bridgeControlSchema = z
  .object({
    requestResync: z.custom<BridgeControl["requestResync"]>((value) => typeof value === "function"),
    pause: z.custom<NonNullable<BridgeControl["pause"]>>((value) => typeof value === "function").optional(),
    resume: z.custom<NonNullable<BridgeControl["resume"]>>((value) => typeof value === "function").optional(),
    dispose: z.custom<BridgeControl["dispose"]>((value) => typeof value === "function"),
  })
  .strict();

export interface BridgeAdapter {
  readonly info: BridgeInfo;
  events(signal: AbortSignal): AsyncIterable<Envelope>;
  readonly control: BridgeControl;
  extension<K extends keyof ExtensionHandleRegistry>(name: K): ExtensionHandleRegistry[K] | undefined;
}

export const bridgeAdapterSchema = z
  .object({
    info: bridgeInfoSchema,
    events: z.custom<BridgeAdapter["events"]>((value) => typeof value === "function"),
    control: bridgeControlSchema,
    extension: z.custom<BridgeAdapter["extension"]>((value) => typeof value === "function"),
  })
  .strict();

export interface AdapterFactoryContext<C> {
  bridgeId: string;
  config: C;
  credentials: BridgeCredentialProvider;
}

export const adapterFactoryContextSchema = z
  .object({ bridgeId: nonEmptyString, config: z.unknown(), credentials: bridgeCredentialProviderSchema })
  .strict();

export type AdapterFactory<C> = (ctx: AdapterFactoryContext<C>) => BridgeAdapter;

export interface AdapterRegistration<C> {
  adapterType: string;
  configSchema: ZodType<C>;
  credentialRequirements: readonly CredentialRequirement[];
  capabilitySchemas: readonly SchemaRegistration[];
  equivalenceMappings?: readonly EquivalenceMapping[];
  factory: AdapterFactory<C>;
}

export const adapterRegistrationSchema = z
  .object({
    adapterType: boundedString(128),
    configSchema: zodTypeSchema,
    credentialRequirements: z.array(credentialRequirementSchema).readonly(),
    capabilitySchemas: z.array(schemaRegistrationSchema).readonly(),
    equivalenceMappings: z.array(equivalenceMappingSchema).readonly().optional(),
    factory: z.custom<AdapterFactory<unknown>>(isSynchronousFunction),
  })
  .strict();

// ---- journal and stream termination --------------------------------------

export const ingestRecordSchema = z
  .object({ bridgeId: nonEmptyString, receivedAt: nonEmptyString, envelope: envelopeSchema })
  .strict();
export type IngestRecord = z.infer<typeof ingestRecordSchema>;

export const bridgeStreamErrorReasonSchema = z.enum([
  "upstream_unavailable",
  "authentication_failed",
  "rate_limited",
  "protocol_error",
  "internal_error",
]);
export type BridgeStreamErrorReason = z.infer<typeof bridgeStreamErrorReasonSchema>;

/** Serialized, non-stack stream error data suitable for diagnostics. */
export const bridgeStreamErrorSchema = z
  .object({ reason: bridgeStreamErrorReasonSchema, message: z.string().max(1024) })
  .strict();
export type BridgeStreamErrorData = z.infer<typeof bridgeStreamErrorSchema>;

export class BridgeStreamError extends Error {
  readonly reason: BridgeStreamErrorReason;

  constructor(message: string, reason: BridgeStreamErrorReason);
  constructor(reason: BridgeStreamErrorReason, message?: string);
  constructor(first: string, second?: string) {
    const firstIsReason = bridgeStreamErrorReasonSchema.safeParse(first).success;
    const reason = (firstIsReason ? first : second) as BridgeStreamErrorReason;
    const message = firstIsReason ? (second ?? first) : first;
    if (!bridgeStreamErrorReasonSchema.safeParse(reason).success) {
      throw new TypeError("Invalid bridge stream error reason");
    }
    super(message);
    this.name = "BridgeStreamError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Map an untyped stream failure into the closed stream-error contract. */
export function normalizeBridgeStreamError(error: unknown): BridgeStreamError {
  if (error instanceof BridgeStreamError) return error;
  return new BridgeStreamError(error instanceof Error ? error.message : "Bridge stream failed", "internal_error");
}

// ---- compatibility aliases for schema consumers -------------------------

export const JsonValueSchema = jsonValueSchema;
export const TimeMetaSchema = timeMetaSchema;
export const IdentityClaimSchema = identityClaimSchema;
export const IdentityClaimSourceSchema = identityClaimSourceSchema;
export const ExtensionDeclarationSchema = extensionDeclarationSchema;
export const CanonicalExtensionKeySchema = canonicalExtensionKeySchema;
export const CredentialKindSchema = credentialKindSchema;
export const CredentialRequirementSchema = credentialRequirementSchema;
export const CredentialMaterialSchema = credentialMaterialSchema;
export const BridgeCredentialProviderSchema = bridgeCredentialProviderSchema;
export const ResourceBudgetSchema = resourceBudgetSchema;
export const SchemaRegistrationSchema = schemaRegistrationSchema;
export const EquivalenceMappingSchema = equivalenceMappingSchema;
export const WorldCapabilitySchema = worldCapabilitySchema;
export const AdapterCapabilityRefSchema = adapterCapabilityRefSchema;
export const DeviceDescriptorSchema = deviceDescriptorSchema;
export const StateEventSchema = stateEventSchema;
export const SnapshotManifestSchema = snapshotManifestSchema;
export const SyncStartEventSchema = syncStartEventSchema;
export const DeviceUpsertedEventSchema = deviceUpsertedEventSchema;
export const DeviceRemovedEventSchema = deviceRemovedEventSchema;
export const DeviceHealthEventSchema = deviceHealthEventSchema;
export const BridgeHealthEventSchema = bridgeHealthEventSchema;
export const HeartbeatEventSchema = heartbeatEventSchema;
export const ExtensionEventSchema = extensionEventSchema;
export const SyncCompleteEventSchema = syncCompleteEventSchema;
export const StateEnvelopeEventSchema = stateEnvelopeEventSchema;
export const BridgeEventSchema = bridgeEventSchema;
export const EnvelopeSchema = envelopeSchema;
export const BridgeInfoSchema = bridgeInfoSchema;
export const SemverSchema = semverSchema;
export const SemanticVersionSchema = semanticVersionSchema;
export const CoreReasonCodeSchema = coreReasonCodeSchema;
export const AdapterCodeSchema = adapterCodeSchema;
export const ControlResultSchema = controlResultSchema;
export const BridgeConnectionStateSchema = bridgeConnectionStateSchema;
export const HistoryGapSchema = historyGapSchema;
export const HubBridgeDiagnosticsSchema = hubBridgeDiagnosticsSchema;
export const BridgeControlSchema = bridgeControlSchema;
export const BridgeAdapterSchema = bridgeAdapterSchema;
export const AdapterFactoryContextSchema = adapterFactoryContextSchema;
export const AdapterRegistrationSchema = adapterRegistrationSchema;
export const IngestRecordSchema = ingestRecordSchema;
export const BridgeStreamErrorReasonSchema = bridgeStreamErrorReasonSchema;
export const BridgeStreamErrorSchema = bridgeStreamErrorSchema;
