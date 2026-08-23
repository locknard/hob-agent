import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ProductSetupDraftProjection,
} from "@hob-agent/inbox-web/setup";
import { validateCustomModelBaseURL } from "@hob-agent/agent-layer/model-providers";
import type {
  ProductBootstrapConfigDraft,
  ProductBootstrapVoiceAsrConfig,
  ProductBootstrapVoiceTtsConfig,
  ProductVoiceRuntimeConfig,
} from "./product-bootstrap-config-store.js";
import type { ProductModelSetupStage } from "./product-model-setup.js";
import type { ProductBridgeSetupStage } from "./product-bridge-setup.js";
import type { ProductVoiceSetupStage } from "./product-voice-setup.js";
import { normalizePrivateVoiceEndpoint } from "./voice/private-voice-endpoint.js";

const DRAFT_VERSION = "hob.setup-draft/v2" as const;
const LEGACY_DRAFT_VERSION = "hob.setup-draft/v1" as const;
const MAX_DRAFT_BYTES = 16_384;
const MAX_PENDING_VOICE_CLEANUPS = 8;
const MAX_VOICE_STAGING_LEASES = 8;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SECRET_KEY = /token|secret|password|passphrase|(?:api|access|private|signing|encryption).?key|credential/i;

interface StoredSetupDraft extends Omit<ProductSetupDraftProjection, "voice"> {
  readonly version: typeof DRAFT_VERSION;
  readonly sessionDigest: string;
  readonly sessionExpiresAt: string;
  readonly modelCredentialRef?: string;
  readonly modelProfileId?: string;
  readonly modelProbeLatencyMs?: number;
  readonly bridgeId?: string;
  readonly bridgeConfig?: Readonly<Record<string, unknown>>;
  readonly bridgeCredentialRefs?: Readonly<Record<string, string>>;
  readonly bridgeProbeLatencyMs?: number;
  readonly voice?: {
    readonly asr?: ProductBootstrapVoiceAsrConfig;
    readonly tts?: ProductBootstrapVoiceTtsConfig;
  };
  readonly voiceProbeLatencyMs?: { readonly asr?: number; readonly tts?: number };
  readonly voiceSkipped?: true;
  /** Credential-backed stages that were removed from setup progress and still need vault cleanup. */
  readonly voiceCleanup?: readonly ProductVoiceSetupStage[];
  /** Exact credential locators durably reserved before a voice probe can write them. */
  readonly voiceStaging?: readonly ProductVoiceSetupStage[];
}

