/**
 * Typed errors, mapped from the client API's `error.code` envelope.
 *
 * The API returns `{ detail, error: { code, message, status, context? } }` on
 * every failure. `detail` is display text that may be reworded at any time;
 * `code` is the stable thing to branch on. These classes are the SDK's side of
 * that contract — catch the class, not the string.
 */

/** Stable codes the client API emits. Mirrors `apps/client/errors.py::ErrorCode`. */
export const ErrorCode = {
  UNAUTHENTICATED: "unauthenticated",
  INVALID_CREDENTIALS: "invalid_credentials",
  TOKEN_EXPIRED: "token_expired",
  FORBIDDEN: "forbidden",
  VALIDATION_ERROR: "validation_error",
  BAD_REQUEST: "bad_request",
  NOT_FOUND: "not_found",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  IDEMPOTENCY_KEY_REQUIRED: "idempotency_key_required",
  CONFLICT: "conflict",
  INSUFFICIENT_BALANCE: "insufficient_balance",
  QUOTA_EXCEEDED: "quota_exceeded",
  RATE_LIMITED: "rate_limited",
  SERVER_ERROR: "server_error",
  UNAVAILABLE: "unavailable",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  detail?: unknown;
  error?: {
    code?: string;
    message?: string;
    status?: number;
    context?: Record<string, unknown>;
  };
}

/** Base class for everything this SDK throws. */
export class MagicweaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Required for `instanceof` to survive the ES5 downlevel some RN setups use.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A non-2xx response from the API. */
export class MagicweaveApiError extends MagicweaveError {
  readonly status: number;
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    requestId?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.context = context;
    this.requestId = requestId;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  static fromResponse(
    status: number,
    body: ApiErrorBody | undefined,
    requestId?: string,
  ): MagicweaveApiError {
    const envelope = body?.error;
    const code = envelope?.code ?? fallbackCode(status);
    const message =
      envelope?.message ??
      (typeof body?.detail === "string" ? body.detail : `Request failed (${status})`);
    const context = envelope?.context ?? {};

    switch (code) {
      case ErrorCode.UNAUTHENTICATED:
      case ErrorCode.TOKEN_EXPIRED:
      case ErrorCode.INVALID_CREDENTIALS:
        return new MagicweaveAuthError(status, code, message, context, requestId);
      case ErrorCode.IDEMPOTENCY_CONFLICT:
        return new IdempotencyConflictError(status, code, message, context, requestId);
      case ErrorCode.INSUFFICIENT_BALANCE:
        return new InsufficientBalanceError(status, code, message, context, requestId);
      case ErrorCode.VALIDATION_ERROR:
        return new ValidationError(status, code, message, context, requestId);
      case ErrorCode.RATE_LIMITED:
        return new RateLimitedError(status, code, message, context, requestId);
      default:
        return new MagicweaveApiError(status, code, message, context, requestId);
    }
  }
}

/** 401/403 — the player's session is not usable. */
export class MagicweaveAuthError extends MagicweaveApiError {}

/**
 * 409 — this idempotency key was already used by a *different* operation.
 *
 * Distinct from a successful replay: a replay returns the original result with
 * a 2xx. This means the key was reused for something else, which is a bug in
 * key generation, not a transient failure. Never retried.
 */
export class IdempotencyConflictError extends MagicweaveApiError {
  override get retryable(): boolean {
    return false;
  }
}

/** 402 — the player cannot afford this. Surface it; do not retry. */
export class InsufficientBalanceError extends MagicweaveApiError {}

/** 422 — the request did not match the schema. A code bug, not a transient one. */
export class ValidationError extends MagicweaveApiError {}

/** 429 — slow down. Retried with backoff, honouring `Retry-After` when present. */
export class RateLimitedError extends MagicweaveApiError {
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    requestId?: string,
    retryAfterMs?: number,
  ) {
    super(status, code, message, context, requestId);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request never reached the API (DNS, offline, TLS, abort). */
export class MagicweaveNetworkError extends MagicweaveError {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * A write could not be sent now, but is durably queued and will be replayed.
 *
 * This is the offline path (E4): the operation is *not* lost, it just has no
 * result yet. Listen on `client.queue` for the outcome.
 */
export class MagicweaveQueuedError extends MagicweaveError {
  readonly entryId: string;

  constructor(entryId: string, message = "Write is queued and will be retried") {
    super(message);
    this.entryId = entryId;
  }
}

/** The SDK was used incorrectly — bad config, missing init. */
export class MagicweaveConfigError extends MagicweaveError {}

function fallbackCode(status: number): string {
  if (status === 401) return ErrorCode.UNAUTHENTICATED;
  if (status === 402) return ErrorCode.INSUFFICIENT_BALANCE;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 422) return ErrorCode.VALIDATION_ERROR;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status >= 500) return ErrorCode.SERVER_ERROR;
  return ErrorCode.BAD_REQUEST;
}
