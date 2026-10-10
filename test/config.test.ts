import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER, RELINK, VERSION, configDir, serverUrl } from '../src/config.js';

describe('serverUrl', () => {
  it('defaults to production', () => {
    expect(serverUrl({})).toBe('https://mcp.goautolane.com/courier-mcp');
    expect(DEFAULT_SERVER).toBe('https://mcp.goautolane.com/courier-mcp');
  });

  it('takes AUTOLANE_COURIER_URL, trimmed and without a trailing slash', () => {
    expect(serverUrl({ AUTOLANE_COURIER_URL: ' https://api-sandbox.goautolane.com/courier-mcp/ ' })).toBe('https://api-sandbox.goautolane.com/courier-mcp');
  });

  it('allows http only on localhost, for a local dev server', () => {
    expect(serverUrl({ AUTOLANE_COURIER_URL: 'http://localhost:3000/courier-mcp' })).toBe('http://localhost:3000/courier-mcp');
    expect(serverUrl({ AUTOLANE_COURIER_URL: 'http://127.0.0.1:3000/courier-mcp' })).toBe('http://127.0.0.1:3000/courier-mcp');
    expect(() => serverUrl({ AUTOLANE_COURIER_URL: 'http://example.com/courier-mcp' })).toThrow('AUTOLANE_COURIER_URL must be an https URL');
  });

  it('refuses a value that is not a URL', () => {
    expect(() => serverUrl({ AUTOLANE_COURIER_URL: 'mcp.goautolane.com' })).toThrow();
  });
});

describe('configDir', () => {
  it('uses %APPDATA%\\autolane on Windows', () => {
    expect(configDir({ APPDATA: 'C:\\Users\\c\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\c\\AppData\\Roaming', 'autolane'));
  });

  it('uses $XDG_CONFIG_HOME/autolane when set', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/tmp/xdg' }, 'linux')).toBe('/tmp/xdg/autolane');
  });

  it('falls back to ~/.config/autolane on Linux and macOS', () => {
    expect(configDir({}, 'linux')).toBe(join(homedir(), '.config', 'autolane'));
    expect(configDir({}, 'darwin')).toBe(join(homedir(), '.config', 'autolane'));
  });
});

describe('constants', () => {
  it('VERSION is the package version, and RELINK names the login command', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    expect(RELINK).toBe('Not linked. Run: npx -y @autolane/courier-mcp login --no-browser');
  });
});
