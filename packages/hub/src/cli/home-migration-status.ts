import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  readHomeMigrationStatusFromPaths as readStatusFromPaths,
  type HomeAutomationMigrationStatusPaths,
  type HomeAutomationMigrationStatusResult,
} from "../home/home-automation-migration-status-reader.js";
import { readProductBootstrapLaunchConfig, type LaunchEnvironment } from "../launch-config.js";

export type {
  HomeAutomationMigrationStatusPaths,
  HomeAutomationMigrationStatusResult,
} from "../home/home-automation-migration-status-reader.js";

/** Parses the one operator input; status never infers an assessment identity. */
export function parseHomeMigrationStatusArgs(
  args: readonly string[],
): { readonly assessmentId: string } {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0) throw new TypeError("--assessment-id is required");
  if (normalized[0] !== "--assessment-id") throw new TypeError("unknown argument");
  if (normalized.length < 2) throw new TypeError("--assessment-id is required");
  if (normalized.length > 2) throw new TypeError("unknown argument");
  const assessmentId = normalized[1];
  if (!/^[a-f0-9]{32}$/u.test(assessmentId)) throw new TypeError("invalid assessment id");
  return { assessmentId };
}

/** Reads only durable migration/proposal SQLite rows in read-only mode. */
export function readHomeMigrationStatus(
  environment: LaunchEnvironment,
  assessmentId: string,
): HomeAutomationMigrationStatusResult {
  const { dataDirectory } = readProductBootstrapLaunchConfig(environment);
  return readStatusFromPaths({
    migrationPath: join(dataDirectory, "home-automation-migrations.sqlite"),
    proposalPath: join(dataDirectory, "proposals.sqlite"),
  }, assessmentId);
}

export function readHomeMigrationStatusFromPaths(
  paths: HomeAutomationMigrationStatusPaths,
  assessmentId: string,
): HomeAutomationMigrationStatusResult {
  return readStatusFromPaths(paths, assessmentId);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  let args: { readonly assessmentId: string };
  try {
    args = parseHomeMigrationStatusArgs(process.argv.slice(2));
  } catch {
    console.error("hob-agent migration status failed");
    process.exitCode = 1;
    args = { assessmentId: "invalid" };
  }
  if (process.exitCode !== 1) {
    try {
      console.log(JSON.stringify(readHomeMigrationStatus(process.env, args.assessmentId)));
    } catch {
      console.error("hob-agent migration status failed");
      process.exitCode = 1;
    }
  }
}
