/**
 * The request path: behaviours E1 (connect once), E2 (session), E3 (crash-safe
 * writes), E4 (offline queue) and E5 (retry and backoff), in one place.
 *
 * Everything above this file — the resource wrappers — is a thin, typed naming
 * layer. All the judgment lives here.
 */

import {
  ErrorCode,
  MagicweaveApiError,
  MagicweaveAuthError,
  MagicweaveConfigError,
  MagicweaveNetworkError,
  MagicweaveQueuedError,
  RateLimitedError,
  type ApiErrorBody,
} from "./errors.js";
import { WriteQueue } from "./queue.js";
import { Session, type TokenPair } from "./session.js";
import { ForgivingStorage, MemoryStorage, silentLogger } from "./storage.js";
import type {
  Logger,
  MagicweaveConfig,
  QueuedWrite,
  RetryPolicy,
  Storage,
} from "./types.js";

export const SDK_VERSION = "0.1.0";

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: 0.3,
};

/** Endpoints that must not carry player auth, and must never be queued. */
const AUTH_PATHS = new Set([
  "/auth/signup",
  "/auth/login",
  "/auth/otp/request",
  "/auth/otp/verify",
  "/auth/google-signin",
  "/auth/apple-signin",
  "/auth/refresh",
  "/auth/resend-verification",
]);

/**
 * Writes that take the idempotency key in the request *body* rather than the
 * `Idempotency-Key` header. The client API is split this way — `/game` writes
 * use a body field, inventory and shop use the header — and hiding that split
 * is precisely the SDK's job.
 */
