/**
 * A fake API to test the ergonomics layer against.
 *
 * Deliberately not a mocking library: the behaviours under test are about
 * *sequences* — a request that fails then succeeds, a token that expires
 * mid-flight, a process that dies between persisting and sending — and those
 * read far more clearly as a scripted server than as a stack of mock
 * expectations.
 */

import type { Storage } from "../src/types.js";

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (request: RecordedRequest) => ResponseSpec | undefined;

export interface ResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw a network-level failure instead of responding. */
  networkError?: boolean;
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  private readonly responders: Responder[] = [];
  private defaultSpec: ResponseSpec = { status: 200, body: {} };

  /** Client routes live at the root unless `combined()` is called. */
  private layout: "standalone" | "combined" = "standalone";

  combined(): this {
    this.layout = "combined";
    return this;
  }

  default(spec: ResponseSpec): this {
    this.defaultSpec = spec;
    return this;
  }

  on(match: string | RegExp, spec: ResponseSpec | Responder): this {
    this.responders.push((request) => {
      const target = `${request.method} ${request.path}`;
      const hit =
        typeof match === "string"
          ? target === match || request.path === match
          : match.test(target);
      if (!hit) return undefined;
      return typeof spec === "function" ? spec(request) : spec;
    });
    return this;
  }

  /** Respond differently on each successive call. The last spec repeats. */
  sequence(match: string | RegExp, specs: ResponseSpec[]): this {
    let index = 0;
    return this.on(match, () => {
      const spec = specs[Math.min(index, specs.length - 1)] as ResponseSpec;
      index += 1;
      return spec;
    });
  }

  countOf(match: string): number {
    return this.requests.filter((r) => `${r.method} ${r.path}` === match).length;
  }

  lastOf(match: string): RecordedRequest | undefined {
    return [...this.requests].reverse().find((r) => `${r.method} ${r.path}` === match);
  }

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const parsed = new URL(url);
    const rawPath = parsed.pathname;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    // /healthz is answered by the layout, before any recorded responder.
    if (rawPath === "/healthz") {
      return jsonResponse(200, {
        status: "ok",
        service: this.layout === "combined" ? "admin-api" : "client-api",
      });
    }
    if (rawPath === "/client/healthz") {
      return jsonResponse(200, { status: "ok", service: "client-api" });
    }

    const path = rawPath.startsWith("/client/") ? rawPath.slice("/client".length) : rawPath;
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path,
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    this.requests.push(request);

    let spec: ResponseSpec | undefined;
    for (const responder of this.responders) {
      spec = responder(request);
      if (spec) break;
    }
    spec ??= this.defaultSpec;

    if (spec.networkError) throw new TypeError("Network request failed");
    return jsonResponse(spec.status ?? 200, spec.body ?? {}, spec.headers);
  }) as typeof fetch;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** An in-memory store you can inspect, corrupt, and hand to a "restarted" client. */
export class InspectableStorage implements Storage {
  readonly map = new Map<string, string>();
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  find(suffix: string): string | undefined {
    for (const [key, value] of this.map) if (key.endsWith(suffix)) return value;
    return undefined;
  }
}

/** Deterministic ids, so assertions can name the key that was used. */
export function seededIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Collapses backoff to nothing so retry tests run instantly. */
export const noSleep = async (): Promise<void> => {};

export const errorBody = (code: string, message = "boom", status = 400) => ({
  detail: message,
  error: { code, message, status },
});