/** Durable owner of the paired-device session and non-secret setup progress. */
export class ProductSetupDraftStore {
  private readonly path: string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createDraftId: () => string = randomUUID,
  ) {
    this.path = join(directory, "setup-draft.json");
  }

  establishSession(input: {
    readonly sessionToken: string;
    readonly sessionExpiresAt: Date;
  }): Promise<ProductSetupDraftProjection> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isFinite(input.sessionExpiresAt.getTime()) || input.sessionExpiresAt.getTime() <= this.now().getTime()) {
        throw new TypeError("Setup session expiry is invalid");
      }
      const current = await this.loadStored();
      const stored: StoredSetupDraft = Object.freeze({
        version: DRAFT_VERSION,
        draftId: current?.draftId ?? validDraftId(this.createDraftId()),
        revision: current?.revision ?? 1,
        stage: current?.stage ?? "identity",
        ...(current?.householdName === undefined ? {} : { householdName: current.householdName }),
        ...(current?.agentName === undefined ? {} : { agentName: current.agentName }),
        ...(current?.model === undefined ? {} : { model: current.model }),
        ...(current?.modelCredentialRef === undefined ? {} : { modelCredentialRef: current.modelCredentialRef }),
        ...(current?.modelProfileId === undefined ? {} : { modelProfileId: current.modelProfileId }),
        ...(current?.modelProbeLatencyMs === undefined ? {} : { modelProbeLatencyMs: current.modelProbeLatencyMs }),
        ...(current?.bridge === undefined ? {} : { bridge: current.bridge }),
        ...(current?.bridgeId === undefined ? {} : { bridgeId: current.bridgeId }),
        ...(current?.bridgeConfig === undefined ? {} : { bridgeConfig: current.bridgeConfig }),
        ...(current?.bridgeCredentialRefs === undefined ? {} : { bridgeCredentialRefs: current.bridgeCredentialRefs }),
        ...(current?.bridgeProbeLatencyMs === undefined ? {} : { bridgeProbeLatencyMs: current.bridgeProbeLatencyMs }),
        ...(current?.voice === undefined ? {} : { voice: current.voice }),
        ...(current?.voiceProbeLatencyMs === undefined ? {} : { voiceProbeLatencyMs: current.voiceProbeLatencyMs }),
        ...(current?.voiceSkipped === undefined ? {} : { voiceSkipped: current.voiceSkipped }),
        ...(current?.voiceCleanup === undefined ? {} : { voiceCleanup: current.voiceCleanup }),
        ...(current?.voiceStaging === undefined ? {} : { voiceStaging: current.voiceStaging }),
        sessionDigest: digest(sessionToken).toString("hex"),
        sessionExpiresAt: input.sessionExpiresAt.toISOString(),
      });
      await this.writeStored(stored);
      return project(stored);
    });
  }

  async loadForSession(sessionToken: string): Promise<ProductSetupDraftProjection | undefined> {
    const token = boundedSessionToken(sessionToken);
    const stored = await this.loadStored();
    if (stored === undefined || this.now().getTime() >= Date.parse(stored.sessionExpiresAt)) return undefined;
    const actual = digest(token);
    const expected = Buffer.from(stored.sessionDigest, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? project(stored) : undefined;
  }

  /** Lists the credential-backed voice stages whose durable cleanup has not yet succeeded. */
  async pendingVoiceCleanupForSession(sessionToken: string): Promise<readonly ProductVoiceSetupStage[]> {
    const token = boundedSessionToken(sessionToken);
    const stored = await this.loadStored();
    requireActiveSession(stored, token, this.now());
    return stored!.voiceCleanup ?? Object.freeze([]);
  }

  /** Lists retired credential locators for bounded Hub maintenance, including expired setup drafts. */
  async pendingVoiceCleanupForMaintenance(): Promise<readonly ProductVoiceSetupStage[]> {
    const stored = await this.loadStored();
    return stored?.voiceCleanup ?? Object.freeze([]);
  }

  /** Lists credential leases that a new process recovers before it accepts setup requests. */
  async pendingVoiceStagingForRecovery(): Promise<readonly ProductVoiceSetupStage[]> {
    const stored = await this.loadStored();
    return stored?.voiceStaging ?? Object.freeze([]);
  }

  /** Atomically retires every cold-start staging lease before normal cleanup resumes. */
  retireVoiceStagingForRecovery(): Promise<number> {
    return this.exclusive(async () => {
      const stored = await this.loadStored();
      const staging = stored?.voiceStaging;
      if (stored === undefined || staging === undefined) return 0;
      const voiceCleanup = appendVoiceCleanup(stored.voiceCleanup, staging);
      const { voiceStaging: _voiceStaging, voiceCleanup: _voiceCleanup, ...withoutPending } = stored;
      await this.writeStored(Object.freeze({
        ...withoutPending,
        ...(voiceCleanup.length === 0 ? {} : { voiceCleanup }),
      }));
      return staging.length;
    });
  }

  /** Persists an exact credential cleanup lease before the provider setup owner writes the locator. */
  reserveVoiceCredential(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly stage: ProductVoiceSetupStage;
  }): Promise<void> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new TypeError("Setup draft revision is invalid");
      }
      const stored = await this.loadStored();
      requireActiveSession(stored, sessionToken, this.now());
      if (stored!.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      if (stored!.stage !== "voice") throw new Error("Setup draft stage conflict");
      const stage = validateVoiceStage(stored!.draftId, input.stage);
      if (stage.credentialRef === undefined) throw new TypeError("Voice credential staging lease is invalid");
      if (activeVoiceCredentialRefs(stored!.voice).has(stage.credentialRef)
        || stored!.voiceCleanup?.some((candidate) => candidate.credentialRef === stage.credentialRef)) {
        throw new Error("Voice credential staging lease is invalid");
      }
      if ((stored!.voiceCleanup?.length ?? 0) + (stored!.voiceStaging?.length ?? 0) >= MAX_PENDING_VOICE_CLEANUPS) {
        throw new Error("Setup voice cleanup backlog is full");
      }
      const voiceStaging = appendVoiceStage(stored!.voiceStaging, stage);
      if (voiceStaging.length === (stored!.voiceStaging?.length ?? 0)) return;
      await this.writeStored(Object.freeze({ ...stored!, voiceStaging }));
    });
  }

  /** Acknowledges an exact retired locator after a Hub-owned vault delete succeeds. */
  ackVoiceCleanupForMaintenance(stage: ProductVoiceSetupStage): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.loadStored();
      if (stored === undefined) return;
      await this.ackVoiceStageInStored(stored, validateVoiceStage(stored.draftId, stage), "cleanup");
    });
  }

  /** Acknowledges an exact staging lease after its provider attempt or cold-start recovery deletes it. */
  ackVoiceStaging(stage: ProductVoiceSetupStage): Promise<void> {
    return this.exclusive(async () => {
      const stored = await this.loadStored();
      if (stored === undefined) return;
      await this.ackVoiceStageInStored(stored, validateVoiceStage(stored.draftId, stage), "staging");
    });
  }

  /** Returns the exact, non-secret configuration that the verified map stage staged. */
  async activationCandidateForSession(sessionToken: string, expectedRevision: number): Promise<ProductBootstrapConfigDraft | undefined> {
    const token = boundedSessionToken(sessionToken);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return undefined;
    const stored = await this.loadStored();
    if (stored === undefined || this.now().getTime() >= Date.parse(stored.sessionExpiresAt)) return undefined;
    const expected = Buffer.from(stored.sessionDigest, "hex");
    const actual = digest(token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
      || stored.revision !== expectedRevision || stored.stage !== "map") return undefined;
    return activationCandidate(stored);
  }

  saveIdentity(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly householdName: string;
    readonly agentName: string;
  }): Promise<ProductSetupDraftProjection> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new TypeError("Setup draft revision is invalid");
      }
      const stored = await this.loadStored();
      if (stored === undefined || this.now().getTime() >= Date.parse(stored.sessionExpiresAt)) {
        throw new Error("Setup session expired");
      }
      const expectedDigest = Buffer.from(stored.sessionDigest, "hex");
      const actualDigest = digest(sessionToken);
      if (expectedDigest.length !== actualDigest.length || !timingSafeEqual(expectedDigest, actualDigest)) {
        throw new Error("Setup session unavailable");
      }
      if (stored.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      const updated: StoredSetupDraft = Object.freeze({
        ...stored,
        revision: stored.revision + 1,
        stage: "model",
        householdName: boundedName(input.householdName, "Household name"),
        agentName: boundedName(input.agentName, "Agent name"),
      });
      await this.writeStored(updated);
      return project(updated);
    });
  }

  recordModelProbe(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly stage: ProductModelSetupStage;
    readonly latencyMs: number;
  }): Promise<ProductSetupDraftProjection> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new TypeError("Setup draft revision is invalid");
      }
      if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 120_000) {
        throw new TypeError("Setup model probe latency is invalid");
      }
      const stored = await this.loadStored();
      requireActiveSession(stored, sessionToken, this.now());
      if (stored!.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      if (stored!.stage !== "model") throw new Error("Setup draft stage conflict");
      const model = validateModelStage(stored!.draftId, input.stage);
      const updated: StoredSetupDraft = Object.freeze({
        ...stored!,
        revision: stored!.revision + 1,
        stage: "bridge",
        model: model.projection,
        modelCredentialRef: model.credentialRef,
        modelProfileId: model.profileId,
        modelProbeLatencyMs: input.latencyMs,
      });
      await this.writeStored(updated);
      return project(updated);
    });
  }

  recordBridgeProbe(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly stage: ProductBridgeSetupStage;
    readonly latencyMs: number;
    readonly summary: { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number };
  }): Promise<ProductSetupDraftProjection> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new TypeError("Setup draft revision is invalid");
      if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 120_000) throw new TypeError("Setup bridge probe latency is invalid");
      const stored = await this.loadStored();
      requireActiveSession(stored, sessionToken, this.now());
      if (stored.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      if (stored.stage !== "bridge") throw new Error("Setup draft stage conflict");
      const bridge = validateBridgeStage(input.stage, input.summary);
      const updated: StoredSetupDraft = Object.freeze({
        ...stored,
        revision: stored.revision + 1,
        stage: "voice",
        bridge: bridge.projection,
        bridgeId: bridge.bridgeId,
        bridgeConfig: bridge.config,
        bridgeCredentialRefs: bridge.credentialRefs,
        bridgeProbeLatencyMs: input.latencyMs,
      });
      await this.writeStored(updated);
      return project(updated);
    });
  }

  /** Persists one successfully probed ASR or TTS track and reports a replaced stage for vault cleanup. */
  recordVoiceProbe(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly stage: ProductVoiceSetupStage;
    readonly latencyMs: number;
  }): Promise<{ readonly draft: ProductSetupDraftProjection; readonly replaced: readonly ProductVoiceSetupStage[] }> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new TypeError("Setup draft revision is invalid");
      if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 120_000) throw new TypeError("Setup voice probe latency is invalid");
      const stored = await this.loadStored();
      requireActiveSession(stored, sessionToken, this.now());
      if (stored.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      if (stored.stage !== "voice") throw new Error("Setup draft stage conflict");
      const stage = validateVoiceStage(stored.draftId, input.stage);
      if (stage.credentialRef !== undefined && !stored.voiceStaging?.some((candidate) => sameVoiceCleanupStage(candidate, stage))) {
        throw new Error("Voice credential staging lease is missing");
      }
      const replaced = stored.voice?.[stage.kind] === undefined ? [] : [voiceStage(stored.voice[stage.kind]!, stage.kind)];
      const voiceCleanup = appendVoiceCleanup(stored.voiceCleanup, replaced, stage.credentialRef);
      const voiceStaging = (stored.voiceStaging ?? []).filter((candidate) => !sameVoiceCleanupStage(candidate, stage));
      const voice = stage.kind === "asr"
        ? Object.freeze({ ...stored.voice, asr: voiceConfig(stage) as ProductBootstrapVoiceAsrConfig })
        : Object.freeze({ ...stored.voice, tts: voiceConfig(stage) as ProductBootstrapVoiceTtsConfig });
      const probeLatencyMs = Object.freeze({ ...stored.voiceProbeLatencyMs, [stage.kind]: input.latencyMs });
      const complete = voice.asr !== undefined && voice.tts !== undefined;
      const { voiceStaging: _voiceStaging, ...withoutVoiceStaging } = stored;
      const updated: StoredSetupDraft = Object.freeze({
        ...withoutVoiceStaging,
        revision: stored.revision + 1,
        stage: complete ? "map" : "voice",
        voice,
        voiceProbeLatencyMs: probeLatencyMs,
        ...(voiceCleanup.length === 0 ? {} : { voiceCleanup }),
        ...(voiceStaging.length === 0 ? {} : { voiceStaging: Object.freeze(voiceStaging) }),
      });
      await this.writeStored(updated);
      return Object.freeze({ draft: project(updated), replaced: Object.freeze(replaced) });
    });
  }

  /** Explicitly finishes optional voice setup and reports every staged track that the caller owns to discard. */
  skipVoice(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
  }): Promise<{ readonly draft: ProductSetupDraftProjection; readonly replaced: readonly ProductVoiceSetupStage[] }> {
    return this.exclusive(async () => {
      const sessionToken = boundedSessionToken(input.sessionToken);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new TypeError("Setup draft revision is invalid");
      const stored = await this.loadStored();
      requireActiveSession(stored, sessionToken, this.now());
      if (stored.revision !== input.expectedRevision) throw new Error("Setup draft revision conflict");
      if (stored.stage !== "voice") throw new Error("Setup draft stage conflict");
      if ((stored.voiceStaging?.length ?? 0) > 0) throw new Error("Setup voice credential staging is active");
      const replaced = stored.voice === undefined ? [] : [
        ...(stored.voice.asr === undefined ? [] : [voiceStage(stored.voice.asr, "asr")]),
        ...(stored.voice.tts === undefined ? [] : [voiceStage(stored.voice.tts, "tts")]),
      ];
      const voiceCleanup = appendVoiceCleanup(stored.voiceCleanup, replaced);
      const { voice: _voice, voiceProbeLatencyMs: _latencies, voiceSkipped: _skipped, voiceCleanup: _voiceCleanup, ...withoutVoice } = stored;
      const updated: StoredSetupDraft = Object.freeze({
        ...withoutVoice,
        revision: stored.revision + 1,
        stage: "map",
        voiceSkipped: true,
        ...(voiceCleanup.length === 0 ? {} : { voiceCleanup }),
      });
      await this.writeStored(updated);
      return Object.freeze({ draft: project(updated), replaced: Object.freeze(replaced) });
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(work, work);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadStored(): Promise<StoredSetupDraft | undefined> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (Buffer.byteLength(source) > MAX_DRAFT_BYTES) throw new Error("Setup draft exceeds its size limit");
    return validateStored(JSON.parse(source) as unknown);
  }

  private async writeStored(stored: StoredSetupDraft): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const source = `${JSON.stringify(stored)}\n`;
    if (Buffer.byteLength(source) > MAX_DRAFT_BYTES) throw new Error("Setup draft exceeds its size limit");
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(source, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temporaryPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    }
  }

  private async ackVoiceStageInStored(
    stored: StoredSetupDraft,
    stage: ProductVoiceSetupStage,
    kind: "cleanup" | "staging",
  ): Promise<void> {
    if (stage.credentialRef === undefined) throw new TypeError("Voice cleanup stage is invalid");
    const pending = kind === "cleanup" ? stored.voiceCleanup ?? [] : stored.voiceStaging ?? [];
    if (!pending.some((candidate) => sameVoiceCleanupStage(candidate, stage))) return;
    const remaining = pending.filter((candidate) => !sameVoiceCleanupStage(candidate, stage));
    const field = kind === "cleanup" ? "voiceCleanup" : "voiceStaging";
    const { [field]: _removed, ...withoutPending } = stored;
    const updated: StoredSetupDraft = Object.freeze({
      ...withoutPending,
      ...(remaining.length === 0 ? {} : { [field]: Object.freeze(remaining) }),
    });
    await this.writeStored(updated);
  }
}