const BODY_KEY_PATH_PREFIXES = ["/game/"];

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Skip player auth (used by the auth endpoints themselves). */
  anonymous?: boolean;
  /** Treat as a mutating write: durable, idempotent, queueable. */
  write?: boolean;
  /**
   * Reuse a caller-supplied idempotency key. Pass the same value to make two
   * separate calls the *same* logical operation — the server returns the first
   * result rather than applying it twice.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class Transport {
  readonly session: Session;
  readonly queue: WriteQueue;

  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly storage: Storage;
  private readonly namespace: string;
  private readonly durableWrites: boolean;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  /** Resolved once by `/healthz` probing, then reused (E1). */
  private resolvedRoot: string | null = null;
  private rootProbe: Promise<string> | null = null;

  readonly logger: Logger;

  constructor(private readonly config: MagicweaveConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new MagicweaveConfigError(
        "clientId and clientSecret are required — copy them from the console's Environments page",
      );
    }
    if (!config.baseUrl) {
      throw new MagicweaveConfigError("baseUrl is required, e.g. https://api.magicweave.xyz");
    }
    if (config.mode === "external" && !config.externalUserId) {
      throw new MagicweaveConfigError(
        "externalUserId is required when mode is 'external' — it identifies the player",
      );
    }

    const rawFetch = config.fetch ?? globalThis.fetch;
    if (!rawFetch) {
      throw new MagicweaveConfigError(
        "no fetch implementation found — pass one via config.fetch",
      );
    }
    // Bind so an unbound `globalThis.fetch` does not lose its receiver.
    this.fetchImpl = rawFetch.bind(globalThis);

    this.logger = config.logger ?? silentLogger;
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    this.namespace = config.storageNamespace ?? `mw:${config.clientId}`;
    this.durableWrites = config.durableWrites ?? true;
    this.platform = config.platform ?? "typescript";
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = config.newId ?? defaultId;
    this.storage = new ForgivingStorage(config.storage ?? new MemoryStorage(), this.logger);

    this.session = new Session(this.storage, this.namespace, this.logger, (refreshToken) =>
      this.performRefresh(refreshToken),
    );

    this.queue = new WriteQueue(
      this.storage,
      this.namespace,
      this.logger,
      (entry) => this.sendQueued(entry),
      (error) => isRetryable(error),
    );
  }

  // ── E1: connect once ──────────────────────────────────────────────────────

  /**
   * Work out whether client routes sit at the root or under `/client`.
   *
   * The docs currently ask every developer to write this branch by hand. One
   * probe, cached for the process lifetime, and nobody has to think about it.
   * A probe that fails falls back to the configured base rather than blocking
   * startup — a wrong guess surfaces as a 404 on the first real call, which is
   * a better failure than refusing to start.
   */
  async root(): Promise<string> {
    if (this.resolvedRoot) return this.resolvedRoot;
    if (this.rootProbe) return this.rootProbe;

    const base = this.config.baseUrl.replace(/\/$/, "");
    this.rootProbe = (async () => {
      try {
        const service = await this.probeService(`${base}/healthz`);
        if (service === "client-api") return base;
        if (service === "admin-api") {
          const combined = `${base}/client`;
          if ((await this.probeService(`${combined}/healthz`)) === "client-api") {
            this.logger.debug("combined deployment detected, using /client prefix");
            return combined;
          }
        }
      } catch (error) {
        this.logger.warn("healthz probe failed, assuming standalone layout", error);
      }
      return base;
    })();

    this.resolvedRoot = await this.rootProbe;
    this.rootProbe = null;
    return this.resolvedRoot;
  }

  private async probeService(url: string): Promise<string | null> {
    const response = await this.fetchImpl(url, { method: "GET" });
    if (!response.ok) return null;
    const body = (await response.json()) as { service?: string };
    return body?.service ?? null;
  }

  // ── headers ───────────────────────────────────────────────────────────────

  private async headers(options: RequestOptions): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "x-client-id": this.config.clientId,
      "x-client-secret": this.config.clientSecret,
      "x-mw-sdk": `${this.platform}/${SDK_VERSION}`,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";

    if (!options.anonymous) {
      if ((this.config.mode ?? "network") === "external") {
        headers["x-external-user-id"] = this.config.externalUserId as string;
      } else {
        const token = await this.session.accessToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }
    }
    return headers;
  }

  private url(root: string, path: string, query?: RequestOptions["query"]): string {
    const url = `${root}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  // ── public entry points ───────────────────────────────────────────────────

  /** A read. Retried on transient failure; never queued. */
  async request<T>(options: RequestOptions): Promise<T> {
    if (options.write) return this.write<T>(options);
    return this.send<T>(options);
  }

  /**
   * A write: persisted before it is sent, and replayed with the same key.
   *
   * When the send cannot complete but could later, the entry stays queued and
   * this throws `MagicweaveQueuedError` — the operation is not lost, it just
   * has no result yet. Listen on `client.queue` for the eventual outcome.
   */
  async write<T>(options: RequestOptions): Promise<T> {
    const key = options.idempotencyKey ?? this.newId();
    const keyTransport = usesBodyKey(options.path) ? "body" : "header";

    if (!this.durableWrites) {
      return this.send<T>(options, key, keyTransport);
    }

    const entry: QueuedWrite = {
      id: this.newId(),
      method: options.method,
      path: options.path,
      body: options.body,
      idempotencyKey: key,
      keyTransport,
      createdAt: this.now(),
      attempts: 0,
    };

    // Persist BEFORE the first attempt. This ordering is the whole guarantee:
    // a crash after this line replays with the same key; a crash before it
    // means the write never happened at all.
    await this.queue.enqueue(entry);

    try {
      const result = await this.send<T>(options, key, keyTransport);
      await this.queue.remove(entry.id);
      return result;
    } catch (error) {
      if (isRetryable(error)) {
        entry.attempts = 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        this.logger.info(
          `${options.method} ${options.path} could not be delivered — queued for retry`,
        );
        throw new MagicweaveQueuedError(entry.id);
      }
      // A permanent failure will never succeed on replay, so it must not stay
      // in the queue blocking everything behind it.
      await this.queue.remove(entry.id);
      throw error;
    }
  }

  /** Drain anything left over from a previous session or a lost connection. */
  async flush(): Promise<void> {
    await this.queue.drain();
  }

  private async sendQueued(entry: QueuedWrite): Promise<unknown> {
    return this.send(
      { method: entry.method, path: entry.path, body: entry.body, write: true },
      entry.idempotencyKey,
      entry.keyTransport,
    );
  }

  // ── E5: the retry loop ────────────────────────────────────────────────────

  private async send<T>(
    options: RequestOptions,
    idempotencyKey?: string,
    keyTransport: "header" | "body" = "header",
  ): Promise<T> {
    const root = await this.root();
    let attempt = 0;
    let refreshed = false;

    for (;;) {
      attempt += 1;
      try {
        return await this.attempt<T>(root, options, idempotencyKey, keyTransport);
      } catch (error) {
        // E2: one silent refresh, then replay the original request.
        if (
          error instanceof MagicweaveAuthError &&
          !refreshed &&
          !options.anonymous &&
          (this.config.mode ?? "network") === "network" &&
          (error.code === ErrorCode.UNAUTHENTICATED || error.code === ErrorCode.TOKEN_EXPIRED)
        ) {
          refreshed = true;
          const tokens = await this.session.refresh();
          if (tokens) continue;
        }

        if (!isRetryable(error) || attempt >= this.retry.maxAttempts) throw error;

        const delay =
          error instanceof RateLimitedError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : backoffDelay(this.retry, attempt);
        this.logger.debug(
          `retrying ${options.method} ${options.path} in ${delay}ms (attempt ${attempt})`,
        );
        await this.sleep(delay);
      }
    }
  }

  private async attempt<T>(
    root: string,
    options: RequestOptions,
    idempotencyKey: string | undefined,
    keyTransport: "header" | "body",
  ): Promise<T> {
    const headers = await this.headers(options);
    let body = options.body;

    if (idempotencyKey) {
      if (keyTransport === "header") {
        headers["Idempotency-Key"] = idempotencyKey;
      } else {
        body = { ...(body as Record<string, unknown> | undefined), idempotency_key: idempotencyKey };
        headers["content-type"] = "application/json";
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(root, options.path, options.query), {
        method: options.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      throw new MagicweaveNetworkError(
        `${options.method} ${options.path} did not reach the API`,
        error,
      );
    }

    if (response.headers?.get?.("x-mw-idempotency-generated") === "true") {
      this.logger.warn(
        `${options.method} ${options.path} was sent without an idempotency key — ` +
          "this write is not retry-safe",
      );
    }

    if (response.status === 204) return undefined as T;

    const payload = await readJson(response);

    if (!response.ok) {
      const error = MagicweaveApiError.fromResponse(
        response.status,
        payload as ApiErrorBody,
        response.headers?.get?.("x-request-id") ?? undefined,
      );
      if (error instanceof RateLimitedError) {
        const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
        if (retryAfter !== undefined) {
          throw new RateLimitedError(
            error.status,
            error.code,
            error.message,
            error.context,
            error.requestId,
            retryAfter,
          );
        }
      }
      throw error;
    }

    return payload as T;
  }

  private async performRefresh(refreshToken: string): Promise<TokenPair> {
    const payload = await this.send<{ access_token?: string; refresh_token?: string }>(
      {
        method: "POST",
        path: "/auth/refresh",
        body: { refresh_token: refreshToken },
        anonymous: true,
      },
    );
    if (!payload?.access_token) {
      throw new MagicweaveAuthError(401, ErrorCode.TOKEN_EXPIRED, "Refresh returned no token");
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? refreshToken,
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function isAuthPath(path: string): boolean {
  return AUTH_PATHS.has(path);
}

export function usesBodyKey(path: string): boolean {
  return BODY_KEY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Transient failures only — never a 4xx the server will reject identically. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof MagicweaveNetworkError) return true;
  if (error instanceof MagicweaveApiError) return error.retryable;
  return false;
}

export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.round(capped * (1 + Math.random() * policy.jitter));
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

function defaultId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  // RN's Hermes has no randomUUID. This is not cryptographically strong, but an
  // idempotency key only has to be unique per device, not unguessable.
  return `mw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
