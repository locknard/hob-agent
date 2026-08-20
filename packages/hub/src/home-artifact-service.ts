import { Context, Service } from "@deepseek-ai/cordis";

import {
  ArtifactRegistry,
  type ArtifactAssessmentEntry,
  type ArtifactAssessmentListQuery,
  type ArtifactAssessmentLookup,
  type ArtifactRegistryAudit,
  type ArtifactRegistryAuditQuery,
  type ArtifactRegistryEntry,
  type ArtifactRegistryListQuery,
  type ArtifactRegistryOptions,
} from "./artifact-registry.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeArtifacts: HomeArtifactService;
  }
}

export type HomeArtifactServiceOptions = ArtifactRegistryOptions;

export interface HomeArtifactCapabilities {
  readonly schemaVersion: "1";
  readonly lifecycleStates: readonly ["draft", "superseded"];
  readonly canCompile: false;
  readonly canSimulate: false;
  readonly canExecute: false;
}

export interface HomeArtifactDiagnostics extends HomeArtifactCapabilities {
  readonly status: "ready";
  readonly hasRecords: boolean;
}

const CAPABILITIES: HomeArtifactCapabilities = Object.freeze({
  schemaVersion: "1",
  lifecycleStates: Object.freeze(["draft", "superseded"] as const),
  canCompile: false,
  canSimulate: false,
  canExecute: false,
});

/**
 * Production read boundary for M3b artifact records.
 *
 * Registry mutation remains an internal future compiler/policy concern. This
 * service deliberately gives the Agent and review surface no create, compile,
 * simulation, approval, bridge, or execution method.
 */
export class HomeArtifactService extends Service {
  private readonly registry: ArtifactRegistry;

  constructor(ctx: Context, options: HomeArtifactServiceOptions) {
    super(ctx, "homeArtifacts");
    this.registry = new ArtifactRegistry(options);
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => this.registry.close(), "home-artifacts.close");
  }

  capabilities(): HomeArtifactCapabilities {
    return CAPABILITIES;
  }

  /** Metadata-only projection; artifact titles, behavior and household values never cross it. */
  diagnostics(): HomeArtifactDiagnostics {
    return Object.freeze({
      status: "ready",
      ...CAPABILITIES,
      hasRecords: this.registry.list({ limit: 1 }).length > 0,
    });
  }

  getRevision(artifactId: string, revision: number): ArtifactRegistryEntry | undefined {
    return this.registry.getRevision(artifactId, revision);
  }

  list(query?: ArtifactRegistryListQuery): readonly ArtifactRegistryEntry[] {
    return this.registry.list(query);
  }

  audit(query?: ArtifactRegistryAuditQuery): readonly ArtifactRegistryAudit[] {
    return this.registry.audit(query);
  }

  listAttestations(query?: ArtifactAssessmentListQuery): readonly ArtifactAssessmentEntry[] {
    return this.registry.listAttestations(query);
  }

  latestAttestation(query: ArtifactAssessmentLookup): ArtifactAssessmentEntry | undefined {
    return this.registry.latestAttestation(query);
  }
}
