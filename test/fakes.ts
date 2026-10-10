// A fetch that plays the courier OAuth endpoints (contract A68, A91, A97) from queues of replies, recording every call.
import type { Fetch } from '../src/oauth.js';

export const SERVER = 'https://mcp.example.test/courier-mcp';
export const ENDPOINTS = {
  registration_endpoint: `${SERVER}/oauth/register`,
  device_authorization_endpoint: `${SERVER}/oauth/device_authorization`,
  token_endpoint: `${SERVER}/oauth/token`,
  revocation_endpoint: `${SERVER}/oauth/revoke`,
};
export const METADATA_URL = 'https://mcp.example.test/.well-known/oauth-authorization-server/courier-mcp';

export interface Reply {
  status?: number;
  body?: unknown;
}
export interface FakeCall {
  url: string;
  method: string;
  form: Record<string, string>;
  json: unknown;
}
type Route = 'metadata' | 'register' | 'device' | 'token' | 'revoke';

export const oauthError = (error: string, status = 400): Reply => ({ status, body: { error, error_description: `${error} (fake)` } });
export const tokenReply = (access: string, refresh: string, expiresIn = 3600): Reply => ({ body: { access_token: access, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope: 'courier:write' } });

export function fakeOAuth(replies: Partial<Record<Route, Reply[]>> = {}) {
  const calls: FakeCall[] = [];
  const defaults: Record<Route, Reply> = {
    metadata: { body: { issuer: SERVER, ...ENDPOINTS } },
    register: { status: 201, body: { client_id: 'mc_new' } },
    device: { body: { device_code: 'dev-1', user_code: 'BCDF-GHJK', verification_uri: `${SERVER}/oauth/device`, verification_uri_complete: `${SERVER}/oauth/device?user_code=BCDFGHJK`, expires_in: 600, interval: 5 } },
    token: tokenReply('at-1', 'rt-1'),
    revoke: { body: {} },
  };
  const routes: Record<string, Route> = {
    [METADATA_URL]: 'metadata',
    [ENDPOINTS.registration_endpoint]: 'register',
    [ENDPOINTS.device_authorization_endpoint]: 'device',
    [ENDPOINTS.token_endpoint]: 'token',
    [ENDPOINTS.revocation_endpoint]: 'revoke',
  };
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const isJson = (new Headers(init?.headers).get('content-type') ?? '').includes('json');
    calls.push({ url, method: init?.method ?? 'GET', form: isJson ? {} : Object.fromEntries(new URLSearchParams(body)), json: isJson ? JSON.parse(body) : null });
    const route = routes[url];
    const reply = route ? (replies[route]?.shift() ?? defaults[route]) : { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}
