import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_GRANT, OAuthError, discover, pollDevice, refresh, register, revoke, startDevice, type DeviceStart } from '../src/oauth.js';
import { ENDPOINTS, METADATA_URL, SERVER, fakeOAuth, oauthError, tokenReply } from './fakes.js';

const start: DeviceStart = { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_uri: `${SERVER}/oauth/device`, expires_in: 600, interval: 5 };

describe('discover', () => {
  it('reads the path-inserted RFC 8414 document of the server URL', async () => {
    const { fetch, calls } = fakeOAuth();
    expect(await discover(SERVER, fetch)).toMatchObject(ENDPOINTS);
    expect(calls[0].url).toBe(METADATA_URL);
  });

  it('refuses a server whose document lacks an endpoint the package needs', async () => {
    const { fetch } = fakeOAuth({ metadata: [{ body: { issuer: SERVER, token_endpoint: ENDPOINTS.token_endpoint } }] });
    await expect(discover(SERVER, fetch)).rejects.toThrow('does not offer registration_endpoint; is it a Courier MCP URL?');
  });

  it('refuses metadata whose issuer is not the server URL', async () => {
    const { fetch } = fakeOAuth({ metadata: [{ body: { issuer: 'https://other.example.test/courier-mcp', ...ENDPOINTS } }] });
    await expect(discover(SERVER, fetch)).rejects.toThrow('issuer');
  });

  it.each(['registration_endpoint', 'device_authorization_endpoint', 'token_endpoint', 'revocation_endpoint'] as const)('refuses an %s on another origin', async (field) => {
    const { fetch } = fakeOAuth({ metadata: [{ body: { issuer: SERVER, ...ENDPOINTS, [field]: 'https://evil.example.test/oauth/x' } }] });
    await expect(discover(SERVER, fetch)).rejects.toThrow(field);
  });

  it('names the value it was given when the issuer or an endpoint is wrong', async () => {
    const wrongIssuer = fakeOAuth({ metadata: [{ body: { issuer: 'https://other.example.test/courier-mcp', ...ENDPOINTS } }] });
    await expect(discover(SERVER, wrongIssuer.fetch)).rejects.toThrow('https://other.example.test/courier-mcp');
    const wrongOrigin = fakeOAuth({ metadata: [{ body: { issuer: SERVER, ...ENDPOINTS, token_endpoint: 'https://evil.example.test/oauth/x' } }] });
    await expect(discover(SERVER, wrongOrigin.fetch)).rejects.toThrow('https://evil.example.test/oauth/x');
  });

  it('turns an HTTP error into an OAuthError', async () => {
    const { fetch } = fakeOAuth({ metadata: [{ status: 404, body: 'Not Found' }] });
    await expect(discover(SERVER, fetch)).rejects.toMatchObject({ code: 'http_404', status: 404, message: 'http_404 from /.well-known/oauth-authorization-server/courier-mcp' });
  });
});

describe('register', () => {
  it('registers a device-only public client and returns its id', async () => {
    const { fetch, calls } = fakeOAuth();
    expect(await register(ENDPOINTS, 'Autolane Courier MCP', fetch)).toBe('mc_new');
    expect(calls[0].json).toEqual({ client_name: 'Autolane Courier MCP', redirect_uris: [], grant_types: [DEVICE_GRANT, 'refresh_token'], token_endpoint_auth_method: 'none' });
  });
});

