import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RELINK } from '../src/config.js';
import type { Fetch } from '../src/oauth.js';
import { createProxy } from '../src/proxy.js';
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
    await expect(agent.listTools()).rejects.toThrow(RELINK);
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
