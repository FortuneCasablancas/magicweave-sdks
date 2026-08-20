# Magicweave SDKs

Engine SDKs for the Magicweave client API — Unity, Flutter, React Native / TypeScript, Unreal.

A game should not have to write base-URL detection, header plumbing, token refresh, retry logic,
idempotency keys and a WebSocket client before it can grant a player a coin. That week of
undifferentiated work is what lives here instead.

## Layout

```
spec/
  client-openapi.snapshot.json   # the pinned codegen source, owned by the backend
  ERGONOMICS.md                  # E1–E8: normative, one spec for every SDK
conformance/
  scenarios/core.yaml            # the executable form of ERGONOMICS.md
scripts/
  sync-spec.sh                   # pull the snapshot from backend/ (or a live URL)
  generate.sh                    # regenerate a platform's transport, versions pinned
typescript/                      # reference implementation
unity/                           # UPM package
```

## The architecture, in one rule

Three layers, and one rule that keeps four SDKs affordable:

| Layer | Source | Rule |
|---|---|---|
| **Engine idiom** | per platform | packaging, config assets, editor tooling, samples |
| **Ergonomics** | [`spec/ERGONOMICS.md`](spec/ERGONOMICS.md) | hand-written once per language |
| **Transport** | generated from the snapshot | **never hand-edited** |

If a generated method is wrong or ugly, fix the spec or the generator template. The moment someone
edits generated code, regeneration becomes a merge conflict and the whole model collapses.

## The eight behaviours

Every SDK implements all of these, identically. Full detail in [`spec/ERGONOMICS.md`](spec/ERGONOMICS.md).

| | Behaviour | The point |
|---|---|---|
| **E1** | Connect once | Three values in; deployment layout discovered, not configured |
| **E2** | A session that survives | Secure token storage, single-flight refresh, network/non-network as a flag |
| **E3** | Crash-safe writes | The idempotency key is persisted *before* the request goes out |
| **E4** | Offline queue | Writes made on a subway are delivered, in order, exactly once |
| **E5** | Retry and backoff | Transient only, jittered, `Retry-After`-aware |
| **E6** | Realtime that reconnects | Subscriptions are SDK state, replayed after any drop |
| **E7** | A typed catalog | `Currency.Gold` fails at compile time, not in production |
| **E8** | Environments in the editor | Switching testing → production is never a code change |

E3 and E4 are one mechanism. E4 is only safe because the API guarantees idempotent replay — without
that guarantee, an offline retry queue is a double-spend generator.

## Getting started

```bash
./scripts/sync-spec.sh            # refresh spec/ from a sibling backend checkout
./scripts/generate.sh typescript  # or unity | flutter | unreal | all

cd typescript && npm install && npm test
```

`generate.sh` runs openapi-generator through Docker at a pinned version, so no contributor needs a
JVM and nobody's local toolchain can silently rewrite four SDKs.

## Using the TypeScript SDK

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
await mw.shop.purchase("starter-pack");   // durable, idempotent, offline-safe
```

Credentials come from the console's **Environments** page. In a web or HTML5 build, the client
secret is readable by anyone with devtools — proxy those calls through a server you control.

## Adding a behaviour

1. Write it in `spec/ERGONOMICS.md`.
2. Add a scenario to `conformance/scenarios/core.yaml`.
3. Implement it in TypeScript first, with unit tests.
4. Port to the other SDKs against the same scenarios.

A behaviour with no scenario will drift, so steps 1 and 2 belong in the same commit as step 3.

## Keeping up with the API

The backend owns `contracts/client-openapi.snapshot.json` and gates it in CI: a stale snapshot or an
`oasdiff`-breaking change fails the build there. This repo mirrors that snapshot and re-checks it,
so a spec change surfaces as a failing job here rather than as a runtime error on a player's device.

Operation ids are the generated method names. Renaming a client-API handler renames a method in
every shipped SDK — the backend's `apps/client/test_sdk_contract.py` treats that as a breaking
change, and so should you.
