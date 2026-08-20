/**
 * One describe block per ergonomics behaviour (E1–E6).
 *
 * These are the reference assertions the other three SDKs are ported against —
 * if a behaviour is not pinned here, it will drift in C#, Dart and C++.
 */

import { describe, expect, it, vi } from "vitest";

import { Magicweave, connect } from "../src/client.js";
import {
  IdempotencyConflictError,
  InsufficientBalanceError,
  MagicweaveApiError,
  MagicweaveConfigError,
  MagicweaveNetworkError,
  MagicweaveQueuedError,
  RateLimitedError,
  ValidationError,
} from "../src/errors.js";
import { RealtimeClient } from "../src/realtime.js";
import { silentLogger } from "../src/storage.js";
import type { MagicweaveConfig, WebSocketLike } from "../src/types.js";
import {
  FakeApi,
  InspectableStorage,
  errorBody,
  noSleep,
  seededIds,
} from "./harness.js";

function makeClient(api: FakeApi, overrides: Partial<MagicweaveConfig> = {}) {
  return new Magicweave({
    clientId: "cid",
    clientSecret: "csec",
    baseUrl: "https://api.example.test",
    fetch: api.fetch,
    logger: silentLogger,
    sleep: noSleep,
    newId: seededIds("key"),
    ...overrides,
  });
}

// ── E1 ──────────────────────────────────────────────────────────────────────

describe("E1 · connect once", () => {
  it("uses the root when /healthz says client-api", async () => {
    const api = new FakeApi().on("GET /wallet", { body: { gems: 5 } });
    const mw = makeClient(api);

    await expect(mw.wallet.get()).resolves.toEqual({ gems: 5 });
    expect(api.lastOf("GET /wallet")?.url).toBe("https://api.example.test/wallet");
  });

  it("finds the /client prefix on a combined deployment without being told", async () => {
    const api = new FakeApi().combined().on("GET /wallet", { body: { gems: 7 } });
    const mw = makeClient(api);

    await expect(mw.wallet.get()).resolves.toEqual({ gems: 7 });
    // The recorded path is normalised, so assert on the URL actually fetched.
    expect(api.lastOf("GET /wallet")?.url).toBe("https://api.example.test/client/wallet");
  });

  it("probes only once no matter how many calls race", async () => {
    const api = new FakeApi();
    const probe = vi.spyOn(api, "fetch" as never);
    const mw = makeClient(api);

    await Promise.all([mw.wallet.get(), mw.stats.get(), mw.shop.list()]);

    const healthProbes = probe.mock.calls.filter(([url]) => String(url).endsWith("/healthz"));
    expect(healthProbes).toHaveLength(1);
  });

  it("falls back to the configured base when the probe fails", async () => {
    const api = new FakeApi();
    const failingProbe: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/healthz")) throw new TypeError("offline");
      return api.fetch(input, init);
    }) as typeof fetch;

    const mw = makeClient(api, { fetch: failingProbe });
    await expect(mw.wallet.get()).resolves.toBeDefined();
  });

  it("refuses to construct without credentials", () => {
    expect(() => makeClient(new FakeApi(), { clientId: "" })).toThrow(MagicweaveConfigError);
    expect(() => makeClient(new FakeApi(), { baseUrl: "" })).toThrow(MagicweaveConfigError);
  });

  it("requires an external user id in external mode", () => {
    expect(() => makeClient(new FakeApi(), { mode: "external" })).toThrow(
      MagicweaveConfigError,
    );
  });
});

// ── headers ─────────────────────────────────────────────────────────────────

describe("headers", () => {
  it("sends the environment credentials and identifies the SDK", async () => {
    const api = new FakeApi();
    await makeClient(api).wallet.get();

    const headers = api.lastOf("GET /wallet")?.headers ?? {};
    expect(headers["x-client-id"]).toBe("cid");
    expect(headers["x-client-secret"]).toBe("csec");
    expect(headers["x-mw-sdk"]).toMatch(/^typescript\/\d+\.\d+\.\d+$/);
  });

  it("sends x-external-user-id instead of a bearer in external mode", async () => {
    const api = new FakeApi();
    const mw = makeClient(api, { mode: "external", externalUserId: "player-9" });
    await mw.wallet.get();

    const headers = api.lastOf("GET /wallet")?.headers ?? {};
    expect(headers["x-external-user-id"]).toBe("player-9");
    expect(headers.authorization).toBeUndefined();
  });
});

