import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RetentionCoordinator } from "../home/home-retention-service.js";
import { SqliteIngestJournal, type IngestJournalRetentionResult } from "../world/ingest-journal.js";
import { readHomeWorldLaunchConfig, type LaunchEnvironment } from "../launch-config.js";
import { SqliteProposalStore } from "../home/proposal-store.js";

export interface HomeRetentionOperationResult {
  readonly mode: "preview";
  readonly bridgeId: string;
  readonly evidenceWindowStart: string;
  readonly candidateCount: number;
  readonly affectedEventCount: number;
  readonly affectedBytes: number;
  readonly protectedRecoveryCount: number;
  readonly protectedHistoryGapCount: number;
  readonly protectedProposalEvidenceCount: number;
  readonly protectedEvidenceWindowCount: number;
  readonly resultingPartialCoverage: boolean;
}

export interface HomeRetentionOperationOptions {
  readonly now?: () => string;
}

/**
 * Runs one local, aggregate-only retention decision without starting a bridge,
 * model, DSH loop, Inbox mutation route, or timer. Preview is the default.
 */
export async function runHomeRetentionOperation(
  environment: LaunchEnvironment,
  args: readonly string[],
  options: HomeRetentionOperationOptions = {},
): Promise<HomeRetentionOperationResult> {
  parseArgs(args);
  const config = readHomeWorldLaunchConfig(environment);
  const bridgeId = requiredBounded(environment.HOB_RETENTION_BRIDGE_ID, "configured bridge");
  const reason = requiredBounded(environment.HOB_RETENTION_REASON, "retention reason", 1_000);
  if (!config.bridges.some((bridge) => bridge.bridgeId === bridgeId)) {
    throw new Error("Retention configured bridge is unavailable");
  }
  const confirmation = environment.HOB_RETENTION_CONFIRM_BRIDGE_ID;
  if (confirmation !== undefined) {
    throw new Error("Retention confirmation is unavailable while apply is disabled");
  }

  const journalPath = join(config.journalDirectory, `${encodeURIComponent(bridgeId)}.sqlite`);
  const proposalPath = join(config.dataDirectory, "proposals.sqlite");
  await requirePrivateDatabase(journalPath, "journal");
  await requirePrivateDatabase(proposalPath, "proposal store");

  const journal = new SqliteIngestJournal(journalPath);
  const proposals = new SqliteProposalStore({ path: proposalPath });
  try {
    const coordinator = new RetentionCoordinator({
      journal: (requestedBridgeId) => requestedBridgeId === bridgeId ? journal : undefined,
      bridgeIds: () => [bridgeId],
    }, proposals, { now: options.now });
    const request = {
      bridgeId,
      requestedBy: "local-operator",
      reason,
    };
    const result = coordinator.preview(request);
    return projectResult(result);
  } finally {
    proposals.close();
    journal.close();
  }
}

function projectResult(
  result: IngestJournalRetentionResult,
): HomeRetentionOperationResult {
  return Object.freeze({
    mode: "preview",
    bridgeId: result.bridgeId,
    evidenceWindowStart: result.evidenceWindowStart,
    candidateCount: result.candidateCount,
    affectedEventCount: result.deletedEventCount,
    affectedBytes: result.bytesDeleted,
    protectedRecoveryCount: result.skippedRecoveryCount,
    protectedHistoryGapCount: result.skippedHistoryGapCount,
    protectedProposalEvidenceCount: result.skippedProposalEvidenceCount,
    protectedEvidenceWindowCount: result.skippedEvidenceWindowCount,
    resultingPartialCoverage: result.partialCoverage,
  });
}

function parseArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Invalid retention operation arguments");
  }
  if (args.length === 0) return;
  throw new Error("Invalid retention operation arguments");
}

function requiredBounded(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

async function requirePrivateDatabase(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid");
  } catch {
    throw new Error(`Retention ${label} is unavailable`);
  }
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void runHomeRetentionOperation(process.env, process.argv.slice(2)).then(
    (result) => { console.log(JSON.stringify(result)); },
    () => {
      console.error("hob-agent retention operation failed");
      process.exitCode = 1;
    },
  );
}
