import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  createInboxBasicAuthenticator,
  ProposalInboxHttpService,
} from "../packages/inbox-web/src/proposal-inbox-http-service.js";
import type {
  InboxProductReviewProjection,
  InboxProductShellProjection,
  InboxReviewActor,
} from "../packages/inbox-web/src/proposal-inbox-service.js";
import type {
  ProductAutomation,
  ProductMigrationSelection,
  ProductProposal,
} from "../packages/inbox-web/src/product-shell.js";

const DEFAULT_PORT = 4_173;
const SELECTION_TOKEN = "a".repeat(32);
const PREPARED_PROPOSAL_ID = "fixture-migration-proposal";

const FIXTURE_ACTOR: InboxReviewActor = Object.freeze({
  principalId: "fixture-admin",
  role: "admin",
  present: true,
  device: Object.freeze({ kind: "private", boundPrincipalId: "fixture-admin" }),
});

type FixtureAutomation = ProductAutomation & { lifecycle: ProductAutomation["lifecycle"] };

export interface ProductMigrationFixtureOptions {
  /** Use 0 in tests to obtain an available loopback port. */
  readonly port?: number;
  /** The local Basic-auth password. It is never written to stdout/stderr. */
  readonly token: string;
  /** Receives only the loopback origin line; defaults to a silent logger. */
  readonly log?: (line: string) => void;
}

export interface ProductMigrationFixtureHandle {
  /** Always an http://127.0.0.1 origin. */
  readonly origin: string;
  /** Disposes the HTTP service and its fixture context; safe to call repeatedly. */
  stop(): Promise<void>;
}

interface ProductMigrationFixtureServiceOptions {
  readonly selectionToken: string;
}

/**
 * A presentation-only Home Inbox owner for product acceptance.
 *
 * This fixture intentionally has no Hub, Home Assistant bridge, model, agent,
 * SQLite store, or execution owner. It exposes the same neutral projections
 * consumed by the production ProposalInboxHttpService.
 */
class ProductMigrationFixtureInbox extends Service {
  private readonly selectionToken: string;
  private selectionPrepared = false;
  private automations: FixtureAutomation[] = [
    {
      id: "fixture-active",
      title: "客厅晚间灯",
      lifecycle: "active",
      reviewLane: "migration",
      version: 2,
      lastResult: "已部署并读回核对 · 2026-08-24",
    },
    {
      id: "fixture-recovery",
      title: "门口灯恢复",
      lifecycle: "recovery_required",
      reviewLane: "migration",
      version: 3,
    },
    {
      id: "fixture-enable-failed",
      title: "清晨柔光",
      lifecycle: "enable_failed",
      reviewLane: "migration",
      version: 4,
      failureReason: "这次迁移没有完成，家里的设置保持原样。",
    },
  ];

  constructor(ctx: Context, options: ProductMigrationFixtureServiceOptions) {
    super(ctx, "homeInbox");
    this.selectionToken = options.selectionToken;
  }

  review(): Promise<{ readonly status: "approved" }> {
    return Promise.resolve({ status: "approved" });
  }

  canObserveNow(): boolean {
    return false;
  }

  observeNow(): Promise<"no_proposal"> {
    return Promise.resolve("no_proposal");
  }

  getProductReviewCounts(): { readonly runtimeConfirmations: 0; readonly persistentProposals: 1 } {
    return { runtimeConfirmations: 0, persistentProposals: 1 };
  }

  getProductReviewProjection(
    _actor?: InboxReviewActor,
    selectedProposalId?: string,
  ): InboxProductReviewProjection {
    const proposal = selectedProposalId === PREPARED_PROPOSAL_ID ? migrationProposal() : undefined;
    return {
      runtimeConfirmations: [],
      proposals: proposal === undefined ? [] : [proposal],
      ...(proposal === undefined ? {} : { selectedProposal: proposal }),
      standardProposalCount: 0,
      migrationProposalCount: proposal === undefined ? 0 : 1,
      proposalCapacityUsed: 0,
      proposalCapacity: 5,
    };
  }

  getProductShellProjection(
    _actor?: InboxReviewActor,
    _batchRequestId?: string,
    includeMigrationSelections = false,
  ): InboxProductShellProjection {
    return {
      connection: { state: "quiet", lastContact: "刚刚" },
      spaces: [],
      controlSpaces: [],
      activity: [],
      automations: this.automations,
      migrationSelections: includeMigrationSelections ? this.selections() : [],
    };
  }

  async prepareMigrationSelection(input: {
    readonly selectionToken: string;
    readonly actor: InboxReviewActor;
  }): Promise<{ readonly status: "prepared"; readonly proposalId: string }> {
    if (input.selectionToken !== this.selectionToken || !isPrivateFixtureActor(input.actor)) {
      throw new Error("migration_selection_unavailable");
    }
    this.selectionPrepared = true;
    return { status: "prepared", proposalId: PREPARED_PROPOSAL_ID };
  }

  canEnableProposal(): boolean {
    return true;
  }

  enableProposal(input: { readonly proposalId: string; readonly expectedRevision: number; readonly reviewer: string }): void {
    if (input.proposalId !== PREPARED_PROPOSAL_ID || input.expectedRevision !== 1) {
      throw new Error("proposal_not_found");
    }
  }

  canControlAutomation(): boolean {
    return true;
  }

  controlAutomation(input: {
    readonly proposalId: string;
    readonly command: "pause" | "resume" | "close" | "retry";
    readonly actor: string;
  }): void {
    const current = this.automations.find((automation) => automation.id === input.proposalId);
    if (current === undefined) throw new Error("automation_not_found");
    const lifecycle = input.command === "pause"
      ? "paused"
      : input.command === "resume"
        ? "active"
        : input.command === "close"
          ? "closed"
          : "active";
    this.automations = this.automations.map((automation) => automation.id === input.proposalId
      ? { ...automation, lifecycle }
      : automation);
  }

