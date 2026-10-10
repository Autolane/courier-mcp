import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileStore, type Saved } from '../src/store.js';

const SERVER = 'https://mcp.example.test/courier-mcp';
const saved: Saved = { server: SERVER, client_id: 'mc_1', access_token: 'at', access_expires_at: 1, refresh_token: 'rt' };

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'courier-mcp-store-'));
  dir = join(root, 'autolane');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fileStore', () => {
  it('reads null before anything is written', async () => {
    expect(await fileStore(dir, SERVER).read()).toBeNull();
  });

  it('writes and reads back, with a 0700 directory and a 0600 file', async () => {
    const store = fileStore(dir, SERVER);
    await store.write(saved);
    expect(await store.read()).toEqual(saved);
    expect(store.path).toBe(join(dir, 'courier-mcp.json'));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it('replaces the file by rename, leaving no temp file behind', async () => {
    const store = fileStore(dir, SERVER);
    await store.write(saved);
    await store.write({ ...saved, refresh_token: 'rt-2' });
    expect((await store.read())?.refresh_token).toBe('rt-2');
    expect(await readdir(dir)).toEqual(['courier-mcp.json']);
  });

  it('reads a file saved for another server as not linked', async () => {
    await fileStore(dir, 'https://api-sandbox.goautolane.com/courier-mcp').write({ ...saved, server: 'https://api-sandbox.goautolane.com/courier-mcp' });
    expect(await fileStore(dir, SERVER).read()).toBeNull();
  });

  it('remove deletes the file and is fine when there is none', async () => {
    const store = fileStore(dir, SERVER);
    await store.remove();
    await store.write(saved);
    await store.remove();
    expect(await store.read()).toBeNull();
  });
});

describe('withLock', () => {
  it('runs one holder at a time, across store instances', async () => {
    const order: string[] = [];
    const hold = (name: string) => async () => {
      order.push(`${name}-in`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`${name}-out`);
    };
    await Promise.all([fileStore(dir, SERVER).withLock(hold('a')), fileStore(dir, SERVER).withLock(hold('b'))]);
    // Either may go first, but each leaves before the other enters.
    expect([['a-in', 'a-out', 'b-in', 'b-out'], ['b-in', 'b-out', 'a-in', 'a-out']]).toContainEqual(order);
  });

  it('takes over a lock older than the stale limit', async () => {
    const store = fileStore(dir, SERVER, { staleMs: 1_000 });
    await store.write(saved);
    const lock = join(dir, 'courier-mcp.lock');
    await writeFile(lock, '999999 old\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await store.withLock(async () => 'ran')).toBe('ran');
  });

  it('gives up on a live lock after the wait limit', async () => {
    const store = fileStore(dir, SERVER, { waitMs: 200, pollMs: 20 });
    await store.write(saved);
    await writeFile(join(dir, 'courier-mcp.lock'), `${process.pid} now\n`);
    await expect(store.withLock(async () => 'ran')).rejects.toThrow('Another courier-mcp process holds');
  });

  it('releases the lock when the holder throws', async () => {
    const store = fileStore(dir, SERVER);
    await expect(store.withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await readdir(dir)).not.toContain('courier-mcp.lock');
  });

  it('leaves a lock another holder took over, when the first holder finishes late', async () => {
    const store = fileStore(dir, SERVER);
    const lock = join(dir, 'courier-mcp.lock');
    await store.withLock(async () => {
      await writeFile(lock, 'other-holder-token\n');
    });
    expect(await readFile(lock, 'utf8')).toBe('other-holder-token\n');
  });
});
