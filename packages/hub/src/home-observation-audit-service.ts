import { Context, Service } from "@deepseek-ai/cordis";

import {
  SqliteObservationAuditStore,
  type ObservationAuditRecord,
  type ObservationAuditStore,
  type ObservationTrigger,
  type SqliteObservationAuditStoreOptions,
} from "./observation-audit-store.js";
import type { HomeObservationOutcome } from "./home-observation-scheduler.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeObservationAudit: HomeObservationAuditService;
  }
}

export interface HomeObservationAuditServiceOptions extends SqliteObservationAuditStoreOptions {
  /** Test seam; production owns the SQLite implementation. */
  readonly store?: ObservationAuditStore & { close?: () => void };
}

/** Cordis lifecycle wrapper around the Hub-owned observation audit ledger. */
export class HomeObservationAuditService extends Service {
  private readonly store: ObservationAuditStore & { close?: () => void };

  constructor(ctx: Context, options: HomeObservationAuditServiceOptions) {
    super(ctx, "homeObservationAudit");
    this.store = options.store ?? new SqliteObservationAuditStore(options);
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.store.close?.(), "home-observation-audit.close");
  }

  begin(input: { readonly trigger: ObservationTrigger; readonly startedAt: string }): string {
    return this.store.begin(input);
  }

  complete(input: {
    readonly id: string;
    readonly completedAt: string;
    readonly outcome: HomeObservationOutcome;
  }): void {
    this.store.complete(input);
  }

  list(query?: { readonly limit?: number }): readonly ObservationAuditRecord[] {
    return this.store.list(query);
  }
}
