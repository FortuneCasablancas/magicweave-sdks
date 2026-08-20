using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Magicweave;
using Xunit;

namespace Magicweave.Tests
{
    /// <summary>
    /// The C# port of the TypeScript reference tests.
    /// </summary>
    /// <remarks>
    /// Deliberately mirrors <c>typescript/test/ergonomics.test.ts</c> case for
    /// case. Two SDKs implementing "the same" behaviour from prose will drift;
    /// two SDKs asserting the same sequences will not.
    /// </remarks>
    public class FakeTransport : IHttpTransport
    {
        public readonly List<HttpCall> Calls = new List<HttpCall>();
        private readonly List<Func<HttpCall, HttpOutcome>> _responders = new List<Func<HttpCall, HttpOutcome>>();
        private HttpOutcome _default = Ok("{}");

        /// <summary>Client routes live at the root unless Combined() is called.</summary>
        private bool _combined;

        public FakeTransport Combined()
        {
            _combined = true;
            return this;
        }

        public FakeTransport Default(HttpOutcome outcome)
        {
            _default = outcome;
            return this;
        }

        public FakeTransport On(string methodAndPath, HttpOutcome outcome) =>
            On(methodAndPath, _ => outcome);

        public FakeTransport On(string methodAndPath, Func<HttpCall, HttpOutcome> responder)
        {
            _responders.Add(call => Match(call, methodAndPath) ? responder(call) : null);
            return this;
        }

        /// <summary>Respond differently on each successive call; the last repeats.</summary>
        public FakeTransport Sequence(string methodAndPath, params HttpOutcome[] outcomes)
        {
            var index = 0;
            return On(methodAndPath, _ =>
            {
                var outcome = outcomes[Math.Min(index, outcomes.Length - 1)];
                index += 1;
                return outcome;
            });
        }

        public int CountOf(string methodAndPath) => Calls.Count(c => Match(c, methodAndPath));

        public HttpCall LastOf(string methodAndPath) =>
            Calls.LastOrDefault(c => Match(c, methodAndPath));

        private static bool Match(HttpCall call, string methodAndPath)
        {
            var parts = methodAndPath.Split(' ');
            return call.Method == parts[0] && NormalisedPath(call.Url) == parts[1];
        }

        private static string NormalisedPath(string url)
        {
            var path = new Uri(url).AbsolutePath;
            return path.StartsWith("/client/") ? path.Substring("/client".Length) : path;
        }

        public Task<HttpOutcome> SendAsync(HttpCall call, CancellationToken cancellationToken)
        {
            var path = new Uri(call.Url).AbsolutePath;

            if (path == "/healthz")
            {
                return Task.FromResult(Ok(
                    _combined ? "{\"service\":\"admin-api\"}" : "{\"service\":\"client-api\"}"));
            }

            if (path == "/client/healthz")
            {
                return Task.FromResult(Ok("{\"service\":\"client-api\"}"));
            }

            Calls.Add(call);

            foreach (var responder in _responders)
            {
                var outcome = responder(call);
                if (outcome != null) return Task.FromResult(outcome);
            }

            return Task.FromResult(_default);
        }

        public static HttpOutcome Ok(string body = "{}") =>
            new HttpOutcome { Status = 200, Body = body };

        public static HttpOutcome Fail(int status, string code, string message = "boom") =>
            new HttpOutcome
            {
                Status = status,
                Body = "{\"detail\":\"" + message + "\",\"error\":{\"code\":\"" + code +
                       "\",\"message\":\"" + message + "\",\"status\":" + status + "}}"
            };

        public static HttpOutcome Offline() =>
            new HttpOutcome { TransportError = "network unreachable" };
    }

    /// <summary>An in-memory store you can inspect and hand to a "restarted" client.</summary>
    public class InspectableStorage : IMagicweaveStorage
    {
        public readonly Dictionary<string, string> Map = new Dictionary<string, string>();

