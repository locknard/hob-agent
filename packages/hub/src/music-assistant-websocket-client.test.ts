import assert from "node:assert/strict";
import test from "node:test";

interface SocketLike {
  readonly sent: readonly unknown[];
  readonly closed: boolean;
  receive(message: unknown): void;
  send(data: string): void;
  close(): void;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
}

interface ClientModule {
  readonly MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION: number;
  readonly MusicAssistantWebSocketSearchClient: new (options: Record<string, unknown>) => {
    search(input: {
      readonly query: string;
      readonly mediaTypes: readonly string[];
      readonly limit: number;
      readonly signal: AbortSignal;
    }): Promise<unknown>;
    dispose(): void | Promise<void>;
  };
  readonly probeMusicAssistantEndpoint: (options: Record<string, unknown>) => Promise<unknown>;
  readonly toMusicAssistantWebSocketUrl: (baseUrl: string) => string;
}

async function loadClient(): Promise<ClientModule> {
  try {
    const loaded = await import("./music-assistant-websocket-client.js") as unknown as Partial<ClientModule>;
    if (typeof loaded.MusicAssistantWebSocketSearchClient !== "function"
      || typeof loaded.probeMusicAssistantEndpoint !== "function"
      || typeof loaded.toMusicAssistantWebSocketUrl !== "function"
      || !Number.isSafeInteger(loaded.MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION)) {
      throw new Error("Music Assistant WebSocket client exports are incomplete");
    }
    return loaded as ClientModule;
  } catch (error) {
    assert.fail(`Music Assistant WebSocket client is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class FakeSocket implements SocketLike {
  readonly sent: unknown[] = [];
  closed = false;
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

const SERVER_INFO = {
  server_id: "server-private-id",
  server_version: "2.9.10",
  schema_version: 46,
  min_supported_schema_version: 28,
  base_url: "http://private.internal:8095",
  homeassistant_addon: true,
  onboard_done: true,
  name: "Private Music",
  status: "running",
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("normalizes only explicit local HTTP or HTTPS Music Assistant WebSocket URLs", async () => {
  const { toMusicAssistantWebSocketUrl } = await loadClient();
  assert.equal(toMusicAssistantWebSocketUrl("http://mass.local:8095"), "ws://mass.local:8095/ws");
  assert.equal(toMusicAssistantWebSocketUrl("http://192.168.100.20:8095/"), "ws://192.168.100.20:8095/ws");
  assert.equal(toMusicAssistantWebSocketUrl("https://music.example.test/prefix"), "wss://music.example.test/prefix/ws");
  assert.equal(toMusicAssistantWebSocketUrl("https://music.example.test/ws"), "wss://music.example.test/ws");
  for (const unsafe of [
    "http://public.example.com:8095",
    "https://user:password@music.example.test",
    "https://music.example.test/path?token=secret",
    "file:///private/music",
  ]) assert.throws(() => toMusicAssistantWebSocketUrl(unsafe), /Music Assistant URL/i);
});

test("preflights bounded server info without resolving or sending a credential", async () => {
  const { MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION, probeMusicAssistantEndpoint } = await loadClient();
  assert.equal(MUSIC_ASSISTANT_CLIENT_SCHEMA_VERSION, 46);
  const socket = new FakeSocket();
  let now = 1_000;
  const probing = probeMusicAssistantEndpoint({
    baseUrl: "http://mass.local:8095",
    socketFactory: () => socket,
    clock: () => now,
  });
  now = 1_042;
  socket.receive(SERVER_INFO);
  assert.deepEqual(await probing, {
    status: "credential_required",
    schemaVersion: 46,
    serverVersion: "2.9.10",
    latencyMs: 42,
  });
  assert.deepEqual(socket.sent, []);
  assert.equal(socket.closed, true);
});

test("authenticates one short-lived socket and exposes only music/search", async () => {
  const { MusicAssistantWebSocketSearchClient } = await loadClient();
  const socket = new FakeSocket();
  const resolvedSignals: AbortSignal[] = [];
  const client = new MusicAssistantWebSocketSearchClient({
    baseUrl: "http://mass.local:8095",
    resolveToken: async (signal: AbortSignal) => {
      resolvedSignals.push(signal);
      return "private-long-lived-token";
    },
    socketFactory: () => socket,
    messageIdFactory: (() => {
      const ids = ["auth-message-0001", "search-message-01"];
      return () => ids.shift();
    })(),
  });
  const signal = new AbortController().signal;
  const searching = client.search({ query: "jazz", mediaTypes: ["track", "playlist"], limit: 3, signal });
  assert.deepEqual(socket.sent, []);
  socket.receive(SERVER_INFO);
  await flush();
  assert.equal(resolvedSignals.length, 1);
  assert.equal(resolvedSignals[0]?.aborted, false);
  assert.deepEqual(socket.sent, [{
    message_id: "auth-message-0001",
    command: "auth",
    args: { token: "private-long-lived-token" },
  }]);
  socket.receive({
    message_id: "auth-message-0001",
    result: { authenticated: true, user: { user_id: "private-user-id", name: "Private User" } },
    partial: false,
  });
  await flush();
  assert.deepEqual(socket.sent[1], {
    message_id: "search-message-01",
    command: "music/search",
    args: {
      search_query: "jazz",
      media_types: ["track", "playlist"],
      limit: 3,
      library_only: false,
    },
  });
  const rawResult = { tracks: [{ uri: "library://track/1" }], playlists: [] };
  socket.receive({ message_id: "search-message-01", result: rawResult, partial: false });
  assert.deepEqual(await searching, rawResult);
  assert.equal(socket.closed, true);
  assert.equal(JSON.stringify(client).includes("private-long-lived-token"), false);
  await client.dispose();
});

test("fails closed with redacted errors and aborts every in-flight search on disposal", async () => {
  const { MusicAssistantWebSocketSearchClient } = await loadClient();
  const sockets: FakeSocket[] = [];
  let credentialReads = 0;
  const client = new MusicAssistantWebSocketSearchClient({
    baseUrl: "https://music.example.test",
    resolveToken: async () => {
      credentialReads += 1;
      return "private-long-lived-token";
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    messageIdFactory: () => "bounded-message-01",
  });
  const incompatible = client.search({
    query: "jazz",
    mediaTypes: ["track"],
    limit: 1,
    signal: new AbortController().signal,
  });
  sockets[0]?.receive({ ...SERVER_INFO, min_supported_schema_version: 47 });
  await assert.rejects(incompatible, (error: unknown) => (
    error instanceof Error
      && /Music Assistant search failed/i.test(error.message)
      && !error.message.includes("private")
  ));
  assert.equal(credentialReads, 0);

  const pending = client.search({
    query: "ambient",
    mediaTypes: ["playlist"],
    limit: 1,
    signal: new AbortController().signal,
  });
  sockets[1]?.receive(SERVER_INFO);
  await flush();
  await client.dispose();
  await assert.rejects(pending, /Music Assistant search failed/i);
  assert.equal(sockets[1]?.closed, true);
  await client.dispose();

  const constructionFailure = new MusicAssistantWebSocketSearchClient({
    baseUrl: "https://music.example.test",
    resolveToken: async () => "private-long-lived-token",
    socketFactory: () => {
      throw new Error("dial failed for https://music.example.test?token=private-long-lived-token");
    },
  });
  await assert.rejects(
    constructionFailure.search({
      query: "jazz",
      mediaTypes: ["track"],
      limit: 1,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "Music Assistant search failed",
  );
});

test("does not open a socket for an already-cancelled or over-capacity search", async () => {
  const { MusicAssistantWebSocketSearchClient } = await loadClient();
  const sockets: FakeSocket[] = [];
  const client = new MusicAssistantWebSocketSearchClient({
    baseUrl: "https://music.example.test",
    resolveToken: async () => "private-long-lived-token",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(client.search({
    query: "jazz",
    mediaTypes: ["track"],
    limit: 1,
    signal: cancelled.signal,
  }), /Music Assistant search failed/i);
  assert.equal(sockets.length, 0);

  const pending = Array.from({ length: 4 }, (_, index) => client.search({
    query: `jazz ${index}`,
    mediaTypes: ["track"],
    limit: 1,
    signal: new AbortController().signal,
  }));
  assert.equal(sockets.length, 4);
  await assert.rejects(client.search({
    query: "one too many",
    mediaTypes: ["track"],
    limit: 1,
    signal: new AbortController().signal,
  }), /Music Assistant search failed/i);
  assert.equal(sockets.length, 4);
  await client.dispose();
  await Promise.allSettled(pending);
});
