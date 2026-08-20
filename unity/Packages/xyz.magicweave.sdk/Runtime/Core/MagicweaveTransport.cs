using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Magicweave
{
    /// <summary>
    /// The request path: behaviours E1–E5 in one place.
    /// </summary>
    /// <remarks>
    /// Everything above this class is a typed naming layer. All the judgment
    /// about failure lives here, and it matches
    /// <c>spec/ERGONOMICS.md</c> line for line with the TypeScript reference.
    /// </remarks>
    public sealed class MagicweaveTransport
    {
        public const string SdkVersion = "0.1.0";

        private const string GeneratedMarkerHeader = "x-mw-idempotency-generated";

        /// <summary>
        /// Writes that carry the idempotency key in the request <em>body</em>
        /// rather than the header. The client API is split this way — /game
        /// writes use a body field, inventory and shop use the header — and
        /// hiding that split is precisely the SDK's job.
        /// </summary>
        private static readonly string[] BodyKeyPathPrefixes = { "/game/" };

        private readonly MagicweaveOptions _options;
        private readonly IMagicweaveStorage _storage;
        private readonly SemaphoreSlim _rootGate = new SemaphoreSlim(1, 1);
        private readonly Random _random = new Random();

        private string _resolvedRoot;

        public Session Session { get; }
        public WriteQueue Queue { get; }
        public IMagicweaveLogger Logger { get; }

        public MagicweaveTransport(MagicweaveOptions options)
        {
            options.Validate();
            _options = options;

            Logger = options.Logger ?? NullLogger.Instance;
            _storage = new ForgivingStorage(options.Storage ?? new MemoryStorage(), Logger);

            var ns = string.IsNullOrEmpty(options.StorageNamespace)
                ? "mw:" + options.ClientId
                : options.StorageNamespace;

            Session = new Session(_storage, ns, Logger, PerformRefreshAsync);
            Queue = new WriteQueue(_storage, ns, Logger, SendQueuedAsync, IsRetryable);
        }

        // ── E1: connect once ──────────────────────────────────────────────────

        /// <summary>
        /// Work out whether client routes sit at the root or under <c>/client</c>.
        /// </summary>
        /// <remarks>
        /// The docs currently ask every developer to write this branch by hand.
        /// One probe, cached for the process lifetime. A probe that fails falls
        /// back to the configured base rather than blocking startup — a wrong
        /// guess surfaces as a 404 on the first real call, which is a better
        /// failure than a game that will not boot.
        /// </remarks>
        public async Task<string> RootAsync()
        {
            if (_resolvedRoot != null) return _resolvedRoot;

            await _rootGate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_resolvedRoot != null) return _resolvedRoot;

                var trimmed = _options.BaseUrl.TrimEnd('/');
                try
                {
                    var service = await ProbeServiceAsync(trimmed + "/healthz").ConfigureAwait(false);
                    if (service == "client-api")
                    {
                        _resolvedRoot = trimmed;
                    }
                    else if (service == "admin-api")
                    {
                        var combined = trimmed + "/client";
                        var nested = await ProbeServiceAsync(combined + "/healthz").ConfigureAwait(false);
                        if (nested == "client-api")
                        {
                            Logger.Debug("combined deployment detected, using /client prefix");
                            _resolvedRoot = combined;
                        }
                    }
                }
                catch (Exception error)
                {
                    Logger.Warn("healthz probe failed, assuming standalone layout: " + error.Message);
                }

                _resolvedRoot = _resolvedRoot ?? trimmed;
                return _resolvedRoot;
            }
            finally
            {
                _rootGate.Release();
            }
        }

        private async Task<string> ProbeServiceAsync(string url)
        {
            var outcome = await _options.Transport
                .SendAsync(new HttpCall { Method = "GET", Url = url }, CancellationToken.None)
                .ConfigureAwait(false);

            if (!outcome.IsSuccess) return null;
            return Json.ParseObject(outcome.Body)?["service"]?.ToString();
        }

        // ── headers ───────────────────────────────────────────────────────────

        private async Task<IDictionary<string, string>> BuildHeadersAsync(bool anonymous, bool hasBody)
        {
            var headers = new Dictionary<string, string>
            {
                ["x-client-id"] = _options.ClientId,
                ["x-client-secret"] = _options.ClientSecret,
                ["x-mw-sdk"] = _options.Platform + "/" + SdkVersion,
                ["accept"] = "application/json"
            };

            if (hasBody) headers["content-type"] = "application/json";

            if (!anonymous)
            {
                if (_options.Mode == IdentityMode.External)
                {
                    headers["x-external-user-id"] = _options.ExternalUserId;
                }
                else
                {
                    var token = await Session.AccessTokenAsync().ConfigureAwait(false);
                    if (!string.IsNullOrEmpty(token)) headers["authorization"] = "Bearer " + token;
                }
            }

            return headers;
        }

        // ── public entry points ───────────────────────────────────────────────

        /// <summary>A read. Retried on transient failure; never queued.</summary>
        public Task<string> RequestAsync(string method, string path, object body = null,
            bool anonymous = false, CancellationToken cancellationToken = default)
        {
            return SendWithRetryAsync(method, path, body, anonymous, null, "header", cancellationToken);
        }

        /// <summary>
        /// A write: persisted before it is sent, and replayed with the same key.
        /// </summary>
        /// <remarks>
        /// When the send cannot complete but could later, the entry stays queued
        /// and this throws <see cref="MagicweaveQueuedException"/> — the operation
        /// is not lost, it just has no result yet.
        /// </remarks>
        public async Task<string> WriteAsync(string method, string path, object body = null,
            string idempotencyKey = null, CancellationToken cancellationToken = default)
        {
            var key = idempotencyKey ?? _options.NewId();
            var keyTransport = UsesBodyKey(path) ? "body" : "header";

            if (!_options.DurableWrites)
            {
                return await SendWithRetryAsync(method, path, body, false, key, keyTransport, cancellationToken)
                    .ConfigureAwait(false);
            }

            var entry = new QueuedWrite
            {
                Id = _options.NewId(),
                Method = method,
                Path = path,
                Body = body == null ? null : Json.Serialize(body),
                IdempotencyKey = key,
                KeyTransport = keyTransport,
                CreatedAtUnixMs = _options.Clock().ToUnixTimeMilliseconds(),
                Attempts = 0
            };

            // Persist BEFORE the first attempt. This ordering is the whole
            // guarantee: a crash after this line replays with the same key; a
            // crash before it means the write never happened at all.
            await Queue.EnqueueAsync(entry).ConfigureAwait(false);

            try
            {
                var result = await SendWithRetryAsync(method, path, body, false, key, keyTransport, cancellationToken)
                    .ConfigureAwait(false);
                await Queue.RemoveAsync(entry.Id).ConfigureAwait(false);
                return result;
            }
            catch (Exception error) when (IsRetryable(error))
            {
                entry.Attempts = 1;
                entry.LastError = error.Message;
                Logger.Info($"{method} {path} could not be delivered — queued for retry");
                throw new MagicweaveQueuedException(entry.Id);
            }
            catch
            {
                // A permanent failure will never succeed on replay, so it must not
                // stay in the queue blocking everything behind it.
                await Queue.RemoveAsync(entry.Id).ConfigureAwait(false);
                throw;
            }
        }

        /// <summary>Drain anything left over from a previous session or a lost connection.</summary>
        public Task FlushAsync() => Queue.DrainAsync();

        private Task<string> SendQueuedAsync(QueuedWrite entry)
        {
            object body = entry.Body == null
                ? null
                : Json.Deserialize<Dictionary<string, object>>(entry.Body);

            return SendWithRetryAsync(entry.Method, entry.Path, body, false,
                entry.IdempotencyKey, entry.KeyTransport, CancellationToken.None);
        }

        // ── E5: the retry loop ────────────────────────────────────────────────

        private async Task<string> SendWithRetryAsync(string method, string path, object body,
            bool anonymous, string idempotencyKey, string keyTransport,
            CancellationToken cancellationToken)
        {
            var root = await RootAsync().ConfigureAwait(false);
            var attempt = 0;
            var refreshed = false;

            while (true)
            {
                attempt += 1;
                try
                {
                    return await AttemptAsync(root, method, path, body, anonymous,
                        idempotencyKey, keyTransport, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    // E2: one silent refresh, then replay the original request.
                    if (!refreshed
                        && !anonymous
                        && _options.Mode == IdentityMode.Network
                        && error is MagicweaveAuthException authError
                        && (authError.Code == ErrorCode.Unauthenticated
                            || authError.Code == ErrorCode.TokenExpired))
                    {
                        refreshed = true;
                        var tokens = await Session.RefreshAsync().ConfigureAwait(false);
                        if (tokens != null) continue;
                    }

                    if (!IsRetryable(error) || attempt >= _options.Retry.MaxAttempts) throw;

                    var delay = error is RateLimitedException limited && limited.RetryAfterMs.HasValue
                        ? limited.RetryAfterMs.Value
                        : BackoffDelayMs(attempt);

                    Logger.Debug($"retrying {method} {path} in {delay}ms (attempt {attempt})");
                    await SleepAsync(delay, cancellationToken).ConfigureAwait(false);
                }
            }
        }

        private async Task<string> AttemptAsync(string root, string method, string path, object body,
            bool anonymous, string idempotencyKey, string keyTransport,
            CancellationToken cancellationToken)
        {
            var payload = body;

            if (idempotencyKey != null && keyTransport == "body")
            {
                var map = payload == null
                    ? new Dictionary<string, object>()
                    : Json.Deserialize<Dictionary<string, object>>(Json.Serialize(payload));
                map["idempotency_key"] = idempotencyKey;
                payload = map;
            }

            var serialized = payload == null ? null : Json.Serialize(payload);
            var headers = await BuildHeadersAsync(anonymous, serialized != null).ConfigureAwait(false);

            if (idempotencyKey != null && keyTransport == "header")
            {
                headers["Idempotency-Key"] = idempotencyKey;
            }

            var call = new HttpCall
            {
                Method = method,
                Url = root + path,
                Headers = headers,
                Body = serialized
            };

            var outcome = await _options.Transport.SendAsync(call, cancellationToken).ConfigureAwait(false);

            if (outcome.IsTransportFailure)
            {
                throw new MagicweaveNetworkException(
                    $"{method} {path} did not reach the API: {outcome.TransportError}");
            }

            if (HeaderValue(outcome.Headers, GeneratedMarkerHeader) == "true")
            {
                Logger.Warn(
                    $"{method} {path} was sent without an idempotency key — this write is not retry-safe");
            }

            if (outcome.IsSuccess) return outcome.Body;

            var exception = ErrorDecoder.Decode(outcome.Status, outcome.Body);
            if (exception is RateLimitedException rateLimited)
            {
                var retryAfter = ParseRetryAfterMs(HeaderValue(outcome.Headers, "retry-after"));
                if (retryAfter.HasValue)
                {
                    throw new RateLimitedException(rateLimited.Status, rateLimited.Code,
                        rateLimited.Message, rateLimited.Context, retryAfter);
                }
            }

            throw exception;
        }

        private async Task<TokenPair> PerformRefreshAsync(string refreshToken)
        {
            var body = await SendWithRetryAsync("POST", "/auth/refresh",
                new Dictionary<string, object> { ["refresh_token"] = refreshToken },
                true, null, "header", CancellationToken.None).ConfigureAwait(false);

            var parsed = Json.ParseObject(body);
            var access = parsed?["access_token"]?.ToString();
            if (string.IsNullOrEmpty(access))
            {
                throw new MagicweaveAuthException(401, ErrorCode.TokenExpired, "Refresh returned no token");
            }

            return new TokenPair
            {
                AccessToken = access,
                RefreshToken = parsed["refresh_token"]?.ToString() ?? refreshToken
            };
        }

        // ── helpers ───────────────────────────────────────────────────────────

        public static bool UsesBodyKey(string path)
        {
            foreach (var prefix in BodyKeyPathPrefixes)
            {
                if (path.StartsWith(prefix, StringComparison.Ordinal)) return true;
            }

            return false;
        }

        /// <summary>Transient failures only — never a 4xx the server rejects identically.</summary>
        public static bool IsRetryable(Exception error)
        {
            if (error is MagicweaveNetworkException) return true;
            if (error is MagicweaveApiException api) return api.Retryable;
            return false;
        }

        internal int BackoffDelayMs(int attempt)
        {
            var exponential = _options.Retry.BaseDelayMs * Math.Pow(2, attempt - 1);
            var capped = Math.Min(exponential, _options.Retry.MaxDelayMs);
            return (int)Math.Round(capped * (1 + _random.NextDouble() * _options.Retry.Jitter));
        }

        private Task SleepAsync(int ms, CancellationToken cancellationToken)
        {
            return _options.Sleep != null
                ? _options.Sleep(ms, cancellationToken)
                : Task.Delay(ms, cancellationToken);
        }

        private static string HeaderValue(IDictionary<string, string> headers, string name)
        {
            if (headers == null) return null;
            foreach (var pair in headers)
            {
                if (string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase)) return pair.Value;
            }

            return null;
        }

        internal static int? ParseRetryAfterMs(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;

            if (double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out var seconds))
            {
                return (int)Math.Max(0, seconds * 1000);
            }

            if (DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal, out var when))
            {
                var delta = (when - DateTimeOffset.UtcNow).TotalMilliseconds;
                return (int)Math.Max(0, delta);
            }

            return null;
        }

        internal static string BuildQuery(IDictionary<string, string> query)
        {
            if (query == null || query.Count == 0) return string.Empty;

            var builder = new StringBuilder();
            foreach (var pair in query)
            {
                if (pair.Value == null) continue;
                builder.Append(builder.Length == 0 ? '?' : '&');
                builder.Append(Uri.EscapeDataString(pair.Key));
                builder.Append('=');
                builder.Append(Uri.EscapeDataString(pair.Value));
            }

            return builder.ToString();
        }
    }
}
