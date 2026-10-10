import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RELINK } from '../src/config.js';
import type { Fetch } from '../src/oauth.js';
import { bearerFetch, createProxy } from '../src/proxy.js';
import { NotLinkedError, type Session } from '../src/session.js';
import { startCourierServer } from './courierServer.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** An agent connected to the proxy over an in-memory pair, as an agent's stdio would be. */
async function agentThrough(server: string, session: Session, fetch?: Fetch): Promise<Client> {
  const proxy = createProxy({ server, session, fetch });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(proxySide);
  const agent = new Client({ name: 'agent', version: '0.0.0' });
  await agent.connect(agentSide);
  cleanups.push(() => agent.close(), () => proxy.close());
  return agent;
}

describe('createProxy', () => {
  it('forwards tools/list, tools/call, resources/list and resources/read with the bearer token', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const agent = await agentThrough(courier.url, { accessToken: async () => 'good' });
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(['check_delivery']);
    expect(await agent.callTool({ name: 'check_delivery', arguments: { address: '500 W 2nd St' } })).toMatchObject({ content: [{ type: 'text', text: 'checked 500 W 2nd St' }] });
    expect((await agent.listResources()).resources.map((r) => r.uri)).toEqual(['courier://description']);
    expect((await agent.readResource({ uri: 'courier://description' })).contents[0]).toMatchObject({ text: '# Courier' });
    expect(courier.bearers.length).toBeGreaterThan(0);
    expect(courier.bearers.every((b) => b === 'Bearer good')).toBe(true);
  });

  it('on a 401 forces one refresh and resends the same request', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const forced: boolean[] = [];
    let token = 'stale';
    const agent = await agentThrough(courier.url, {
      accessToken: async ({ force = false } = {}) => {
        forced.push(force);
        if (force) token = 'good';
        return token;
      },
    });
    expect((await agent.listTools()).tools).toHaveLength(1);
    expect(courier.bearers.slice(0, 2)).toEqual(['Bearer stale', 'Bearer good']);
    expect(forced.filter(Boolean)).toHaveLength(1);
  });

  it('answers a tool call with the relink line as a tool error when the login is gone, and fails a list with it', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const agent = await agentThrough(courier.url, { accessToken: async () => { throw new NotLinkedError(); } });
    expect(await agent.callTool({ name: 'check_delivery', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: RELINK }] });
  });

  it('lists one login tool when the login is gone, and calling it returns the relink line', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const agent = await agentThrough(courier.url, { accessToken: async () => { throw new NotLinkedError(); } });
    const { tools } = await agent.listTools();
    expect(tools).toEqual([{ name: 'autolane_courier_login_needed', description: `${RELINK}, then restart your agent.`, inputSchema: { type: 'object', properties: {} } }]);
    expect(await agent.callTool({ name: 'autolane_courier_login_needed', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: `${RELINK}, then restart your agent.` }] });
  });

  it('forwards resources/templates/list', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const agent = await agentThrough(courier.url, { accessToken: async () => 'good' });
    expect((await agent.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual(['courier://delivery/{id}']);
  });

  it("passes the agent's abort signal into every forwarded request", async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const spies = (['listTools', 'callTool', 'listResources', 'listResourceTemplates', 'readResource'] as const).map((name) => ({ name, spy: vi.spyOn(Client.prototype, name) }));
    const agent = await agentThrough(courier.url, { accessToken: async () => 'good' });
    await agent.listTools();
    await agent.callTool({ name: 'check_delivery', arguments: {} });
    await agent.listResources();
    await agent.listResourceTemplates();
    await agent.readResource({ uri: 'courier://description' });
    // The agent's own client made these calls too; the forwarded ones carry a signal in their options (callTool's third argument, the rest's second).
    for (const { name, spy } of spies) {
      const optionsAt = name === 'callTool' ? 2 : 1;
      expect(spy.mock.calls.some((args) => (args[optionsAt] as { signal?: unknown } | undefined)?.signal instanceof AbortSignal), name).toBe(true);
    }
    vi.restoreAllMocks();
  });

  it('closes the upstream client when the proxy closes', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const proxy = createProxy({ server: courier.url, session: { accessToken: async () => 'good' } });
    const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(proxySide);
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(agentSide);
    await agent.listTools();
    const close = vi.spyOn(Client.prototype, 'close');
    await proxy.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(close).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    await agent.close();
  });

  it('keeps the cause in the error the agent receives and in the log line', async () => {
    const lines: string[] = [];
    const unreachable: Fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }); };
    const proxy = createProxy({ server: 'https://mcp.example.test/courier-mcp', session: { accessToken: async () => 'good' }, fetch: unreachable, log: (line) => lines.push(line) });
    const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(proxySide);
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(agentSide);
    cleanups.push(() => agent.close(), () => proxy.close());
    await expect(agent.callTool({ name: 'check_delivery', arguments: {} })).rejects.toThrow('fetch failed (getaddrinfo ENOTFOUND mcp.example.test)');
    await expect(agent.listTools()).rejects.toThrow('fetch failed (getaddrinfo ENOTFOUND mcp.example.test)');
    proxy.onerror?.(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }));
    expect(lines).toContain('courier-mcp: fetch failed (getaddrinfo ENOTFOUND mcp.example.test)');
  });

  it('reports a protocol error as one line on the log, with the message and nothing else', () => {
    const lines: string[] = [];
    const proxy = createProxy({ server: 'http://127.0.0.1:1/courier-mcp', session: { accessToken: async () => 'good' }, log: (line) => lines.push(line) });
    proxy.onerror?.(new Error('bad frame\nsecond line'));
    expect(lines).toEqual(['courier-mcp: bad frame second line']);
  });

  it('a 401 that persists after the forced refresh makes exactly two upstream requests, then an error', async () => {
    const courier = await startCourierServer('good');
    cleanups.push(courier.close);
    const forced: boolean[] = [];
    const agent = await agentThrough(courier.url, { accessToken: async ({ force = false } = {}) => { forced.push(force); return 'still-bad'; } });
    await expect(agent.listTools()).rejects.toThrow();
    expect(courier.bearers).toEqual(['Bearer still-bad', 'Bearer still-bad']);
    expect(forced).toEqual([false, true]);
  });

  it('fails a call when Autolane cannot be reached, and tries to connect again on the next one', async () => {
    let attempts = 0;
    const counting: Fetch = async (input, init) => {
      attempts += 1;
      return fetch(input, init);
    };
    const agent = await agentThrough('http://127.0.0.1:1/courier-mcp', { accessToken: async () => 'good' }, counting);
    await expect(agent.callTool({ name: 'check_delivery', arguments: {} })).rejects.toThrow();
    const afterFirst = attempts;
    await expect(agent.callTool({ name: 'check_delivery', arguments: {} })).rejects.toThrow();
    expect(afterFirst).toBeGreaterThan(0);
    expect(attempts).toBeGreaterThan(afterFirst);
  });
});

describe('bearerFetch', () => {
  it('cancels the 401 body before it resends', async () => {
    let cancelled = false;
    const unauthorized = new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 401 });
    const base: Fetch = async (_input, init) => (new Headers(init?.headers).get('authorization') === 'Bearer fresh' ? new Response('ok') : unauthorized);
    const session: Session = { accessToken: async ({ force = false } = {}) => (force ? 'fresh' : 'stale') };
    expect(await (await bearerFetch(session, base)('http://x.test/')).text()).toBe('ok');
    expect(cancelled).toBe(true);
  });
});
