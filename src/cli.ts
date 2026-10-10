// The commands (spec section 4.1). Everything a command prints goes through `out`/`err`; serve prints nothing to
// stdout, which carries MCP messages.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { RELINK, VERSION, configDir, serverUrl } from './config.js';
import { describeError } from './errors.js';
import { login } from './login.js';
import { discover, revoke, type Fetch } from './oauth.js';
import { createProxy } from './proxy.js';
import { createSession } from './session.js';
import { fileStore } from './store.js';

export const USAGE = `Usage: npx -y @autolane/courier-mcp [command]

  (no command)          Run the MCP server on stdio; this is what your agent's config runs
  login [--no-browser]  Link this machine to your phone
  logout                Remove this machine's link
  status                Show whether this machine is linked

AUTOLANE_COURIER_URL changes the server (default https://mcp.goautolane.com/courier-mcp).`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
  /** serve's transport; stdio unless a test passes one. */
  transport?: () => Transport;
}

/** Runs one command and resolves to its exit code, or to null for serve, which keeps running. */
export async function main(argv: string[], deps: CliDeps): Promise<number | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'no-browser': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', default: false } },
  });
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  if (values.version) {
    deps.out(VERSION);
    return 0;
  }
  const server = serverUrl(deps.env);
  const store = fileStore(configDir(deps.env), server);
  const now = deps.now ?? Date.now;
  const [command = 'serve', ...rest] = positionals;
  if (rest.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  switch (command) {
    case 'login':
      await login({ server, store, noBrowser: values['no-browser'], print: deps.out, openUrl: deps.openUrl, fetch: deps.fetch, sleep: deps.sleep, now });
      return 0;
    case 'logout':
      // Under the lock: a refresh in an agent must not rotate the token between our read and our revoke.
      return store.withLock(async () => {
        const saved = await store.read();
        if (!saved) {
          deps.out('This machine is not linked.');
          return 0;
        }
        try {
          await revoke(await discover(server, deps.fetch), saved.client_id, saved.refresh_token, deps.fetch);
        } catch (error) {
          deps.err(`Could not reach Autolane to revoke the link (${describeError(error)}); removing it from this machine anyway.`);
        }
        await store.remove();
        deps.out('Logged out. This machine is no longer linked.');
        return 0;
      });
    case 'status': {
      const saved = await store.read();
      if (!saved) {
        deps.out(`Not linked to ${server}.`);
        return 1;
      }
      const access = saved.access_expires_at > now() ? `valid until ${new Date(saved.access_expires_at).toISOString()}` : 'expired; it refreshes on the next call';
      deps.out(`Linked to ${server}.\nAccess token ${access}.\nToken file: ${store.path}`);
      return 0;
    }
    case 'serve': {
      if (!(await store.read())) {
        deps.err(RELINK);
        return 1;
      }
      const session = createSession({ store, endpoints: () => discover(server, deps.fetch), fetch: deps.fetch, now });
      await createProxy({ server, session, fetch: deps.fetch }).connect(deps.transport?.() ?? new StdioServerTransport());
      return null;
    }
    default:
      deps.err(USAGE);
      return 2;
  }
}
