// Fault injection for the store: a failure partway through must not leave a lock or a temp file behind.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Saved } from '../src/store.js';

const faults = vi.hoisted(() => ({ writeFile: false, rename: false, closes: 0 }));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        faults.closes += 1;
        await close();
      };
      if (faults.writeFile) handle.writeFile = async () => { throw new Error('disk full'); };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw new Error('rename refused');
      return actual.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args),
  };
});

const { fileStore } = await import('../src/store.js');

const SERVER = 'https://mcp.example.test/courier-mcp';
const saved: Saved = { server: SERVER, client_id: 'mc_1', access_token: 'at', access_expires_at: 1, refresh_token: 'rt' };

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'courier-mcp-faults-'));
  dir = join(root, 'autolane');
  faults.writeFile = false;
  faults.rename = false;
  faults.closes = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('store faults', () => {
  it('closes the handle and removes the lock when writing into the lock fails, then rethrows', async () => {
    faults.writeFile = true;
    await expect(fileStore(dir, SERVER).withLock(async () => 'ran')).rejects.toThrow('disk full');
    expect(faults.closes).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes its temp file when the rename fails, then rethrows', async () => {
    faults.rename = true;
    await expect(fileStore(dir, SERVER).write(saved)).rejects.toThrow('rename refused');
    expect(await readdir(dir)).toEqual([]);
  });
});