        public Task<string> GetAsync(string key)
        {
            Map.TryGetValue(key, out var value);
            return Task.FromResult(value);
        }

        public Task SetAsync(string key, string value)
        {
            Map[key] = value;
            return Task.CompletedTask;
        }

        public Task RemoveAsync(string key)
        {
            Map.Remove(key);
            return Task.CompletedTask;
        }

        public string Find(string suffix) =>
            Map.FirstOrDefault(kv => kv.Key.EndsWith(suffix, StringComparison.Ordinal)).Value;
    }

    public static class Build
    {
        public static MagicweaveClient Client(
            FakeTransport transport,
            IMagicweaveStorage storage = null,
            Action<MagicweaveOptions> tweak = null)
        {
            var counter = 0;
            var options = new MagicweaveOptions
            {
                ClientId = "cid",
                ClientSecret = "csec",
                BaseUrl = "https://api.example.test",
                Transport = transport,
                Storage = storage ?? new MemoryStorage(),
                NewId = () => "key-" + (++counter),
                Sleep = (ms, ct) => Task.CompletedTask
            };
            tweak?.Invoke(options);
            return new MagicweaveClient(options);
        }
    }

    // ── E1 ──────────────────────────────────────────────────────────────────

    public class E1ConnectOnce
    {
        [Fact]
        public async Task UsesRootWhenHealthzSaysClientApi()
        {
            var api = new FakeTransport().On("GET /wallet", FakeTransport.Ok("{\"gems\":5}"));
            var body = await Build.Client(api).Wallet.GetAsync();

            Assert.Contains("\"gems\":5", body);
            Assert.Equal("https://api.example.test/wallet", api.LastOf("GET /wallet").Url);
        }

        [Fact]
        public async Task FindsClientPrefixOnCombinedDeployment()
        {
            var api = new FakeTransport().Combined().On("GET /wallet", FakeTransport.Ok());
            await Build.Client(api).Wallet.GetAsync();

            Assert.Equal("https://api.example.test/client/wallet", api.LastOf("GET /wallet").Url);
        }

        [Fact]
        public async Task MissingCredentialsThrowAtConstruction()
        {
            var api = new FakeTransport();
            Assert.Throws<MagicweaveConfigException>(() =>
                Build.Client(api, tweak: o => o.ClientId = ""));
            Assert.Throws<MagicweaveConfigException>(() =>
                Build.Client(api, tweak: o => o.BaseUrl = ""));
            await Task.CompletedTask;
        }

        [Fact]
        public void ExternalModeRequiresAUserId()
        {
            Assert.Throws<MagicweaveConfigException>(() =>
                Build.Client(new FakeTransport(), tweak: o => o.Mode = IdentityMode.External));
        }
    }

    // ── headers ─────────────────────────────────────────────────────────────

    public class Headers
    {
        [Fact]
        public async Task SendsCredentialsAndIdentifiesTheSdk()
        {
            var api = new FakeTransport();
            await Build.Client(api).Wallet.GetAsync();

            var headers = api.LastOf("GET /wallet").Headers;
            Assert.Equal("cid", headers["x-client-id"]);
            Assert.Equal("csec", headers["x-client-secret"]);
            Assert.StartsWith("unity/", headers["x-mw-sdk"]);
        }

        [Fact]
        public async Task ExternalModeSendsUserIdInsteadOfBearer()
        {
            var api = new FakeTransport();
            var mw = Build.Client(api, tweak: o =>
            {
                o.Mode = IdentityMode.External;
                o.ExternalUserId = "player-9";
            });

            await mw.Wallet.GetAsync();

            var headers = api.LastOf("GET /wallet").Headers;
            Assert.Equal("player-9", headers["x-external-user-id"]);
            Assert.False(headers.ContainsKey("authorization"));
        }
    }

    // ── E2 ──────────────────────────────────────────────────────────────────

