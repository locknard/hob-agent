import assert from "node:assert/strict";
import test from "node:test";

import { Context, Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

interface ToolModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: CordisContext) => void;
}

async function loadTool(): Promise<ToolModule> {
  try {
    const loaded = await import("./dsh-home-media-conversation-tool.js") as unknown as Partial<ToolModule>;
    if (loaded.name !== "dsh-home-media-conversation-tool"
      || !Array.isArray(loaded.inject)
      || typeof loaded.apply !== "function") {
      throw new Error("home media conversation tool exports are incomplete");
    }
    return loaded as ToolModule;
  } catch (error) {
    assert.fail(`home media conversation tool is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class StubConversation extends Service {
  readonly calls: unknown[] = [];

  constructor(ctx: Context) { super(ctx, "homeMediaConversation"); }

  async handle(input: unknown) {
    this.calls.push(input);
    const operation = (input as { readonly operation: string }).operation;
    if (operation === "search") {
      return {
        status: "clarification",
        slot: "mediaRef",
        reason: "ambiguous",
        options: [{ mediaRef: "opaqueMediaRef0001", title: "晚间爵士", sourceLabel: "家庭音乐库", playable: true }],
      };
    }
    if (operation === "prepare") {
      return {
        status: "prepared",
        intent: {
          kind: "play_media",
          playerCapabilityId: "hwc-media-room",
          mediaRef: "opaqueMediaRef0001",
          queueMode: "play_next",
        },
      };
    }
    return {
      status: "pending_confirmation",
      ticketId: "action-ticket-1",
      policyClass: "confirmation",
      intent: {
        kind: "play_media",
        playerCapabilityId: "hwc-media-room",
        mediaRef: "opaqueMediaRef0001",
        queueMode: "replace_and_play",
      },
    };
  }
}

test("exposes one bounded media conversation tool with closed clarification and exact references", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubConversation);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ["home_media_conversation"]);
    const definition = ctx.tools.get("home_media_conversation");
    assert.ok(definition);
    assert.match(definition.description, /clarification/i);
    assert.match(definition.description, /opaque.*mediaRef/i);
    assert.match(definition.description, /ticket/i);
    assert.match(definition.description, /does not.*(?:authenticate|identity)/i);
    assert.deepEqual(
      Object.keys(definition.parameters.properties as Record<string, unknown>).sort(),
      ["mediaRef", "operation", "playerCapabilityId", "query", "queueMode", "requestId"],
    );

    const search = await ctx.tools.execute({
      callId: "media-conversation-search" as never,
      name: "home_media_conversation",
      arguments: { operation: "search", query: "爵士" },
      signal: new AbortController().signal,
    });
    assert.equal(search.isError, false);
    const clarification = search.content.find((item) => item.type === "text");
    assert.ok(clarification && clarification.type === "text");
    assert.deepEqual(JSON.parse(clarification.text), {
      status: "clarification",
      slot: "mediaRef",
      reason: "ambiguous",
      options: [{ mediaRef: "opaqueMediaRef0001", title: "晚间爵士", sourceLabel: "家庭音乐库", playable: true }],
    });

    const prepare = await ctx.tools.execute({
      callId: "media-conversation-prepare" as never,
      name: "home_media_conversation",
      arguments: {
        operation: "prepare",
        mediaRef: "opaqueMediaRef0001",
        playerCapabilityId: "hwc-media-room",
        queueMode: "play_next",
      },
      signal: new AbortController().signal,
    });
    assert.equal(prepare.isError, false);

    const request = await ctx.tools.execute({
      callId: "media-conversation-request" as never,
      name: "home_media_conversation",
      arguments: {
        operation: "request_action",
        requestId: "media-request-1",
        mediaRef: "opaqueMediaRef0001",
        playerCapabilityId: "hwc-media-room",
        queueMode: "replace_and_play",
      },
      signal: new AbortController().signal,
    });
    assert.equal(request.isError, false);
    const action = request.content.find((item) => item.type === "text");
    assert.ok(action && action.type === "text");
    assert.deepEqual(JSON.parse(action.text), {
      status: "pending_confirmation",
      ticketId: "action-ticket-1",
      policyClass: "confirmation",
      intent: {
        kind: "play_media",
        playerCapabilityId: "hwc-media-room",
        mediaRef: "opaqueMediaRef0001",
        queueMode: "replace_and_play",
      },
    });
    const calls = ctx.homeMediaConversation.calls as Array<Record<string, unknown>>;
    assert.deepEqual(calls.map(({ signal: _signal, ...call }) => call), [
      { operation: "search", query: "爵士" },
      {
        operation: "prepare",
        mediaRef: "opaqueMediaRef0001",
        playerCapabilityId: "hwc-media-room",
        queueMode: "play_next",
      },
      {
        operation: "request_action",
        requestId: "media-request-1",
        mediaRef: "opaqueMediaRef0001",
        playerCapabilityId: "hwc-media-room",
        queueMode: "replace_and_play",
      },
    ]);
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});

test("rejects non-opaque refs, missing slots, hidden actor fields and confirmation operations before Hub", async () => {
  const { apply, inject, name } = await loadTool();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(StubConversation);
  const fiber = await ctx.plugin({ name, inject, apply });
  try {
    for (const argumentsValue of [
      { operation: "prepare", mediaRef: "https://provider.invalid/jazz", playerCapabilityId: "hwc-media-room", queueMode: "play_next" },
      { operation: "prepare", mediaRef: "opaqueMediaRef0001", playerCapabilityId: "hwc-media-room", queueMode: "play" },
      { operation: "request_action", requestId: "request-1", mediaRef: "opaqueMediaRef0001", playerCapabilityId: "hwc-media-room", queueMode: "replace_and_play", actor: { principalId: "admin" } },
      { operation: "confirm", ticketId: "action-ticket-1", actor: { principalId: "admin" } },
      { operation: "search" },
    ]) {
      const result = await ctx.tools.execute({
        callId: `media-conversation-invalid-${JSON.stringify(argumentsValue)}` as never,
        name: "home_media_conversation",
        arguments: argumentsValue,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true, `accepted invalid conversation arguments ${JSON.stringify(argumentsValue)}`);
    }
    assert.deepEqual(ctx.homeMediaConversation.calls, []);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
