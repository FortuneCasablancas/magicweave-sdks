using System;
using System.Collections.Generic;

namespace Magicweave
{
    /// <summary>
    /// Stable codes the client API returns in <c>error.code</c>.
    /// Mirrors <c>apps/client/errors.py::ErrorCode</c> and the TypeScript SDK.
    /// </summary>
    /// <remarks>
    /// Branch on these, never on the message: <c>detail</c> is display text that
    /// gets reworded, <c>code</c> is part of the API contract.
    /// </remarks>
    public static class ErrorCode
    {
        public const string Unauthenticated = "unauthenticated";
        public const string InvalidCredentials = "invalid_credentials";
        public const string TokenExpired = "token_expired";
        public const string Forbidden = "forbidden";

        public const string ValidationError = "validation_error";
        public const string BadRequest = "bad_request";
        public const string NotFound = "not_found";

        public const string IdempotencyConflict = "idempotency_conflict";
        public const string IdempotencyKeyRequired = "idempotency_key_required";
        public const string Conflict = "conflict";

        public const string InsufficientBalance = "insufficient_balance";
        public const string QuotaExceeded = "quota_exceeded";

        public const string RateLimited = "rate_limited";
        public const string ServerError = "server_error";
        public const string Unavailable = "unavailable";
    }

    /// <summary>Base class for everything the SDK throws.</summary>
    public class MagicweaveException : Exception
    {
        public MagicweaveException(string message) : base(message) { }
        public MagicweaveException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>A non-2xx response from the API.</summary>
    public class MagicweaveApiException : MagicweaveException
    {
        public int Status { get; }
        public string Code { get; }
        public IReadOnlyDictionary<string, object> Context { get; }

        public MagicweaveApiException(
            int status,
            string code,
            string message,
            IReadOnlyDictionary<string, object> context = null)
            : base(message)
        {
            Status = status;
            Code = code;
            Context = context ?? new Dictionary<string, object>();
        }

        /// <summary>True when retrying the identical request could plausibly succeed.</summary>
        public virtual bool Retryable => Status == 408 || Status == 429 || Status >= 500;

        public static MagicweaveApiException FromResponse(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null)
        {
            switch (code)
            {
                case ErrorCode.Unauthenticated:
                case ErrorCode.TokenExpired:
                case ErrorCode.InvalidCredentials:
                    return new MagicweaveAuthException(status, code, message, context);
                case ErrorCode.IdempotencyConflict:
                    return new IdempotencyConflictException(status, code, message, context);
                case ErrorCode.InsufficientBalance:
                    return new InsufficientBalanceException(status, code, message, context);
                case ErrorCode.ValidationError:
                    return new MagicweaveValidationException(status, code, message, context);
                case ErrorCode.RateLimited:
                    return new RateLimitedException(status, code, message, context);
                default:
                    return new MagicweaveApiException(status, code, message, context);
            }
        }

        /// <summary>The generic code for a status no call site has classified.</summary>
        public static string CodeForStatus(int status)
        {
            switch (status)
            {
                case 401: return ErrorCode.Unauthenticated;
                case 402: return ErrorCode.InsufficientBalance;
                case 403: return ErrorCode.Forbidden;
                case 404: return ErrorCode.NotFound;
                case 409: return ErrorCode.Conflict;
                case 422: return ErrorCode.ValidationError;
                case 429: return ErrorCode.RateLimited;
                default: return status >= 500 ? ErrorCode.ServerError : ErrorCode.BadRequest;
            }
        }
    }

    /// <summary>401/403 — the player's session is not usable.</summary>
    public class MagicweaveAuthException : MagicweaveApiException
    {
        public MagicweaveAuthException(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null)
            : base(status, code, message, context) { }
    }

    /// <summary>
    /// 409 — this key was already used by a <em>different</em> operation.
    /// A successful replay returns 2xx, so this means the key was reused: a bug
    /// in key generation, not a transient failure. Never retried.
    /// </summary>
    public class IdempotencyConflictException : MagicweaveApiException
    {
        public IdempotencyConflictException(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null)
            : base(status, code, message, context) { }

        public override bool Retryable => false;
    }

    /// <summary>402 — the player cannot afford this. Show it; do not retry.</summary>
    public class InsufficientBalanceException : MagicweaveApiException
    {
        public InsufficientBalanceException(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null)
            : base(status, code, message, context) { }
    }

    /// <summary>422 — the request did not match the schema. A code bug.</summary>
    public class MagicweaveValidationException : MagicweaveApiException
    {
        public MagicweaveValidationException(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null)
            : base(status, code, message, context) { }
    }

    /// <summary>429 — slow down. Retried with backoff, honouring Retry-After.</summary>
    public class RateLimitedException : MagicweaveApiException
    {
        public int? RetryAfterMs { get; }

        public RateLimitedException(int status, string code, string message,
            IReadOnlyDictionary<string, object> context = null, int? retryAfterMs = null)
            : base(status, code, message, context)
        {
            RetryAfterMs = retryAfterMs;
        }
    }

    /// <summary>The request never reached the API (offline, DNS, TLS, abort).</summary>
    public class MagicweaveNetworkException : MagicweaveException
    {
        public MagicweaveNetworkException(string message, Exception inner = null)
            : base(message, inner) { }
    }

    /// <summary>
    /// A write could not be sent now, but is durably queued and will be replayed.
    /// The operation is not lost — it has no result yet.
    /// </summary>
    public class MagicweaveQueuedException : MagicweaveException
    {
        public string EntryId { get; }

        public MagicweaveQueuedException(string entryId)
            : base("Write is queued and will be retried")
        {
            EntryId = entryId;
        }
    }

    /// <summary>The SDK was configured wrongly. Thrown at construction, not first use.</summary>
    public class MagicweaveConfigException : MagicweaveException
    {
        public MagicweaveConfigException(string message) : base(message) { }
    }
}
