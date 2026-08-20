using System.Collections.Generic;
using System.Threading.Tasks;
using Magicweave;
using Magicweave.Unity;
using UnityEngine;
using UnityEngine.UI;

namespace Magicweave.Samples
{
    /// <summary>
    /// Sign in, read a wallet, submit a score, and watch the offline queue drain.
    /// </summary>
    /// <remarks>
    /// Drop this on a GameObject, wire the four UI fields, and press play. The
    /// interesting part is <see cref="OnSubmitScore"/>: turn off your wifi before
    /// pressing it and the score is still safe — it lands in the durable queue
    /// and delivers itself when the connection returns.
    /// </remarks>
    public sealed class QuickStartDemo : MonoBehaviour
    {
        [Header("Sign in")]
        public InputField emailField;
        public InputField codeField;

        [Header("Output")]
        public Text statusText;
        public Text walletText;

        private void Start()
        {
            // Surface queue activity so the offline path is visible rather than magic.
            MagicweaveSDK.Client.QueueChanged += (_, e) =>
            {
                switch (e.Kind)
                {
                    case QueueEventKind.Enqueued:
                        Status($"queued {e.Entry.Path}");
                        break;
                    case QueueEventKind.Sent:
                        Status($"delivered {e.Entry.Path}");
                        break;
                    case QueueEventKind.Failed:
                        Status($"gave up on {e.Entry.Path}: {e.Error?.Message}");
                        break;
                    case QueueEventKind.Drained:
                        Status("everything synced");
                        break;
                }
            };

            _ = BootAsync();
        }

        private async Task BootAsync()
        {
            try
            {
                await MagicweaveSDK.InitAsync();
                Status(MagicweaveSDK.Client.IsSignedIn
                    ? "signed in — welcome back"
                    : "enter your email to get a sign-in code");

                if (MagicweaveSDK.Client.IsSignedIn) await RefreshWalletAsync();
            }
            catch (MagicweaveConfigException error)
            {
                Status(error.Message);
            }
        }

        public async void OnRequestCode()
        {
            try
            {
                await MagicweaveSDK.Client.Auth.RequestOtpAsync(emailField.text);
                Status("check your email for a 6-digit code");
            }
            catch (MagicweaveApiException error)
            {
                Status(error.Message);
            }
        }

        public async void OnVerifyCode()
        {
            try
            {
                await MagicweaveSDK.Client.Auth.VerifyOtpAsync(emailField.text, codeField.text);
                Status("signed in");
                await RefreshWalletAsync();
            }
            catch (MagicweaveApiException error)
            {
                Status(error.Message);
            }
        }

        /// <summary>Try this with wifi off — the score survives.</summary>
        public async void OnSubmitScore()
        {
            var score = Random.Range(100, 10000);
            try
            {
                await MagicweaveSDK.Client.Game.RecordAsync(
                    new Dictionary<string, object> { ["score"] = score });
                Status($"score {score} recorded");
                await RefreshWalletAsync();
            }
            catch (MagicweaveQueuedException)
            {
                // Not an error: the write is persisted and will be delivered.
                Status($"score {score} saved — will sync when you're back online");
            }
            catch (InsufficientBalanceException)
            {
                Status("not enough currency to play a round");
            }
            catch (MagicweaveApiException error)
            {
                Status($"{error.Code}: {error.Message}");
            }
        }

        public async void OnFlush()
        {
            await MagicweaveSDK.Client.FlushAsync();
            var pending = await MagicweaveSDK.Client.PendingWritesAsync();
            Status(pending == 0 ? "everything synced" : $"{pending} write(s) still pending");
        }

        private async Task RefreshWalletAsync()
        {
            try
            {
                if (walletText != null) walletText.text = await MagicweaveSDK.Client.Wallet.GetAsync();
            }
            catch (MagicweaveException error)
            {
                Status(error.Message);
            }
        }

        private void Status(string message)
        {
            if (statusText != null) statusText.text = message;
            Debug.Log("[QuickStart] " + message);
        }
    }
}