    public class E2Session
    {
        private const string Tokens =
            "{\"access_token\":\"access-1\",\"refresh_token\":\"refresh-1\"}";

        [Fact]
        public async Task StoresTokensAndSendsThemAsBearer()
        {
            var api = new FakeTransport().On("POST /auth/otp/verify", FakeTransport.Ok(Tokens));
            var storage = new InspectableStorage();
            var mw = Build.Client(api, storage);

            await mw.Auth.VerifyOtpAsync("p@example.test", "123456");
            await mw.Wallet.GetAsync();

            Assert.True(mw.IsSignedIn);
            Assert.Equal("Bearer access-1", api.LastOf("GET /wallet").Headers["authorization"]);
            Assert.Equal("access-1", storage.Find("access_token"));
        }

        [Fact]
        public async Task RestoresSessionAcrossRestart()
        {
            var api = new FakeTransport().On("POST /auth/otp/verify", FakeTransport.Ok(Tokens));
            var storage = new InspectableStorage();

            await Build.Client(api, storage).Auth.VerifyOtpAsync("p@example.test", "123456");

            var revived = Build.Client(api, storage);
            await revived.InitAsync();

            Assert.True(revived.IsSignedIn);
            await revived.Wallet.GetAsync();
            Assert.Equal("Bearer access-1", api.LastOf("GET /wallet").Headers["authorization"]);
        }

        [Fact]
        public async Task RefreshesOn401AndReplaysTheRequest()
        {
            var api = new FakeTransport()
                .On("POST /auth/otp/verify", FakeTransport.Ok(Tokens))
                .On("POST /auth/refresh", FakeTransport.Ok("{\"access_token\":\"access-2\"}"))
                .Sequence("GET /wallet",
                    FakeTransport.Fail(401, ErrorCode.TokenExpired, "expired"),
                    FakeTransport.Ok("{\"gems\":3}"));

            var mw = Build.Client(api);
            await mw.Auth.VerifyOtpAsync("p@example.test", "123456");

            var body = await mw.Wallet.GetAsync();

            Assert.Contains("\"gems\":3", body);
            Assert.Equal(1, api.CountOf("POST /auth/refresh"));
            Assert.Equal(2, api.CountOf("GET /wallet"));
            Assert.Equal("Bearer access-2", api.LastOf("GET /wallet").Headers["authorization"]);
        }

        [Fact]
        public async Task RefreshesExactlyOnceWhenSeveralRequestsGet401Together()
        {
            var refreshed = false;
            var api = new FakeTransport()
                .On("POST /auth/otp/verify", FakeTransport.Ok(Tokens))
                .On("POST /auth/refresh", _ =>
                {
                    refreshed = true;
                    return FakeTransport.Ok("{\"access_token\":\"access-2\"}");
                })
                .Default(FakeTransport.Ok());

            api.On("GET /wallet", _ => refreshed
                ? FakeTransport.Ok()
                : FakeTransport.Fail(401, ErrorCode.TokenExpired, "expired"));
            api.On("GET /stats", _ => refreshed
                ? FakeTransport.Ok()
                : FakeTransport.Fail(401, ErrorCode.TokenExpired, "expired"));
            api.On("GET /currency", _ => refreshed
                ? FakeTransport.Ok()
                : FakeTransport.Fail(401, ErrorCode.TokenExpired, "expired"));

            var mw = Build.Client(api);
            await mw.Auth.VerifyOtpAsync("p@example.test", "123456");

            await Task.WhenAll(
                mw.Wallet.GetAsync(),
                mw.Stats.GetAsync(),
                mw.Currency.BalancesAsync());

            Assert.Equal(1, api.CountOf("POST /auth/refresh"));
        }

