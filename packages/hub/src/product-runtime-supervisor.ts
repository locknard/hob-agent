import { randomBytes } from "node:crypto";

import { Context, type Fiber } from "@deepseek-ai/cordis";
import {
  ProductSetupHttpService,
  type ProductSetupDraftPort,
} from "@hob-agent/inbox-web/setup";
import { ProductHttpHost } from "@hob-agent/inbox-web/product-http-host";
import type {
  InboxAuthenticationRequest,
  InboxRequestAuthenticator,
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
import {
  ProductVoiceSetupService,
  type ProductVoiceSetupOptions,
} from "./product-voice-setup.js";
import { PrivateVoiceRuntimeService } from "./voice/private-voice-runtime-service.js";

const PRODUCT_SESSION_COOKIE = "hob_product_session";
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEFAULT_PRODUCT_SETUP_PORT = 8787;
export const PRODUCT_PAIRING_TTL_MS = 10 * 60 * 1_000;

export interface ProductSetupAnnouncement {
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
}

/** Setup drafts additionally provide an exact, verified activation candidate. */
export interface ProductRuntimeSetupDrafts extends ProductSetupDraftPort {
  activationCandidateForSession(
    sessionToken: string,
    expectedRevision: number,
  ): Promise<ProductBootstrapConfigDraft | undefined>;
}

interface ProductRuntimeConfigurationStore {
  load(): Promise<ProductBootstrapConfiguration | undefined>;
  commit: ProductBootstrapConfigStore["commit"];
}

export interface ProductRuntimeSupervisorOptions {
  readonly dataDirectory: string;
  readonly port: number;
  readonly now?: () => Date;
  readonly pairingCode?: string;
  readonly createSessionToken?: () => string;
  readonly announce?: (announcement: ProductSetupAnnouncement) => void;
  /** Provider-neutral ASR/TTS setup capability. It remains idle until a caller probes a track. */
  readonly voiceSetup?: ProductVoiceSetupOptions;
  /** Test seam and one durable owner for paired setup progress. */
  readonly setupDrafts?: ProductRuntimeSetupDrafts;
  /** Test seam and the single durable active-generation owner. */
  readonly configurationStore?: ProductRuntimeConfigurationStore;
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
  private readonly setupDrafts: ProductRuntimeSetupDrafts;
  private readonly configurationStore: ProductRuntimeConfigurationStore;
  private readonly host: ProductHttpHost;
  private readonly activation: ProductActivationController;
  private activeBundle: RuntimeProductBundle | undefined;
  private setupFiber: Fiber | undefined;
  private setupSurface: ProductSetupHttpService | undefined;
  private statusValue: "created" | "starting" | "running" | "stopping" | "stopped" = "created";
  private stopTask: Promise<void> | undefined;
  private modeValue: ProductRuntimeMode = "setup";

  constructor(private readonly options: ProductRuntimeSupervisorOptions) {
    this.now = options.now ?? (() => new Date());
    this.setupDrafts = options.setupDrafts
      ?? new ProductSetupController(new ProductSetupDraftStore(options.dataDirectory, this.now));
    this.configurationStore = options.configurationStore ?? new ProductBootstrapConfigStore(options.dataDirectory, this.now);
    this.host = new ProductHttpHost({ port: options.port });
    this.activation = new ProductActivationController({
      configurationStore: this.configurationStore,
      mountCandidate: (candidate) => this.options.mountOperational({
        candidate,
        context: this.context,
        host: this.host,
        authenticateProductSession: this.authenticateProductSession,
      }),
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
      await this.host.listen();
      await this.context.plugin(ProductVoiceSetupService, this.options.voiceSetup ?? {});
      await this.context.plugin(PrivateVoiceRuntimeService);
      const active = await this.configurationStore.load();
      if (active === undefined) {
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
        setupDrafts: this.setupDrafts,
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
    const mounted = await this.options.mountOperational({
      candidate: configuration,
      context: this.context,
      host: this.host,
      authenticateProductSession: this.authenticateProductSession,
    });
    if (mounted === undefined) throw new Error("Active household product is unavailable");
    mounted.attach();
    this.activeBundle = mounted;
    this.modeValue = "operational";
  }

  private async activate(input: {
    readonly sessionToken: string;
    readonly expectedRevision: number;
  }): Promise<{ readonly status: "activated" | "busy" | "conflict" | "unavailable" }> {
    const candidate = await this.setupDrafts.activationCandidateForSession(
      input.sessionToken,
      input.expectedRevision,
    );
    if (candidate === undefined) return { status: "conflict" };
    const current = await this.configurationStore.load();
    const result = await this.activation.activate({
      draft: candidate,
      expectedGeneration: current?.generation ?? 0,
    });
    return await this.finishActivation(result);
  }

  private async finishActivation(result: ProductActivationResult): Promise<{ readonly status: "activated" | "busy" | "conflict" | "unavailable" }> {
    if (result.status !== "activated") return result;
    const mounted = result.mounted as RuntimeProductBundle;
    mounted.attach();
    this.activeBundle = mounted;
    await this.disposeSetupSurface();
    this.modeValue = "operational";
    return { status: "activated" };
  }

  private readonly authenticateProductSession: InboxRequestAuthenticator = async (
    request: InboxAuthenticationRequest,
  ): Promise<boolean> => {
    const token = cookieValue(request.cookie, PRODUCT_SESSION_COOKIE);
    return token !== undefined && await this.setupDrafts.loadForSession(token) !== undefined;
  };

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

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join("=")); } catch { return undefined; }
  }
  return undefined;
}
