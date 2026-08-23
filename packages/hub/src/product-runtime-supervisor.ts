import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  MacOSKeychainSecretVault,
  type WritableSecretVault,
} from "@hob-agent/agent-layer/model-credentials";
import {
  ProductSetupHttpService,
  type ProductSetupDraftPort,
} from "@hob-agent/inbox-web/setup";
import { ProductHttpHost } from "@hob-agent/inbox-web/product-http-host";
import type {
  InboxAuthenticationRequest,
  InboxRequestAuthenticator,
  ProductSessionRecoveryPort,
} from "@hob-agent/inbox-web/http";

import type { HomeHubRuntime } from "./process-entry.js";
import {
  ProductActivationController,
  type ProductActivationResult,
} from "./product-activation-controller.js";
import {
  ProductBootstrapConfigStore,
  type ProductBootstrapConfigDraft,
  type ProductBootstrapConfiguration,
} from "./product-bootstrap-config-store.js";
import { ProductSetupController } from "./product-setup-controller.js";
import { ProductSetupDraftStore } from "./product-setup-draft-store.js";
import { ProductSessionStore } from "./product-session-store.js";
import {
  ProductVoiceSetupService,
  type ProductVoiceSetupOptions,
} from "./product-voice-setup.js";
import { ProductOperationalVoiceSettings } from "./product-operational-voice-settings.js";
import { ProductVoiceCleanupLedger, type ProductVoiceCleanupEntry } from "./product-voice-cleanup-ledger.js";
import { PrivateVoiceGateway } from "./voice/private-voice-gateway.js";
import { PrivateVoiceProviderRuntime } from "./voice/private-voice-provider-runtime.js";

const PRODUCT_SESSION_COOKIE = "hob_product_session";
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEFAULT_PRODUCT_SETUP_PORT = 8787;
export const PRODUCT_PAIRING_TTL_MS = 10 * 60 * 1_000;
export const PRODUCT_OPERATIONAL_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const PRODUCT_SESSION_PRINCIPAL_ID = "household-owner";
const PRODUCT_SESSION_DEVICE_ID = "setup-browser";

export interface ProductSetupAnnouncement {
  readonly origin: string;
  readonly pairingCode: string;
  readonly expiresAt: Date;
}

export interface ProductSessionRecoveryAnnouncement {
  readonly origin: string;
  readonly pairingCode: string;
  readonly expiresAt: Date;
}

/** A mounted operational product takes ownership of its HTTP surface only after configuration commits. */
export interface RuntimeProductBundle {
  attach(): void;
  dispose(): Promise<void>;
}

/** All operational resources mount below the supervisor's one product root. */
export interface ProductRuntimeOperationalMountInput {
  readonly candidate: ProductBootstrapConfigDraft;
  readonly context: Context;
  readonly host: ProductHttpHost;
  readonly authenticateProductSession: InboxRequestAuthenticator;
  /** One-time local recovery authority scoped to this active product generation. */
  readonly recoverProductSession: ProductSessionRecoveryPort;
  /** Stable provider-neutral ASR/TTS boundary for this exact operational bundle. */
  readonly privateVoice: PrivateVoiceGateway;
  /** Operational configuration owner backed by this bundle's exact voice gateway and credential ledger. */
  readonly voiceSettings: ProductOperationalVoiceSettings;
}

/** Setup drafts additionally provide an exact, verified activation candidate. */
export interface ProductRuntimeSetupDrafts extends ProductSetupDraftPort {
  activationCandidateForSession(
    sessionToken: string,
    expectedRevision: number,
  ): Promise<ProductBootstrapConfigDraft | undefined>;
  /** Runs one bounded pass over retired setup credentials when this owner supports maintenance. */
  sweepVoiceCredentialCleanup?(): Promise<void>;
  /** Runs once during cold start before either setup or operational HTTP surfaces attach. */
  recoverVoiceCredentialStaging?(): Promise<void>;
}

interface ProductRuntimeConfigurationStore {
  load(): Promise<ProductBootstrapConfiguration | undefined>;
  commit: ProductBootstrapConfigStore["commit"];
  commitVoice: ProductBootstrapConfigStore["commitVoice"];
}