function project(stored: StoredSetupDraft): ProductSetupDraftProjection {
  const voice = projectVoice(stored.voice, stored.voiceProbeLatencyMs);
  return Object.freeze({
    draftId: stored.draftId,
    revision: stored.revision,
    stage: stored.stage,
    ...(stored.householdName === undefined ? {} : { householdName: stored.householdName }),
    ...(stored.agentName === undefined ? {} : { agentName: stored.agentName }),
    ...(stored.model === undefined ? {} : { model: stored.model }),
    ...(stored.bridge === undefined ? {} : { bridge: stored.bridge }),
    ...(voice === undefined ? {} : { voice }),
    ...(stored.voiceSkipped === undefined ? {} : { voiceSkipped: true }),
  });
}

function projectVoice(
  voice: StoredSetupDraft["voice"],
  latencies: StoredSetupDraft["voiceProbeLatencyMs"],
): ProductSetupDraftProjection["voice"] | undefined {
  if (voice === undefined) return undefined;
  const asr = voice.asr === undefined ? undefined : Object.freeze({
    transport: voice.asr.transport,
    endpoint: voice.asr.endpoint,
    ...(voice.asr.model === undefined ? {} : { model: voice.asr.model }),
    probeLatencyMs: latencies?.asr,
  });
  const tts = voice.tts === undefined ? undefined : Object.freeze({
    transport: voice.tts.transport,
    endpoint: voice.tts.endpoint,
    locale: voice.tts.locale,
    ...(voice.tts.voice === undefined ? {} : { voice: voice.tts.voice }),
    ...(voice.tts.model === undefined ? {} : { model: voice.tts.model }),
    probeLatencyMs: latencies?.tts,
  });
  return Object.freeze({ ...(asr === undefined ? {} : { asr }), ...(tts === undefined ? {} : { tts }) }) as ProductSetupDraftProjection["voice"];
}

