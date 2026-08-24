import assert from "node:assert/strict";
import test from "node:test";

import { MIGRATION_FAULT_KINDS } from "../home/migration-fault-admission-matrix.js";

test("projects the closed fault matrix as a configuration-only read-only report", async () => {
  const cli = await import("./home-migration-fault-matrix.js").catch(() => undefined);
  assert.ok(cli, "the migration fault matrix CLI must exist");
  if (cli === undefined) return;

  const report = cli.createMigrationFaultMatrixReport();
  assert.equal(report.schemaVersion, "1");
  assert.equal(report.outcome, "matrix");
  assert.equal(report.exitCode, 0);
  assert.equal(report.scope, "acceptance_policy_only");
  assert.deepEqual(report.faults.map((fault) => fault.fault), [...MIGRATION_FAULT_KINDS]);
  assert.equal(report.faults.length, 6);
  assert.equal(report.runtimeStarted, false);
  assert.equal(report.credentialsRead, false);
  assert.equal(report.remoteWritesPerformed, false);
  assert.equal(report.localWritesPerformed, false);
  assert.equal(report.faultInjectionPerformed, false);

  const serialized = JSON.stringify(report);
  for (const forbidden of ["HOB_DATA_DIR", "HOB_BRIDGES", "token", "endpoint", "HomeWorld", "bridgeId"]) {
    assert.equal(serialized.includes(forbidden), false, `matrix report leaked ${forbidden}`);
  }
});

test("keeps the CLI report independent of environment values and external arguments", async () => {
  const cli = await import("./home-migration-fault-matrix.js");
  const first = cli.createMigrationFaultMatrixReport();
  const originalArgv = process.argv;
  try {
    process.argv = [...originalArgv, "--unknown", "secret-input"];
    const second = cli.createMigrationFaultMatrixReport();
    assert.deepEqual(second, first);
  } finally {
    process.argv = originalArgv;
  }
});