describe('register without a client id', () => {
  it.each([{}, { client_id: 7 }])('rejects a reply of %j', async (body) => {
    const { fetch } = fakeOAuth({ register: [{ status: 201, body }] });
    await expect(register(ENDPOINTS, 'n', fetch)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });
});

describe('startDevice', () => {
  it('posts the client id and returns the codes', async () => {
    const { fetch, calls } = fakeOAuth();
    expect(await startDevice(ENDPOINTS, 'mc_1', fetch)).toMatchObject({ device_code: 'dev-1', user_code: 'BCDF-GHJK' });
    expect(calls[0].form).toEqual({ client_id: 'mc_1' });
  });
});

describe('pollDevice', () => {
  it('waits the interval, keeps going on authorization_pending, adds five seconds on slow_down, and returns the tokens', async () => {
    const { fetch, calls } = fakeOAuth({ token: [oauthError('authorization_pending'), oauthError('slow_down'), tokenReply('at-1', 'rt-1')] });
    const sleeps: number[] = [];
    const tokens = await pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(tokens).toMatchObject({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(calls[0].form).toEqual({ grant_type: DEVICE_GRANT, device_code: 'dev-1', client_id: 'mc_1' });
  });

  it('defaults to a five-second interval when the server names none', async () => {
    const { fetch } = fakeOAuth();
    const sleeps: number[] = [];
    await pollDevice(ENDPOINTS, 'mc_1', { ...start, interval: undefined }, { fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(sleeps).toEqual([5_000]);
  });

  it('stops with expired_token once the code and the server grace period have passed, without another request', async () => {
    const { fetch, calls } = fakeOAuth({ token: [oauthError('authorization_pending')] });
    let clock = 0;
    const err = await pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async (ms) => { clock += ms + 626_000; }, now: () => clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: 'expired_token' });
    expect(calls).toHaveLength(0);
  });

  it('still polls in the 30 second grace after expires_in, for a late approval', async () => {
    const { fetch, calls } = fakeOAuth();
    let clock = 0;
    await pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async (ms) => { clock += ms + 610_000; }, now: () => clock });
    expect(calls).toHaveLength(1);
  });

  it.each(['expired_token', 'access_denied', 'invalid_client', 'invalid_request'])('stops on %s', async (code) => {
    const { fetch, calls } = fakeOAuth({ token: [oauthError(code)] });
    await expect(pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async () => {}, now: () => 0 })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it('keeps polling after a network failure, more slowly', async () => {
    let n = 0;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return fakeOAuth().fetch(input, init);
    };
    const sleeps: number[] = [];
    const tokens = await pollDevice(ENDPOINTS, 'mc_1', start, { fetch: flaky, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(tokens.access_token).toBe('at-1');
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it('fails at once on an error that is not a failed request, a programming bug included', async () => {
    let calls = 0;
    const buggy: typeof globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    };
    await expect(pollDevice(ENDPOINTS, 'mc_1', start, { fetch: buggy, sleep: async () => {}, now: () => 0 })).rejects.toThrow('Cannot read properties of undefined');
    expect(calls).toBe(1);
  });

  it('fails at once on a 200 whose body is null', async () => {
    const { fetch, calls } = fakeOAuth({ token: [{ body: null }] });
    await expect(pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async () => {}, now: () => 0 })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toHaveLength(1);
  });

  it('names the last failure when the code expires after transient failures', async () => {
    const down: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }); };
    let clock = 0;
    const err = await pollDevice(ENDPOINTS, 'mc_1', start, { fetch: down, sleep: async () => { clock += 400_000; }, now: () => clock }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'expired_token' });
    expect((err as Error).message).toContain('(last error: fetch failed (getaddrinfo ENOTFOUND mcp.example.test))');
  });

  it('says nothing of a last error when there was none', async () => {
    const { fetch } = fakeOAuth({ token: [oauthError('authorization_pending')] });
    let clock = 0;
    const err = await pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async () => { clock += 626_000; }, now: () => clock }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('last error');
  });

  it('keeps polling after a timeout, more slowly', async () => {
    let n = 0;
    const slow: typeof globalThis.fetch = async (input, init) => {
      if (n++ === 0) throw new DOMException('The operation timed out', 'TimeoutError');
      return fakeOAuth().fetch(input, init);
    };
    const sleeps: number[] = [];
    await pollDevice(ENDPOINTS, 'mc_1', start, { fetch: slow, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it('keeps polling after a 5xx, more slowly', async () => {
    const { fetch } = fakeOAuth({ token: [{ status: 503, body: 'down' }, tokenReply('at-1', 'rt-1')] });
    const sleeps: number[] = [];
    await pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(sleeps).toEqual([5_000, 10_000]);
  });
});

describe('refresh', () => {
  it('posts the refresh grant and returns the rotated pair', async () => {
    const { fetch, calls } = fakeOAuth({ token: [tokenReply('at-2', 'rt-2')] });
    expect(await refresh(ENDPOINTS, 'mc_1', 'rt-1', fetch)).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(calls[0].form).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'mc_1' });
  });

  it('throws an OAuthError carrying the code and status on a refusal', async () => {
    const { fetch } = fakeOAuth({ token: [oauthError('invalid_grant')] });
    await expect(refresh(ENDPOINTS, 'mc_1', 'rt-1', fetch)).rejects.toMatchObject({ code: 'invalid_grant', status: 400, message: 'invalid_grant: invalid_grant (fake)' });
  });
});

