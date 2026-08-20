# The ergonomics layer

**Status:** normative. Every Magicweave SDK implements all eight behaviours below, with the same
observable semantics. The TypeScript SDK is the reference implementation; where this document and
the code disagree, this document is wrong and should be fixed.

## Why this document exists

An OpenAPI generator gives you a *transport* — models, paths, verbs. It cannot give you a good SDK,
because everything that makes an SDK good is a judgment call about failure: what to retry, where to
put a token, what happens when the player walks into a lift.

Those judgments have to be made once and made identically in four languages, or the SDKs diverge
and "it works in Unity" becomes a support category. So they are written down here, numbered, and
pinned by a conformance suite that every SDK runs against a live testing environment.

The split is strict:

| Layer | Source | Rule |
|---|---|---|
| Transport | generated from `client-openapi.snapshot.json` | never hand-edited |
| Ergonomics | this document | hand-written once per language |
| Engine idiom | per platform | packaging, config assets, editor tooling |

If a generated method is wrong or ugly, fix the spec or the generator template — never the output.

---

## E1 · Connect once

**Behaviour.** Construction takes three values: `clientId`, `clientSecret`, `baseUrl`. Everything
else is discovered.

- The SDK probes `GET {baseUrl}/healthz` once per process and caches the result.
  - `{"service":"client-api"}` → client routes are at `baseUrl`.
  - `{"service":"admin-api"}` → probe `{baseUrl}/client/healthz`; if that answers `client-api`, all
    paths get the `/client` prefix.
- A probe that fails does **not** block startup. Fall back to `baseUrl` unprefixed and let the first
  real call surface a 404. A game that will not boot because a health check timed out is worse than
  one that reports a clear error on its first request.
- Concurrent calls made before the probe resolves share one probe, not one each.
- Missing `clientId`, `clientSecret` or `baseUrl` throws a **configuration** error at construction —
  not on first use, where it would surface three screens into the game.

**Why.** The docs currently instruct every developer to write this branch by hand. It is the first
thing they meet and it has nothing to do with their game.

## E2 · A session that survives

**Behaviour.**

- Tokens live in a caller-supplied store. The default is memory; anything durable is explicit,
  because a token is a credential and only the app knows where credentials belong on its platform
  (Keychain, Keystore, `expo-secure-store`). Never a plaintext preferences file — and specifically
  never Unity's `PlayerPrefs`.
- Sign-in stores both tokens. `isSignedIn` reflects storage, so a restart resumes the session.
- A 401 carrying `unauthenticated` or `token_expired` triggers **one** refresh, then replays the
  original request once. A second 401 propagates.
- Refresh is **single-flight**: N concurrent 401s produce exactly one `POST /auth/refresh`. Without
  this, a game that fires six requests on resume sends six refreshes and the last one to land
  invalidates the tokens the other five just stored.
- A rejected refresh token clears the session rather than retrying. The caller should show sign-in.
- Auth endpoints themselves are never refreshed and never carry a bearer.
- **Network vs non-network is a config flag.** `mode: "network"` sends `Authorization: Bearer`;
  `mode: "external"` sends `x-external-user-id`. Nothing above the transport knows which it is.

## E3 · Crash-safe writes

**Behaviour.**

- Every mutating call gets an idempotency key, minted by the SDK and **persisted before the request
  is sent**. That ordering is the entire guarantee: a crash after persisting replays with the same
  key; a crash before it means the write never happened.
- Every retry of a logical operation reuses the same key. A caller may supply their own to make two
  separate calls one operation (`purchase(sku, { idempotencyKey: checkoutId })`).
- The SDK hides the API's split transport: `Idempotency-Key` **header** for inventory and shop
  writes, `idempotency_key` **body field** for `/game` writes. Callers never see the difference.
- If a response carries `x-mw-idempotency-generated: true`, the server had to invent a key and that
  write was not retry-safe. Log a warning — it means a write path is bypassing the SDK.
- Reads are never assigned keys and never persisted.

**Why.** The API guarantees replay safety. Almost nobody uses it, because using it correctly means
persisting a key before a network call — which no one does by hand.

## E4 · Offline queue

**Behaviour.**

