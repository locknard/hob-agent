import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHomeInboxProcessOptions,
  createHomeInboxRuntime,
} from "./home-inbox.js";

test("mounts the persisted Inbox without HomeWorld or DSH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hob-standalone-inbox-"));
  const runtime = createHomeInboxRuntime({
    homeProposals: { path: join(directory, "proposals.sqlite") },
    homeObservationAudit: { path: join(directory, "observation-audit.sqlite") },
    inboxHttp: { port: 0, authenticate: () => true },
  });
  try {
    await runtime.start();
    assert.equal(runtime.status, "running");
    assert.notEqual(runtime.context.homeProposals, undefined);
    assert.notEqual(runtime.context.homeInbox, undefined);
    assert.notEqual(runtime.context.homeObservationAudit, undefined);
    assert.notEqual(runtime.context.homeInboxHttp, undefined);
    assert.equal(runtime.context.homeWorld, undefined);
    assert.equal(runtime.context.homeAgent, undefined);
    await assert.rejects(() => runtime.context.homeProposals.createDraft({
      kind: "household-insight",
      title: "Must remain impossible",
      summary: "Standalone review cannot create a model proposal.",
      idempotencyKey: "standalone-must-not-create",
      provenance: { producer: "dsh-home-agent" },
      selectedHwIds: ["unknown-device"],
      risk: { level: "low", reasons: [] },
      intent: {
        type: "household-insight",
        description: "Do not create this.",
        rollback: "No change exists.",
      },
    }), /HomeWorld is required/);
    assert.match(runtime.context.homeInboxHttp.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${runtime.context.homeInboxHttp.origin}/proposals`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Proposal inbox/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(runtime.status, "stopped");
});

test("builds a standalone process slice without bridge or model options", () => {
  const options = createHomeInboxProcessOptions({
    HOB_DATA_DIR: "/tmp/hob-standalone-inbox-config",
    HOB_INBOX_AUTH_TOKEN: "i".repeat(32),
  });
  assert.equal(options.homeProposals.path, "/tmp/hob-standalone-inbox-config/proposals.sqlite");
  assert.equal(options.homeObservationAudit.path, "/tmp/hob-standalone-inbox-config/observation-audit.sqlite");
  assert.equal(options.inboxHttp.port, 8_787);
  assert.equal("homeWorld" in options, false);
  assert.equal("agent" in options, false);
  assert.equal("launchEnvironment" in options, false);
});