// ── E2 ──────────────────────────────────────────────────────────────────────

describe("E2 · a session that survives", () => {
  const tokens = { access_token: "access-1", refresh_token: "refresh-1" };

  it("stores tokens on sign-in and sends them as a bearer", async () => {
    const api = new FakeApi().on("POST /auth/otp/verify", { body: tokens });
    const storage = new InspectableStorage();
    const mw = makeClient(api, { storage });

    await mw.auth.verifyOtp("p@example.test", "123456");
    await mw.wallet.get();

    expect(mw.isSignedIn).toBe(true);
    expect(api.lastOf("GET /wallet")?.headers.authorization).toBe("Bearer access-1");
    expect(storage.find("access_token")).toBe("access-1");
  });

  it("restores a session from storage across a restart", async () => {
    const api = new FakeApi().on("POST /auth/otp/verify", { body: tokens });
    const storage = new InspectableStorage();

    await makeClient(api, { storage }).auth.verifyOtp("p@example.test", "123456");

    // A brand new client — same device, new process.
    const revived = makeClient(api, { storage });
    await revived.init();
    expect(revived.isSignedIn).toBe(true);

    await revived.wallet.get();
    expect(api.lastOf("GET /wallet")?.headers.authorization).toBe("Bearer access-1");
  });

  it("refreshes on 401 and replays the original request", async () => {
    const api = new FakeApi()
      .on("POST /auth/otp/verify", { body: tokens })
      .on("POST /auth/refresh", { body: { access_token: "access-2" } })
      .sequence("GET /wallet", [
        { status: 401, body: errorBody("token_expired", "expired", 401) },
        { status: 200, body: { gems: 3 } },
      ]);

    const mw = makeClient(api);
    await mw.auth.verifyOtp("p@example.test", "123456");

    await expect(mw.wallet.get()).resolves.toEqual({ gems: 3 });
    expect(api.countOf("POST /auth/refresh")).toBe(1);
    expect(api.countOf("GET /wallet")).toBe(2);
    expect(api.lastOf("GET /wallet")?.headers.authorization).toBe("Bearer access-2");
  });

  it("refreshes exactly once when several requests get 401 together", async () => {
    let refreshed = false;
    const api = new FakeApi()
      .on("POST /auth/otp/verify", { body: tokens })
      .on("POST /auth/refresh", () => {
        refreshed = true;
        return { body: { access_token: "access-2" } };
      })
      .on(/^GET \/(wallet|stats|shop)/, () =>
        refreshed
          ? { status: 200, body: { ok: true } }
          : { status: 401, body: errorBody("token_expired", "expired", 401) },
      );

    const mw = makeClient(api);
    await mw.auth.verifyOtp("p@example.test", "123456");

    await Promise.all([mw.wallet.get(), mw.stats.get(), mw.shop.list()]);
    expect(api.countOf("POST /auth/refresh")).toBe(1);
  });

  it("clears the session when the refresh token itself is rejected", async () => {
    const api = new FakeApi()
      .on("POST /auth/otp/verify", { body: tokens })
      .on("POST /auth/refresh", {
        status: 401,
        body: errorBody("unauthenticated", "dead", 401),
      })
      .on("GET /wallet", { status: 401, body: errorBody("token_expired", "expired", 401) });

    const mw = makeClient(api);
    await mw.auth.verifyOtp("p@example.test", "123456");

    await expect(mw.wallet.get()).rejects.toBeInstanceOf(MagicweaveApiError);
    expect(mw.isSignedIn).toBe(false);
  });

  it("does not attempt a refresh for anonymous auth calls", async () => {
    const api = new FakeApi().on("POST /auth/login", {
      status: 401,
      body: errorBody("invalid_credentials", "nope", 401),
    });

    await expect(makeClient(api).auth.login("p@example.test", "wrong")).rejects.toThrow();
    expect(api.countOf("POST /auth/refresh")).toBe(0);
  });
});

