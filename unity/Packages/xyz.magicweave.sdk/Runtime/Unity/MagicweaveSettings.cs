using System;
using UnityEngine;

namespace Magicweave.Unity
{
    /// <summary>Which environment a build talks to.</summary>
    public enum MagicweaveEnvironmentKind
    {
        Testing,
        Production
    }

    /// <summary>One environment's credentials, as issued by the console.</summary>
    [Serializable]
    public sealed class MagicweaveEnvironment
    {
        [Tooltip("A name for you — not sent anywhere.")]
        public string label = "Testing";

        public MagicweaveEnvironmentKind kind = MagicweaveEnvironmentKind.Testing;

        [Tooltip("From the console: Project → Environments → this environment.")]
        public string clientId;

        [Tooltip("Treat like a password. Never commit it to a public repo.")]
        public string clientSecret;

        [Tooltip("Preview credentials target the DRAFT release — for QA before you publish.")]
        public bool usePreviewCredentials;

        public bool IsComplete => !string.IsNullOrEmpty(clientId) && !string.IsNullOrEmpty(clientSecret);
    }

    /// <summary>
    /// Behaviour E8 — environments in the editor.
    /// </summary>
    /// <remarks>
    /// Credentials live here, not in code, so pointing a build at production is a
    /// dropdown rather than an edit-compile cycle. The asset is created by
    /// <c>Window → Magicweave → Setup</c>, which also offers to gitignore it.
    /// <para/>
    /// A shipped build embeds whatever is in this asset, so on WebGL the client
    /// secret is readable by anyone with devtools. That is a property of the
    /// platform, not of this asset — route web builds through a server you own.
    /// </remarks>
    public sealed class MagicweaveSettings : ScriptableObject
    {
        public const string ResourcePath = "MagicweaveSettings";
        public const string DefaultBaseUrl = "https://api.magicweave.xyz";

        [Tooltip("API host. Leave as-is unless you run your own deployment.")]
        public string baseUrl = DefaultBaseUrl;

        [Tooltip("Which of the environments below this build uses.")]
        public int activeEnvironmentIndex;

        public MagicweaveEnvironment[] environments =
        {
            new MagicweaveEnvironment { label = "Testing", kind = MagicweaveEnvironmentKind.Testing }
        };

        [Header("Identity")]
        [Tooltip("Non-network projects identify the player with your own id instead of a token.")]
        public bool nonNetworkProject;

        [Header("Behaviour")]
        [Tooltip("Persist every write before sending it, so a crash or a dead network cannot lose it.")]
        public bool durableWrites = true;

        [Tooltip("Log SDK activity to the Unity console. Leave off in a shipping build.")]
        public bool verboseLogging;

        private static MagicweaveSettings _instance;

        /// <summary>
        /// The settings asset from <c>Resources</c>, or null if setup has not run.
        /// </summary>
        public static MagicweaveSettings Instance
        {
            get
            {
                if (_instance == null) _instance = Resources.Load<MagicweaveSettings>(ResourcePath);
                return _instance;
            }
        }

        public MagicweaveEnvironment ActiveEnvironment
        {
            get
            {
                if (environments == null || environments.Length == 0) return null;
                var index = Mathf.Clamp(activeEnvironmentIndex, 0, environments.Length - 1);
                return environments[index];
            }
        }

        /// <summary>Turn the asset into options, with a readable error if it is half-filled.</summary>
        public MagicweaveOptions ToOptions()
        {
            var environment = ActiveEnvironment;
            if (environment == null)
            {
                throw new MagicweaveConfigException(
                    "No environments configured. Open Window → Magicweave → Setup and paste the " +
                    "client id and secret from your project's Environments page.");
            }

            if (!environment.IsComplete)
            {
                throw new MagicweaveConfigException(
                    $"Environment '{environment.label}' is missing its client id or secret. " +
                    "Copy both from the console: Project → Environments.");
            }

            return new MagicweaveOptions
            {
                ClientId = environment.clientId,
                ClientSecret = environment.clientSecret,
                BaseUrl = string.IsNullOrEmpty(baseUrl) ? DefaultBaseUrl : baseUrl,
                Mode = nonNetworkProject ? IdentityMode.External : IdentityMode.Network,
                DurableWrites = durableWrites,
                Logger = verboseLogging ? (IMagicweaveLogger)new UnityLogger() : NullLogger.Instance,
                Transport = new UnityWebRequestTransport(),
                Storage = new FileStorage(),
                Platform = "unity"
            };
        }
    }

    public sealed class UnityLogger : IMagicweaveLogger
    {
        public void Debug(string message) => UnityEngine.Debug.Log("[Magicweave] " + message);
        public void Info(string message) => UnityEngine.Debug.Log("[Magicweave] " + message);
        public void Warn(string message) => UnityEngine.Debug.LogWarning("[Magicweave] " + message);
        public void Error(string message) => UnityEngine.Debug.LogError("[Magicweave] " + message);
    }
}
