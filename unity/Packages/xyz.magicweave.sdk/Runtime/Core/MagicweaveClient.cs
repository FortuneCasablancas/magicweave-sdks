using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Magicweave
{
    /// <summary>
    /// The one object a game holds.
    /// </summary>
    /// <example>
    /// <code>
    /// var mw = MagicweaveClient.Create(MagicweaveSettings.Instance);
    /// await mw.InitAsync();
    /// await mw.Auth.VerifyOtpAsync(email, code);
    /// var wallet = await mw.Wallet.GetAsync();
    /// </code>
    /// </example>
    public sealed class MagicweaveClient
    {
        private readonly MagicweaveTransport _transport;

        public AuthApi Auth { get; }
        public WalletApi Wallet { get; }
        public CurrencyApi Currency { get; }
        public InventoryApi Inventory { get; }
        public ShopApi Shop { get; }
        public LeaderboardsApi Leaderboards { get; }
        public GameApi Game { get; }
        public StatsApi Stats { get; }
        public ProfileApi Profile { get; }
        public SpinWheelApi SpinWheel { get; }
        public StreakApi Streak { get; }
        public DocumentsApi Documents { get; }

        /// <summary>Raised as queued writes are enqueued, sent, dropped, or fully drained.</summary>
        public event EventHandler<QueueEventArgs> QueueChanged
        {
            add => _transport.Queue.Changed += value;
            remove => _transport.Queue.Changed -= value;
        }

        public MagicweaveClient(MagicweaveOptions options)
        {
            _transport = new MagicweaveTransport(options);

            Auth = new AuthApi(_transport);
            Wallet = new WalletApi(_transport);
            Currency = new CurrencyApi(_transport);
            Inventory = new InventoryApi(_transport);
            Shop = new ShopApi(_transport);
            Leaderboards = new LeaderboardsApi(_transport);
            Game = new GameApi(_transport);
            Stats = new StatsApi(_transport);
            Profile = new ProfileApi(_transport);
            SpinWheel = new SpinWheelApi(_transport);
            Streak = new StreakApi(_transport);
            Documents = new DocumentsApi(_transport);
        }

        public bool IsSignedIn => _transport.Session.IsAuthenticated;

        /// <summary>
        /// Resolve the deployment layout, restore any stored session, and replay
        /// writes left over from last time.
        /// </summary>
        /// <remarks>
        /// Optional — every call works without it — but calling it once at boot
        /// means the first real request does not pay for the /healthz probe, and
        /// a player who closed the game offline gets their progress delivered
        /// before they notice it was missing.
        /// </remarks>
        public async Task InitAsync()
        {
            await _transport.RootAsync().ConfigureAwait(false);
            await _transport.Session.LoadAsync().ConfigureAwait(false);
            await _transport.FlushAsync().ConfigureAwait(false);
        }

        /// <summary>How many writes are still undelivered — for a "syncing…" indicator.</summary>
        public Task<int> PendingWritesAsync() => _transport.Queue.CountAsync();

        /// <summary>Try to deliver everything queued. Call this when connectivity returns.</summary>
        public Task FlushAsync() => _transport.FlushAsync();

        internal MagicweaveTransport Transport => _transport;
    }

    /// <summary>Base for the typed resource wrappers.</summary>
    public abstract class ApiBase
    {
        protected readonly MagicweaveTransport T;

        protected ApiBase(MagicweaveTransport transport) => T = transport;

        protected static string Encode(string segment) => Uri.EscapeDataString(segment);

        /// <summary>Document and realtime paths are multi-segment, so slashes survive.</summary>
        protected static string EncodePath(string path)
        {
            var parts = path.Split('/');
            var encoded = new List<string>(parts.Length);
            foreach (var part in parts)
            {
                if (!string.IsNullOrEmpty(part)) encoded.Add(Uri.EscapeDataString(part));
            }

            return string.Join("/", encoded);
        }

        protected Task<string> Get(string path) => T.RequestAsync("GET", path);
        protected Task<string> Write(string method, string path, object body = null, string key = null)
            => T.WriteAsync(method, path, body, key);
    }

    public sealed class AuthApi : ApiBase
    {
        public AuthApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> SignupAsync(string email, string password) =>
            T.RequestAsync("POST", "/auth/signup",
                new Dictionary<string, object> { ["email"] = email, ["password"] = password }, true);

        public Task LoginAsync(string email, string password) =>
            StoreTokensAsync(T.RequestAsync("POST", "/auth/login",
                new Dictionary<string, object> { ["email"] = email, ["password"] = password }, true));

        /// <summary>Send a one-time code to the player's email.</summary>
        public Task RequestOtpAsync(string email) =>
            T.RequestAsync("POST", "/auth/otp/request",
                new Dictionary<string, object> { ["email"] = email }, true);

        /// <summary>Exchange the code for a session.</summary>
        public Task VerifyOtpAsync(string email, string otp) =>
            StoreTokensAsync(T.RequestAsync("POST", "/auth/otp/verify",
                new Dictionary<string, object> { ["email"] = email, ["otp"] = otp }, true));

        public Task SignInWithGoogleAsync(string idToken) =>
            StoreTokensAsync(T.RequestAsync("POST", "/auth/google-signin",
                new Dictionary<string, object> { ["id_token"] = idToken }, true));

        public Task SignInWithAppleAsync(string identityToken) =>
            StoreTokensAsync(T.RequestAsync("POST", "/auth/apple-signin",
                new Dictionary<string, object> { ["identity_token"] = identityToken }, true));

        /// <summary>Forget the session on this device. Does not revoke server-side.</summary>
        public Task SignOutAsync() => T.Session.ClearAsync();

        private async Task StoreTokensAsync(Task<string> call)
        {
            var body = await call.ConfigureAwait(false);
            var parsed = Json.ParseObject(body);
            var access = parsed?["access_token"]?.ToString();
            if (string.IsNullOrEmpty(access)) return;

            await T.Session.SetAsync(new TokenPair
            {
                AccessToken = access,
                RefreshToken = parsed["refresh_token"]?.ToString()
            }).ConfigureAwait(false);
        }
    }

    public sealed class WalletApi : ApiBase
    {
        public WalletApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> GetAsync() => Get("/wallet");
        public Task<string> HistoryAsync() => Get("/wallet/history");
    }

    public sealed class CurrencyApi : ApiBase
    {
        public CurrencyApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> BalancesAsync() => Get("/currency");
        public Task<string> BalanceAsync(string currencyKey) => Get("/currency/" + Encode(currencyKey));
        public Task<string> HistoryAsync() => Get("/currency/history");
    }

    public sealed class InventoryApi : ApiBase
    {
        public InventoryApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> ListAsync() => Get("/inventory");
        public Task<string> GetAsync(string itemKey) => Get("/inventory/" + Encode(itemKey));
        public Task<string> HistoryAsync() => Get("/inventory/history");

        public Task<string> ConsumeAsync(string itemKey, int? quantity = null,
            int? instanceId = null, string idempotencyKey = null)
        {
            var body = new Dictionary<string, object>();
            if (quantity.HasValue) body["quantity"] = quantity.Value;
            if (instanceId.HasValue) body["instance_id"] = instanceId.Value;
            return Write("POST", $"/inventory/{Encode(itemKey)}/consume", body, idempotencyKey);
        }

        public Task<string> EquipAsync(string itemKey, int instanceId, string slot,
            string idempotencyKey = null) =>
            Write("POST", $"/inventory/{Encode(itemKey)}/{instanceId}/equip",
                new Dictionary<string, object> { ["slot"] = slot }, idempotencyKey);

        public Task<string> UnequipAsync(string itemKey, int instanceId, string idempotencyKey = null) =>
            Write("POST", $"/inventory/{Encode(itemKey)}/{instanceId}/unequip", null, idempotencyKey);
    }

    public sealed class ShopApi : ApiBase
    {
        public ShopApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> ListAsync() => Get("/shop");
        public Task<string> GetAsync(string listingKey) => Get("/shop/" + Encode(listingKey));
        public Task<string> HistoryAsync(string listingKey) =>
            Get($"/shop/{Encode(listingKey)}/history");

        /// <summary>
        /// Spends in-game currency. Durable and idempotent — a retry cannot
        /// double-charge, even if the process dies mid-request.
        /// </summary>
        public Task<string> PurchaseAsync(string listingKey, string idempotencyKey = null) =>
            Write("POST", $"/shop/{Encode(listingKey)}/purchase", null, idempotencyKey);
    }

    public sealed class LeaderboardsApi : ApiBase
    {
        public LeaderboardsApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> ListAsync() => Get("/leaderboards");
        public Task<string> GetAsync(string slug) => Get("/leaderboards/" + Encode(slug));
        public Task<string> EntriesAsync(string slug) => Get($"/leaderboards/{Encode(slug)}/entries");

        /// <summary>The signed-in player's own rank.</summary>
        public Task<string> MeAsync(string slug) => Get($"/leaderboards/{Encode(slug)}/me");

        /// <summary>Neighbours above and below the player — the "you are here" strip.</summary>
        public Task<string> ContextAsync(string slug) => Get($"/leaderboards/{Encode(slug)}/context");

        /// <summary>Board, entries and the player's rank in one round trip.</summary>
        public Task<string> BundleAsync(string slug) => Get($"/leaderboards/{Encode(slug)}/bundle");

        public Task<string> RewardsAsync(string slug) => Get($"/leaderboards/{Encode(slug)}/rewards");
    }

    /// <summary>
    /// A play session: enter (paying any entry cost), record the outcome, or refund.
    /// </summary>
    /// <remarks>
    /// The highest-stakes writes in the product — Record is what moves a score
    /// onto a leaderboard and pays out currency — so every one is durable and
    /// idempotent. The key rides in the body here, not the header; the transport
    /// handles that difference.
    /// </remarks>
    public sealed class GameApi : ApiBase
    {
        public GameApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> EnterAsync(string manifestKey, string idempotencyKey = null) =>
            Write("POST", "/game/enter",
                new Dictionary<string, object> { ["manifest_key"] = manifestKey }, idempotencyKey);

        public Task<string> EnterAndStartAsync(string manifestKey, string idempotencyKey = null) =>
            Write("POST", "/game/enter-and-start",
                new Dictionary<string, object> { ["manifest_key"] = manifestKey }, idempotencyKey);

        public Task<string> RecordAsync(IDictionary<string, object> payload, string idempotencyKey = null) =>
            Write("POST", "/game/record", payload, idempotencyKey);

        public Task<string> RefundAsync(IDictionary<string, object> payload, string idempotencyKey = null) =>
            Write("POST", "/game/refund", payload, idempotencyKey);

        public Task<string> ActiveSessionAsync() => Get("/game/session");

        public Task<string> AbandonSessionAsync(IDictionary<string, object> payload = null) =>
            Write("PUT", "/game/session", payload);
    }

    public sealed class StatsApi : ApiBase
    {
        public StatsApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> GetAsync() => Get("/stats");
    }

    public sealed class ProfileApi : ApiBase
    {
        public ProfileApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> GetAsync() => Get("/profile/");
        public Task<string> ByUserIdAsync(string userId) => Get("/profile/" + Encode(userId));

        public Task<string> CreateAsync(IDictionary<string, object> payload) =>
            Write("POST", "/profile/", payload);

        public Task<string> UpdateAsync(IDictionary<string, object> payload) =>
            Write("PATCH", "/profile/", payload);
    }

    public sealed class SpinWheelApi : ApiBase
    {
        public SpinWheelApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> ListAsync() => Get("/spin-wheel/wheels");
        public Task<string> GetAsync(string keySlug) =>
            Get("/spin-wheel/wheels/by-key/" + Encode(keySlug));
        public Task<string> StateAsync(string keySlug) =>
            Get($"/spin-wheel/wheels/by-key/{Encode(keySlug)}/state");

        /// <summary>Preview the odds without consuming a spin.</summary>
        public Task<string> DrySpinAsync(string keySlug) =>
            T.RequestAsync("POST", $"/spin-wheel/wheels/by-key/{Encode(keySlug)}/dry-spin");

        public Task<string> SpinAsync(string keySlug, string idempotencyKey = null) =>
            Write("POST", $"/spin-wheel/wheels/by-key/{Encode(keySlug)}/spin", null, idempotencyKey);

        public Task<string> ClaimAsync(string keySlug, IDictionary<string, object> payload = null,
            string idempotencyKey = null) =>
            Write("POST", $"/spin-wheel/wheels/by-key/{Encode(keySlug)}/claim-spin-reward",
                payload, idempotencyKey);
    }

    public sealed class StreakApi : ApiBase
    {
        public StreakApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> StatusAsync(string keySlug) => Get($"/streak/{Encode(keySlug)}/status");
        public Task<string> HistoryAsync(string keySlug) => Get($"/streak/{Encode(keySlug)}/history");

        public Task<string> CheckInAsync(string keySlug, string idempotencyKey = null) =>
            Write("POST", $"/streak/{Encode(keySlug)}/check-in", null, idempotencyKey);
    }

    /// <summary>
    /// Project-scoped JSON storage. Not player-isolated: any authenticated player
    /// can read or write any path, so namespace by user id ("user/{id}/save") and
    /// enforce ownership in your own logic.
    /// </summary>
    public sealed class DocumentsApi : ApiBase
    {
        public DocumentsApi(MagicweaveTransport transport) : base(transport) { }

        public Task<string> GetAsync(string path) => Get("/documents/docs/" + EncodePath(path));

        public Task<string> SetAsync(string path, object data) =>
            Write("PUT", "/documents/docs/" + EncodePath(path),
                new Dictionary<string, object> { ["data"] = data });

        public Task<string> MergeAsync(string path, object data) =>
            Write("PATCH", "/documents/docs/" + EncodePath(path),
                new Dictionary<string, object> { ["data"] = data });

        public Task<string> DeleteAsync(string path) =>
            Write("DELETE", "/documents/docs/" + EncodePath(path));

        public Task<string> ListAsync(string collection) =>
            Get("/documents/collections/" + Encode(collection));

        public Task<string> AddAsync(string collection, object data) =>
            Write("POST", "/documents/collections/" + Encode(collection),
                new Dictionary<string, object> { ["data"] = data });
    }
}
