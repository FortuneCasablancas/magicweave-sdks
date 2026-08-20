using System;
using System.Threading.Tasks;
using UnityEngine;

namespace Magicweave.Unity
{
    /// <summary>
    /// The entry point a game touches: <c>MagicweaveSDK.Client</c>.
    /// </summary>
    /// <remarks>
    /// One shared client per process, built from the settings asset, kept alive
    /// across scene loads, and flushed whenever the app comes back to the
    /// foreground — which on mobile is the moment connectivity usually returns.
    /// </remarks>
    [DisallowMultipleComponent]
    public sealed class MagicweaveSDK : MonoBehaviour
    {
        private static MagicweaveSDK _runner;
        private static MagicweaveClient _client;

        /// <summary>
        /// The shared client. Built on first access from the settings asset.
        /// </summary>
        /// <exception cref="MagicweaveConfigException">
        /// If setup has not run, or an environment is missing credentials.
        /// </exception>
        public static MagicweaveClient Client
        {
            get
            {
                if (_client != null) return _client;

                var settings = MagicweaveSettings.Instance;
                if (settings == null)
                {
                    throw new MagicweaveConfigException(
                        "No Magicweave settings found. Open Window → Magicweave → Setup to create " +
                        "them, or build a MagicweaveClient yourself with MagicweaveOptions.");
                }

                _client = new MagicweaveClient(settings.ToOptions());
                EnsureRunner();
                return _client;
            }
        }

        /// <summary>True once <see cref="InitAsync"/> or a first call has resolved the layout.</summary>
        public static bool IsReady { get; private set; }

        /// <summary>
        /// Resolve the deployment layout, restore the session, and replay writes
        /// left over from last time. Safe to call more than once.
        /// </summary>
        public static async Task InitAsync()
        {
            await Client.InitAsync().ConfigureAwait(false);
            IsReady = true;
        }

        /// <summary>
        /// Point the SDK at explicit options instead of the settings asset.
        /// Call before first use — a server build, or a test harness.
        /// </summary>
        public static void Configure(MagicweaveOptions options)
        {
            _client = new MagicweaveClient(options);
            IsReady = false;
            EnsureRunner();
        }

        /// <summary>Drop the client. The next access rebuilds it from settings.</summary>
        public static void Reset()
        {
            _client = null;
            IsReady = false;
        }

        private static void EnsureRunner()
        {
            if (_runner != null || !Application.isPlaying) return;

            var host = new GameObject("Magicweave")
            {
                hideFlags = HideFlags.HideAndDontSave
            };
            _runner = host.AddComponent<MagicweaveSDK>();
            DontDestroyOnLoad(host);
        }

        private void OnApplicationPause(bool paused)
        {
            // Coming back from the background is when a player's connection has
            // usually just returned, so it is the best moment to drain.
            if (!paused) FlushQuietly();
        }

        private void OnApplicationFocus(bool focused)
        {
            if (focused) FlushQuietly();
        }

        private void FlushQuietly()
        {
            if (_client == null) return;

            // Fire-and-forget on purpose: a failed drain leaves everything queued
            // for the next attempt, and a lifecycle callback must never throw.
            _ = FlushSafeAsync();
        }

        private static async Task FlushSafeAsync()
        {
            try
            {
                await _client.FlushAsync().ConfigureAwait(false);
            }
            catch (Exception error)
            {
                Debug.LogWarning("[Magicweave] background flush failed: " + error.Message);
            }
        }
    }
}