function validateStored(value: unknown): StoredSetupDraft {
  if (!isRecord(value) || (value.version !== DRAFT_VERSION && value.version !== LEGACY_DRAFT_VERSION)) throw new Error("Setup draft header is invalid");
  const legacy = value.version === LEGACY_DRAFT_VERSION;
  if (legacy && (value.stage === "voice" || hasOwn(value, "voice") || hasOwn(value, "voiceProbeLatencyMs")
    || hasOwn(value, "voiceSkipped") || hasOwn(value, "voiceCleanup") || hasOwn(value, "voiceStaging"))) {
    throw new Error("Setup voice evidence is invalid");
  }
  const draftId = validDraftId(value.draftId);
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error("Setup draft revision is invalid");
  if (value.stage !== "identity" && value.stage !== "model" && value.stage !== "bridge" && value.stage !== "voice" && value.stage !== "map") throw new Error("Setup draft stage is invalid");
  if (typeof value.sessionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.sessionDigest)) {
    throw new Error("Setup session digest is invalid");
  }
  if (typeof value.sessionExpiresAt !== "string" || !Number.isFinite(Date.parse(value.sessionExpiresAt))) {
    throw new Error("Setup session expiry is invalid");
  }
  const householdName = value.householdName === undefined ? undefined : boundedName(value.householdName, "Household name");
  const agentName = value.agentName === undefined ? undefined : boundedName(value.agentName, "Agent name");
  if ((value.stage === "model" || value.stage === "bridge" || value.stage === "voice" || value.stage === "map") && (householdName === undefined || agentName === undefined)) {
    throw new Error("Setup identity is incomplete");
  }
  const model = value.model === undefined ? undefined : validateStoredModel(value.model);
  const modelCredentialRef = value.modelCredentialRef === undefined ? undefined : boundedString(value.modelCredentialRef, 512, "Model credential reference");
  const modelProfileId = value.modelProfileId === undefined ? undefined : boundedString(value.modelProfileId, 256, "Model profile id");
  const modelProbeLatencyMs = value.modelProbeLatencyMs === undefined ? undefined : Number(value.modelProbeLatencyMs);
  const bridge = value.bridge === undefined ? undefined : validateStoredBridge(value.bridge);
  const bridgeId = value.bridgeId === undefined ? undefined : validBridgeId(value.bridgeId);
  const bridgeConfig = value.bridgeConfig === undefined ? undefined : validateBridgeConfig(value.bridgeConfig);
  const bridgeCredentialRefs = value.bridgeCredentialRefs === undefined ? undefined : validateBridgeCredentialRefs(bridgeId, value.bridgeCredentialRefs);
  const bridgeProbeLatencyMs = value.bridgeProbeLatencyMs === undefined ? undefined : Number(value.bridgeProbeLatencyMs);
  if ((value.stage === "bridge" || value.stage === "voice" || value.stage === "map") && (model === undefined || modelCredentialRef === undefined || modelProfileId === undefined
    || typeof modelProbeLatencyMs !== "number" || !Number.isSafeInteger(modelProbeLatencyMs)
    || modelProbeLatencyMs < 0 || modelProbeLatencyMs > 120_000)) {
    throw new Error("Setup model evidence is incomplete");
  }
  if (model !== undefined && modelCredentialRef !== undefined && modelProfileId !== undefined) {
    validateModelProfileEvidence(draftId, model, modelCredentialRef, modelProfileId);
  }
  if ((value.stage === "voice" || value.stage === "map") && (bridge === undefined || bridgeId === undefined || bridgeConfig === undefined || bridgeCredentialRefs === undefined
    || typeof bridgeProbeLatencyMs !== "number" || !Number.isSafeInteger(bridgeProbeLatencyMs)
    || bridgeProbeLatencyMs < 0 || bridgeProbeLatencyMs > 120_000)) {
    throw new Error("Setup bridge evidence is incomplete");
  }
  const voice = value.voice === undefined ? undefined : validateStoredVoice(draftId, value.voice);
  const voiceProbeLatencyMs = value.voiceProbeLatencyMs === undefined ? undefined : validateVoiceProbeLatencies(value.voiceProbeLatencyMs, voice);
  const voiceCleanup = value.voiceCleanup === undefined ? undefined : validateVoiceCleanup(draftId, value.voiceCleanup, MAX_PENDING_VOICE_CLEANUPS);
  const voiceStaging = value.voiceStaging === undefined ? undefined : validateVoiceCleanup(draftId, value.voiceStaging, MAX_VOICE_STAGING_LEASES);
  if ((voiceCleanup?.length ?? 0) + (voiceStaging?.length ?? 0) > MAX_PENDING_VOICE_CLEANUPS) {
    throw new Error("Setup voice cleanup is invalid");
  }
  const activeVoiceRefs = activeVoiceCredentialRefs(voice);
  if (voiceCleanup?.some((stage) => stage.credentialRef !== undefined && activeVoiceRefs.has(stage.credentialRef))
    || voiceStaging?.some((stage) => stage.credentialRef !== undefined && activeVoiceRefs.has(stage.credentialRef))
    || voiceCleanup?.some((stage) => voiceStaging?.some((candidate) => sameVoiceCleanupStage(candidate, stage)) ?? false)) {
    throw new Error("Setup voice cleanup is invalid");
  }
  const voiceSkipped = value.voiceSkipped === undefined
    ? legacy && value.stage === "map" && voice === undefined ? true : undefined
    : value.voiceSkipped === true ? true : invalidVoiceState();
  if (voiceSkipped !== undefined && voice !== undefined) throw new Error("Setup voice evidence is invalid");
  if (voiceStaging !== undefined && value.stage !== "voice") throw new Error("Setup voice credential staging is invalid");
  if (value.stage === "voice" && voiceSkipped !== undefined) throw new Error("Setup voice evidence is invalid");
  if (value.stage === "map" && !legacy && voiceSkipped === undefined && !completeVoice(voice)) {
    throw new Error("Setup voice evidence is incomplete");
  }
  if ((value.stage === "identity" || value.stage === "model" || value.stage === "bridge")
    && (voiceSkipped !== undefined || voice !== undefined || voiceProbeLatencyMs !== undefined)) {
    throw new Error("Setup voice evidence is invalid");
  }
  return Object.freeze({
    version: DRAFT_VERSION,
    draftId,
    revision: Number(value.revision),
    stage: value.stage,
    sessionDigest: value.sessionDigest,
    sessionExpiresAt: value.sessionExpiresAt,
    ...(householdName === undefined ? {} : { householdName }),
    ...(agentName === undefined ? {} : { agentName }),
    ...(model === undefined ? {} : { model }),
    ...(modelCredentialRef === undefined ? {} : { modelCredentialRef }),
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
    ...(modelProbeLatencyMs === undefined ? {} : { modelProbeLatencyMs }),
    ...(bridge === undefined ? {} : { bridge }),
    ...(bridgeId === undefined ? {} : { bridgeId }),
    ...(bridgeConfig === undefined ? {} : { bridgeConfig }),
    ...(bridgeCredentialRefs === undefined ? {} : { bridgeCredentialRefs }),
    ...(bridgeProbeLatencyMs === undefined ? {} : { bridgeProbeLatencyMs }),
    ...(voice === undefined ? {} : { voice }),
    ...(voiceProbeLatencyMs === undefined ? {} : { voiceProbeLatencyMs }),
    ...(voiceSkipped === undefined ? {} : { voiceSkipped }),
    ...(voiceCleanup === undefined ? {} : { voiceCleanup }),
    ...(voiceStaging === undefined ? {} : { voiceStaging }),
  });
}

