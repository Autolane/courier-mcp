// Where the package talks to, and where it keeps its login (spec section 4.4).
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SERVER = 'https://mcp.goautolane.com/courier-mcp';
export const RELINK = 'Not linked. Run: npx -y @autolane/courier-mcp login --no-browser';
/** The client_name the phone page shows: "Link your phone to Autolane Courier MCP". */
export const CLIENT_NAME = 'Autolane Courier MCP';
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** The courier MCP endpoint: AUTOLANE_COURIER_URL (sandbox, or a local dev server over http), else production. */
export function serverUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AUTOLANE_COURIER_URL?.trim() || DEFAULT_SERVER;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`AUTOLANE_COURIER_URL must be an https URL (or http on localhost): ${raw}`);
  }
  return url.toString().replace(/\/$/, '');
}

/** The token file's directory: %APPDATA%\autolane on Windows, else $XDG_CONFIG_HOME/autolane or ~/.config/autolane. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'autolane');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autolane');
}
