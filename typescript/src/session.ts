/**
 * Behaviour E2 — a session that survives.
 *
 * Holds the access/refresh pair, persists it through the configured store, and
 * refreshes it exactly once when several in-flight requests all get a 401. The
 * single-flight part matters more than it looks: a game that fires six requests
 * on resume will otherwise send six refreshes, and whichever one lands last
 * wins — invalidating the tokens the other five just stored.
 */

import { MagicweaveAuthError } from "./errors.js";
import type { Logger, Storage } from "./types.js";

export interface TokenPair {
  accessToken: string;
  refreshToken?: string;
}

const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

export class Session {
  private tokens: TokenPair | null = null;
  private loaded = false;
  private inFlightRefresh: Promise<TokenPair | null> | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
    private readonly logger: Logger,
    /** Performs the actual `/auth/refresh` call. Injected to avoid a cycle. */
    private readonly refreshFn: (refreshToken: string) => Promise<TokenPair>,
  ) {}

  private key(name: string): string {
    return `${this.namespace}:${name}`;
  }

  /** Reads persisted tokens on first use. Later calls are in-memory. */
  async load(): Promise<TokenPair | null> {
    if (this.loaded) return this.tokens;
    const [accessToken, refreshToken] = await Promise.all([
      this.storage.get(this.key(ACCESS_KEY)),
      this.storage.get(this.key(REFRESH_KEY)),
    ]);
    this.tokens = accessToken
      ? { accessToken, refreshToken: refreshToken ?? undefined }
      : null;
    this.loaded = true;
    return this.tokens;
  }

  async set(tokens: TokenPair): Promise<void> {
    this.tokens = tokens;
    this.loaded = true;
    await this.storage.set(this.key(ACCESS_KEY), tokens.accessToken);
    if (tokens.refreshToken) {
      await this.storage.set(this.key(REFRESH_KEY), tokens.refreshToken);
    }
  }

  async clear(): Promise<void> {
    this.tokens = null;
    this.loaded = true;
    await Promise.all([
      this.storage.remove(this.key(ACCESS_KEY)),
      this.storage.remove(this.key(REFRESH_KEY)),
    ]);
  }

  async accessToken(): Promise<string | null> {
    return (await this.load())?.accessToken ?? null;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  /**
   * Refresh once, no matter how many callers ask at the same time.
   *
   * Returns the new pair, or `null` when there is nothing to refresh with or
   * the refresh itself was rejected — in which case the session is cleared and
   * the caller should surface a sign-in prompt rather than retrying.
   */
  async refresh(): Promise<TokenPair | null> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    this.inFlightRefresh = (async () => {
      const current = await this.load();
      if (!current?.refreshToken) {
        this.logger.debug("refresh requested with no refresh token");
        return null;
      }
      try {
        const next = await this.refreshFn(current.refreshToken);
        await this.set(next);
        this.logger.debug("access token refreshed");
        return next;
      } catch (error) {
        if (error instanceof MagicweaveAuthError) {
          // The refresh token itself is dead. Keeping it would make every
          // subsequent request pay for two round trips before failing.
          this.logger.info("refresh token rejected, clearing session");
          await this.clear();
          return null;
        }
        throw error;
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }
}