function activationCandidate(stored: StoredSetupDraft): ProductBootstrapConfigDraft {
  if (stored.stage !== "map" || stored.householdName === undefined || stored.agentName === undefined
    || stored.model === undefined || stored.modelCredentialRef === undefined || stored.modelProfileId === undefined
    || stored.bridge === undefined || stored.bridgeId === undefined || stored.bridgeConfig === undefined || stored.bridgeCredentialRefs === undefined
    || stored.voiceStaging !== undefined) {
    throw new Error("Setup activation candidate is incomplete");
  }
  const modelProfile = validateModelProfileEvidence(
    stored.draftId,
    stored.model,
    stored.modelCredentialRef,
    stored.modelProfileId,
  );
  const voice = completeVoice(stored.voice) ? Object.freeze({ asr: stored.voice.asr, tts: stored.voice.tts }) : undefined;
  return Object.freeze({
    householdName: stored.householdName,
    agentName: stored.agentName,
    modelReference: `${stored.model.provider}/${stored.model.modelId}`,
    ...(stored.model.baseURL === undefined ? {} : { modelBaseURL: stored.model.baseURL }),
    modelProfile,
    bridges: Object.freeze([Object.freeze({
      bridgeId: stored.bridgeId,
      adapterType: stored.bridge.adapterType,
      config: stored.bridgeConfig,
      credentialRefs: stored.bridgeCredentialRefs,
    })]),
    ...(voice === undefined ? {} : { voice }),
  });
}

