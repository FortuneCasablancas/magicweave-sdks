/**
 * Magicweave SDK for TypeScript, React Native and Expo.
 *
 * ```ts
 * import { connect } from "@magicweave/sdk";
 *
 * const mw = await connect({
 *   clientId: process.env.MW_CLIENT_ID!,
 *   clientSecret: process.env.MW_CLIENT_SECRET!,
 *   baseUrl: "https://api.magicweave.xyz",
 * });
 *
 * await mw.auth.requestOtp("player@example.com");
 * await mw.auth.verifyOtp("player@example.com", "123456");
 *
 * const wallet = await mw.wallet.get();
 * await mw.shop.purchase("starter-pack");   // durable, idempotent, offline-safe
 * ```
 */

export { Magicweave, connect } from "./client.js";
export { SDK_VERSION } from "./transport.js";

export {
  ErrorCode,
  IdempotencyConflictError,
  InsufficientBalanceError,
  MagicweaveApiError,
  MagicweaveAuthError,
  MagicweaveConfigError,
  MagicweaveError,
  MagicweaveNetworkError,
  MagicweaveQueuedError,
  RateLimitedError,
  ValidationError,
} from "./errors.js";
export type { ErrorCodeValue } from "./errors.js";

export {
  AsyncStorageAdapter,
  ForgivingStorage,
  MemoryStorage,
  WebStorage,
  consoleLogger,
  silentLogger,
} from "./storage.js";
export type { AsyncStorageLike, WebStorageLike } from "./storage.js";

export { RealtimeClient } from "./realtime.js";
export type { RealtimeListener, RealtimeMessage } from "./realtime.js";

export { WriteQueue } from "./queue.js";

export type {
  IdentityMode,
  Logger,
  MagicweaveConfig,
  QueueEvent,
  QueueEventName,
  QueuedWrite,
  RetryPolicy,
  Storage,
} from "./types.js";

export type { WriteOptions } from "./resources/index.js";
export type * from "./generated/helpers.js";