interface ProductRuntimeSessionStore {
  create: ProductSessionStore["create"];
  authenticate: ProductSessionStore["authenticate"];
  rotate: ProductSessionStore["rotate"];
  remove: ProductSessionStore["remove"];
  clearForSetup: ProductSessionStore["clearForSetup"];
}

export interface ProductRuntimeSupervisorOptions {
  readonly dataDirectory: string;
  readonly port: number;
  readonly now?: () => Date;
  readonly pairingCode?: string;
  readonly createSessionToken?: () => string;
  /** Generates the token that replaces the expiring setup cookie after activation. */
  readonly createOperationalSessionToken?: () => string;
  /** Test seam for the local recovery code generated for each active runtime. */
  readonly createRecoveryPairingCode?: () => string;
  /** Long-lived local browser pairing lifetime. The server retains no plaintext token. */
  readonly operationalSessionTtlMs?: number;
  readonly announce?: (announcement: ProductSetupAnnouncement) => void;
  /** Announces the short-lived local recovery code after the product becomes active. */
  readonly announceRecovery?: (announcement: ProductSessionRecoveryAnnouncement) => void;
  /** Provider-neutral ASR/TTS setup capability. It remains idle until a caller probes a track. */
  readonly voiceSetup?: ProductVoiceSetupOptions;
  /** Test seam and one durable owner for paired setup progress. */
  readonly setupDrafts?: ProductRuntimeSetupDrafts;
  /** Test seam and the single durable active-generation owner. */
  readonly configurationStore?: ProductRuntimeConfigurationStore;
  /** Test seam for the durable owner of the active local browser pairing. */
  readonly productSessions?: ProductRuntimeSessionStore;
  /** Mounts an already verified candidate into this root's child fiber. */
  readonly mountOperational: (input: ProductRuntimeOperationalMountInput) => Promise<RuntimeProductBundle | undefined>;
}

export type ProductRuntimeMode = "setup" | "operational";

/**
 * The single process composition root for first-run setup and the operational
 * household product. It owns one Cordis tree and one local HTTP listener.
 */
export class ProductRuntimeSupervisor implements HomeHubRuntime {
  readonly context = new Context();
  private readonly now: () => Date;
  private readonly voiceCredentialVault: WritableSecretVault;
  private readonly setupDraftStore: ProductSetupDraftStore | undefined;
  private setupDrafts: ProductRuntimeSetupDrafts | undefined;
  private readonly configurationStore: ProductRuntimeConfigurationStore;
  private readonly productSessions: ProductRuntimeSessionStore;
  private readonly voiceCleanupLedger: ProductVoiceCleanupLedger;
  private readonly host: ProductHttpHost;
  private readonly activation: ProductActivationController<
    { readonly sessionExpiresAt: Date },
    { readonly operationalSessionToken: string },
    RuntimeProductBundle
  >;
  private activeBundle: RuntimeProductBundle | undefined;
  private setupFiber: Fiber | undefined;
  private setupSurface: ProductSetupHttpService | undefined;
  private statusValue: "created" | "starting" | "running" | "stopping" | "stopped" = "created";
  private stopTask: Promise<void> | undefined;
  private modeValue: ProductRuntimeMode = "setup";
  private pendingRecoveryAnnouncement: ProductSessionRecoveryAnnouncement | undefined;

  constructor(private readonly options: ProductRuntimeSupervisorOptions) {
    this.now = options.now ?? (() => new Date());
    this.voiceCredentialVault = options.voiceSetup?.vault ?? new MacOSKeychainSecretVault();
    this.setupDrafts = options.setupDrafts;
    this.setupDraftStore = options.setupDrafts === undefined
      ? new ProductSetupDraftStore(options.dataDirectory, this.now)
      : undefined;
    this.configurationStore = options.configurationStore ?? new ProductBootstrapConfigStore(options.dataDirectory, this.now);
    this.productSessions = options.productSessions ?? new ProductSessionStore(options.dataDirectory, this.now);
    this.voiceCleanupLedger = new ProductVoiceCleanupLedger(options.dataDirectory, this.now);
    this.host = new ProductHttpHost({ port: options.port });
    this.activation = new ProductActivationController({
      configurationStore: this.configurationStore,
      mountCandidate: (candidate) => this.mountOperationalCandidate(candidate),
      commitParticipant: {
        acquire: async ({ context }) => {
          const sessionExpiresAt = new Date(this.now().getTime() + operationalSessionTtlMs(this.options.operationalSessionTtlMs));
          await this.productSessions.create({
            token: context.operationalSessionToken,
            principalId: PRODUCT_SESSION_PRINCIPAL_ID,
            deviceId: PRODUCT_SESSION_DEVICE_ID,
            expiresAt: sessionExpiresAt,
          });
          return {
            receipt: Object.freeze({ sessionExpiresAt }),
            rollback: () => this.productSessions.remove(context.operationalSessionToken),
          };
        },
      },
    });
  }

