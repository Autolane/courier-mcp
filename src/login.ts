// `login`: RFC 8628 from a terminal (spec section 4.2). Print the link and code, open the link unless
// --no-browser, wait while the user links their phone on any device, then save the tokens.
import { spawn } from 'node:child_process';
import { CLIENT_NAME } from './config.js';
import { discover, pollDevice, register, startDevice, type Fetch } from './oauth.js';
import { savedFrom } from './session.js';
import type { TokenStore } from './store.js';

export interface LoginOptions {
  server: string;
  store: TokenStore;
  noBrowser: boolean;
  print: (line: string) => void;
  openUrl?: (url: string) => void;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function login(opts: LoginOptions): Promise<void> {
  const endpoints = await discover(opts.server, opts.fetch);
  const clientId = (await opts.store.read())?.client_id ?? (await register(endpoints, CLIENT_NAME, opts.fetch));
  const start = await startDevice(endpoints, clientId, opts.fetch);
  const link = start.verification_uri_complete ?? start.verification_uri;
  opts.print(`Open this link on any device (your phone works), then link your phone:\n\n  ${link}\n\nThe page should show the code ${start.user_code}. Waiting...`);
  if (!opts.noBrowser) (opts.openUrl ?? openBrowser)(link);
  const tokens = await pollDevice(endpoints, clientId, start, { fetch: opts.fetch, sleep: opts.sleep, now: opts.now });
  await opts.store.write(savedFrom({ server: opts.server, client_id: clientId }, tokens, (opts.now ?? Date.now)()));
  opts.print('Linked. Your agent can use Autolane Courier now.');
}

/** Best effort: on a machine with no browser nothing opens, and the printed link is the way in. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
