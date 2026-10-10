// The access token to send. Near expiry, or after a 401, it refreshes under the store's lock, re-reading the file
// inside it: a second agent that waited uses the token the first just rotated, since reusing the old refresh token
// would make the server revoke the whole family (no grace window).
import { RELINK } from './config.js';
import { OAuthError, refresh, type Endpoints, type Fetch, type TokenSet } from './oauth.js';
import type { Saved, TokenStore } from './store.js';

/** Refresh when less than this is left on the access token. */
const REFRESH_EARLY_MS = 60_000;

export class NotLinkedError extends Error {
  constructor() {
    super(RELINK);
    this.name = 'NotLinkedError';
  }
}

export function savedFrom(base: Pick<Saved, 'server' | 'client_id'>, tokens: TokenSet, now: number): Saved {
  return { server: base.server, client_id: base.client_id, access_token: tokens.access_token, refresh_token: tokens.refresh_token, access_expires_at: now + tokens.expires_in * 1000 };
}

export interface Session {
  accessToken(opts?: { force?: boolean }): Promise<string>;
}

export function createSession(opts: { store: TokenStore; endpoints: () => Promise<Endpoints>; fetch?: Fetch; now?: () => number }): Session {
  const now = opts.now ?? Date.now;
  return {
    async accessToken({ force = false } = {}) {
      const seen = await opts.store.read();
      if (!seen) throw new NotLinkedError();
      if (!force && seen.access_expires_at - now() > REFRESH_EARLY_MS) return seen.access_token;
      return opts.store.withLock(async () => {
        const current = await opts.store.read();
        if (!current) throw new NotLinkedError();
        if (current.refresh_token !== seen.refresh_token) return current.access_token;
        let tokens: TokenSet;
        try {
          tokens = await refresh(await opts.endpoints(), current.client_id, current.refresh_token, opts.fetch);
        } catch (error) {
          // invalid_grant: the refresh token is spent or revoked. invalid_client: the server forgot this client. Both need a new login.
          if (error instanceof OAuthError && (error.code === 'invalid_grant' || error.code === 'invalid_client')) throw new NotLinkedError();
          throw error;
        }
        await opts.store.write(savedFrom(current, tokens, now()));
        return tokens.access_token;
      });
    },
  };
}