- E3's persistence *is* the queue. A write that cannot be delivered stays in it and drains later.
- A write that fails **retryably** (network error, 408, 429, 5xx) leaves the entry queued and raises
  a distinct `Queued` signal — the operation is not lost, it has no result *yet*.
- A write that fails **permanently** (4xx that is not 408/429) is removed and raises the real error.
  Replaying a 422 forever would wedge every write behind one that can never succeed.
- Draining is **ordered, oldest first**, and stops at the first entry that fails retryably. Order is
  load-bearing in an economy: a purchase that spends coins a queued grant provides must not jump
  ahead of it.
- The queue survives process restart. `init()` drains it.
- A corrupt queue is discarded with an error log, not replayed.
- Callers can observe `enqueued` / `sent` / `failed` / `drained` and read a pending count, so a game
  can show "syncing…" without inventing its own bookkeeping.
- Durability is opt-out (`durableWrites: false`) for callers who genuinely want fire-and-forget.

## E5 · Retry and backoff

**Behaviour.**

- Retry only: network failures, 408, 429, 5xx. Never a 4xx the server will reject identically.
- Exponential backoff from a base delay, capped, with jitter — a thousand devices reconnecting after
  an outage must not arrive in lockstep.
- Honour `Retry-After` (seconds or HTTP date) when present, in preference to computed backoff.
- Default: 4 attempts, 250 ms base, 8 s cap, 30% jitter. All configurable.
- `idempotency_conflict` is **never** retried — the key was reused for a different operation, which
  is a bug in key generation, not a transient failure.

**Why.** There are no rate limits and no `Retry-After` today. Building both in now means every
shipped game starts honouring them the day the server grows them, with no game update.

## E6 · Realtime that reconnects

**Behaviour.**

- Connect to `{root}/realtime/ws`, subscribe by path. The server sends `{event:"init", path, value}`
  on subscribe, then `{event:"change", path, value}` for writes beneath that path.
- Subscriptions are **SDK state, not socket state** — after a drop, every live subscription is
  replayed on the new socket. Callers never handle reconnection.
- Reconnect with exponential backoff and jitter; stop permanently when the caller closes.
- A change at `a/b/c` wakes listeners on `a/b` and `a/b/c`, but not on `a/b2`.
- A listener that throws does not prevent other listeners from running.
- Last listener for a path unsubscribes on the wire.

**Documented, not hidden.** The tree has no compare-and-swap, no increment, no transactions, and
last-write-wins semantics; there is no presence and no TTL. The SDK cannot fix that, so its API
steers away from it — offer a "write under a unique child key" helper, never an `append()`.

## E7 · A typed catalog, not string keys

**Behaviour.**

- `mw sdk types --platform <p>` reads the project's live definitions (currencies, stats, items,
  leaderboards, wheels) via the existing `mw spec export` path and emits language-native constants:
  `Currency.Gold`, `Leaderboard.WeeklyHighScore`, `Item.IronSword`.
- Output is a generated file the developer commits, regenerated when the economy changes.
- A key that no longer exists becomes a **compile error**, not a 404 in production.

**Why.** This is the one piece no generic OpenAPI client can produce — it needs the definition
graph, which only Magicweave has. It is also the difference between an SDK that wraps an API and
one that knows what game you are building.

> Status: specified, not yet implemented. It belongs in the CLI (`magicweave-cli`), not in each SDK,
> and should land alongside the console's "copy as SDK constant" affordance.

## E8 · Environments in the editor

**Behaviour.**

- Testing, production and preview credentials are selected from the engine's own settings UI — a
  Unity `ScriptableObject` inspector, an Unreal `DataAsset`, a `magicweave.json` for Flutter and
  React Native.
- Switching what a build points at is **never** a code change.
- The config file is gitignored by default and the console offers it as a download, so a secret
  reaches a project without being pasted into source.
- Preview credentials are surfaced as a first-class choice, not buried — QA'ing an unpublished
  release is the whole point of them.

> Status: specified. The config-file half lands with the console's Connect section; the editor UI is
> per-platform work.

---

## Conformance

`conformance/scenarios/*.yaml` encodes these behaviours as executable scenarios. Every SDK ships a
thin runner that executes them against a live **testing** environment created with `mw init`. A
behaviour that is not covered by a scenario will drift — so a new behaviour means a new scenario in
the same commit.
