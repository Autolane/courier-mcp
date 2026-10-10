// A stand-in for /courier-mcp: a real MCP server over Streamable HTTP (stateless), one tool, one resource, and a
// 401 for any bearer but `token`. Records every Authorization header it sees.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function startCourierServer(token: string): Promise<{ url: string; bearers: string[]; close: () => Promise<void> }> {
  const bearers: string[] = [];
  const http = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    bearers.push(auth);
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    const mcp = new Server({ name: 'fake-courier', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'check_delivery', description: 'Check a delivery', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: `checked ${String(r.params.arguments?.address)}` }] }));
    mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'courier://description', name: 'connector-description' }] }));
    mcp.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: 'courier://delivery/{id}', name: 'delivery' }] }));
    mcp.setRequestHandler(ReadResourceRequestSchema, async (r) => ({ contents: [{ uri: r.params.uri, text: '# Courier' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/courier-mcp`,
    bearers,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
