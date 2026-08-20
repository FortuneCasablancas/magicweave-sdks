/** Public configuration and the pluggable seams (storage, fetch, sockets, clock). */

/**
 * How players are identified on each call.
 *
 * - `network` — the project is a network project; the SDK holds an access/refresh
 *   token pair and sends `Authorization: Bearer`.
 * - `external` — the project is not a network project; the caller owns identity
 *   and the SDK sends `x-external-user-id`.
 *
 * This is the one place the distinction lives. Nothing above the transport has
 * to remember which kind of project it is talking to (behaviour E2).
 */
export type IdentityMode = "network" | "external";

/** Async key/value store the SDK uses for tokens and the durable write queue. */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  maxAttempts: number;
  /** Delay before the first retry, in ms. Doubles each attempt. */
  baseDelayMs: number;
  /** Ceiling for a single backoff delay, in ms. */
  maxDelayMs: number;
  /** Random fraction (0–1) added to each delay to avoid a thundering herd. */
  jitter: number;
}

export interface MagicweaveConfig {
  /** Environment client id, from the console's Environments page. */
  clientId: string;
  /** Environment client secret. Never ship this in a web build — proxy instead. */
  clientSecret: string;
  /**
   * API host, e.g. `https://api.magicweave.xyz`. The SDK probes `/healthz` once
   * to work out whether client routes live at the root or under `/client`
   * (behaviour E1), so a combined deployment needs no extra configuration.
   */
  baseUrl: string;
  /** Defaults to `network`. */
  mode?: IdentityMode;
  /** Required when `mode` is `external`; sent as `x-external-user-id`. */
  externalUserId?: string;

  /** Defaults to an in-memory store. Supply a real one to survive restarts. */
  storage?: Storage;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `globalThis.WebSocket`. Needed only for realtime. */
  webSocket?: WebSocketConstructorLike;
  logger?: Logger;
  retry?: Partial<RetryPolicy>;

  /**
   * Persist every write before sending it, so a crash mid-request cannot lose
   * the operation and a retry reuses the same idempotency key (E3 + E4).
   * Defaults to true. Turning it off makes writes fire-and-forget.
   */
  durableWrites?: boolean;
  /** Namespace for storage keys. Set this if two projects share one device store. */
  storageNamespace?: string;
  /** Overrides the `x-mw-sdk` platform tag. Defaults to `typescript`. */
  platform?: string;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable id generator, for tests. */
  newId?: () => string;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

/** A durably-persisted write awaiting delivery. */
export interface QueuedWrite {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  /** The idempotency key minted before the first send, reused by every retry. */
  idempotencyKey: string;
  /** Whether the key rides in the header or the request body. */
  keyTransport: "header" | "body";
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export type QueueEventName = "enqueued" | "sent" | "failed" | "drained";

export interface QueueEvent {
  entry: QueuedWrite;
  result?: unknown;
  error?: unknown;
}
