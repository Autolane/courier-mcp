import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { USAGE, describeError, main, type CliDeps } from '../src/cli.js';
import { RELINK, VERSION } from '../src/config.js';
import { fileStore, type Saved } from '../src/store.js';
import { startCourierServer } from './courierServer.js';
import { SERVER, fakeOAuth } from './fakes.js';

const NOW = 1_800_000_000_000;
let xdg: string;
let out: string[];
let err: string[];
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  xdg = await mkdtemp(join(tmpdir(), 'courier-mcp-cli-'));
  out = [];
  err = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(xdg, { recursive: true, force: true });
});

const deps = (over: Partial<CliDeps> = {}): CliDeps => ({ env: { XDG_CONFIG_HOME: xdg, AUTOLANE_COURIER_URL: SERVER }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, sleep: async () => {}, ...over });
const link = (over: Partial<Saved> = {}, server = SERVER) => fileStore(join(xdg, 'autolane'), server).write({ server, client_id: 'mc_1', access_token: 'secret-access', refresh_token: 'secret-refresh', access_expires_at: NOW + 3_600_000, ...over });

describe('main', () => {
  it('--help prints the usage, --version the version', async () => {
    expect(await main(['--help'], deps())).toBe(0);
    expect(await main(['--version'], deps())).toBe(0);
    expect(out).toEqual([USAGE, VERSION]);
  });

  it('an unknown command or an extra argument prints the usage to stderr and exits 2', async () => {
    expect(await main(['lgoin'], deps())).toBe(2);
    expect(await main(['status', 'extra'], deps())).toBe(2);
    expect(err).toEqual([USAGE, USAGE]);
  });

  it('a bad AUTOLANE_COURIER_URL rejects with the reason', async () => {
    await expect(main(['status'], deps({ env: { XDG_CONFIG_HOME: xdg, AUTOLANE_COURIER_URL: 'http://example.com/courier-mcp' } }))).rejects.toThrow('must be an https URL');
  });

  it('status says not linked and exits 1', async () => {
    expect(await main(['status'], deps())).toBe(1);
    expect(out).toEqual([`Not linked to ${SERVER}.`]);
  });

  it('status names the server, the expiry and the file, never a token', async () => {
    await link();
    expect(await main(['status'], deps())).toBe(0);
    expect(out[0]).toContain(`Linked to ${SERVER}.`);
    expect(out[0]).toContain(`valid until ${new Date(NOW + 3_600_000).toISOString()}`);
    expect(out[0]).toContain(join(xdg, 'autolane', 'courier-mcp.json'));
    expect(out[0]).not.toContain('secret');
  });

  it('a damaged token file reads as not linked, and the parse error never reaches the output', async () => {
    await mkdir(join(xdg, 'autolane'), { recursive: true });
    await writeFile(join(xdg, 'autolane', 'courier-mcp.json'), '{ "refresh_token": SECRETREFRESH');
    expect(await main(['status'], deps())).toBe(1);
    expect(await main([], deps())).toBe(1);
    expect(out).toEqual([`Not linked to ${SERVER}.`]);
    expect(err).toEqual([RELINK]);
    const { fetch } = fakeOAuth();
    expect(await main(['login', '--no-browser'], deps({ fetch }))).toBe(0);
    expect(await fileStore(join(xdg, 'autolane'), SERVER).read()).toMatchObject({ client_id: 'mc_new', access_token: 'at-1' });
  });

  it('status says an expired access token refreshes on the next call', async () => {
    await link({ access_expires_at: NOW - 1 });
    expect(await main(['status'], deps())).toBe(0);
    expect(out[0]).toContain('expired; it refreshes on the next call');
  });

  it('login --no-browser links and saves the tokens', async () => {
    const { fetch } = fakeOAuth();
    const opened: string[] = [];
    expect(await main(['login', '--no-browser'], deps({ fetch, openUrl: (u) => opened.push(u) }))).toBe(0);
    expect(opened).toEqual([]);
    expect(await fileStore(join(xdg, 'autolane'), SERVER).read()).toMatchObject({ client_id: 'mc_new', access_token: 'at-1' });
  });

  it('logout revokes the refresh token and removes the file', async () => {
    await link();
    const { fetch, calls } = fakeOAuth();
    expect(await main(['logout'], deps({ fetch }))).toBe(0);
    expect(calls.find((c) => c.url.endsWith('/oauth/revoke'))?.form).toEqual({ token: 'secret-refresh', token_type_hint: 'refresh_token', client_id: 'mc_1' });
    expect(await fileStore(join(xdg, 'autolane'), SERVER).read()).toBeNull();
    expect(out).toEqual(['Logged out. This machine is no longer linked.']);
  });

  it('logout revokes while it holds the lock, and releases it', async () => {
    await link();
    const lock = join(xdg, 'autolane', 'courier-mcp.lock');
    const heldDuringRevoke: boolean[] = [];
    const { fetch } = fakeOAuth();
    const watching: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/oauth/revoke')) heldDuringRevoke.push(existsSync(lock));
      return fetch(input, init);
    };
    expect(await main(['logout'], deps({ fetch: watching }))).toBe(0);
    expect(heldDuringRevoke).toEqual([true]);
    expect(existsSync(lock)).toBe(false);
  });

  it('logout still removes the file when Autolane cannot be reached', async () => {
    await link();
    const failing = async () => { throw new TypeError('fetch failed'); };
    expect(await main(['logout'], deps({ fetch: failing }))).toBe(0);
    expect(err[0]).toBe('Could not reach Autolane to revoke the link (fetch failed); removing it from this machine anyway.');
    expect(await fileStore(join(xdg, 'autolane'), SERVER).read()).toBeNull();
  });

  it('describeError adds the cause, which says why a fetch failed', () => {
    expect(describeError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }))).toBe('fetch failed (getaddrinfo ENOTFOUND mcp.example.test)');
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError('odd')).toBe('odd');
  });

  it('logout names the cause when Autolane cannot be reached', async () => {
    await link();
    const failing = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }); };
    expect(await main(['logout'], deps({ fetch: failing }))).toBe(0);
    expect(err[0]).toBe('Could not reach Autolane to revoke the link (fetch failed (getaddrinfo ENOTFOUND mcp.example.test)); removing it from this machine anyway.');
  });

  it('logout with nothing linked says so', async () => {
    expect(await main(['logout'], deps())).toBe(0);
    expect(out).toEqual(['This machine is not linked.']);
  });

  it('serve without a login prints the relink line to stderr and exits 1', async () => {
    expect(await main([], deps())).toBe(1);
    expect(err).toEqual([RELINK]);
    expect(out).toEqual([]);
  });

  it('serve with a login runs the proxy on the given transport and stays running', async () => {
    const courier = await startCourierServer('secret-access');
    cleanups.push(courier.close);
    const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
    await link({}, courier.url);
    const code = await main([], deps({ env: { XDG_CONFIG_HOME: xdg, AUTOLANE_COURIER_URL: courier.url }, transport: () => proxySide }));
    expect(code).toBeNull();
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    cleanups.push(() => agent.close());
    await agent.connect(agentSide);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(['check_delivery']);
    expect(out).toEqual([]);
  });
});
