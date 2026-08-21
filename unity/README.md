# Magicweave for Unity

```
Window → Magicweave → Setup
```

Paste the client id and secret from your project's **Environments** page in the console, and you're
connected. Nothing else to configure.

## Install

Package Manager → **Add package from git URL**:

```
https://github.com/FortuneCasablancas/magicweave-sdks.git?path=/unity/Packages/xyz.magicweave.sdk#unity-v0.1.0
```

Requires Unity 2021.3+ and `com.unity.nuget.newtonsoft-json` (resolved automatically).

## Use it

```csharp
using Magicweave;
using Magicweave.Unity;

async void Start()
{
    await MagicweaveSDK.InitAsync();

    if (!MagicweaveSDK.Client.IsSignedIn)
    {
        await MagicweaveSDK.Client.Auth.RequestOtpAsync(email);
        await MagicweaveSDK.Client.Auth.VerifyOtpAsync(email, code);
    }

    var wallet = await MagicweaveSDK.Client.Wallet.GetAsync();
    await MagicweaveSDK.Client.Game.RecordAsync(new Dictionary<string, object> { ["score"] = 4200 });
}
```

## Writes survive a dead network

Every mutating call is written to disk *before* it is sent, carrying an idempotency key that
survives a crash. Lose connectivity mid-purchase and nothing is lost — and nothing is applied twice.

```csharp
try
{
    await MagicweaveSDK.Client.Shop.PurchaseAsync("starter-pack");
}
catch (MagicweaveQueuedException)
{
    // Not a failure. The write is on disk and will deliver itself.
    ShowToast("Saved — will sync when you're back online");
}
catch (InsufficientBalanceException)
{
    ShowStore();
}
```

The queue drains on `InitAsync`, on `FlushAsync()`, and automatically whenever the app returns to
the foreground — which on mobile is usually the moment the connection comes back.

```csharp
MagicweaveSDK.Client.QueueChanged += (_, e) =>
{
    if (e.Kind == QueueEventKind.Sent) Debug.Log($"delivered {e.Entry.Path}");
};

int pending = await MagicweaveSDK.Client.PendingWritesAsync();   // for a "syncing…" indicator
```

## Errors are typed

Catch the class, or branch on `error.Code`. Never match on the message — that is display text and
gets reworded.

| Class | When |
|---|---|
| `InsufficientBalanceException` | the player cannot afford it |
| `IdempotencyConflictException` | a key was reused for a different operation |
| `MagicweaveAuthException` | the session is unusable; prompt for sign-in |
| `RateLimitedException` | retried automatically, honouring `Retry-After` |
| `MagicweaveNetworkException` | the request never reached the API |
| `MagicweaveQueuedException` | not an error — the write is queued |

## Switching environments

The setup window's **This build uses** dropdown picks the environment. Testing, production, and
preview credentials are all just entries in the list — moving a build between them never touches
code. The window warns you when a build points at production, when it is using preview credentials,
and when a WebGL target would ship the client secret inside the build.

## Platform notes

- **WebGL.** The transport is `UnityWebRequest`, not `HttpClient`, so it works — but the client
  secret is readable by any player with devtools. Route web builds through a server you control.
- **Storage.** Tokens and the queue live in files under `Application.persistentDataPath`, not
  `PlayerPrefs` (a plaintext registry key or plist a player can edit). That is durable, not secret:
  for a game where token theft matters, implement `IMagicweaveStorage` over the platform keystore
  and pass it in `MagicweaveOptions.Storage`.
- **Threads.** Nothing here spawns one. Continuations run on Unity's main thread.

## Layout

```
Runtime/Core/       engine-independent ergonomics — compiles and unit-tests without Unity
Runtime/Unity/      UnityWebRequest transport, settings asset, lifecycle hooks
Runtime/Generated/  generated transport — NEVER hand-edit; run scripts/generate.sh unity
Editor/             the setup window
Samples~/QuickStart sign in, read a wallet, submit a score, watch the queue drain
```

`Runtime/Core/` has no `UnityEngine` dependency on purpose: it compiles as plain netstandard2.1 and
is covered by 41 unit tests in `dotnet-verify/`, so a logic bug surfaces in CI rather than in the
editor.