  canRecoverAutomation(proposalId: string): boolean {
    return proposalId === "fixture-recovery"
      && this.automations.some((automation) => automation.id === proposalId && automation.lifecycle === "recovery_required");
  }

  recoverAutomation(input: { readonly proposalId: string; readonly actor: string }): void {
    if (!this.canRecoverAutomation(input.proposalId)) throw new Error("automation_recovery_unavailable");
    this.automations = this.automations.map((automation) => automation.id === input.proposalId
      ? { ...automation, lifecycle: "active", lastResult: "已恢复并读回核对 · 2026-08-24" }
      : automation);
  }

  private selections(): readonly ProductMigrationSelection[] {
    return [
      this.selectionPrepared
        ? { name: "晚间灯", status: "prepared", proposalId: PREPARED_PROPOSAL_ID }
        : { name: "晚间灯光", status: "selectable", selectionToken: this.selectionToken },
      { name: "起床灯", status: "prepared", proposalId: PREPARED_PROPOSAL_ID },
      { name: "旧规则", status: "unavailable", unavailableReason: "assessment_unavailable" },
    ];
  }
}

function migrationProposal(): ProductProposal {
  return {
    id: PREPARED_PROPOSAL_ID,
    revision: 1,
    title: "起床灯",
    kind: "automation-draft",
    reviewLane: "migration",
    lifecycle: "ready",
    status: "pending",
    summary: "一条已经准备好的家庭自动化迁移建议。",
    readiness: ["证据已整理", "迁移范围已限制为一个灯"],
    why: ["保留家庭已经在使用的灯光安排。"],
    willDo: ["在指定时间调整起床灯。"],
    willNotDo: ["不会改变其他设备，也不会删除原有安排。"],
    evidence: ["当前规则已完成只读检查。"],
    unknowns: ["是否长期保留由家庭成员决定。"],
    risk: "低风险；启用前仍需要你明确批准。",
  };
}

function isPrivateFixtureActor(actor: InboxReviewActor): boolean {
  return actor.present
    && actor.device.kind === "private"
    && actor.device.boundPrincipalId === actor.principalId;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Migration fixture port must be an integer from 0 to 65535");
  }
  return port;
}

function validateToken(token: string): string {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) {
    throw new TypeError("HOB_MIGRATION_FIXTURE_TOKEN is required and must be 32 to 512 characters");
  }
  return token;
}

export async function createProductMigrationFixture(
  options: ProductMigrationFixtureOptions,
): Promise<ProductMigrationFixtureHandle> {
  const port = validatePort(options.port ?? DEFAULT_PORT);
  const token = validateToken(options.token);
  const context = new Context();
  let inboxFiber: Awaited<ReturnType<typeof context.plugin>> | undefined;
  let httpFiber: Awaited<ReturnType<typeof context.plugin>> | undefined;
  try {
    inboxFiber = await context.plugin(ProductMigrationFixtureInbox, { selectionToken: SELECTION_TOKEN });
    httpFiber = await context.plugin(ProposalInboxHttpService, {
      port,
      authenticate: createInboxBasicAuthenticator(token),
      principal: FIXTURE_ACTOR,
    });
    const origin = context.homeInboxHttp.origin;
    options.log?.(`Migration product fixture listening at ${origin}`);
    let stopPromise: Promise<void> | undefined;
    return {
      origin,
      stop: () => {
        stopPromise ??= (async () => {
          await httpFiber?.dispose();
          await inboxFiber?.dispose();
          await context.fiber.dispose();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    await httpFiber?.dispose();
    await inboxFiber?.dispose();
    await context.fiber.dispose();
    throw error;
  }
}

export function parseProductMigrationFixturePort(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): number {
  let value: string | undefined;
  let hasPort = false;
  let hasSeparator = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      if (hasSeparator) throw new TypeError("Migration fixture argument separator may appear only once");
      hasSeparator = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--port") {
      if (hasPort) throw new TypeError("Migration fixture port may be specified only once");
      value = argv[index + 1];
      if (value === undefined || value === "--" || value.startsWith("-")) {
        throw new TypeError("Migration fixture --port requires a value");
      }
      hasPort = true;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--port=")) {
      if (hasPort) throw new TypeError("Migration fixture port may be specified only once");
      value = argument.slice("--port=".length);
      if (value.length === 0) throw new TypeError("Migration fixture --port requires a value");
      hasPort = true;
      continue;
    }
    throw new TypeError(`Unknown migration fixture argument: ${argument ?? "<missing>"}`);
  }
  if (help) return DEFAULT_PORT;
  const configured = value ?? environment.HOB_MIGRATION_FIXTURE_PORT ?? String(DEFAULT_PORT);
  if (configured.trim().length === 0) throw new TypeError("Migration fixture port requires a value");
  return validatePort(Number(configured));
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url);
}

async function runCli(): Promise<void> {
  const port = parseProductMigrationFixturePort();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: pnpm dev:migration-fixture [--port <0..65535>]");
    console.log("The fixture listens on 127.0.0.1 and never prints authentication or device tokens.");
    return;
  }
  const token = process.env.HOB_MIGRATION_FIXTURE_TOKEN;
  if (token === undefined) throw new Error("HOB_MIGRATION_FIXTURE_TOKEN is required");
  const fixture = await createProductMigrationFixture({
    port,
    token,
    log: (line) => console.log(line),
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= fixture.stop();
    return stopPromise;
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (isMainModule()) {
  void runCli().catch(() => {
    console.error("Migration product fixture failed to start.");
    process.exitCode = 1;
  });
}
