using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Magicweave
{
    /// <summary>How players are identified on each call.</summary>
    public enum IdentityMode
    {
        /// <summary>Network project: the SDK holds tokens and sends <c>Authorization: Bearer</c>.</summary>
        Network,

        /// <summary>Non-network project: the caller owns identity, sent as <c>x-external-user-id</c>.</summary>
        External
    }

    /// <summary>Async key/value store for tokens and the durable write queue.</summary>
    /// <remarks>
    /// The SDK never picks a store for you. A token is a credential, and only the
    /// app knows where credentials belong on its platform — so the default is
    /// memory and anything durable is explicit. Specifically: not PlayerPrefs,
    /// which is a plaintext file any player can read and edit.
    /// </remarks>
    public interface IMagicweaveStorage
    {
        Task<string> GetAsync(string key);
        Task SetAsync(string key, string value);
        Task RemoveAsync(string key);
    }

    public interface IMagicweaveLogger
    {
        void Debug(string message);
        void Info(string message);
        void Warn(string message);
        void Error(string message);
    }

    /// <summary>One HTTP round trip. Implemented by UnityWebRequest at runtime.</summary>
    /// <remarks>
    /// This interface is why the core is engine-independent: the ergonomics layer
    /// can be unit-tested against a fake without a Unity player loop, and the same
    /// code runs in a plain .NET console tool.
    /// </remarks>
    public interface IHttpTransport
    {
        Task<HttpOutcome> SendAsync(HttpCall call, CancellationToken cancellationToken);
    }

    public sealed class HttpCall
    {
        public string Method { get; set; } = "GET";
        public string Url { get; set; }
        public IDictionary<string, string> Headers { get; set; } = new Dictionary<string, string>();
        public string Body { get; set; }
    }

    public sealed class HttpOutcome
    {
        /// <summary>Zero when the request never reached the server.</summary>
        public int Status { get; set; }
        public string Body { get; set; }
        public IDictionary<string, string> Headers { get; set; } = new Dictionary<string, string>();

        /// <summary>Set when the request failed below HTTP — offline, DNS, TLS.</summary>
        public string TransportError { get; set; }

        public bool IsTransportFailure => TransportError != null;
        public bool IsSuccess => !IsTransportFailure && Status >= 200 && Status < 300;
    }

    public sealed class RetryPolicy
    {
        /// <summary>Total attempts including the first. 1 disables retrying.</summary>
        public int MaxAttempts { get; set; } = 4;

        public int BaseDelayMs { get; set; } = 250;
        public int MaxDelayMs { get; set; } = 8000;

        /// <summary>Random fraction (0–1) added to each delay, so a thousand devices
        /// reconnecting after an outage do not arrive in lockstep.</summary>
        public double Jitter { get; set; } = 0.3;
    }

    public sealed class MagicweaveOptions
    {
        /// <summary>Environment client id, from the console's Environments page.</summary>
        public string ClientId { get; set; }

        /// <summary>Environment client secret. Never ship this in a WebGL build.</summary>
        public string ClientSecret { get; set; }

        /// <summary>
        /// API host, e.g. <c>https://api.magicweave.xyz</c>. The SDK probes
        /// <c>/healthz</c> once to discover whether client routes live at the root
        /// or under <c>/client</c>, so a combined deployment needs no extra config.
        /// </summary>
        public string BaseUrl { get; set; }

        public IdentityMode Mode { get; set; } = IdentityMode.Network;

        /// <summary>Required when <see cref="Mode"/> is External.</summary>
        public string ExternalUserId { get; set; }

        public IMagicweaveStorage Storage { get; set; }
        public IMagicweaveLogger Logger { get; set; }
        public IHttpTransport Transport { get; set; }
        public RetryPolicy Retry { get; set; } = new RetryPolicy();

        /// <summary>
        /// Persist every write before sending it, so a crash mid-request cannot
        /// lose the operation and a retry reuses the same idempotency key.
        /// </summary>
        public bool DurableWrites { get; set; } = true;

        /// <summary>Namespace for storage keys. Set it if two projects share a device store.</summary>
        public string StorageNamespace { get; set; }

        /// <summary>Overrides the <c>x-mw-sdk</c> platform tag.</summary>
        public string Platform { get; set; } = "unity";

        // Injectable seams, for tests.
        public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;
        public Func<int, CancellationToken, Task> Sleep { get; set; }
        public Func<string> NewId { get; set; } = () => Guid.NewGuid().ToString("N");

        internal void Validate()
        {
            if (string.IsNullOrEmpty(ClientId) || string.IsNullOrEmpty(ClientSecret))
            {
                throw new MagicweaveConfigException(
                    "ClientId and ClientSecret are required — copy them from the console's Environments page.");
            }

            if (string.IsNullOrEmpty(BaseUrl))
            {
                throw new MagicweaveConfigException(
                    "BaseUrl is required, e.g. https://api.magicweave.xyz");
            }

            if (Mode == IdentityMode.External && string.IsNullOrEmpty(ExternalUserId))
            {
                throw new MagicweaveConfigException(
                    "ExternalUserId is required when Mode is External — it identifies the player.");
            }

            if (Transport == null)
            {
                throw new MagicweaveConfigException(
                    "No IHttpTransport supplied. In Unity, use MagicweaveClient.Create(settings), " +
                    "which wires up the UnityWebRequest transport for you.");
            }
        }
    }

    /// <summary>A durably-persisted write awaiting delivery.</summary>
    [Serializable]
    public sealed class QueuedWrite
    {
        public string Id;
        public string Method;
        public string Path;
        public string Body;

        /// <summary>The key minted before the first send, reused by every retry.</summary>
        public string IdempotencyKey;

        /// <summary>"header" for inventory/shop writes, "body" for /game writes.</summary>
        public string KeyTransport;

        public long CreatedAtUnixMs;
        public int Attempts;
        public string LastError;
    }

    public enum QueueEventKind
    {
        Enqueued,
        Sent,
        Failed,
        Drained
    }

    public sealed class QueueEventArgs : EventArgs
    {
        public QueueEventKind Kind { get; }
        public QueuedWrite Entry { get; }
        public string ResponseBody { get; }
        public Exception Error { get; }

        public QueueEventArgs(QueueEventKind kind, QueuedWrite entry,
            string responseBody = null, Exception error = null)
        {
            Kind = kind;
            Entry = entry;
            ResponseBody = responseBody;
            Error = error;
        }
    }
}