  get origin(): string { return this.host.origin; }
  get mode(): ProductRuntimeMode { return this.modeValue; }
  get status(): "created" | "starting" | "running" | "stopping" | "stopped" { return this.statusValue; }

  async start(): Promise<void> {
    if (this.statusValue !== "created") {
      throw new Error(`Product runtime supervisor cannot start from ${this.statusValue} state`);
    }
    this.statusValue = "starting";
    try {
      const active = await this.configurationStore.load();
      await this.recoverOperationalVoiceCleanup(active).catch(() => undefined);
      await this.host.listen();
      await this.context.plugin(ProductVoiceSetupService, {
        ...this.options.voiceSetup,
        vault: this.voiceCredentialVault,
      });
      if (this.setupDrafts === undefined) {
        const store = this.setupDraftStore;
        if (store === undefined) throw new Error("Product setup draft owner is unavailable");
        this.setupDrafts = new ProductSetupController(
          store,
          undefined,
          undefined,
          this.context.productVoiceSetup,
        );
      }
      await this.recoverVoiceCredentialStaging();
      await this.sweepVoiceCredentialCleanup();
      if (active === undefined) {
        await this.productSessions.clearForSetup();
        await this.mountSetupSurface();
      } else {
        await this.mountActiveConfiguration(active);
      }
      this.statusValue = "running";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped") return;
    if (this.stopTask !== undefined) return this.stopTask;
    this.statusValue = "stopping";
    this.stopTask = this.disposeRuntime();
    return this.stopTask;
  }

  private async mountSetupSurface(): Promise<void> {
    const pairingCode = this.options.pairingCode ?? createPairingCode();
    const expiresAt = new Date(this.now().getTime() + PRODUCT_PAIRING_TTL_MS);
    this.setupFiber = await this.context.plugin(async (setupContext: Context) => {
      await setupContext.plugin(ProductSetupHttpService, {
        host: this.host,
        pairingCode,
        pairingExpiresAt: expiresAt,
        now: this.now,
        createSessionToken: this.options.createSessionToken ?? (() => randomBytes(32).toString("base64url")),
        createOperationalSessionToken: this.options.createOperationalSessionToken ?? (() => randomBytes(32).toString("base64url")),
        setupDrafts: this.requireSetupDrafts(),
        activation: { activate: (input) => this.activate(input) },
      });
      const setup = setupContext.get("productSetupHttp") as ProductSetupHttpService | undefined;
      if (setup === undefined) throw new Error("Product setup surface is unavailable");
      this.setupSurface = setup;
      setup.attach();
    });
    this.options.announce?.({ origin: this.host.origin, pairingCode, expiresAt });
    this.modeValue = "setup";
  }

  private async mountActiveConfiguration(configuration: ProductBootstrapConfiguration): Promise<void> {
    const mounted = await this.mountOperationalCandidate(configuration);
    if (mounted === undefined) throw new Error("Active household product is unavailable");
    try {
      mounted.attach();
    } catch (error) {
      await mounted.dispose().catch(() => undefined);
      throw error;
    }
    this.activeBundle = mounted;
    this.modeValue = "operational";
    this.announcePendingRecovery();
  }

  private async activate(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
    readonly operationalSessionToken?: string;
  }): Promise<
    | { readonly status: "activated"; readonly sessionExpiresAt: Date }
    | { readonly status: "busy" | "conflict" | "unavailable" }
  > {
    const candidate = await this.requireSetupDrafts().activationCandidateForSession(
      input.sessionToken,
      input.expectedRevision,
    );
    if (candidate === undefined) return { status: "conflict" };
    if (input.operationalSessionToken === undefined) return { status: "unavailable" };
    const current = await this.configurationStore.load();
    const result = await this.activation.activate({
      draft: candidate,
      expectedGeneration: current?.generation ?? 0,
      context: { operationalSessionToken: input.operationalSessionToken },
    });
    if (result.status !== "activated") return result;
    if (!await this.finishActivation(result)) return { status: "unavailable" };
    return { status: "activated", sessionExpiresAt: result.receipt!.sessionExpiresAt };
  }

