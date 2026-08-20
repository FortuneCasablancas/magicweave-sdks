using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Magicweave
{
    /// <summary>The default store. Forgets everything when the process exits.</summary>
    public sealed class MemoryStorage : IMagicweaveStorage
    {
        private readonly Dictionary<string, string> _map = new Dictionary<string, string>();

        public Task<string> GetAsync(string key)
        {
            _map.TryGetValue(key, out var value);
            return Task.FromResult(value);
        }

        public Task SetAsync(string key, string value)
        {
            _map[key] = value;
            return Task.CompletedTask;
        }

        public Task RemoveAsync(string key)
        {
            _map.Remove(key);
            return Task.CompletedTask;
        }
    }

    /// <summary>
    /// A store that swallows its own failures.
    /// </summary>
    /// <remarks>
    /// A full disk or a revoked keychain entitlement must not take a running game
    /// down: a failed read behaves as a cache miss, a failed write is logged and
    /// dropped. Durability degrades silently, which is why it warns.
    /// </remarks>
    public sealed class ForgivingStorage : IMagicweaveStorage
    {
        private readonly IMagicweaveStorage _inner;
        private readonly IMagicweaveLogger _logger;

        public ForgivingStorage(IMagicweaveStorage inner, IMagicweaveLogger logger)
        {
            _inner = inner;
            _logger = logger;
        }

        public async Task<string> GetAsync(string key)
        {
            try
            {
                return await _inner.GetAsync(key).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                _logger?.Warn($"storage read failed for '{key}', treating as empty: {error.Message}");
                return null;
            }
        }

        public async Task SetAsync(string key, string value)
        {
            try
            {
                await _inner.SetAsync(key, value).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                _logger?.Warn($"storage write failed for '{key}', value not persisted: {error.Message}");
            }
        }

        public async Task RemoveAsync(string key)
        {
            try
            {
                await _inner.RemoveAsync(key).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                _logger?.Warn($"storage delete failed for '{key}': {error.Message}");
            }
        }
    }

    public sealed class NullLogger : IMagicweaveLogger
    {
        public static readonly NullLogger Instance = new NullLogger();

        public void Debug(string message) { }
        public void Info(string message) { }
        public void Warn(string message) { }
        public void Error(string message) { }
    }
}