function validateStoredVoice(draftId: string, value: unknown): NonNullable<StoredSetupDraft["voice"]> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => key !== "asr" && key !== "tts")) throw new Error("Setup voice evidence is invalid");
  const asr = value.asr === undefined ? undefined : voiceConfig(validateVoiceStage(draftId, { ...(value.asr as Record<string, unknown>), kind: "asr" })) as ProductBootstrapVoiceAsrConfig;
  const tts = value.tts === undefined ? undefined : voiceConfig(validateVoiceStage(draftId, { ...(value.tts as Record<string, unknown>), kind: "tts" })) as ProductBootstrapVoiceTtsConfig;
  return Object.freeze({ ...(asr === undefined ? {} : { asr }), ...(tts === undefined ? {} : { tts }) });
}

function validateVoiceProbeLatencies(value: unknown, voice: StoredSetupDraft["voice"]): { readonly asr?: number; readonly tts?: number } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "asr" && key !== "tts")) throw new Error("Setup voice evidence is invalid");
  const asr = value.asr === undefined ? undefined : boundedProbeLatency(value.asr);
  const tts = value.tts === undefined ? undefined : boundedProbeLatency(value.tts);
  if ((voice?.asr === undefined) !== (asr === undefined) || (voice?.tts === undefined) !== (tts === undefined)) {
    throw new Error("Setup voice evidence is incomplete");
  }
  return Object.freeze({ ...(asr === undefined ? {} : { asr }), ...(tts === undefined ? {} : { tts }) });
}

function validateVoiceCleanup(draftId: string, value: unknown, maximum: number): readonly ProductVoiceSetupStage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error("Setup voice cleanup is invalid");
  }
  const seen = new Set<string>();
  const stages = value.map((candidate) => {
    const stage = validateVoiceStage(draftId, candidate);
    if (stage.credentialRef === undefined || seen.has(stage.credentialRef)) {
      throw new Error("Setup voice cleanup is invalid");
    }
    seen.add(stage.credentialRef);
    return stage;
  });
  return Object.freeze(stages);
}

function appendVoiceCleanup(
  pending: readonly ProductVoiceSetupStage[] | undefined,
  removed: readonly ProductVoiceSetupStage[],
  activeCredentialRef?: string,
): readonly ProductVoiceSetupStage[] {
  const cleanup = [...(pending ?? [])];
  const locators = new Set(cleanup.map((stage) => stage.credentialRef));
  for (const stage of removed) {
    if (stage.credentialRef === undefined || stage.credentialRef === activeCredentialRef || locators.has(stage.credentialRef)) continue;
    if (cleanup.length >= MAX_PENDING_VOICE_CLEANUPS) throw new Error("Setup voice cleanup backlog is full");
    cleanup.push(stage);
    locators.add(stage.credentialRef);
  }
  return Object.freeze(cleanup);
}

function appendVoiceStage(
  pending: readonly ProductVoiceSetupStage[] | undefined,
  stage: ProductVoiceSetupStage,
): readonly ProductVoiceSetupStage[] {
  if (stage.credentialRef === undefined) throw new TypeError("Voice credential staging lease is invalid");
  if (pending?.some((candidate) => sameVoiceCleanupStage(candidate, stage))) return pending;
  if ((pending?.length ?? 0) >= MAX_VOICE_STAGING_LEASES) throw new Error("Setup voice cleanup backlog is full");
  return Object.freeze([...(pending ?? []), stage]);
}

function activeVoiceCredentialRefs(voice: StoredSetupDraft["voice"] | undefined): ReadonlySet<string> {
  return new Set([
    voice?.asr?.credentialRef,
    voice?.tts?.credentialRef,
  ].filter((reference): reference is string => reference !== undefined));
}

function sameVoiceCleanupStage(left: ProductVoiceSetupStage, right: ProductVoiceSetupStage): boolean {
  if (left.kind !== right.kind || left.transport !== right.transport || left.endpoint !== right.endpoint
    || left.credentialRef !== right.credentialRef || left.model !== right.model) return false;
  return left.kind === "asr" || (right.kind === "tts" && left.locale === right.locale && left.voice === right.voice);
}

function boundedProbeLatency(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 120_000) throw new Error("Setup voice probe latency is invalid");
  return Number(value);
}

function invalidVoiceState(): never {
  throw new Error("Setup voice evidence is invalid");
}

function completeVoice(voice: StoredSetupDraft["voice"] | undefined): voice is ProductVoiceRuntimeConfig {
  return voice?.asr !== undefined && voice.tts !== undefined;
}

