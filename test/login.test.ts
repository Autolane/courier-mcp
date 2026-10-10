import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_NAME } from '../src/config.js';
import { login } from '../src/login.js';
import { fileStore, type TokenStore } from '../src/store.js';
import { SERVER, fakeOAuth, oauthError, tokenReply } from './fakes.js';

const NOW = 1_800_000_000_000;
let root: string;
let store: TokenStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'courier-mcp-login-'));
  store = fileStore(join(root, 'autolane'), SERVER);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (fetch: typeof globalThis.fetch, noBrowser: boolean) => {
  const printed: string[] = [];
  const opened: string[] = [];
  const done = login({ server: SERVER, store, noBrowser, print: (l) => printed.push(l), openUrl: (u) => opened.push(u), fetch, sleep: async () => {}, now: () => NOW });
  return { done, printed, opened };
};

describe('login', () => {
  it('registers a client, prints the link and code, opens the link, waits for the phone, and saves the tokens', async () => {
    const { fetch, calls } = fakeOAuth({ token: [oauthError('authorization_pending'), tokenReply('at-1', 'rt-1')] });
    const { done, printed, opened } = run(fetch, false);
    await done;
    expect(calls.find((c) => c.url.endsWith('/oauth/register'))?.json).toMatchObject({ client_name: CLIENT_NAME, redirect_uris: [] });
    expect(printed[0]).toContain(`${SERVER}/oauth/device?user_code=BCDFGHJK`);
    expect(printed[0]).toContain('BCDF-GHJK');
    expect(printed.at(-1)).toBe('Linked. Your agent can use Autolane Courier now.');
    expect(opened).toEqual([`${SERVER}/oauth/device?user_code=BCDFGHJK`]);
    expect(await store.read()).toEqual({ server: SERVER, client_id: 'mc_new', access_token: 'at-1', refresh_token: 'rt-1', access_expires_at: NOW + 3_600_000 });
  });

  it('with --no-browser only prints the link', async () => {
    const { fetch } = fakeOAuth();
    const { done, opened } = run(fetch, true);
    await done;
    expect(opened).toEqual([]);
  });

  it('prints the plain verification URI when the server sends no complete one', async () => {
    const { fetch } = fakeOAuth({ device: [{ body: { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_uri: `${SERVER}/oauth/device`, expires_in: 600, interval: 5 } }] });
    const { done, printed } = run(fetch, true);
    await done;
    expect(printed[0]).toContain(`  ${SERVER}/oauth/device\n`);
  });

  it('prints a link on another origin but never opens it', async () => {
    const evil = 'https://evil.example.test/oauth/device?user_code=BCDFGHJK';
    const { fetch } = fakeOAuth({ device: [{ body: { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_uri: evil, expires_in: 600, interval: 5 } }] });
    const { done, printed, opened } = run(fetch, false);
    await done;
    expect(printed[0]).toContain(evil);
    expect(opened).toEqual([]);
  });

  it('prints and opens the same normalised link, and strips control characters from what it prints', async () => {
    const { fetch } = fakeOAuth({ device: [{ body: { device_code: 'dev-1', user_code: 'BC\x1b[2JDF-GHJK', verification_uri: 'https://MCP.example.test/courier-mcp/oauth/device\u0007', expires_in: 600, interval: 5 } }] });
    const { done, printed, opened } = run(fetch, false);
    await done;
    expect(opened).toEqual([new URL('https://MCP.example.test/courier-mcp/oauth/device\u0007').href]);
    expect(printed[0]).toContain(`  ${opened[0]}\n`);
    expect(printed[0]).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/u);
    expect(printed[0]).toContain('BC[2JDF-GHJK');
  });

  it.each(['http://mcp.example.test/courier-mcp/oauth/device', 'https://mcp.example.test:8443/courier-mcp/oauth/device'])('prints but never opens %s (same host, other scheme or port)', async (uri) => {
    const { fetch } = fakeOAuth({ device: [{ body: { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_uri: uri, expires_in: 600, interval: 5 } }] });
    const { done, printed, opened } = run(fetch, false);
    await done;
    expect(printed[0]).toContain(uri);
    expect(opened).toEqual([]);
  });

  it('saves under the lock, and revokes the refresh token it replaces', async () => {
    await store.write({ server: SERVER, client_id: 'mc_old', access_token: 'a', refresh_token: 'rt-old', access_expires_at: 0 });
    let held = false;
    const writes: boolean[] = [];
    const locked: TokenStore = { ...store, read: () => store.read(), remove: () => store.remove(), write: async (s) => { writes.push(held); await store.write(s); }, withLock: async (fn) => { held = true; try { return await store.withLock(fn); } finally { held = false; } } };
    const { fetch, calls } = fakeOAuth();
    await login({ server: SERVER, store: locked, noBrowser: true, print: () => {}, fetch, sleep: async () => {}, now: () => NOW });
    expect(writes).toEqual([true]);
    expect(calls.find((c) => c.url.endsWith('/oauth/revoke'))?.form).toEqual({ token: 'rt-old', token_type_hint: 'refresh_token', client_id: 'mc_old' });
  });

  it('still links when revoking the old refresh token fails', async () => {
    await store.write({ server: SERVER, client_id: 'mc_old', access_token: 'a', refresh_token: 'rt-old', access_expires_at: 0 });
    const { fetch } = fakeOAuth({ revoke: [{ status: 503, body: {} }] });
    await run(fetch, true).done;
    expect((await store.read())?.refresh_token).toBe('rt-1');
  });

  it('reuses the client already saved for this server', async () => {
    await store.write({ server: SERVER, client_id: 'mc_old', access_token: 'a', refresh_token: 'r', access_expires_at: 0 });
    const { fetch, calls } = fakeOAuth();
    await run(fetch, true).done;
    expect(calls.some((c) => c.url.endsWith('/oauth/register'))).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/oauth/device_authorization'))?.form).toEqual({ client_id: 'mc_old' });
    expect((await store.read())?.client_id).toBe('mc_old');
  });

  it('registers again, once, when the server no longer knows the saved client', async () => {
    await store.write({ server: SERVER, client_id: 'mc_old', access_token: 'a', refresh_token: 'r', access_expires_at: 0 });
    const { fetch, calls } = fakeOAuth({ device: [oauthError('invalid_client', 401)] });
    await run(fetch, true).done;
    expect(calls.filter((c) => c.url.endsWith('/oauth/register'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/oauth/device_authorization')).map((c) => c.form)).toEqual([{ client_id: 'mc_old' }, { client_id: 'mc_new' }]);
    expect((await store.read())?.client_id).toBe('mc_new');
  });

  it('gives up when the freshly registered client is refused too', async () => {
    const { fetch, calls } = fakeOAuth({ device: [oauthError('invalid_client', 401), oauthError('invalid_client', 401)] });
    await expect(run(fetch, true).done).rejects.toMatchObject({ code: 'invalid_client' });
    expect(calls.filter((c) => c.url.endsWith('/oauth/register'))).toHaveLength(1);
  });

  it('saves nothing when the link expires', async () => {
    const { fetch } = fakeOAuth({ token: [oauthError('expired_token')] });
    await expect(run(fetch, true).done).rejects.toMatchObject({ code: 'expired_token' });
    expect(await store.read()).toBeNull();
  });
});
