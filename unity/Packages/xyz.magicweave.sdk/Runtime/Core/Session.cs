using System;
using System.Threading.Tasks;

namespace Magicweave
{
    public sealed class TokenPair
    {
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
    }

    /// <summary>
    /// Behaviour E2 — a session that survives.
    /// </summary>
    /// <remarks>
    /// The single-flight refresh matters more than it looks. A game that fires
    /// six requests on resume will otherwise send six refreshes, and whichever
    /// lands last wins — invalidating the tokens the other five just stored.
    /// </remarks>
    public sealed class Session
    {
        private const string AccessKey = "access_token";
        private const string RefreshKey = "refresh_token";

        private readonly IMagicweaveStorage _storage;
        private readonly string _namespace;
        private readonly IMagicweaveLogger _logger;
        private readonly Func<string, Task<TokenPair>> _refreshFn;
        private readonly object _gate = new object();

        private TokenPair _tokens;
        private bool _loaded;
        private Task<TokenPair> _inFlightRefresh;

        public Session(
            IMagicweaveStorage storage,
            string storageNamespace,
            IMagicweaveLogger logger,
            Func<string, Task<TokenPair>> refreshFn)
        {
            _storage = storage;
            _namespace = storageNamespace;
            _logger = logger;
            _refreshFn = refreshFn;
        }

        public bool IsAuthenticated => _tokens != null;

        private string Key(string name) => _namespace + ":" + name;

        public async Task<TokenPair> LoadAsync()
        {
            if (_loaded) return _tokens;

            var access = await _storage.GetAsync(Key(AccessKey)).ConfigureAwait(false);
            var refresh = await _storage.GetAsync(Key(RefreshKey)).ConfigureAwait(false);

            _tokens = string.IsNullOrEmpty(access)
                ? null
                : new TokenPair { AccessToken = access, RefreshToken = refresh };
            _loaded = true;
            return _tokens;
        }

        public async Task SetAsync(TokenPair tokens)
        {
            _tokens = tokens;
            _loaded = true;
            await _storage.SetAsync(Key(AccessKey), tokens.AccessToken).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(tokens.RefreshToken))
            {
                await _storage.SetAsync(Key(RefreshKey), tokens.RefreshToken).ConfigureAwait(false);
            }
        }

        public async Task ClearAsync()
        {
            _tokens = null;
            _loaded = true;
            await _storage.RemoveAsync(Key(AccessKey)).ConfigureAwait(false);
            await _storage.RemoveAsync(Key(RefreshKey)).ConfigureAwait(false);
        }

        public async Task<string> AccessTokenAsync()
        {
            var tokens = await LoadAsync().ConfigureAwait(false);
            return tokens?.AccessToken;
        }

        /// <summary>
        /// Refresh once, no matter how many callers ask at the same time.
        /// Returns null when there is nothing to refresh with, or the refresh
        /// token itself was rejected — in which case the session is cleared and
        /// the caller should prompt for sign-in rather than retrying.
        /// </summary>
        public Task<TokenPair> RefreshAsync()
        {
            lock (_gate)
            {
                if (_inFlightRefresh != null) return _inFlightRefresh;
                _inFlightRefresh = RefreshCoreAsync();
                return _inFlightRefresh;
            }
        }

        private async Task<TokenPair> RefreshCoreAsync()
        {
            try
            {
                var current = await LoadAsync().ConfigureAwait(false);
                if (current == null || string.IsNullOrEmpty(current.RefreshToken))
                {
                    _logger?.Debug("refresh requested with no refresh token");
                    return null;
                }

                try
                {
                    var next = await _refreshFn(current.RefreshToken).ConfigureAwait(false);
                    await SetAsync(next).ConfigureAwait(false);
                    _logger?.Debug("access token refreshed");
                    return next;
                }
                catch (MagicweaveAuthException)
                {
                    // The refresh token is dead. Keeping it would make every later
                    // request pay for two round trips before failing.
                    _logger?.Info("refresh token rejected, clearing session");
                    await ClearAsync().ConfigureAwait(false);
                    return null;
                }
            }
            finally
            {
                lock (_gate)
                {
                    _inFlightRefresh = null;
                }
            }
        }
    }
}
