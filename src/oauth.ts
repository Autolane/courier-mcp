// The courier authorization server, over fetch: RFC 8414 discovery, RFC 7591 registration of a device-only
// public client (AUT-3861), the RFC 8628 device grant (contract A91), refresh with rotation, RFC 7009 revoke.
export type Fetch = typeof globalThis.fetch;

/** No request may hang: a refresh stuck past the lock's stale limit would let a second process reuse the refresh token. */
const REQUEST_TIMEOUT_MS = 10_000;
const timeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface Endpoints {
  registration_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    description: string | undefined,
    readonly status: number,
    /** The endpoint path, for an error the server gave no description of. */
    from?: string,
  ) {
    super(description ? `${code}: ${description}` : from ? `${code} from ${from}` : code);
  }
}

const ENDPOINT_KEYS = ['registration_endpoint', 'device_authorization_endpoint', 'token_endpoint', 'revocation_endpoint'] as const;

async function json<T>(res: Response, url: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const description = typeof body.error_description === 'string' ? body.error_description : undefined;
    throw new OAuthError(typeof body.error === 'string' ? body.error : `http_${res.status}`, description, res.status, new URL(url).pathname);
  }
  return body as T;
}

/** A 200 that is not a token set must not reach the saved file, where the missing fields would drop the refresh token. */
async function tokenSet(res: Response, url: string): Promise<TokenSet> {
  const body = await json<Partial<Record<keyof TokenSet, unknown>>>(res, url);
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)) {
    throw new OAuthError('invalid_response', 'The token response is missing a field', 502);
  }
  return body as TokenSet;
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  signal: timeout(),
});

/** RFC 8414 section 3.1: the issuer is the server URL (contract A97), so its path goes after the well-known prefix. */
export async function discover(server: string, f: Fetch = fetch): Promise<Endpoints> {
  const url = new URL(server);
  const metadataUrl = `${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/$/, '')}`;
  const meta = await json<Partial<Record<(typeof ENDPOINT_KEYS)[number], unknown>>>(await f(metadataUrl, { signal: timeout() }), metadataUrl);
  for (const key of ENDPOINT_KEYS) {
    if (typeof meta[key] !== 'string') throw new Error(`${server} does not offer ${key}; is it a Courier MCP URL?`);
  }
  return meta as Endpoints;
}

/** A client with no redirect URI links only through the device grant (AUT-3861). */
export async function register(endpoints: Endpoints, clientName: string, f: Fetch = fetch): Promise<string> {
  const res = await f(endpoints.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [], grant_types: [DEVICE_GRANT, 'refresh_token'], token_endpoint_auth_method: 'none' }),
    signal: timeout(),
  });
  return (await json<{ client_id: string }>(res, endpoints.registration_endpoint)).client_id;
}

export async function startDevice(endpoints: Endpoints, clientId: string, f: Fetch = fetch): Promise<DeviceStart> {
  return json<DeviceStart>(await f(endpoints.device_authorization_endpoint, form({ client_id: clientId })), endpoints.device_authorization_endpoint);
}

const isTransient = (error: unknown) => error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));

/** RFC 8628 sections 3.4 and 3.5: wait `interval` seconds between polls, five more after each slow_down, until the user links or the code expires. */
export async function pollDevice(
  endpoints: Endpoints,
  clientId: string,
  start: DeviceStart,
  opts: { fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenSet> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  // The server still accepts an approval for 30 seconds after expires_in, so the local deadline does too.
  const deadline = now() + start.expires_in * 1000 + 30_000;
  let interval = start.interval ?? 5;
  for (;;) {
    await sleep(interval * 1000);
    if (now() > deadline) throw new OAuthError('expired_token', 'The link expired before your phone was linked; run login again', 400);
    try {
      return await tokenSet(await f(endpoints.token_endpoint, form({ grant_type: DEVICE_GRANT, device_code: start.device_code, client_id: clientId })), endpoints.token_endpoint);
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'authorization_pending') continue;
      // RFC 8628 section 3.5: a slow_down, a dropped connection, a timeout or a 5xx all mean "wait longer and ask again".
      if ((error instanceof OAuthError && (error.code === 'slow_down' || (error.status >= 500 && error.code !== 'invalid_response'))) || isTransient(error)) {
        interval += 5;
        continue;
      }
      throw error;
    }
  }
}

export async function refresh(endpoints: Endpoints, clientId: string, refreshToken: string, f: Fetch = fetch): Promise<TokenSet> {
  return tokenSet(await f(endpoints.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })), endpoints.token_endpoint);
}

export async function revoke(endpoints: Endpoints, clientId: string, token: string, f: Fetch = fetch): Promise<void> {
  const res = await f(endpoints.revocation_endpoint, form({ token, token_type_hint: 'refresh_token', client_id: clientId }));
  if (!res.ok) throw new OAuthError(`http_${res.status}`, undefined, res.status, new URL(endpoints.revocation_endpoint).pathname);
}
