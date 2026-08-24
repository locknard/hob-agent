import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import {
  createProductMigrationFixture,
  parseProductMigrationFixturePort,
  type ProductMigrationFixtureOptions,
} from "../../../scripts/product-migration-fixture.js";

const fixtureToken = "migration-fixture-test-token-12345678901234567890";
const authorization = `Basic ${Buffer.from(`home:${fixtureToken}`).toString("base64")}`;
const selectionToken = "a".repeat(32);

test("starts a loopback-only migration product fixture with every review state", async () => {
  const logs: string[] = [];
  const fixture = await createProductMigrationFixture({
    port: 0,
    token: fixtureToken,
    log: (line) => logs.push(line),
  });

  try {
    assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${fixture.origin}/automations`, {
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /data-migration-selection-state="selectable"/);
    assert.match(html, /data-migration-selection-state="prepared"/);
    assert.match(html, /data-migration-selection-state="unavailable"/);
    assert.match(html, /data-automation-state="active"/);
    assert.match(html, /data-automation-state="recovery_required"/);
    assert.match(html, /data-automation-state="enable_failed"/);
    assert.match(html, /准备迁移建议/);
    assert.match(html, /查看并批准/);
    assert.match(html, /href="\/review-center\?proposal=fixture-migration-proposal"/);
    assert.match(html, /继续恢复/);
    assert.match(html, /重试迁移/);
    assert.doesNotMatch(html, /native-rule|ruleRef|sourceFingerprint|sha256:/u);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^Migration product fixture listening at http:\/\/127\.0\.0\.1:\d+$/);
    assert.doesNotMatch(logs.join("\n"), /migration-fixture-test-token|a{32}|native-rule|sourceFingerprint/u);
  } finally {
    await fixture.stop();
  }
});

test("prepares a fixture selection and closes its listener idempotently", async () => {
  const fixture = await createProductMigrationFixture({ port: 0, token: fixtureToken });

  try {
    const response = await fetch(`${fixture.origin}/automations/migration/prepare`, {
      method: "POST",
      headers: {
        authorization,
        origin: fixture.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `selectionToken=${selectionToken}`,
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/review-center?proposal=fixture-migration-proposal");

    const page = await fetch(`${fixture.origin}/automations`, {
      headers: { authorization },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-migration-selection-state="prepared"/);
  } finally {
    await fixture.stop();
    await fixture.stop();
  }

  await assert.rejects(
    fetch(`${fixture.origin}/automations`, { headers: { authorization } }),
  );
});

test("requires an explicit fixture token before opening a listener", async () => {
  await assert.rejects(
    createProductMigrationFixture({ port: 0 } as ProductMigrationFixtureOptions),
    /HOB_MIGRATION_FIXTURE_TOKEN|token.*required/i,
  );
});

test("rejects unknown, duplicate, and missing port arguments", () => {
  assert.equal(parseProductMigrationFixturePort(["--port", "0"], {}), 0);
  assert.throws(() => parseProductMigrationFixturePort(["--unknown"], {}), /unknown/i);
  assert.throws(() => parseProductMigrationFixturePort(["--port"], {}), /port.*value|missing/i);
  assert.throws(() => parseProductMigrationFixturePort(["--port", "1", "--port=2"], {}), /once|duplicate/i);
  assert.throws(() => parseProductMigrationFixturePort(["positional"], {}), /unknown|argument/i);
});

test("CLI refuses to open a listener when its token is absent", () => {
  const environment = { ...process.env };
  delete environment.HOB_MIGRATION_FIXTURE_TOKEN;
  const result = spawnSync("pnpm", ["dev:migration-fixture", "--", "--port", "0"], {
    cwd: resolve(process.cwd()),
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.notEqual(result.status, null);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /listening at/iu);
  assert.match(result.stderr, /failed to start/i);
});
