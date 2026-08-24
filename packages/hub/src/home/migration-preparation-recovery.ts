import type { ArtifactPreparationJobStatus } from "../artifact/preparation-job-port.js";

interface MigrationPreparationRecoveryJobSource {
  listPreparationJobs(limit: number): readonly {
    readonly proposalId: string;
    readonly status: ArtifactPreparationJobStatus;
  }[];
}
interface MigrationPreparationRecoveryPort {
  recoverMigrationSelections(): Promise<unknown>;
  refreshPreparedWorkflowForProposal(proposalId: string): Promise<unknown>;
}

export interface MigrationPreparationRecoveryOptions {
  readonly jobs: MigrationPreparationRecoveryJobSource;
  readonly migrations: MigrationPreparationRecoveryPort;
}

/**
 * Replays the two durable migration handoffs in their required order. Every
 * scan is bounded and every corrupt row stays isolated; this helper has no
 * proposal creation port and therefore cannot manufacture household intent.
 */
export async function recoverMigrationPreparationHandoffs(
  options: MigrationPreparationRecoveryOptions,
): Promise<void> {
  try {
    await options.migrations.recoverMigrationSelections();
  } catch {
    // A corrupt selection row cannot suppress independent succeeded jobs.
  }

  let jobs: ReturnType<MigrationPreparationRecoveryJobSource["listPreparationJobs"]>;
  try {
    jobs = options.jobs.listPreparationJobs(100);
  } catch {
    return;
  }
  for (const job of jobs) {
    if (job.status !== "succeeded") continue;
    try {
      await options.migrations.refreshPreparedWorkflowForProposal(job.proposalId);
    } catch {
      // One corrupt workflow cannot suppress later bounded recovery rows.
    }
  }
}