  private async finishActivation(result: Extract<ProductActivationResult<
    { readonly sessionExpiresAt: Date },
    RuntimeProductBundle
  >, { readonly status: "activated" }>): Promise<boolean> {
    try {
      result.mounted.attach();
    } catch {
      await result.mounted.dispose().catch(() => undefined);
      try {
        const committed = await this.configurationStore.load();
        if (committed === undefined) return false;
        await this.mountActiveConfiguration(committed);
      } catch {
        return false;
      }
      await this.disposeSetupSurface().catch(() => undefined);
      return true;
    }
    this.activeBundle = result.mounted;
    this.modeValue = "operational";
    this.announcePendingRecovery();
    // The product handler is already attached before this cleanup begins. A
    // fiber-disposal failure cannot revoke its committed configuration/session
    // or suppress the cookie receipt needed to reach that live handler.
    await this.disposeSetupSurface().catch(() => undefined);
    await this.sweepVoiceCredentialCleanup();
    return true;
  }

  private async sweepVoiceCredentialCleanup(): Promise<void> {
    if (this.setupDrafts?.sweepVoiceCredentialCleanup === undefined) return;
    await this.setupDrafts.sweepVoiceCredentialCleanup().catch(() => undefined);
  }

  private async recoverVoiceCredentialStaging(): Promise<void> {
    if (this.setupDrafts?.recoverVoiceCredentialStaging === undefined) return;
    await this.setupDrafts.recoverVoiceCredentialStaging().catch(() => undefined);
  }

  private readonly authenticateProductSession: InboxRequestAuthenticator = async (
    request: InboxAuthenticationRequest,
  ): Promise<boolean> => {
    const token = cookieValue(request.cookie, PRODUCT_SESSION_COOKIE);
    return token !== undefined && await this.productSessions.authenticate(token) !== undefined;
  };

  private requireSetupDrafts(): ProductRuntimeSetupDrafts {
    if (this.setupDrafts === undefined) throw new Error("Product setup draft owner is unavailable");
    return this.setupDrafts;
  }

  private async mountOperationalCandidate(
    candidate: ProductBootstrapConfigDraft,
  ): Promise<RuntimeProductBundle | undefined> {
    const recovery = this.createSessionRecovery();
    const configGeneration = await this.operationalGeneration(candidate);
    let provider: PrivateVoiceProviderRuntime | undefined;
    if (candidate.voice !== undefined) {
      provider = new PrivateVoiceProviderRuntime({
        config: candidate.voice,
        vault: this.voiceCredentialVault,
      });
      await provider.start();
    }
    const privateVoice = provider === undefined
      ? new PrivateVoiceGateway()
      : new PrivateVoiceGateway({
          configGeneration,
          providerGeneration: `${candidate.modelProfile.id}:${configGeneration}`,
          runtime: provider,
        });
    const voiceSettings = new ProductOperationalVoiceSettings({
      configurationStore: this.configurationStore,
      gateway: privateVoice,
      voiceSetup: this.context.productVoiceSetup,
      cleanupLedger: this.voiceCleanupLedger,
      vault: this.voiceCredentialVault,
      createCandidateId: () => `v${randomBytes(24).toString("base64url")}`,
      createProviderRuntime: (config) => new PrivateVoiceProviderRuntime({
        config,
        vault: this.voiceCredentialVault,
      }),
    });

    let mounted: RuntimeProductBundle | undefined;
    try {
      mounted = await this.options.mountOperational({
        candidate,
        context: this.context,
        host: this.host,
        authenticateProductSession: this.authenticateProductSession,
        recoverProductSession: recovery.port,
        privateVoice,
        voiceSettings,
      });
    } catch (error) {
      await privateVoice.dispose({ force: true });
      throw error;
    }
    if (mounted === undefined) {
      await privateVoice.dispose({ force: true });
      return undefined;
    }
    this.pendingRecoveryAnnouncement = recovery.announcement;
    return operationalBundleWithPrivateVoice(mounted, privateVoice);
  }

