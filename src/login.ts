// `login`: RFC 8628 from a terminal (spec section 4.2). Print the link and code, open the link unless
// --no-browser, wait while the user links their phone on any device, then save the tokens.
import { spawn } from 'node:child_process';
import { CLIENT_NAME } from './config.js';
import { describeError, plain } from './errors.js';
import { OAuthError, discover, pollDevice, register, revoke, startDevice, type DeviceStart, type Fetch } from './oauth.js';
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
  const savedClient = (await opts.store.read())?.client_id;
  let clientId = savedClient ?? (await register(endpoints, CLIENT_NAME, opts.fetch));
  let start: DeviceStart;
  try {
    start = await startDevice(endpoints, clientId, opts.fetch);
  } catch (error) {
    // The server forgot the saved client: register a new one, once.
    if (!savedClient || !(error instanceof OAuthError) || error.code !== 'invalid_client') throw error;
    clientId = await register(endpoints, CLIENT_NAME, opts.fetch);
    start = await startDevice(endpoints, clientId, opts.fetch);
  }
  // The link comes from the server's reply. Print and open the parsed form, and open it only on the server's own origin.
  const url = new URL(start.verification_uri_complete ?? start.verification_uri);
  opts.print(`Open this link on any device (your phone works), then link your phone:\n\n  ${plain(url.href)}\n\nThe page should show the code ${plain(start.user_code)}. Waiting...`);
  if (!opts.noBrowser && url.origin === new URL(opts.server).origin) (opts.openUrl ?? openBrowser)(url.href);
  const tokens = await pollDevice(endpoints, clientId, start, { fetch: opts.fetch, sleep: opts.sleep, now: opts.now });
  // Save under the lock, so a refresh running in an agent cannot interleave with it.
  const previous = await opts.store.withLock(async () => {
    const before = await opts.store.read();
    await opts.store.write(savedFrom({ server: opts.server, client_id: clientId }, tokens, (opts.now ?? Date.now)()));
    return before;
  });
  // The old login is replaced, so revoke it; best effort, since the new one already works.
  if (previous) {
    await revoke(endpoints, previous.client_id, previous.refresh_token, opts.fetch).catch((error: unknown) => {
      opts.print(`Could not revoke the previous link (${describeError(error)}); it expires on its own.`);
    });
  }
  opts.print('Linked. Your agent can use Autolane Courier now.');
}

/** Best effort: on a machine with no browser nothing opens, and the printed link is the way in. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\explorer.exe`, [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
