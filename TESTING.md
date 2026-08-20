# Testing the SDKs

What is actually ready for someone outside the team to try, and what is not. Written to be honest
rather than encouraging — a tester who hits an unverified surface and assumes it is broken costs
more than one who was told where the edges are.

## Status

| SDK | State | Verified how |
|---|---|---|
| **TypeScript / React Native** | Ready to test | 48 unit tests, plus a live smoke test against `api.magicweave.xyz` — layout probe, headers, and typed error mapping all confirmed against production |
| **Unity** | Core ready, editor surface unverified | 41 unit tests on the engine-independent core. `Runtime/Unity/` and `Editor/` have **never been opened in a Unity editor** — someone needs to do that first |
| **Flutter, Unreal** | Not started | — |

## TypeScript / React Native

### Install

Not on npm yet, so install from this repository. The `prepare` script builds on install, so a git
install works without a published package.

```bash
npm install "github:FortuneCasablancas/magicweave-sdks#main"
```

The repository is **private** — a tester needs read access, or a tarball:

```bash
# from a checkout
cd typescript && npm pack          # → magicweave-sdk-0.1.0.tgz
# then, in the test project
npm install /path/to/magicweave-sdk-0.1.0.tgz
```

### Credentials

Project → **Environments** in the console, and use a **testing** environment. Never hand out
production credentials for a test — a tester's writes are real player data there.

### Ten-line check

```ts
import { connect } from "@magicweave/sdk";

const mw = await connect({
  clientId: process.env.MW_CLIENT_ID!,
  clientSecret: process.env.MW_CLIENT_SECRET!,
  baseUrl: "https://api.magicweave.xyz",
});

await mw.auth.requestOtp("you@example.com");
await mw.auth.verifyOtp("you@example.com", "123456");   // code arrives by email

console.log(await mw.wallet.get());
```

A wallet object back means the whole path works. `gems: 0` is normal for a new player.

### The bit worth actually testing

Sign in, then turn on airplane mode and record a few scores:

```ts
import { MagicweaveQueuedError } from "@magicweave/sdk";

try {
  await mw.game.record({ score: 4200 });
} catch (error) {
  if (error instanceof MagicweaveQueuedError) console.log("queued — will sync");
  else throw error;
}

console.log(await mw.pendingWrites());   // > 0 while offline
```

Turn the network back on, call `await mw.flush()`, and confirm every score lands exactly once —
including if you kill the process between queueing and flushing. That last case is the one the
design exists for, and the one worth trying to break.

### Known gaps

- **Not published to npm.** Install from git or a tarball.
- **Realtime is untested against a live socket.** The reconnect logic is unit-tested against a fake;
  nobody has yet pointed it at a real `/realtime/ws`.
- **The error envelope is not deployed yet.** The backend PR that adds `error.code` is still open,
  so the SDK is currently using its status-derived fallback. Typed errors work either way — this is
  the fallback path doing its job — but `insufficient_balance` will read as the generic 402 mapping
  until that PR lands.

## Unity

**Do not hand this to a tester yet.** The core is verified; the Unity surface is not.

Verified: `Runtime/Core/` compiles as netstandard2.1 and passes 41 xUnit tests covering E1–E5.
Generation is verified too — 19 API classes and 113 models come out of the pinned generator.

Unverified: `Runtime/Unity/` (the `UnityWebRequest` transport, the settings `ScriptableObject`, the
lifecycle hooks) and `Editor/` (the setup window). These reference `UnityEngine`, so they cannot be
compiled outside an editor, and no one has opened them in one.

A first pass is roughly twenty minutes:

1. New Unity 2021.3+ project → Package Manager → **Add package from git URL** →
   `https://github.com/FortuneCasablancas/magicweave-sdks.git?path=/unity/Packages/xyz.magicweave.sdk`
2. Confirm it compiles and `com.unity.nuget.newtonsoft-json` resolves.
3. **Window → Magicweave → Setup** → create the settings asset, paste testing credentials.
4. Import the **Quick Start** sample, wire the fields, press play, sign in, read a wallet.
5. Build to WebGL and to Android, and confirm both make a call.

Step 5 matters most: `UnityWebRequest` was chosen over `HttpClient` specifically so WebGL works, and
that reasoning is untested until somebody builds it.

## Reporting

Say which SDK and version, what you did, what happened, and what you expected. Turn on logging first
— `logger: consoleLogger` in TypeScript, **Verbose logging** in the Unity setup window — and include
the output. A `x-mw-idempotency-generated: true` warning in the log is worth reporting on its own:
it means a write bypassed the SDK's key handling.
