import assert from "node:assert/strict";
import test from "node:test";

import { DshHomeAgentService } from "@hob-agent/agent-layer/home-agent";
import { inject, name, projectHomeSnapshot } from "@hob-agent/agent-layer/home-snapshot-tool";

test("exports the neutral Home Agent and snapshot tool entry points", () => {
  assert.equal(typeof DshHomeAgentService, "function");
  assert.equal(name, "dsh-home-snapshot-tool");
  assert.deepEqual(inject, ["tools", "homeWorld"]);
  assert.deepEqual(projectHomeSnapshot(undefined), {
    devices: [],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
  });
});
