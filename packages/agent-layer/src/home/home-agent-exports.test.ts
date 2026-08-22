import assert from "node:assert/strict";
import test from "node:test";

import { DshHomeAgentService } from "@hob-agent/agent-layer/home-agent";
import { AgentLoopTraceService, projectAgentLoopTrace } from "@hob-agent/agent-layer/agent-loop-trace";
import { inject, name, projectHomeSnapshot } from "@hob-agent/agent-layer/home-snapshot-tool";
import { pageHomeInventory } from "@hob-agent/agent-layer/home-inventory-tool";
import { pageHomeRules } from "@hob-agent/agent-layer/home-rules-tool";

test("exports the neutral Home Agent and snapshot tool entry points", () => {
  assert.equal(typeof DshHomeAgentService, "function");
  assert.equal(typeof AgentLoopTraceService, "function");
  assert.equal(typeof projectAgentLoopTrace, "function");
  assert.equal(name, "dsh-home-snapshot-tool");
  assert.deepEqual(inject, ["tools", "homeWorld"]);
  assert.deepEqual(projectHomeSnapshot(undefined), {
    spaces: [],
    devices: [],
    bridgeWatermarks: [],
    metrics: { consistency: [], eventActivity: [], connectionActivity: [] },
    topology: { spaces: 0, totalDevices: 0, devicesWithSingleSpace: 0, devicesWithoutSpace: 0, devicesWithMultipleSpaces: 0 },
  });
  assert.equal(typeof pageHomeRules, "function");
  assert.equal(typeof pageHomeInventory, "function");
});
