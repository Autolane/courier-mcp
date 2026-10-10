// The stdio MCP server an agent runs, in front of /courier-mcp (spec section 4.3). It forwards tools and
// resources, everything the courier server offers, sending the session's bearer token on every request.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './config.js';
import type { Fetch } from './oauth.js';
import { NotLinkedError, type Session } from './session.js';

/** fetch with the bearer token; a 401 forces one refresh and resends (MCP request bodies are strings, so they can go twice). */
export function bearerFetch(session: Session, base: Fetch = fetch): Fetch {
  return async (input, init) => {
    const send = async (force: boolean) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${await session.accessToken({ force })}`);
      return base(input, { ...init, headers });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    await first.body?.cancel();
    return send(true);
  };
}

export function createProxy(opts: { server: string; session: Session; fetch?: Fetch }): Server {
  let remote: Promise<Client> | null = null;
  /** Connects on first use, so the agent's handshake never waits on the network; a failed connect is retried next time. */
  const connected = (): Promise<Client> => {
    remote ??= (async () => {
      const client = new Client({ name: 'autolane-courier-mcp', version: VERSION });
      await client.connect(new StreamableHTTPClientTransport(new URL(opts.server), { fetch: bearerFetch(opts.session, opts.fetch) }));
      return client;
    })().catch((error: unknown) => {
      remote = null;
      throw error;
    });
    return remote;
  };

  const proxy = new Server({ name: 'autolane-courier', version: VERSION }, { capabilities: { tools: {}, resources: {} } });
  proxy.setRequestHandler(ListToolsRequestSchema, async (req) => (await connected()).listTools(req.params));
  proxy.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      return (await (await connected()).callTool(req.params)) as CallToolResult;
    } catch (error) {
      // The agent shows a tool error to the user, so the relink line reaches them.
      if (error instanceof NotLinkedError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      throw error;
    }
  });
  proxy.setRequestHandler(ListResourcesRequestSchema, async (req) => (await connected()).listResources(req.params));
  proxy.setRequestHandler(ReadResourceRequestSchema, async (req) => (await connected()).readResource(req.params));
  return proxy;
}
