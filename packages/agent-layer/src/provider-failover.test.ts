import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProviderFailure,
  shouldRecordProfileFailure,
  shouldTryNextProfile,
} from "./provider-failover.js";

test("classifies provider failures without retaining raw provider messages", () => {
  assert.equal(classifyProviderFailure(new Error("HTTP 429 rate limit exceeded")), "rate_limit");
  assert.equal(classifyProviderFailure(new Error("401 invalid api key")), "auth");
  assert.equal(classifyProviderFailure(new Error("payment required / insufficient balance")), "billing");
  assert.equal(classifyProviderFailure(new Error("socket timeout")), "timeout");
  assert.equal(classifyProviderFailure(new Error("LibreSSL SSL_connect: SSL_ERROR_SYSCALL")), "network");
});

test("rotates profiles only for retryable provider failures", () => {
  assert.equal(shouldTryNextProfile("rate_limit"), true);
  assert.equal(shouldTryNextProfile("overloaded"), true);
  assert.equal(shouldTryNextProfile("auth"), false);
  assert.equal(shouldTryNextProfile("format"), false);
  assert.equal(shouldTryNextProfile("network"), false);
});

test("records only failures that describe the selected credential", () => {
  assert.equal(shouldRecordProfileFailure("auth"), true);
  assert.equal(shouldRecordProfileFailure("billing"), true);
  assert.equal(shouldRecordProfileFailure("rate_limit"), true);
  assert.equal(shouldRecordProfileFailure("overloaded"), false);
  assert.equal(shouldRecordProfileFailure("timeout"), false);
  assert.equal(shouldRecordProfileFailure("format"), false);
  assert.equal(shouldRecordProfileFailure("unknown"), false);
  assert.equal(shouldRecordProfileFailure("network"), false);
});