function validateVoiceStage(draftId: string, value: unknown): ProductVoiceSetupStage {
  if (!isRecord(value) || (value.kind !== "asr" && value.kind !== "tts")) throw new TypeError("Voice setup stage is invalid");
  const allowed = value.kind === "asr"
    ? ["kind", "transport", "endpoint", "credentialRef", "model"]
    : ["kind", "transport", "endpoint", "credentialRef", "locale", "voice", "model"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("Voice setup stage is invalid");
  const transport = voiceTransport(value.transport);
  const credentialRef = value.credentialRef === undefined ? undefined : voiceCredentialRef(draftId, value.kind, value.credentialRef);
  const endpoint = voiceEndpoint(transport, value.endpoint, credentialRef !== undefined);
  if (transport === "wyoming" && credentialRef !== undefined) throw new TypeError("Voice setup stage is invalid");
  const model = value.model === undefined ? undefined : voiceLabel(value.model);
  if (value.kind === "asr") {
    return Object.freeze({ kind: "asr", transport, endpoint, ...(credentialRef === undefined ? {} : { credentialRef }), ...(model === undefined ? {} : { model }) });
  }
  const locale = voiceLocale(value.locale);
  const voice = value.voice === undefined ? undefined : voiceLabel(value.voice);
  if (transport === "wyoming" && model !== undefined) throw new TypeError("Voice setup stage is invalid");
  return Object.freeze({ kind: "tts", transport, endpoint, ...(credentialRef === undefined ? {} : { credentialRef }), locale, ...(voice === undefined ? {} : { voice }), ...(model === undefined ? {} : { model }) });
}

function voiceConfig(stage: ProductVoiceSetupStage): ProductBootstrapVoiceAsrConfig | ProductBootstrapVoiceTtsConfig {
  if (stage.kind === "asr") {
    return Object.freeze({ transport: stage.transport, endpoint: stage.endpoint, ...(stage.credentialRef === undefined ? {} : { credentialRef: stage.credentialRef }), ...(stage.model === undefined ? {} : { model: stage.model }) });
  }
  return Object.freeze({ transport: stage.transport, endpoint: stage.endpoint, ...(stage.credentialRef === undefined ? {} : { credentialRef: stage.credentialRef }), locale: stage.locale, ...(stage.voice === undefined ? {} : { voice: stage.voice }), ...(stage.model === undefined ? {} : { model: stage.model }) });
}

function voiceStage(value: ProductBootstrapVoiceAsrConfig | ProductBootstrapVoiceTtsConfig, kind: "asr" | "tts"): ProductVoiceSetupStage {
  if (kind === "asr") {
    return Object.freeze({ kind, transport: value.transport, endpoint: value.endpoint, ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef }), ...(value.model === undefined ? {} : { model: value.model }) });
  }
  if (!("locale" in value)) throw new Error("Setup voice evidence is invalid");
  return Object.freeze({ kind, transport: value.transport, endpoint: value.endpoint, ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef }), locale: value.locale, ...(value.voice === undefined ? {} : { voice: value.voice }), ...(value.model === undefined ? {} : { model: value.model }) });
}

function voiceTransport(value: unknown): "wyoming" | "openai_http" {
  if (value !== "wyoming" && value !== "openai_http") throw new TypeError("Voice setup stage is invalid");
  return value;
}

