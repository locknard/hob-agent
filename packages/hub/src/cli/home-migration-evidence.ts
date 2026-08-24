import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  readHomeMigrationEvidenceFromPaths as readEvidenceFromPaths,
  type HomeAutomationMigrationEvidenceResult,
  type HomeAutomationMigrationStatusPaths,
} from "../home/home-automation-migration-status-reader.js";
import { readProductBootstrapLaunchConfig, type LaunchEnvironment } from "../launch-config.js";
import { parseHomeMigrationStatusArgs } from "./home-migration-status.js";

export type {
  HomeAutomationMigrationEvidenceReport,
  HomeAutomationMigrationEvidenceResult,
  HomeAutomationMigrationEvidenceWorkflow,
  HomeAutomationMigrationStatusPaths,
} from "../home/home-automation-migration-status-reader.js";

/** Parses the one operator input; evidence never infers an assessment identity. */
export function parseHomeMigrationEvidenceArgs(
  args: readonly string[],
): { readonly assessmentId: string } {
  return parseHomeMigrationStatusArgs(args);
}

/** Reads the redacted evidence manifest from existing durable stores only. */
export function readHomeMigrationEvidence(
  environment: LaunchEnvironment,
  assessmentId: string,
): HomeAutomationMigrationEvidenceResult {
  const { dataDirectory } = readProductBootstrapLaunchConfig(environment);
  return readEvidenceFromPaths({
    migrationPath: join(dataDirectory, "home-automation-migrations.sqlite"),
    proposalPath: join(dataDirectory, "proposals.sqlite"),
  }, assessmentId);
}

export function readHomeMigrationEvidenceFromPaths(
  paths: HomeAutomationMigrationStatusPaths,
  assessmentId: string,
): HomeAutomationMigrationEvidenceResult {
  return readEvidenceFromPaths(paths, assessmentId);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  let args: { readonly assessmentId: string };
  try {
    args = parseHomeMigrationEvidenceArgs(process.argv.slice(2));
  } catch {
    console.error("hob-agent migration evidence failed");
    process.exitCode = 1;
    args = { assessmentId: "invalid" };
  }
  if (process.exitCode !== 1) {
    try {
      console.log(JSON.stringify(readHomeMigrationEvidence(process.env, args.assessmentId)));
    } catch {
      console.error("hob-agent migration evidence failed");
      process.exitCode = 1;
    }
  }
}