describe('a token reply without the tokens', () => {
  const bad = [{ body: {} }, { body: { access_token: 'a', refresh_token: 'r' } }, { body: { access_token: 'a', refresh_token: 'r', expires_in: 'soon' } }];

  it.each(bad)('refresh rejects with invalid_response: %j', async (reply) => {
    const { fetch } = fakeOAuth({ token: [reply] });
    await expect(refresh(ENDPOINTS, 'mc_1', 'rt-1', fetch)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it.each(bad)('pollDevice rejects with invalid_response: %j', async (reply) => {
    const { fetch } = fakeOAuth({ token: [reply] });
    await expect(pollDevice(ENDPOINTS, 'mc_1', start, { fetch, sleep: async () => {}, now: () => 0 })).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });
});

describe('revoke', () => {
  it('posts the refresh token with its hint and the client id', async () => {
    const { fetch, calls } = fakeOAuth();
    await revoke(ENDPOINTS, 'mc_1', 'rt-1', fetch);
    expect(calls[0].form).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'mc_1' });
  });

  it('throws on a non-2xx answer', async () => {
    const { fetch } = fakeOAuth({ revoke: [{ status: 503, body: {} }] });
    await expect(revoke(ENDPOINTS, 'mc_1', 'rt-1', fetch)).rejects.toMatchObject({ code: 'http_503', message: 'http_503 from /courier-mcp/oauth/revoke' });
  });
});

describe('request timeout', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fetch that never answers on its own and rejects when its signal aborts. */
  const hung = (signals: Array<AbortSignal | null | undefined> = []): typeof globalThis.fetch => (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      signals.push(init?.signal);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });

  it('gives every request a 10 second signal and refuses redirects', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetch, calls } = fakeOAuth();
    const signals: Array<AbortSignal | null | undefined> = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const seen: typeof globalThis.fetch = (input, init) => {
      signals.push(init?.signal);
      redirects.push(init?.redirect);
      return fetch(input, init);
    };
    await discover(SERVER, seen);
    await register(ENDPOINTS, 'n', seen);
    await startDevice(ENDPOINTS, 'mc_1', seen);
    await pollDevice(ENDPOINTS, 'mc_1', start, { fetch: seen, sleep: async () => {}, now: () => 0 });
    await refresh(ENDPOINTS, 'mc_1', 'rt-1', seen);
    await revoke(ENDPOINTS, 'mc_1', 'rt-1', seen);
    expect(calls).toHaveLength(6);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(timeout).toHaveBeenCalledTimes(6);
    expect(timeout.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    expect(redirects).toEqual(Array(6).fill('error'));
  });

  it('a request that hangs aborts and rejects', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
    await expect(refresh(ENDPOINTS, 'mc_1', 'rt-1', hung())).rejects.toBeTruthy();
  });
});
