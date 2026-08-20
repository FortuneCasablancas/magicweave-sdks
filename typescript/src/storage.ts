/**
 * Storage adapters.
 *
 * The SDK never picks a store for you. Tokens are credentials, and where they
 * belong differs per platform — Keychain on iOS, Keystore on Android,
 * `expo-secure-store` in Expo, and nothing at all in a short-lived script. So
 * the default is memory (safe, forgets everything on restart) and anything
 * durable is opt-in and explicit.
 */

import type { Logger, Storage } from "./types.js";

/** The default. Loses tokens and any queued writes when the process exits. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Wraps a synchronous web-style store (`localStorage`, `sessionStorage`).
 *
 * Note this is *not* secure storage — a browser store is readable by any script
 * on the page. Fine for a testing environment or a trusted desktop build; for a
 * shipped mobile game use the platform keystore instead.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class WebStorage implements Storage {
  constructor(private readonly backing: WebStorageLike) {}

  async get(key: string): Promise<string | null> {
    return this.backing.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.backing.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    this.backing.removeItem(key);
  }
}

/**
 * Adapts an async, promise-based store — `expo-secure-store`,
 * `@react-native-async-storage/async-storage`, `react-native-keychain`.
 *
 * @example
 * ```ts
 * import * as SecureStore from "expo-secure-store";
 * const storage = new AsyncStorageAdapter({
 *   getItem: SecureStore.getItemAsync,
 *   setItem: SecureStore.setItemAsync,
 *   removeItem: SecureStore.deleteItemAsync,
 * });
 * ```
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class AsyncStorageAdapter implements Storage {
  constructor(private readonly backing: AsyncStorageLike) {}

  async get(key: string): Promise<string | null> {
    return this.backing.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.backing.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    await this.backing.removeItem(key);
  }
}

/**
 * A store that swallows its own failures.
 *
 * A full disk or a revoked keychain entitlement must not take a running game
 * down: a failed read behaves as a cache miss and a failed write is logged and
 * dropped. The cost is that durability degrades silently, which is why it warns.
 */
export class ForgivingStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly logger?: Logger,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.inner.get(key);
    } catch (error) {
      this.logger?.warn("storage read failed, treating as empty", key, error);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.inner.set(key, value);
    } catch (error) {
      this.logger?.warn("storage write failed, value not persisted", key, error);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.inner.remove(key);
    } catch (error) {
      this.logger?.warn("storage delete failed", key, error);
    }
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const consoleLogger: Logger = {
  debug: (m, ...a) => console.debug(`[magicweave] ${m}`, ...a),
  info: (m, ...a) => console.info(`[magicweave] ${m}`, ...a),
  warn: (m, ...a) => console.warn(`[magicweave] ${m}`, ...a),
  error: (m, ...a) => console.error(`[magicweave] ${m}`, ...a),
};
