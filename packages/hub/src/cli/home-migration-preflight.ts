import { accessSync, constants as fsConstants, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import {
  readHomeWorldLaunchConfig,
  type HomeWorldLaunchConfig,
  type LaunchEnvironment,
} from "../launch-config.js";

const MAX_PATH_CHARS = 4_096;
const MAX_BRIDGES_CONFIG_BYTES = 64 * 1024;
const REQUIRED_VARIABLES = [
  "HOB_DATA_DIR", "HOB_BRIDGES", "HOB_HOME_DIR", "HOB_MIGRATION_BRIDGE_ID",
] as const;

export const HOME_MIGRATION_PREFLIGHT_EXIT_CODES = {
  ready: 0,
  missingConfiguration: 2,
  invalidConfiguration: 3,
  pathUnavailable: 4,
  bridgeSelection: 5,
} as const;

export type HomeMigrationPreflightExitCode = typeof HOME_MIGRATION_PREFLIGHT_EXIT_CODES[keyof typeof HOME_MIGRATION_PREFLIGHT_EXIT_CODES];
export type HomeMigrationPreflightVariable = typeof REQUIRED_VARIABLES[number];
export type HomeMigrationPreflightIssueCode = "missing" | "invalid" | "unavailable" | "not_configured" | "unsupported";

export interface HomeMigrationPreflightIssue {
  readonly variable: HomeMigrationPreflightVariable;
  readonly code: HomeMigrationPreflightIssueCode;
  readonly repair: string;
}

export interface HomeMigrationPreflightCheck {
  readonly name: "data_directory" | "bridge_configuration" | "household_directory" | "migration_bridge";
  readonly status: "passed" | "failed" | "blocked";
}

export interface HomeMigrationPreflightReport {
  readonly schemaVersion: "1";
  readonly outcome: "ready" | "needs_attention";
  readonly exitCode: HomeMigrationPreflightExitCode;
  readonly scope: "configuration_only";
  readonly configuredBridgeCount: number;
  readonly selectedBridgeConfigured: boolean;
  readonly checks: readonly HomeMigrationPreflightCheck[];
  readonly issues: readonly HomeMigrationPreflightIssue[];
  readonly runtimeStarted: false;
  readonly credentialsRead: false;
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
  readonly realCutoverVerified: false;
  readonly nextAction?: "assess_migration";
}

/**
 * Checks only local launch configuration and directory accessibility.
 * It never creates a directory, reads a credential, starts HomeWorld, or
 * claims that a bridge is reachable or that a migration cutover succeeded.
 */
export function preflightHomeMigrationEnvironment(
  environment: LaunchEnvironment,
): HomeMigrationPreflightReport {
  const issues: HomeMigrationPreflightIssue[] = [];
  const dataDirectoryCheck = inspectDirectory(environment?.HOB_DATA_DIR, "data");
  if (dataDirectoryCheck.issue !== undefined) issues.push(dataDirectoryCheck.issue);

  const householdDirectoryCheck = inspectDirectory(environment?.HOB_HOME_DIR, "household");

  let config: HomeWorldLaunchConfig | undefined;
  let bridgeConfigurationStatus: HomeMigrationPreflightCheck["status"] = "blocked";
  const rawBridges = environment?.HOB_BRIDGES;
  if (!isPresent(rawBridges)) {
    issues.push({
      variable: "HOB_BRIDGES",
      code: "missing",
      repair: "Set HOB_BRIDGES to a valid JSON bridge array containing the Home Assistant bridge.",
    });
    bridgeConfigurationStatus = "failed";
  } else if (dataDirectoryCheck.status === "passed") {
    try {
      if (Buffer.byteLength(rawBridges, "utf8") > MAX_BRIDGES_CONFIG_BYTES) throw new Error("oversized");
      config = readHomeWorldLaunchConfig(environment);
      if (config.bridges.length === 0 || config.bridges.length > 128 || !validBridgeRegistrations(config)) {
        throw new Error("invalid bridge configuration");
      }
      bridgeConfigurationStatus = "passed";
    } catch {
      issues.push({
        variable: "HOB_BRIDGES",
        code: "invalid",
        repair: "Set HOB_BRIDGES to a valid JSON bridge array with registered, non-secret configuration.",
      });
      bridgeConfigurationStatus = "failed";
    }
  }
  if (householdDirectoryCheck.issue !== undefined) issues.push(householdDirectoryCheck.issue);

  let migrationBridgeStatus: HomeMigrationPreflightCheck["status"] = "blocked";
  let selectedBridgeConfigured = false;
  const selectedBridgeId = environment?.HOB_MIGRATION_BRIDGE_ID;
  if (!isPresent(selectedBridgeId)) {
    issues.push({
      variable: "HOB_MIGRATION_BRIDGE_ID",
      code: "missing",
      repair: "Set HOB_MIGRATION_BRIDGE_ID to one configured Home Assistant bridgeId.",
    });
    migrationBridgeStatus = "failed";
  } else if (!isBoundedId(selectedBridgeId)) {
    issues.push({
      variable: "HOB_MIGRATION_BRIDGE_ID",
      code: "invalid",
      repair: "Set HOB_MIGRATION_BRIDGE_ID to one bounded bridgeId without whitespace or control characters.",
    });
    migrationBridgeStatus = "failed";
  } else if (config !== undefined) {
    const selectedBridge = config.bridges.find((bridge) => bridge.bridgeId === selectedBridgeId);
    if (selectedBridge === undefined) {
      issues.push({
        variable: "HOB_MIGRATION_BRIDGE_ID",
        code: "not_configured",
        repair: "Set HOB_MIGRATION_BRIDGE_ID to a bridgeId present in HOB_BRIDGES.",
      });
      migrationBridgeStatus = "failed";
    } else if (selectedBridge.adapterType !== "home-assistant") {
      issues.push({
        variable: "HOB_MIGRATION_BRIDGE_ID",
        code: "unsupported",
        repair: "Set HOB_MIGRATION_BRIDGE_ID to a configured home-assistant bridgeId.",
      });
      migrationBridgeStatus = "failed";
    } else {
      selectedBridgeConfigured = true;
      migrationBridgeStatus = "passed";
    }
  }

  const checks: HomeMigrationPreflightCheck[] = [
    { name: "data_directory", status: dataDirectoryCheck.status },
    { name: "bridge_configuration", status: bridgeConfigurationStatus },
    { name: "household_directory", status: householdDirectoryCheck.status },
    { name: "migration_bridge", status: migrationBridgeStatus },
  ];
  const exitCode = exitCodeForIssues(issues);
  const ready = exitCode === HOME_MIGRATION_PREFLIGHT_EXIT_CODES.ready
    && checks.every((check) => check.status === "passed")
    && selectedBridgeConfigured;
  const finalExitCode = ready
    ? HOME_MIGRATION_PREFLIGHT_EXIT_CODES.ready
    : exitCode === HOME_MIGRATION_PREFLIGHT_EXIT_CODES.ready
      ? HOME_MIGRATION_PREFLIGHT_EXIT_CODES.invalidConfiguration
      : exitCode;
  return {
    schemaVersion: "1",
    outcome: ready ? "ready" : "needs_attention",
    exitCode: finalExitCode,
    scope: "configuration_only",
    configuredBridgeCount: config?.bridges.length ?? 0,
    selectedBridgeConfigured,
    checks,
    issues,
    runtimeStarted: false,
    credentialsRead: false,
    remoteWritesPerformed: false,
    localWritesPerformed: false,
    realCutoverVerified: false,
    ...(ready ? { nextAction: "assess_migration" as const } : {}),
  };
}

interface DirectoryCheck {
  readonly status: HomeMigrationPreflightCheck["status"];
  readonly issue?: HomeMigrationPreflightIssue;
}

function inspectDirectory(value: string | undefined, kind: "data" | "household"): DirectoryCheck {
  const variable: HomeMigrationPreflightVariable = kind === "data" ? "HOB_DATA_DIR" : "HOB_HOME_DIR";
  const label = kind === "data" ? "private data" : "household";
  const permissions = kind === "data"
    ? fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK
    : fsConstants.R_OK | fsConstants.X_OK;
  if (!isPresent(value)) {
    return {
      status: "failed",
      issue: {
        variable,
        code: "missing",
        repair: `Set ${variable} to an existing ${label} directory.`,
      },
    };
  }
  if (!isSafeAbsoluteDirectoryPath(value)) {
    return {
      status: "failed",
      issue: {
        variable,
        code: "invalid",
        repair: `Set ${variable} to an absolute ${label} directory outside .env paths.`,
      },
    };
  }
  try {
    const metadata = lstatSync(value);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    accessSync(value, permissions);
    return { status: "passed" };
  } catch {
    return {
      status: "failed",
      issue: {
        variable,
        code: "unavailable",
        repair: `Create ${variable} as a private owner-accessible directory and grant the required permissions.`,
      },
    };
  }
}

function validBridgeRegistrations(config: HomeWorldLaunchConfig): boolean {
  return config.bridges.every((bridge) => {
    const registration = config.catalog.getAdapter(bridge.adapterType);
    if (registration === undefined) return false;
    return registration.configSchema.safeParse(bridge.config).success;
  });
}

function exitCodeForIssues(issues: readonly HomeMigrationPreflightIssue[]): HomeMigrationPreflightExitCode {
  if (issues.some((issue) => issue.code === "missing")) return HOME_MIGRATION_PREFLIGHT_EXIT_CODES.missingConfiguration;
  if (issues.some((issue) => issue.code === "invalid")) return HOME_MIGRATION_PREFLIGHT_EXIT_CODES.invalidConfiguration;
  if (issues.some((issue) => issue.code === "unavailable")) return HOME_MIGRATION_PREFLIGHT_EXIT_CODES.pathUnavailable;
  if (issues.some((issue) => issue.code === "not_configured" || issue.code === "unsupported")) {
    return HOME_MIGRATION_PREFLIGHT_EXIT_CODES.bridgeSelection;
  }
  return HOME_MIGRATION_PREFLIGHT_EXIT_CODES.ready;
}

function isSafeAbsoluteDirectoryPath(value: string): boolean {
  return value.length <= MAX_PATH_CHARS
    && isAbsolute(value)
    && value !== ":memory:"
    && !/(?:^|[\\/])\.env(?:$|[\\/])/iu.test(value);
}

function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isBoundedId(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && value.trim() === value
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  try {
    const report = preflightHomeMigrationEnvironment(process.env);
    console.log(JSON.stringify(report));
    if (report.exitCode !== 0) process.exitCode = report.exitCode;
  } catch {
    console.error("hob-agent migration preflight failed; inspect HOB_DATA_DIR, HOB_BRIDGES, HOB_HOME_DIR, and HOB_MIGRATION_BRIDGE_ID");
    process.exitCode = HOME_MIGRATION_PREFLIGHT_EXIT_CODES.invalidConfiguration;
  }
}
