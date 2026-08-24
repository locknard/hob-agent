import assert from "node:assert/strict";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteHomeAdviceStore } from "../home/home-advice-store.js";
import {
  parseHomeAdviceExportArgs,
  readHomeAdviceAcceptanceManifest,
  readHomeAdviceAcceptanceManifestFromPath,
} from "./home-advice-export.js";

const REPORT = {
  summary: "private summary",
  confidence: "partial" as const,
  findings: ["private finding"],
  unknowns: ["private unknown"],
  trial: {
    description: "private trial",
    durationDays: 14,
    successCriteria: ["private criterion"],
    rollback: "private rollback",
  },
  hardwareSuggestions: [{
    capability: "illuminance" as const,
    necessity: "optional" as const,
    reason: "private hardware reason",
    privacyImpact: "low" as const,
    alternative: "private alternative",
  }],
  validationSteps: ["private validation"],
};

function seedAdvice(path: string, withCausality: boolean): void {
  const store = new SqliteHomeAdviceStore({ path, idFactory: () => "advice-export-1" });
  const id = store.begin({ question: "private household question", createdAt: "2026-08-20T10:00:00.000Z" });
  store.appendProgress({ id, type: "accepted", at: "2026-08-20T10:00:00.000Z" });
  store.appendProgress({ id, type: "evaluating_evidence", at: "2026-08-20T10:00:01.000Z" });
  if (withCausality) store.appendProgress({ id, type: "causality", at: "2026-08-20T10:00:01.500Z" });
  store.appendProgress({ id, type: "composing_answer", at: "2026-08-20T10:00:02.000Z" });
  store.complete({ id, report: REPORT, completedAt: "2026-08-20T10:00:03.000Z" });
  store.close();
}

test("parses exactly one explicit advice id", () => {
  assert.deepEqual(parseHomeAdviceExportArgs(["--advice-id", "advice-export-1"]), { adviceId: "advice-export-1" });
  assert.deepEqual(parseHomeAdviceExportArgs(["--", "--advice-id", "advice-export-1"]), { adviceId: "advice-export-1" });
  assert.throws(() => parseHomeAdviceExportArgs([]), /--advice-id is required/);
  assert.throws(() => parseHomeAdviceExportArgs(["--advice-id", "advice-export-1", "extra"]), /unknown argument/);
});

test("exports only durable safe aggregates after observing causality", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-advice-export-"));
  const path = join(directory, "home-advice.sqlite");
  seedAdvice(path, true);
  const before = statSync(path);
  try {
    const result = readHomeAdviceAcceptanceManifestFromPath(path, "advice-export-1");
    assert.deepEqual(result, {
      schemaVersion: "1",
      outcome: "evidence",
      adviceId: "advice-export-1",
      status: "completed",
      createdAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:03.000Z",
      durationMs: 3_000,
      stages: [
        { stage: "accepted", at: "2026-08-20T10:00:00.000Z" },
        { stage: "evaluating_evidence", at: "2026-08-20T10:00:01.000Z" },
        { stage: "causality", at: "2026-08-20T10:00:01.500Z" },
        { stage: "composing_answer", at: "2026-08-20T10:00:02.000Z" },
        { stage: "completed", at: "2026-08-20T10:00:03.000Z" },
      ],
      causality: "observed",
      report: {
        present: true,
        confidence: "partial",
        findings: 1,
        unknowns: 1,
        trial: true,
        hardwareSuggestions: 1,
        validationSteps: 1,
      },
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      "private household question",
      "private summary",
      "private finding",
      "private unknown",
      "private trial",
      "private hardware reason",
    ]) assert.equal(serialized.includes(privateValue), false, `manifest leaked ${privateValue}`);
    const after = statSync(path);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns insufficient evidence and unknown causality when the durable stage is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-advice-export-missing-causality-"));
  const path = join(directory, "home-advice.sqlite");
  seedAdvice(path, false);
  try {
    const result = readHomeAdviceAcceptanceManifestFromPath(path, "advice-export-1");
    assert.equal(result.outcome, "insufficient_evidence");
    assert.equal(result.causality, "unknown");
    assert.equal(result.reason, "causality_stage_missing");
    assert.equal(JSON.stringify(result).includes("private household question"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not create a missing advice database and reports a fixed unavailable reason", () => {
  const directory = mkdtempSync(join(tmpdir(), "hob-advice-export-missing-"));
  const path = join(directory, "missing.sqlite");
  try {
    assert.deepEqual(readHomeAdviceAcceptanceManifest({ HOB_DATA_DIR: directory }, "advice-id"), {
      schemaVersion: "1",
      outcome: "insufficient_evidence",
      adviceId: "advice-id",
      reason: "advice_store_unavailable",
      readMode: "durable_only",
      remoteWritesPerformed: false,
      localWritesPerformed: false,
    });
  } finally {
    assert.equal(statSync(directory).isDirectory(), true);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(path.endsWith("missing.sqlite"), true);
});