        [Fact]
        public async Task ClearsSessionWhenRefreshTokenIsRejected()
        {
            var api = new FakeTransport()
                .On("POST /auth/otp/verify", FakeTransport.Ok(Tokens))
                .On("POST /auth/refresh", FakeTransport.Fail(401, ErrorCode.Unauthenticated, "dead"))
                .On("GET /wallet", FakeTransport.Fail(401, ErrorCode.TokenExpired, "expired"));

            var mw = Build.Client(api);
            await mw.Auth.VerifyOtpAsync("p@example.test", "123456");

            await Assert.ThrowsAnyAsync<MagicweaveApiException>(() => mw.Wallet.GetAsync());
            Assert.False(mw.IsSignedIn);
        }

        [Fact]
        public async Task DoesNotRefreshForAnonymousAuthCalls()
        {
            var api = new FakeTransport()
                .On("POST /auth/login", FakeTransport.Fail(401, ErrorCode.InvalidCredentials, "nope"));

            await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api).Auth.LoginAsync("p@example.test", "wrong"));
            Assert.Equal(0, api.CountOf("POST /auth/refresh"));
        }
    }

    // ── E3 ──────────────────────────────────────────────────────────────────

    public class E3CrashSafeWrites
    {
        [Fact]
        public async Task SendsTheKeyInTheHeaderForShopAndInventory()
        {
            var api = new FakeTransport();
            await Build.Client(api).Shop.PurchaseAsync("pack");

            Assert.Equal("key-1", api.LastOf("POST /shop/pack/purchase").Headers["Idempotency-Key"]);
        }

        [Fact]
        public async Task SendsTheKeyInTheBodyForGameWrites()
        {
            var api = new FakeTransport();
            await Build.Client(api).Game.RecordAsync(
                new Dictionary<string, object> { ["score"] = 10 });

            var call = api.LastOf("POST /game/record");
            Assert.False(call.Headers.ContainsKey("Idempotency-Key"));
            Assert.Contains("\"idempotency_key\":\"key-1\"", call.Body);
            Assert.Contains("\"score\":10", call.Body);
        }

        [Fact]
        public async Task ReusesTheSameKeyAcrossRetries()
        {
            var api = new FakeTransport().Sequence("POST /shop/pack/purchase",
                FakeTransport.Fail(503, ErrorCode.Unavailable, "down"),
                FakeTransport.Ok());

            await Build.Client(api).Shop.PurchaseAsync("pack");

            var keys = api.Calls
                .Where(c => c.Url.EndsWith("/shop/pack/purchase"))
                .Select(c => c.Headers["Idempotency-Key"])
                .ToList();

            Assert.Equal(2, keys.Count);
            Assert.Single(keys.Distinct());
        }

        [Fact]
        public async Task ReplaysACrashedWriteWithItsOriginalKey()
        {
            var storage = new InspectableStorage();

            // First "process": persisted, then the network dies.
            var dying = new FakeTransport().On("POST /shop/pack/purchase", FakeTransport.Offline());
            await Assert.ThrowsAsync<MagicweaveQueuedException>(
                () => Build.Client(dying, storage).Shop.PurchaseAsync("pack"));
            var persistedKey = dying.LastOf("POST /shop/pack/purchase").Headers["Idempotency-Key"];

            // Second "process": same storage, working network.
            var revived = new FakeTransport().On("POST /shop/pack/purchase", FakeTransport.Ok());
            await Build.Client(revived, storage).InitAsync();

            Assert.Equal(1, revived.CountOf("POST /shop/pack/purchase"));
            Assert.Equal(persistedKey,
                revived.LastOf("POST /shop/pack/purchase").Headers["Idempotency-Key"]);
        }

        [Fact]
        public async Task HonoursACallerSuppliedKey()
        {
            var api = new FakeTransport();
            var mw = Build.Client(api);

            await mw.Shop.PurchaseAsync("pack", "checkout-42");
            await mw.Shop.PurchaseAsync("pack", "checkout-42");

            var keys = api.Calls
                .Where(c => c.Url.EndsWith("/shop/pack/purchase"))
                .Select(c => c.Headers["Idempotency-Key"])
                .ToList();

            Assert.Equal(new[] { "checkout-42", "checkout-42" }, keys);
        }

        [Fact]
        public async Task DoesNotQueueReads()
        {
            var storage = new InspectableStorage();
            await Build.Client(new FakeTransport(), storage).Wallet.GetAsync();
            Assert.Null(storage.Find("write_queue"));
        }
    }

    // ── E4 ──────────────────────────────────────────────────────────────────

    public class E4OfflineQueue
    {
        [Fact]
        public async Task KeepsAnUndeliverableWriteAndReportsItAsQueued()
        {
            var api = new FakeTransport().On("POST /shop/pack/purchase", FakeTransport.Offline());
            var mw = Build.Client(api);

            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("pack"));
            Assert.Equal(1, await mw.PendingWritesAsync());
        }

        [Fact]
        public async Task DrainsInOrderWhenConnectivityReturns()
        {
            var storage = new InspectableStorage();
            var offline = new FakeTransport().Default(FakeTransport.Offline());
            var mw = Build.Client(offline, storage);

            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("a"));
            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("b"));
            Assert.Equal(2, await mw.PendingWritesAsync());

            var online = new FakeTransport();
            var reconnected = Build.Client(online, storage);
            var sent = new List<string>();
            reconnected.QueueChanged += (_, e) =>
            {
                if (e.Kind == QueueEventKind.Sent) sent.Add(e.Entry.Path);
            };

            await reconnected.FlushAsync();

            Assert.Equal(new[] { "/shop/a/purchase", "/shop/b/purchase" }, sent);
            Assert.Equal(0, await reconnected.PendingWritesAsync());
        }

        [Fact]
        public async Task DropsAPermanentlyFailingWriteInsteadOfWedgingTheQueue()
        {
            var storage = new InspectableStorage();
            var offline = new FakeTransport().Default(FakeTransport.Offline());
            var mw = Build.Client(offline, storage);

            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("broken"));
            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("fine"));

            var online = new FakeTransport()
                .On("POST /shop/broken/purchase",
                    FakeTransport.Fail(422, ErrorCode.ValidationError, "no such listing"))
                .On("POST /shop/fine/purchase", FakeTransport.Ok());

            var reconnected = Build.Client(online, storage);
            var failed = new List<string>();
            var sent = new List<string>();
            reconnected.QueueChanged += (_, e) =>
            {
                if (e.Kind == QueueEventKind.Failed) failed.Add(e.Entry.Path);
                if (e.Kind == QueueEventKind.Sent) sent.Add(e.Entry.Path);
            };

            await reconnected.FlushAsync();

            Assert.Equal(new[] { "/shop/broken/purchase" }, failed);
            Assert.Equal(new[] { "/shop/fine/purchase" }, sent);
            Assert.Equal(0, await reconnected.PendingWritesAsync());
        }

        [Fact]
        public async Task StopsAtTheFirstStillFailingEntryRatherThanReordering()
        {
            var storage = new InspectableStorage();
            var offline = new FakeTransport().Default(FakeTransport.Offline());
            var mw = Build.Client(offline, storage);
            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("first"));
            await Assert.ThrowsAsync<MagicweaveQueuedException>(() => mw.Shop.PurchaseAsync("second"));

            var partial = new FakeTransport()
                .On("POST /shop/first/purchase", FakeTransport.Fail(503, ErrorCode.Unavailable, "x"))
                .On("POST /shop/second/purchase", FakeTransport.Ok());

            var reconnected = Build.Client(partial, storage);
            await reconnected.FlushAsync();

            Assert.Equal(0, partial.CountOf("POST /shop/second/purchase"));
            Assert.Equal(2, await reconnected.PendingWritesAsync());
        }

        [Fact]
        public async Task SurvivesACorruptQueue()
        {
            var storage = new InspectableStorage();
            storage.Map["mw:cid:write_queue"] = "{not json";

            var mw = Build.Client(new FakeTransport(), storage);
            await mw.FlushAsync();

            Assert.Equal(0, await mw.PendingWritesAsync());
        }

        [Fact]
        public async Task CanBeTurnedOffForFireAndForget()
        {
            var storage = new InspectableStorage();
            var api = new FakeTransport().On("POST /shop/pack/purchase", FakeTransport.Offline());

            await Assert.ThrowsAsync<MagicweaveNetworkException>(
                () => Build.Client(api, storage, o => o.DurableWrites = false).Shop.PurchaseAsync("pack"));

            Assert.Null(storage.Find("write_queue"));
        }
    }

    // ── E5 ──────────────────────────────────────────────────────────────────

    public class E5RetryAndBackoff
    {
        [Fact]
        public async Task RetriesTransientFailures()
        {
            var api = new FakeTransport().Sequence("GET /wallet",
                FakeTransport.Fail(503, ErrorCode.Unavailable, "x"),
                FakeTransport.Offline(),
                FakeTransport.Ok("{\"gems\":1}"));

            var body = await Build.Client(api).Wallet.GetAsync();

            Assert.Contains("\"gems\":1", body);
            Assert.Equal(3, api.CountOf("GET /wallet"));
        }

        [Fact]
        public async Task NeverRetriesA4xx()
        {
            var api = new FakeTransport()
                .On("GET /wallet", FakeTransport.Fail(404, ErrorCode.NotFound, "no wallet"));

            await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api).Wallet.GetAsync());
            Assert.Equal(1, api.CountOf("GET /wallet"));
        }

        [Fact]
        public async Task GivesUpAfterMaxAttempts()
        {
            var api = new FakeTransport()
                .Default(FakeTransport.Fail(500, ErrorCode.ServerError, "x"));

            await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api, tweak: o => o.Retry.MaxAttempts = 2).Wallet.GetAsync());
            Assert.Equal(2, api.CountOf("GET /wallet"));
        }

        [Fact]
        public async Task HonoursRetryAfter()
        {
            var slept = new List<int>();
            var throttled = FakeTransport.Fail(429, ErrorCode.RateLimited, "slow down");
            throttled.Headers["retry-after"] = "2";

            var api = new FakeTransport().Sequence("GET /wallet", throttled, FakeTransport.Ok());

            await Build.Client(api, tweak: o => o.Sleep = (ms, ct) =>
            {
                slept.Add(ms);
                return Task.CompletedTask;
            }).Wallet.GetAsync();

            Assert.Equal(new[] { 2000 }, slept);
        }

        [Fact]
        public async Task BacksOffExponentiallyWithoutRetryAfter()
        {
            var slept = new List<int>();
            var api = new FakeTransport().Sequence("GET /wallet",
                FakeTransport.Fail(500, ErrorCode.ServerError, "x"),
                FakeTransport.Fail(500, ErrorCode.ServerError, "x"),
                FakeTransport.Ok());

            await Build.Client(api, tweak: o =>
            {
                o.Retry.BaseDelayMs = 100;
                o.Retry.Jitter = 0;
                o.Sleep = (ms, ct) =>
                {
                    slept.Add(ms);
                    return Task.CompletedTask;
                };
            }).Wallet.GetAsync();

            Assert.Equal(new[] { 100, 200 }, slept);
        }

        [Fact]
        public void ParsesRetryAfterInBothFormats()
        {
            Assert.Equal(3000, MagicweaveTransport.ParseRetryAfterMs("3"));
            Assert.Null(MagicweaveTransport.ParseRetryAfterMs(null));
            Assert.Null(MagicweaveTransport.ParseRetryAfterMs("not-a-date"));
        }
    }

    // ── errors ──────────────────────────────────────────────────────────────

    public class TypedErrors
    {
        [Theory]
        [InlineData(ErrorCode.InsufficientBalance, 402, typeof(InsufficientBalanceException))]
        [InlineData(ErrorCode.IdempotencyConflict, 409, typeof(IdempotencyConflictException))]
        [InlineData(ErrorCode.ValidationError, 422, typeof(MagicweaveValidationException))]
        [InlineData(ErrorCode.RateLimited, 429, typeof(RateLimitedException))]
        public async Task MapsCodeToClass(string code, int status, Type expected)
        {
            var api = new FakeTransport().On("GET /wallet", FakeTransport.Fail(status, code));

            var error = await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api, tweak: o => o.Retry.MaxAttempts = 1).Wallet.GetAsync());

            Assert.IsType(expected, error);
            Assert.Equal(code, error.Code);
        }

        [Fact]
        public async Task CarriesServerContextThrough()
        {
            var api = new FakeTransport().On("GET /wallet", new HttpOutcome
            {
                Status = 402,
                Body = "{\"detail\":\"Insufficient gold\",\"error\":{\"code\":\"insufficient_balance\"," +
                       "\"message\":\"Insufficient gold\",\"status\":402,\"context\":{\"currency\":\"gold\"}}}"
            });

            var error = await Assert.ThrowsAsync<InsufficientBalanceException>(
                () => Build.Client(api).Wallet.GetAsync());

            Assert.Equal("gold", error.Context["currency"].ToString());
        }

        [Fact]
        public async Task FallsBackToStatusDerivedCodeWhenEnvelopeIsMissing()
        {
            var api = new FakeTransport().On("GET /wallet",
                new HttpOutcome { Status = 403, Body = "{\"detail\":\"nope\"}" });

            var error = await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api).Wallet.GetAsync());

            Assert.Equal(ErrorCode.Forbidden, error.Code);
            Assert.Equal("nope", error.Message);
        }

        [Fact]
        public async Task IdempotencyConflictIsNeverRetried()
        {
            var api = new FakeTransport()
                .Default(FakeTransport.Fail(409, ErrorCode.IdempotencyConflict, "reused"));

            await Assert.ThrowsAsync<IdempotencyConflictException>(
                () => Build.Client(api).Shop.PurchaseAsync("pack"));
            Assert.Equal(1, api.CountOf("POST /shop/pack/purchase"));
        }

        [Fact]
        public async Task SurvivesAnErrorBodyThatIsNotJson()
        {
            var api = new FakeTransport().On("GET /wallet",
                new HttpOutcome { Status = 502, Body = "<html>bad gateway</html>" });

            var error = await Assert.ThrowsAnyAsync<MagicweaveApiException>(
                () => Build.Client(api, tweak: o => o.Retry.MaxAttempts = 1).Wallet.GetAsync());

            Assert.Equal(ErrorCode.ServerError, error.Code);
        }
    }

    // ── path handling ───────────────────────────────────────────────────────

    public class PathHandling
    {
        [Fact]
        public void KnowsWhichPathsCarryTheKeyInTheBody()
        {
            Assert.True(MagicweaveTransport.UsesBodyKey("/game/record"));
            Assert.False(MagicweaveTransport.UsesBodyKey("/shop/x/purchase"));
            Assert.False(MagicweaveTransport.UsesBodyKey("/inventory/x/consume"));
        }

        [Fact]
        public async Task EscapesKeysThatContainUrlSyntax()
        {
            var api = new FakeTransport().Default(FakeTransport.Ok());
            await Build.Client(api).Currency.BalanceAsync("gold coins/premium");

            Assert.Contains("gold%20coins%2Fpremium", api.Calls.Last().Url);
        }

        [Fact]
        public async Task KeepsSlashesInMultiSegmentDocumentPaths()
        {
            var api = new FakeTransport().Default(FakeTransport.Ok());
            await Build.Client(api).Documents.GetAsync("user/42/save");

            Assert.EndsWith("/documents/docs/user/42/save", api.Calls.Last().Url);
        }
    }
}
