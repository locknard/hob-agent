import assert from "node:assert/strict";
import test from "node:test";

import { ProductHttpHost } from "./product-http-host.js";

test("serves exactly one loopback handler and switches it atomically", async () => {
  const host = new ProductHttpHost({ port: 0 });
  await host.listen();

  try {
    assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const unavailable = await fetch(`${host.origin}/`);
    assert.equal(unavailable.status, 503);

    host.switchTo((_request, response) => {
      response.statusCode = 200;
      response.end("setup");
    });
    assert.equal(await (await fetch(`${host.origin}/`)).text(), "setup");

    host.switchTo((_request, response) => {
      response.statusCode = 200;
      response.end("operational");
    });
    assert.equal(await (await fetch(`${host.origin}/`)).text(), "operational");
  } finally {
    await host.dispose();
  }
});

test("rejects an invalid listener port before it creates a server", () => {
  assert.throws(() => new ProductHttpHost({ port: -1 }), /integer from 0 to 65535/i);
});