  private async operationalGeneration(candidate: ProductBootstrapConfigDraft): Promise<number> {
    if (isCommittedConfiguration(candidate)) return candidate.generation;
    return ((await this.configurationStore.load())?.generation ?? 0) + 1;
  }

  /** Reconciles metadata-only ownership before HTTP surfaces attach, then makes one bounded cleanup pass. */
  private async recoverOperationalVoiceCleanup(configuration: ProductBootstrapConfiguration | undefined): Promise<void> {
    const activeRefs = activeVoiceCredentialRefs(configuration);
    for (const owner of activeVoiceCredentialOwners(configuration)) {
      try {
        await this.voiceCleanupLedger.adoptCommitted(owner);
      } catch {
        // Existing ledger facts retain authority; a later settings operation
        // can retry exact adoption without delaying the household product.
      }
    }
    for (const entry of (await this.voiceCleanupLedger.load()).entries) {
      try {
        if (entry.phase === "staged") {
          if (configuration !== undefined
            && entry.expectedGeneration + 1 === configuration.generation
            && activeRefs.has(entry.credentialRef)) {
            await this.voiceCleanupLedger.markCommitted({
              candidateId: entry.candidateId,
              track: entry.track,
              credentialRef: entry.credentialRef,
              expectedGeneration: entry.expectedGeneration,
              committedGeneration: configuration.generation,
            });
          } else {
            await this.voiceCleanupLedger.abandonStaged(entry);
          }
        } else if (entry.phase === "active" && !activeVoiceEntryOwnsConfiguration(entry, configuration, activeRefs)) {
          await this.voiceCleanupLedger.retire({
            candidateId: entry.candidateId,
            track: entry.track,
            credentialRef: entry.credentialRef,
            committedGeneration: entry.committedGeneration!,
          });
        }
      } catch {
        // A later bounded recovery pass retains authority over an unmodified record.
      }
    }
    for (const entry of await this.voiceCleanupLedger.listPending({ limit: 16 })) {
      if (activeRefs.has(entry.credentialRef)) continue;
      try {
        await this.voiceCleanupLedger.markCleanupAttempt(entry);
        await this.voiceCredentialVault.delete(entry.credentialRef);
        await this.voiceCleanupLedger.acknowledge(entry);
      } catch {
        // Vault maintenance never prevents text product availability.
      }
    }
  }

  private createSessionRecovery(): {
    readonly port: ProductSessionRecoveryPort;
    readonly announcement: ProductSessionRecoveryAnnouncement;
  } {
    const pairingCode = this.options.createRecoveryPairingCode?.() ?? createPairingCode();
    const normalizedPairingCode = typeof pairingCode === "string" ? normalizePairingCode(pairingCode) : "";
    if (normalizedPairingCode.length < 6 || normalizedPairingCode.length > 32) throw new TypeError("Product recovery pairing code must contain 6 to 32 characters");
    const expectedDigest = createHash("sha256").update(normalizedPairingCode, "utf8").digest();
    const expiresAt = new Date(this.now().getTime() + PRODUCT_PAIRING_TTL_MS);
    let consumed = false;
    let mutation: Promise<void> = Promise.resolve();
    const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = mutation;
      let release: (() => void) | undefined;
      mutation = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation();
      } finally {
        release?.();
      }
    };
    return Object.freeze({
      announcement: Object.freeze({ origin: this.host.origin, pairingCode, expiresAt }),
      port: Object.freeze({
        recover: (code: string) => exclusive(async () => {
          if (consumed || this.now().getTime() >= expiresAt.getTime() || !sameRecoveryCode(expectedDigest, code)) {
            return { status: "invalid" as const };
          }
          const sessionToken = (this.options.createOperationalSessionToken ?? (() => randomBytes(32).toString("base64url")))();
          const sessionExpiresAt = new Date(this.now().getTime() + operationalSessionTtlMs(this.options.operationalSessionTtlMs));
          try {
            await this.productSessions.rotate({ token: sessionToken, expiresAt: sessionExpiresAt });
          } catch {
            return { status: "unavailable" as const };
          }
          consumed = true;
          return Object.freeze({ status: "recovered" as const, sessionToken, expiresAt: sessionExpiresAt });
        }),
      }),
    });
  }

  private announcePendingRecovery(): void {
    const announcement = this.pendingRecoveryAnnouncement;
    this.pendingRecoveryAnnouncement = undefined;
    if (announcement === undefined) return;
    this.options.announceRecovery?.(announcement);
  }

  private async disposeSetupSurface(): Promise<void> {
    this.setupSurface?.detach();
    this.setupSurface = undefined;
    const fiber = this.setupFiber;
    this.setupFiber = undefined;
    await fiber?.dispose();
  }

  private async disposeRuntime(): Promise<void> {
    let failure: unknown;
    try {
      await this.disposeSetupSurface();
    } catch (error) {
      failure = error;
    }
    try {
      await this.activeBundle?.dispose();
    } catch (error) {
      failure ??= error;
    } finally {
      this.activeBundle = undefined;
    }
    try {
      await this.context.fiber.dispose();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.host.dispose();
    } catch (error) {
      failure ??= error;
    } finally {
      this.statusValue = "stopped";
    }
    if (failure !== undefined) throw failure;
  }
}

