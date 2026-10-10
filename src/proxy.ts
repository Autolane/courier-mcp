// The stdio MCP server an agent runs, in front of /courier-mcp (spec section 4.3). It forwards tools and
// resources, everything the courier server offers, sending the session's bearer token on every request.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, McpError, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RELINK, VERSION } from './config.js';
import { describeError } from './errors.js';
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

/** Shown instead of the courier tools when the login is gone, so the agent can tell the user how to link. */
const LOGIN_TOOL = 'autolane_courier_login_needed';
const loginNeeded = `${RELINK}, then restart your agent.`;

/** One line, no token: only the error's message, newlines folded. */
const reportLine = (error: Error) => `courier-mcp: ${describeError(error).replace(/\s+/g, ' ')}`;

/** The agent sees only an error's message, so a failure that keeps its reason in `cause` is rethrown with it spelled out. */
async function withCause<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const text = describeError(error);
    if (error instanceof NotLinkedError || error instanceof McpError || !(error instanceof Error) || text === error.message) throw error;
    throw new Error(text);
  }
}

export function createProxy(opts: { server: string; session: Session; fetch?: Fetch; log?: (line: string) => void }): Server {
  const write = opts.log ?? ((line: string) => console.error(line));
  let closed = false;
  // Closing aborts the upstream stream, and that abort is not worth a line.
  const log = (line: string) => {
    if (!closed) write(line);
  };
  let remote: Promise<Client> | null = null;
  /** Connects on first use, so the agent's handshake never waits on the network; a failed connect is retried next time. */
  const connected = (): Promise<Client> => {
    remote ??= (async () => {
      const client = new Client({ name: 'autolane-courier-mcp', version: VERSION });
      client.onerror = (error) => log(reportLine(error));
      await client.connect(new StreamableHTTPClientTransport(new URL(opts.server), { fetch: bearerFetch(opts.session, opts.fetch) }));
      return client;
    })().catch((error: unknown) => {
      remote = null;
      throw error;
    });
    return remote;
  };

  const proxy = new Server({ name: 'autolane-courier', version: VERSION }, { capabilities: { tools: {}, resources: {} } });
  proxy.onerror = (error) => log(reportLine(error));
  proxy.onclose = () => {
    closed = true;
    const upstream = remote;
    remote = null;
    void upstream?.then((client) => client.close(), () => {});
  };
  proxy.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    try {
      return await withCause(async () => (await connected()).listTools(req.params, { signal: extra.signal }));
    } catch (error) {
      if (error instanceof NotLinkedError) return { tools: [{ name: LOGIN_TOOL, description: loginNeeded, inputSchema: { type: 'object' as const, properties: {} } }] };
      throw error;
    }
  });
  proxy.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    // The agent shows a tool error to the user, so the relink line reaches them.
    if (req.params.name === LOGIN_TOOL) return { isError: true, content: [{ type: 'text', text: loginNeeded }] };
    try {
      return (await withCause(async () => (await connected()).callTool(req.params, undefined, { signal: extra.signal }))) as CallToolResult;
    } catch (error) {
      if (error instanceof NotLinkedError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      throw error;
    }
  });
  proxy.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => withCause(async () => (await connected()).listResources(req.params, { signal: extra.signal })));
  proxy.setRequestHandler(ListResourceTemplatesRequestSchema, async (req, extra) => withCause(async () => (await connected()).listResourceTemplates(req.params, { signal: extra.signal })));
  proxy.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => withCause(async () => (await connected()).readResource(req.params, { signal: extra.signal })));
  return proxy;
}
