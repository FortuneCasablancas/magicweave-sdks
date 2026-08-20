/**
 * Type plumbing over the generated schema.
 *
 * `schema.ts` is machine output and must never be hand-edited. This file is the
 * hand-written seam that turns it into types the resource wrappers can use, so
 * that regenerating the schema propagates automatically — no resource file
 * repeats a response shape, and a backend field rename becomes a type error
 * here rather than a runtime surprise on a player's device.
 */

import type { components, operations } from "./schema.js";

export type Schemas = components["schemas"];
export type OperationId = keyof operations;

type JsonContent<T> = T extends { content: { "application/json": infer R } } ? R : never;

/** The success body of an operation — 200 where present, else 201. */
export type OpResponse<K extends OperationId> = operations[K]["responses"] extends {
  200: infer R;
}
  ? JsonContent<R>
  : operations[K]["responses"] extends { 201: infer R }
    ? JsonContent<R>
    : unknown;

/** The request body of an operation, if it takes one. */
export type OpBody<K extends OperationId> = operations[K] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : operations[K] extends { requestBody?: { content: { "application/json": infer B } } }
    ? B | undefined
    : never;

// Re-exported so callers can name the shapes they receive without importing
// from a path that says "generated".
export type Wallet = Schemas["ClientWalletResponse"];
export type WalletHistory = OpResponse<"get_wallet_history">;
export type CurrencyBalances = OpResponse<"get_currency_balances">;
export type CurrencyBalance = OpResponse<"get_currency_balance">;
export type InventoryList = OpResponse<"list_inventory">;
export type InventoryItem = OpResponse<"get_inventory_item">;
export type ConsumeResult = OpResponse<"consume_item">;
export type ShopListings = OpResponse<"list_listings">;
export type ShopListing = OpResponse<"get_listing">;
export type PurchaseResult = OpResponse<"purchase_listing">;
export type LeaderboardList = OpResponse<"list_leaderboards">;
export type LeaderboardEntries = OpResponse<"get_entries">;
export type MyRank = OpResponse<"get_my_rank">;
export type PlayerStats = OpResponse<"get_stats">;
export type Profile = OpResponse<"get_profile">;
export type AuthTokens = OpResponse<"verify_otp">;
