# @magicweave/sdk

Magicweave for TypeScript, React Native and Expo.

```bash
npm install @magicweave/sdk
```

```ts
import { connect } from "@magicweave/sdk";

const mw = await connect({
  clientId: process.env.MW_CLIENT_ID!,
  clientSecret: process.env.MW_CLIENT_SECRET!,
  baseUrl: "https://api.magicweave.xyz",
});

await mw.auth.requestOtp("player@example.com");
await mw.auth.verifyOtp("player@example.com", "123456");

const wallet = await mw.wallet.get();
await mw.shop.purchase("starter-pack");
```

That is the whole setup. No base-URL branching, no header plumbing, no token refresh, no retry
loop, no idempotency keys to generate — see [the ergonomics spec](../spec/ERGONOMICS.md) for what
the SDK is doing on your behalf.

## Persist the session

The default token store is memory, so a restart signs the player out. On a real device, hand the
SDK your platform's secure store:

```ts
import * as SecureStore from "expo-secure-store";
import { AsyncStorageAdapter, connect } from "@magicweave/sdk";

const mw = await connect({
  /* … */
  storage: new AsyncStorageAdapter({
    getItem: SecureStore.getItemAsync,
    setItem: SecureStore.setItemAsync,
    removeItem: SecureStore.deleteItemAsync,
  }),
});
```

This also makes the offline queue durable across launches.

## Writes are offline-safe

Every mutating call is persisted before it is sent and carries an idempotency key that survives a
crash, so a retry can never apply it twice.

```ts
import { MagicweaveQueuedError } from "@magicweave/sdk";

try {
  await mw.game.record({ score });
} catch (error) {
  if (error instanceof MagicweaveQueuedError) {
    showToast("Saved — will sync when you're back online");
  } else {
    throw error;
  }
}

mw.onQueue("sent", ({ entry }) => console.log("delivered", entry.path));
const pending = await mw.pendingWrites();   // for a "syncing…" indicator
```

Call `mw.flush()` when connectivity returns.

## Errors are typed

```ts
import { InsufficientBalanceError, RateLimitedError } from "@magicweave/sdk";

try {
  await mw.shop.purchase("legendary-sword");
} catch (error) {
  if (error instanceof InsufficientBalanceError) showStorePrompt();
  else if (error instanceof RateLimitedError) showBusyMessage();
  else throw error;
}
```

Branch on the class or on `error.code` — never on `error.message`, which is display text and may be
reworded at any time.

## Realtime

```ts
const rt = await mw.realtime();
const stop = rt.subscribe(`lobby/${roomId}`, (value) => render(value));
// … later
stop();
```

Reconnection and resubscription are automatic. Note the underlying tree is last-write-wins with no
transactions and no presence — write each message under its own unique child key rather than
patching a shared array, and build presence with your own heartbeat.

## Non-network projects

```ts
const mw = await connect({
  /* … */
  mode: "external",
  externalUserId: currentUser.id,
});
```

## Web builds

The API allows cross-origin requests, so a browser `fetch` works — but a web build ships the client
secret to anyone who opens devtools. Route those calls through a server you control.

## Configuration

| Option | Default | |
|---|---|---|
| `mode` | `"network"` | `"external"` for non-network projects |
| `storage` | memory | your platform's secure store |
| `durableWrites` | `true` | `false` for fire-and-forget writes |
| `retry` | 4 attempts, 250 ms base, 8 s cap, 30% jitter | |
| `logger` | silent | `consoleLogger`, or your own |
| `fetch` / `webSocket` | globals | inject for tests or a custom runtime |

## Development

```bash
npm install
npm run generate     # regenerate src/generated/schema.ts from ../spec
npm test
npm run typecheck
```

`src/generated/` is machine output. Never hand-edit it — fix the OpenAPI spec or the generator
instead, or CI's `generate:check` will fail.