// ── E3 ──────────────────────────────────────────────────────────────────────

describe("E3 · crash-safe writes", () => {
  it("persists the write before sending it", async () => {
    const storage = new InspectableStorage();
    const order: string[] = [];
    const api = new FakeApi().on("POST /shop/pack/purchase", () => {
      order.push("sent");
      return { body: { ok: true } };
    });
    const originalSet = storage.set.bind(storage);
    storage.set = async (key, value) => {
      if (key.endsWith("write_queue")) order.push("persisted");
      return originalSet(key, value);
    };

    await makeClient(api, { storage }).shop.purchase("pack");
    expect(order).toEqual(["persisted", "sent"]);
  });

  it("sends the idempotency key in the header for shop and inventory", async () => {
    const api = new FakeApi();
    await makeClient(api).shop.purchase("pack");

    expect(api.lastOf("POST /shop/pack/purchase")?.headers["idempotency-key"]).toBe("key-1");
  });

  it("sends the idempotency key in the body for /game writes", async () => {
    const api = new FakeApi();
    await makeClient(api).game.record({ score: 10 });

    const request = api.lastOf("POST /game/record");
    expect(request?.headers["idempotency-key"]).toBeUndefined();
    expect(request?.body).toEqual({ score: 10, idempotency_key: "key-1" });
  });

  it("reuses the same key across retries, so a retry cannot double-apply", async () => {
    const api = new FakeApi().sequence("POST /shop/pack/purchase", [
      { status: 503, body: errorBody("unavailable", "down", 503) },
      { status: 200, body: { ok: true } },
    ]);

    await makeClient(api).shop.purchase("pack");

    const keys = api.requests
      .filter((r) => r.path === "/shop/pack/purchase")
      .map((r) => r.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("replays a crashed write with its original key on the next launch", async () => {
    const storage = new InspectableStorage();

    // First "process": the write is persisted, then the network dies.
    const dying = new FakeApi().on("POST /shop/pack/purchase", { networkError: true });
    await expect(makeClient(dying, { storage }).shop.purchase("pack")).rejects.toBeInstanceOf(
      MagicweaveQueuedError,
    );
    const persistedKey = dying.lastOf("POST /shop/pack/purchase")?.headers["idempotency-key"];

    // Second "process": same storage, working network.
    const revived = new FakeApi().on("POST /shop/pack/purchase", { body: { ok: true } });
    await makeClient(revived, { storage, newId: seededIds("fresh") }).init();

    expect(revived.countOf("POST /shop/pack/purchase")).toBe(1);
    expect(revived.lastOf("POST /shop/pack/purchase")?.headers["idempotency-key"]).toBe(
      persistedKey,
    );
  });

  it("honours a caller-supplied key so two calls are one operation", async () => {
    const api = new FakeApi();
    const mw = makeClient(api);

    await mw.shop.purchase("pack", { idempotencyKey: "checkout-42" });
    await mw.shop.purchase("pack", { idempotencyKey: "checkout-42" });

    const keys = api.requests
      .filter((r) => r.path === "/shop/pack/purchase")
      .map((r) => r.headers["idempotency-key"]);
    expect(keys).toEqual(["checkout-42", "checkout-42"]);
  });

  it("does not queue reads", async () => {
    const storage = new InspectableStorage();
    await makeClient(new FakeApi(), { storage }).wallet.get();
    expect(storage.find("write_queue")).toBeUndefined();
  });

  it("warns when the server had to generate the key", async () => {
    const warn = vi.fn();
    const api = new FakeApi().on("POST /shop/pack/purchase", {
      body: { ok: true },
      headers: { "x-mw-idempotency-generated": "true" },
    });

    await makeClient(api, {
      logger: { ...silentLogger, warn },
      durableWrites: false,
    }).shop.purchase("pack");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not retry-safe"));
  });
});

// ── E4 ──────────────────────────────────────────────────────────────────────

describe("E4 · offline queue", () => {
  it("keeps an undeliverable write and reports it as queued", async () => {
    const api = new FakeApi().on("POST /shop/pack/purchase", { networkError: true });
    const mw = makeClient(api);

    await expect(mw.shop.purchase("pack")).rejects.toBeInstanceOf(MagicweaveQueuedError);
    expect(await mw.pendingWrites()).toBe(1);
  });

  it("drains in order when connectivity returns", async () => {
    const storage = new InspectableStorage();
    const offline = new FakeApi().default({ networkError: true });
    const mw = makeClient(offline, { storage });

    await expect(mw.currency.balances()).rejects.toBeInstanceOf(MagicweaveNetworkError);
    await expect(mw.shop.purchase("a")).rejects.toBeInstanceOf(MagicweaveQueuedError);
    await expect(mw.shop.purchase("b")).rejects.toBeInstanceOf(MagicweaveQueuedError);
    expect(await mw.pendingWrites()).toBe(2);

    const online = new FakeApi();
    const reconnected = makeClient(online, { storage });
    const sent: string[] = [];
    reconnected.onQueue("sent", ({ entry }) => sent.push(entry.path));

    await reconnected.flush();

    expect(sent).toEqual(["/shop/a/purchase", "/shop/b/purchase"]);
    expect(await reconnected.pendingWrites()).toBe(0);
  });

  it("drops a permanently-failing write instead of wedging the queue behind it", async () => {
    const storage = new InspectableStorage();
    const offline = new FakeApi().default({ networkError: true });
    const mw = makeClient(offline, { storage });

    await expect(mw.shop.purchase("broken")).rejects.toBeInstanceOf(MagicweaveQueuedError);
    await expect(mw.shop.purchase("fine")).rejects.toBeInstanceOf(MagicweaveQueuedError);

    const online = new FakeApi()
      .on("POST /shop/broken/purchase", {
        status: 422,
        body: errorBody("validation_error", "no such listing", 422),
      })
      .on("POST /shop/fine/purchase", { body: { ok: true } });

    const reconnected = makeClient(online, { storage });
    const failed: string[] = [];
    const sent: string[] = [];
    reconnected.onQueue("failed", ({ entry }) => failed.push(entry.path));
    reconnected.onQueue("sent", ({ entry }) => sent.push(entry.path));

    await reconnected.flush();

    expect(failed).toEqual(["/shop/broken/purchase"]);
    expect(sent).toEqual(["/shop/fine/purchase"]);
    expect(await reconnected.pendingWrites()).toBe(0);
  });

  it("stops at the first still-failing entry rather than reordering", async () => {
    const storage = new InspectableStorage();
    const offline = new FakeApi().default({ networkError: true });
    const mw = makeClient(offline, { storage });
    await expect(mw.shop.purchase("first")).rejects.toBeInstanceOf(MagicweaveQueuedError);
    await expect(mw.shop.purchase("second")).rejects.toBeInstanceOf(MagicweaveQueuedError);

    const partial = new FakeApi()
      .on("POST /shop/first/purchase", { status: 503, body: errorBody("unavailable", "x", 503) })
      .on("POST /shop/second/purchase", { body: { ok: true } });

    const reconnected = makeClient(partial, { storage });
    await reconnected.flush();

    expect(partial.countOf("POST /shop/second/purchase")).toBe(0);
    expect(await reconnected.pendingWrites()).toBe(2);
  });

  it("survives a corrupt queue rather than replaying garbage forever", async () => {
    const storage = new InspectableStorage();
    storage.map.set("mw:cid:write_queue", "{not json");

    const mw = makeClient(new FakeApi(), { storage });
    await expect(mw.flush()).resolves.toBeUndefined();
    expect(await mw.pendingWrites()).toBe(0);
  });

  it("can be turned off for callers who want fire-and-forget", async () => {
    const storage = new InspectableStorage();
    const api = new FakeApi().on("POST /shop/pack/purchase", { networkError: true });

    await expect(
      makeClient(api, { storage, durableWrites: false }).shop.purchase("pack"),
    ).rejects.toBeInstanceOf(MagicweaveNetworkError);
    expect(storage.find("write_queue")).toBeUndefined();
  });
});

// ── E5 ──────────────────────────────────────────────────────────────────────

describe("E5 · retry and backoff", () => {
  it("retries 5xx and network failures", async () => {
    const api = new FakeApi().sequence("GET /wallet", [
      { status: 503, body: errorBody("unavailable", "x", 503) },
      { networkError: true },
      { status: 200, body: { gems: 1 } },
    ]);

    await expect(makeClient(api).wallet.get()).resolves.toEqual({ gems: 1 });
    expect(api.countOf("GET /wallet")).toBe(3);
  });

  it("never retries a 4xx the server will reject identically", async () => {
    const api = new FakeApi().on("GET /wallet", {
      status: 404,
      body: errorBody("not_found", "no wallet", 404),
    });

    await expect(makeClient(api).wallet.get()).rejects.toBeInstanceOf(MagicweaveApiError);
    expect(api.countOf("GET /wallet")).toBe(1);
  });

  it("gives up after maxAttempts", async () => {
    const api = new FakeApi().default({ status: 500, body: errorBody("server_error", "x", 500) });

    await expect(
      makeClient(api, { retry: { maxAttempts: 2 } }).wallet.get(),
    ).rejects.toBeInstanceOf(MagicweaveApiError);
    expect(api.countOf("GET /wallet")).toBe(2);
  });

  it("honours Retry-After when the server starts sending it", async () => {
    const slept: number[] = [];
    const api = new FakeApi().sequence("GET /wallet", [
      {
        status: 429,
        body: errorBody("rate_limited", "slow down", 429),
        headers: { "retry-after": "2" },
      },
      { status: 200, body: { gems: 1 } },
    ]);

    await makeClient(api, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).wallet.get();

    expect(slept).toEqual([2000]);
  });

  it("backs off with jitter when there is no Retry-After", async () => {
    const slept: number[] = [];
    const api = new FakeApi().sequence("GET /wallet", [
      { status: 500, body: errorBody("server_error", "x", 500) },
      { status: 500, body: errorBody("server_error", "x", 500) },
      { status: 200, body: { gems: 1 } },
    ]);

    await makeClient(api, {
      retry: { baseDelayMs: 100, jitter: 0 },
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).wallet.get();

    expect(slept).toEqual([100, 200]);
  });
});

// ── errors ──────────────────────────────────────────────────────────────────

describe("typed errors", () => {
  it.each([
    ["insufficient_balance", 402, InsufficientBalanceError],
    ["idempotency_conflict", 409, IdempotencyConflictError],
    ["validation_error", 422, ValidationError],
    ["rate_limited", 429, RateLimitedError],
  ])("maps %s to its class", async (code, status, klass) => {
    const api = new FakeApi().on("GET /wallet", { status, body: errorBody(code, "m", status) });
    await expect(
      makeClient(api, { retry: { maxAttempts: 1 } }).wallet.get(),
    ).rejects.toBeInstanceOf(klass as never);
  });

  it("carries the server's context through", async () => {
    const api = new FakeApi().on("GET /wallet", {
      status: 402,
      body: {
        detail: "Insufficient gold",
        error: { code: "insufficient_balance", message: "Insufficient gold", status: 402, context: { currency: "gold" } },
      },
    });

    await makeClient(api)
      .wallet.get()
      .catch((error: InsufficientBalanceError) => {
        expect(error.context).toEqual({ currency: "gold" });
        expect(error.code).toBe("insufficient_balance");
      });
  });

  it("falls back to a status-derived code when the envelope is missing", async () => {
    const api = new FakeApi().on("GET /wallet", { status: 403, body: { detail: "nope" } });

    await makeClient(api)
      .wallet.get()
      .catch((error: MagicweaveApiError) => {
        expect(error.code).toBe("forbidden");
        expect(error.message).toBe("nope");
      });
  });

  it("treats an idempotency conflict as permanent, never retrying it", async () => {
    const api = new FakeApi().default({
      status: 409,
      body: errorBody("idempotency_conflict", "reused", 409),
    });

    await expect(makeClient(api).shop.purchase("pack")).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(api.countOf("POST /shop/pack/purchase")).toBe(1);
  });
});

// ── E6 ──────────────────────────────────────────────────────────────────────

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("E6 · realtime", () => {
  function socketClient() {
    FakeSocket.instances = [];
    return new RealtimeClient({
      url: "ws://api.example.test/realtime/ws",
      webSocket: FakeSocket as unknown as new (url: string) => WebSocketLike,
      logger: silentLogger,
      query: { client_id: "cid" },
      sleep: noSleep,
    });
  }

  it("subscribes on connect and delivers the init snapshot", async () => {
    const client = socketClient();
    const seen: unknown[] = [];
    client.subscribe("lobby/room-1", (value) => seen.push(value));
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      action: "subscribe",
      path: "lobby/room-1",
    });

    socket.deliver({ event: "init", path: "lobby/room-1", value: { players: [] } });
    expect(seen).toEqual([{ players: [] }]);
  });

  it("wakes a parent listener on a change beneath it", async () => {
    const client = socketClient();
    const seen: unknown[] = [];
    client.subscribe("lobby/room-1", (value) => seen.push(value));
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.deliver({ event: "change", path: "lobby/room-1/players/p2", value: "ready" });

    expect(seen).toEqual(["ready"]);
  });

  it("ignores a change on an unrelated sibling path", async () => {
    const client = socketClient();
    const seen: unknown[] = [];
    client.subscribe("lobby/room-1", (value) => seen.push(value));
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.deliver({ event: "change", path: "lobby/room-10/players", value: "nope" });

    expect(seen).toEqual([]);
  });

  it("replays every subscription after a reconnect", async () => {
    const client = socketClient();
    client.subscribe("a", () => {});
    client.subscribe("b", () => {});
    await Promise.resolve();

    const first = FakeSocket.instances[0] as FakeSocket;
    first.open();
    expect(first.sent).toHaveLength(2);

    first.close();
    await new Promise((r) => setTimeout(r, 0));

    const second = FakeSocket.instances[1] as FakeSocket;
    expect(second).toBeDefined();
    second.open();
    expect(second.sent.map((s) => JSON.parse(s).path).sort()).toEqual(["a", "b"]);
  });

  it("stops reconnecting once the caller closes it", async () => {
    const client = socketClient();
    client.subscribe("a", () => {});
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    client.close();
    await new Promise((r) => setTimeout(r, 5));

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("unsubscribes when the last listener for a path goes away", async () => {
    const client = socketClient();
    const stop = client.subscribe("a", () => {});
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    stop();

    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({
      action: "unsubscribe",
      path: "a",
    });
  });

  it("survives a listener that throws", async () => {
    const client = socketClient();
    const seen: unknown[] = [];
    client.subscribe("a", () => {
      throw new Error("boom");
    });
    client.subscribe("a", (value) => seen.push(value));
    await Promise.resolve();

    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.deliver({ event: "change", path: "a", value: 1 });

    expect(seen).toEqual([1]);
  });
});

// ── convenience ─────────────────────────────────────────────────────────────

describe("connect()", () => {
  it("initialises and drains before returning", async () => {
    const storage = new InspectableStorage();
    const offline = new FakeApi().default({ networkError: true });
    await expect(
      makeClient(offline, { storage }).shop.purchase("pack"),
    ).rejects.toBeInstanceOf(MagicweaveQueuedError);

    const online = new FakeApi();
    const mw = await connect({
      clientId: "cid",
      clientSecret: "csec",
      baseUrl: "https://api.example.test",
      fetch: online.fetch,
      logger: silentLogger,
      sleep: noSleep,
      storage,
    });

    expect(await mw.pendingWrites()).toBe(0);
    expect(online.countOf("POST /shop/pack/purchase")).toBe(1);
  });
});