function voiceEndpoint(transport: "wyoming" | "openai_http", value: unknown, hasCredential: boolean): string {
  try {
    return normalizePrivateVoiceEndpoint(transport, value, { hasCredential });
  } catch {
    throw new TypeError("Voice setup stage is invalid");
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function voiceCredentialRef(draftId: string, kind: "asr" | "tts", value: unknown): string {
  const reference = boundedString(value, 512, "Voice credential reference");
  if (!new RegExp(`^keychain:hob-agent/voice:${kind}:${draftId}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, "u").test(reference)) {
    throw new TypeError("Voice setup stage is invalid");
  }
  return reference;
}

function voiceLocale(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Voice setup stage is invalid");
  try {
    const [locale] = Intl.getCanonicalLocales(value.trim());
    if (locale === undefined || locale.length > 35) throw new TypeError("Voice setup stage is invalid");
    return locale;
  } catch {
    throw new TypeError("Voice setup stage is invalid");
  }
}

function voiceLabel(value: unknown): string {
  const label = boundedString(value, 128, "Voice label");
  if (/[\u0000-\u001f\u007f]/u.test(label)) throw new TypeError("Voice setup stage is invalid");
  return label;
}

function validateBridgeStage(stage: ProductBridgeSetupStage, summary: {
  readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number;
}): {
  readonly projection: NonNullable<ProductSetupDraftProjection["bridge"]>;
  readonly bridgeId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
} {
  const adapterType = boundedBridgeAdapterType(stage.adapterType);
  const label = boundedBridgeLabel(stage.label);
  const bridgeId = validBridgeId(stage.bridgeId);
  const config = validateBridgeConfig(stage.config);
  const credentialRefs = validateBridgeCredentialRefs(bridgeId, stage.credentialRefs);
  const counts = validateBridgeSummary(summary);
  return {
    projection: Object.freeze({
      adapterType,
      label,
      ...(stage.endpoint === undefined ? {} : { endpoint: boundedBridgeEndpoint(stage.endpoint) }),
      summary: counts,
    }),
    bridgeId,
    config,
    credentialRefs,
  };
}

function validateModelProfileEvidence(
  draftId: string,
  model: NonNullable<ProductSetupDraftProjection["model"]>,
  credentialRef: string,
  profileId: string,
): ProductBootstrapConfigDraft["modelProfile"] {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(model.provider) || /\s/u.test(model.modelId)
    || profileId !== `${model.provider}:setup:${draftId}`
    || !new RegExp(`^keychain:hob-agent/setup-model:${draftId}:[A-Za-z0-9_-]+$`, "u").test(credentialRef)) {
    throw new Error("Setup model evidence is invalid");
  }
  return Object.freeze({ id: profileId, provider: model.provider, kind: "api_key", secretRef: credentialRef });
}

function validBridgeId(value: unknown): string {
  if (typeof value !== "string" || !/^bridge-[a-f0-9]{16}$/u.test(value)) {
    throw new TypeError("Setup bridge id is invalid");
  }
  return value;
}

function boundedBridgeAdapterType(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError("Setup bridge adapter type is invalid");
  return value;
}

function boundedBridgeLabel(value: unknown): string {
  const label = boundedString(value, 128, "Setup bridge label");
  if (/[\u0000-\u001f\u007f]/u.test(label)) throw new TypeError("Setup bridge label is invalid");
  return label;
}

function boundedBridgeEndpoint(value: unknown): string {
  const endpoint = boundedString(value, 2_048, "Setup bridge endpoint");
  if (/[\u0000-\u001f\u007f]/u.test(endpoint)) throw new TypeError("Setup bridge endpoint is invalid");
  return endpoint;
}

function validateBridgeConfig(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Setup bridge config is invalid");
  }
  return cloneJsonObject(value);
}

function validateBridgeCredentialRefs(bridgeId: unknown, value: unknown): Readonly<Record<string, string>> {
  const id = validBridgeId(bridgeId);
  if (!isRecord(value) || Object.keys(value).length !== 1) throw new TypeError("Setup bridge credential references are invalid");
  const refs: Record<string, string> = {};
  for (const [alias, rawReference] of Object.entries(value)) {
    const reference = boundedString(rawReference, 512, "Bridge credential reference");
    if (!IDENTIFIER.test(alias) || reference !== `keychain:hob-agent/bridge:${id}:${alias}`) {
      throw new TypeError("Setup bridge credential references are invalid");
    }
    refs[alias] = reference;
  }
  return Object.freeze(refs);
}

function cloneJsonObject(value: Record<string, unknown>, depth = 0): Readonly<Record<string, unknown>> {
  if (depth > 12 || Object.keys(value).length > 256) throw new TypeError("Setup bridge config is invalid");
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128 || SECRET_KEY.test(key)) throw new TypeError("Setup bridge config is invalid");
    output[key] = cloneJsonValue(child, depth + 1);
  }
  return Object.freeze(output);
}

function cloneJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000 || depth > 12) throw new TypeError("Setup bridge config is invalid");
    return Object.freeze(value.map((entry) => cloneJsonValue(entry, depth + 1)));
  }
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return cloneJsonObject(value, depth);
  }
  throw new TypeError("Setup bridge config is invalid");
}

function validateStoredBridge(value: unknown): NonNullable<ProductSetupDraftProjection["bridge"]> {
  if (!isRecord(value)) {
    throw new Error("Setup bridge selection is invalid");
  }
  return Object.freeze({
    adapterType: boundedBridgeAdapterType(value.adapterType),
    label: boundedBridgeLabel(value.label),
    ...(value.endpoint === undefined ? {} : { endpoint: boundedBridgeEndpoint(value.endpoint) }),
    summary: validateBridgeSummary(value.summary),
  });
}

function validateBridgeSummary(value: unknown): { readonly states: number; readonly entities: number; readonly devices: number; readonly areas: number } {
  if (!isRecord(value)) throw new TypeError("Setup bridge summary is invalid");
  const output = {} as Record<"states" | "entities" | "devices" | "areas", number>;
  for (const key of ["states", "entities", "devices", "areas"] as const) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 100_000) throw new TypeError("Setup bridge summary is invalid");
    output[key] = Number(count);
  }
  return Object.freeze(output);
}

function requireActiveSession(stored: StoredSetupDraft | undefined, sessionToken: string, now: Date): asserts stored is StoredSetupDraft {
  if (stored === undefined || now.getTime() >= Date.parse(stored.sessionExpiresAt)) throw new Error("Setup session expired");
  const expected = Buffer.from(stored.sessionDigest, "hex");
  const actual = digest(sessionToken);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Setup session unavailable");
}

function validateModelStage(draftId: string, stage: ProductModelSetupStage): {
  readonly projection: NonNullable<ProductSetupDraftProjection["model"]>;
  readonly credentialRef: string;
  readonly profileId: string;
} {
  const provider = boundedString(stage.profile.provider, 64, "Model provider");
  const profileId = boundedString(stage.profile.id, 256, "Model profile id");
  const credentialRef = boundedString(stage.profile.secretRef, 512, "Model credential reference");
  if (stage.profile.kind !== "api_key" || profileId !== `${provider}:setup:${draftId}`
    || !credentialRef.startsWith(`keychain:hob-agent/setup-model:${draftId}:`)) {
    throw new TypeError("Setup model stage is invalid");
  }
  const modelId = boundedString(stage.modelId, 256, "Model id");
  const baseURL = stage.baseURL === undefined ? undefined : customModelBaseURL(provider, stage.baseURL);
  return {
    projection: Object.freeze({ provider, modelId, ...(baseURL === undefined ? {} : { baseURL }) }),
    credentialRef,
    profileId,
  };
}

function validateStoredModel(value: unknown): NonNullable<ProductSetupDraftProjection["model"]> {
  if (!isRecord(value)) throw new Error("Setup model selection is invalid");
  const provider = boundedString(value.provider, 64, "Model provider");
  const modelId = boundedString(value.modelId, 256, "Model id");
  const baseURL = value.baseURL === undefined ? undefined : customModelBaseURL(provider, value.baseURL);
  return Object.freeze({ provider, modelId, ...(baseURL === undefined ? {} : { baseURL }) });
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function customModelBaseURL(provider: string, value: unknown): string {
  if (provider !== "custom") throw new TypeError("Model endpoint is invalid");
  try {
    return validateCustomModelBaseURL(boundedString(value, 2_048, "Model endpoint"));
  } catch {
    throw new TypeError("Model endpoint is invalid");
  }
}

function validDraftId(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError("Setup draft id is invalid");
  return value;
}

function boundedSessionToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 512) throw new TypeError("Setup session token is invalid");
  return value;
}

function boundedName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 40 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
