import assert from "node:assert/strict";
import test from "node:test";

import { ADVICE_CLIENT_JS } from "./advice-client.js";

test("ships a same-origin advice stream client with safe reconnect and progress hooks", () => {
  assert.match(ADVICE_CLIENT_JS, /EventSource/);
  assert.match(ADVICE_CLIENT_JS, /data-advice-events/);
  assert.match(ADVICE_CLIENT_JS, /Last-Event-ID|lastEventId/i);
  assert.match(ADVICE_CLIENT_JS, /answer_delta/);
  assert.match(ADVICE_CLIENT_JS, /textContent/);
  assert.match(ADVICE_CLIENT_JS, /data-advice-stage/);
  assert.match(ADVICE_CLIENT_JS, /completedStages/);
  assert.equal(ADVICE_CLIENT_JS.includes("const complete = !reached && !current"), false);
  assert.match(ADVICE_CLIENT_JS, /Retrying|reconnect/i);
  assert.equal(ADVICE_CLIENT_JS.includes("innerHTML"), false);
  assert.equal(ADVICE_CLIENT_JS.includes("eval("), false);
});