export async function startProductRuntimeSupervisor(
  options: ProductRuntimeSupervisorOptions,
): Promise<ProductRuntimeSupervisor> {
  const runtime = new ProductRuntimeSupervisor(options);
  await runtime.start();
  return runtime;
}

export function createPairingCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function operationalBundleWithPrivateVoice(
  mounted: RuntimeProductBundle,
  privateVoice: PrivateVoiceGateway,
): RuntimeProductBundle {
  let disposeTask: Promise<void> | undefined;
  return {
    attach: () => mounted.attach(),
    dispose: () => {
      disposeTask ??= (async () => {
        let failure: unknown;
        try {
          await privateVoice.dispose({ force: true });
        } catch (error) {
          failure = error;
        }
        try {
          await mounted.dispose();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      })();
      return disposeTask;
    },
  };
}

function isCommittedConfiguration(candidate: ProductBootstrapConfigDraft): candidate is ProductBootstrapConfiguration {
  const generation = (candidate as { readonly generation?: unknown }).generation;
  return Number.isSafeInteger(generation) && Number(generation) >= 1;
}

function activeVoiceCredentialRefs(configuration: ProductBootstrapConfiguration | undefined): ReadonlySet<string> {
  const refs = [
    configuration?.voice?.asr.credentialRef,
    configuration?.voice?.tts.credentialRef,
  ].filter((reference): reference is string => reference !== undefined);
  return new Set(refs);
}

function activeVoiceCredentialOwners(configuration: ProductBootstrapConfiguration | undefined): ReadonlyArray<{
  readonly candidateId: string;
  readonly track: "asr" | "tts";
  readonly credentialRef: string;
  readonly committedGeneration: number;
}> {
  if (configuration?.voice === undefined) return [];
  return ([
    ["asr", configuration.voice.asr.credentialRef],
    ["tts", configuration.voice.tts.credentialRef],
  ] as const).flatMap(([track, credentialRef]) => {
    if (credentialRef === undefined) return [];
    const parsed = /^keychain:hob-agent\/voice:(asr|tts):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.exec(credentialRef);
    if (parsed === null || parsed[1] !== track || parsed[2] === undefined) return [];
    return [{
      candidateId: parsed[2],
      track,
      credentialRef,
      committedGeneration: configuration.generation,
    }];
  });
}

function activeVoiceEntryOwnsConfiguration(
  entry: ProductVoiceCleanupEntry,
  configuration: ProductBootstrapConfiguration | undefined,
  activeRefs: ReadonlySet<string>,
): boolean {
  return configuration !== undefined
    && entry.committedGeneration === configuration.generation
    && activeRefs.has(entry.credentialRef);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join("=")); } catch { return undefined; }
  }
  return undefined;
}

function normalizePairingCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function sameRecoveryCode(expected: Buffer, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const actual = createHash("sha256").update(normalizePairingCode(value), "utf8").digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function operationalSessionTtlMs(value: number | undefined): number {
  const ttlMs = value ?? PRODUCT_OPERATIONAL_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 24 * 60 * 60 * 1_000 || ttlMs > 365 * 24 * 60 * 60 * 1_000) {
    throw new TypeError("Product operational session lifetime must be between one day and one year");
  }
  return ttlMs;
}
