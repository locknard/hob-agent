import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  MIGRATION_FAULT_ADMISSION_MATRIX,
  MIGRATION_FAULT_KINDS,
  type MigrationFaultAdmissionPolicy,
  type MigrationFaultKind,
} from "../home/migration-fault-admission-matrix.js";

export interface HomeMigrationFaultMatrixReport {
  readonly schemaVersion: "1";
  readonly outcome: "matrix";
  readonly exitCode: 0;
  readonly scope: "acceptance_policy_only";
  readonly faults: readonly (MigrationFaultAdmissionPolicy & { readonly fault: MigrationFaultKind })[];
  readonly runtimeStarted: false;
  readonly credentialsRead: false;
  readonly remoteWritesPerformed: false;
  readonly localWritesPerformed: false;
  readonly faultInjectionPerformed: false;
}

/** Returns only the closed acceptance policy; it has no environment or runtime dependencies. */
export function createMigrationFaultMatrixReport(): HomeMigrationFaultMatrixReport {
  const faults = MIGRATION_FAULT_KINDS.map((fault) => Object.freeze({
    fault,
    ...MIGRATION_FAULT_ADMISSION_MATRIX[fault],
  }));
  return Object.freeze({
    schemaVersion: "1" as const,
    outcome: "matrix" as const,
    exitCode: 0 as const,
    scope: "acceptance_policy_only" as const,
    faults: Object.freeze(faults),
    runtimeStarted: false as const,
    credentialsRead: false as const,
    remoteWritesPerformed: false as const,
    localWritesPerformed: false as const,
    faultInjectionPerformed: false as const,
  });
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  console.log(JSON.stringify(createMigrationFaultMatrixReport()));
}
