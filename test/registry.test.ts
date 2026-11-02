// AUT-4550: the MCP Registry entry and the npm package must agree. The registry
// proves we own the package by reading mcpName from npm, so package.json carries
// it, and server.json lists this exact package version and the default server.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT_NAME, DEFAULT_SERVER } from '../src/config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

describe('MCP Registry entry (AUT-4550)', () => {
  it('package.json names the registry entry it belongs to', () => {
    expect(pkg.mcpName).toBe('com.goautolane/courier');
    expect(server.name).toBe(pkg.mcpName);
  });

  it('server.json lists this package at this version, run over stdio with npx', () => {
    expect(server.packages).toEqual([
      {
        registryType: 'npm',
        registryBaseUrl: 'https://registry.npmjs.org',
        identifier: pkg.name,
        version: pkg.version,
        runtimeHint: 'npx',
        transport: { type: 'stdio' },
      },
    ]);
  });

  it('server.json lists the remote server the package talks to by default', () => {
    expect(server.remotes).toEqual([{ type: 'streamable-http', url: DEFAULT_SERVER }]);
  });

  it('says Courier by Autolane in the listing and on the phone page', () => {
    expect(server.title).toBe('Courier by Autolane');
    expect(CLIENT_NAME).toBe('Courier by Autolane MCP');
  });
});
