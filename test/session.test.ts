import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELINK } from '../src/config.js';
import { OAuthError } from '../src/oauth.js';
import { NotLinkedError, createSession, savedFrom } from '../src/session.js';
import { fileStore, type Saved, type TokenStore } from '../src/store.js';
import { ENDPOINTS, SERVER, fakeOAuth, oauthError, tokenReply } from './fakes.js';

const NOW = 1_800_000_000_000;
const saved = (over: Partial<Saved> = {}): Saved => ({ server: SERVER, client_id: 'mc_1', access_token: 'at-0', refresh_token: 'rt-0', access_expires_at: NOW + 3_600_000, ...over });
const endpoints = async () => ENDPOINTS;

let root: string;
let store: TokenStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'courier-mcp-session-'));
  store = fileStore(join(root, 'autolane'), SERVER);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('savedFrom', () => {
  it('stamps the access expiry from expires_in', () => {
    expect(savedFrom({ server: SERVER, client_id: 'mc_1' }, { access_token: 'a', refresh_token: 'r', expires_in: 3600 }, NOW)).toEqual({ server: SERVER, client_id: 'mc_1', access_token: 'a', refresh_token: 'r', access_expires_at: NOW + 3_600_000 });
  });
});

describe('createSession', () => {
  it('throws NotLinkedError, carrying the relink line, when nothing is saved', async () => {
    const err = await createSession({ store, endpoints, now: () => NOW }).accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotLinkedError);
    expect((err as Error).message).toBe(RELINK);
  });

  it('returns the saved token while more than a minute is left, with no network call', async () => {
    await store.write(saved({ access_expires_at: NOW + 61_000 }));
    const { fetch, calls } = fakeOAuth();
    expect(await createSession({ store, endpoints, fetch, now: () => NOW }).accessToken()).toBe('at-0');
    expect(calls).toHaveLength(0);
  });

  it('refreshes inside the last minute, saves the rotated pair and returns the new token', async () => {
    await store.write(saved({ access_expires_at: NOW + 59_000 }));
    const { fetch, calls } = fakeOAuth({ token: [tokenReply('at-1', 'rt-1')] });
    expect(await createSession({ store, endpoints, fetch, now: () => NOW }).accessToken()).toBe('at-1');
    expect(calls.map((c) => c.form)).toEqual([{ grant_type: 'refresh_token', refresh_token: 'rt-0', client_id: 'mc_1' }]);
    expect(await store.read()).toEqual(saved({ access_token: 'at-1', refresh_token: 'rt-1', access_expires_at: NOW + 3_600_000 }));
  });

  it('force refreshes a fresh token (the server answered 401)', async () => {
    await store.write(saved());
    const { fetch, calls } = fakeOAuth({ token: [tokenReply('at-1', 'rt-1')] });
    expect(await createSession({ store, endpoints, fetch, now: () => NOW }).accessToken({ force: true })).toBe('at-1');
    expect(calls).toHaveLength(1);
  });

  it('two sessions refreshing at once make one network call and end with the same token', async () => {
    await store.write(saved({ access_expires_at: NOW - 1 }));
    const { fetch, calls } = fakeOAuth({ token: [tokenReply('at-1', 'rt-1')] });
    const other = fileStore(join(root, 'autolane'), SERVER);
    const [a, b] = await Promise.all([
      createSession({ store, endpoints, fetch, now: () => NOW }).accessToken(),
      createSession({ store: other, endpoints, fetch, now: () => NOW }).accessToken(),
    ]);
    expect([a, b]).toEqual(['at-1', 'at-1']);
    expect(calls).toHaveLength(1);
  });

  it('uses the token another process saved while this one waited, instead of reusing the old refresh token', async () => {
    const rotated = saved({ access_token: 'at-9', refresh_token: 'rt-9' });
    const stub: TokenStore = {
      path: 'stub',
      read: vi.fn<TokenStore['read']>().mockResolvedValueOnce(saved({ access_expires_at: NOW - 1 })).mockResolvedValueOnce(rotated),
      write: vi.fn<TokenStore['write']>(),
      remove: vi.fn<TokenStore['remove']>(),
      withLock: (fn) => fn(),
    };
    const { fetch, calls } = fakeOAuth();
    expect(await createSession({ store: stub, endpoints, fetch, now: () => NOW }).accessToken()).toBe('at-9');
    expect(calls).toHaveLength(0);
  });

  it('throws NotLinkedError when the file disappears while waiting for the lock', async () => {
    const stub: TokenStore = {
      path: 'stub',
      read: vi.fn<TokenStore['read']>().mockResolvedValueOnce(saved({ access_expires_at: NOW - 1 })).mockResolvedValueOnce(null),
      write: vi.fn<TokenStore['write']>(),
      remove: vi.fn<TokenStore['remove']>(),
      withLock: (fn) => fn(),
    };
    await expect(createSession({ store: stub, endpoints, now: () => NOW }).accessToken()).rejects.toBeInstanceOf(NotLinkedError);
  });

  it('turns a refused refresh (invalid_grant) into NotLinkedError and keeps the file', async () => {
    await store.write(saved({ access_expires_at: NOW - 1 }));
    const { fetch } = fakeOAuth({ token: [oauthError('invalid_grant')] });
    await expect(createSession({ store, endpoints, fetch, now: () => NOW }).accessToken()).rejects.toBeInstanceOf(NotLinkedError);
    expect(await store.read()).not.toBeNull();
  });

  it('passes any other refresh failure through', async () => {
    await store.write(saved({ access_expires_at: NOW - 1 }));
    const { fetch } = fakeOAuth({ token: [oauthError('server_error', 500)] });
    const err = await createSession({ store, endpoints, fetch, now: () => NOW }).accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: 'server_error', status: 500 });
  });
});
