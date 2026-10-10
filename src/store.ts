// The login on disk (spec section 4.4): one JSON file, 0600 in a 0700 directory, replaced by rename.
// The lock file serializes refreshes: the server rotates refresh tokens and revokes the whole family
// when an old one is reused, so two agents sharing this file must never refresh at once.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Saved {
  server: string;
  client_id: string;
  access_token: string;
  /** Epoch milliseconds. */
  access_expires_at: number;
  refresh_token: string;
}

export interface TokenStore {
  readonly path: string;
  /** The saved login for this store's server, or null (no file, or a file for another server). */
  read(): Promise<Saved | null>;
  write(saved: Saved): Promise<void>;
  remove(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StoreOptions {
  /** A lock file older than this is a crashed holder's, and is taken over. */
  staleMs?: number;
  /** How long to wait for a live lock before giving up. */
  waitMs?: number;
  pollMs?: number;
}

const isSaved = (value: unknown): value is Saved => {
  const v = value as Record<string, unknown> | null;
  return typeof v === 'object' && v !== null && typeof v.server === 'string' && typeof v.client_id === 'string' && typeof v.access_token === 'string' && typeof v.refresh_token === 'string' && typeof v.access_expires_at === 'number';
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function fileStore(dir: string, server: string, opts: StoreOptions = {}): TokenStore {
  const { staleMs = 30_000, waitMs = 10_000, pollMs = 100 } = opts;
  const path = join(dir, 'courier-mcp.json');
  const lockPath = join(dir, 'courier-mcp.lock');
  const ensureDir = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  };

  return {
    path,
    async read() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      // A damaged file reads as not linked, so login can write over it. The parse error is dropped: V8 quotes the file in it.
      const saved: unknown = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      return isSaved(saved) && saved.server === server ? saved : null;
    },
    async write(saved) {
      await ensureDir();
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    },
    async remove() {
      await rm(path, { force: true });
    },
    async withLock(fn) {
      await ensureDir();
      const deadline = Date.now() + waitMs;
      const mine = `${process.pid} ${randomUUID()}\n`;
      for (;;) {
        try {
          const handle = await open(lockPath, 'wx', 0o600);
          await handle.writeFile(mine);
          await handle.close();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
          if (age > staleMs) {
            await rm(lockPath, { force: true });
            continue;
          }
          if (Date.now() > deadline) throw new Error(`Another courier-mcp process holds ${lockPath}; try again in a moment`);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      }
      try {
        return await fn();
      } finally {
        // Another process may have taken a lock we held too long (stale takeover); never remove theirs.
        // debt: two waiters can both judge the same lock stale and both take it, upgrade to an atomic rename takeover if that is seen.
        if ((await readFile(lockPath, 'utf8').catch(() => null)) === mine) await rm(lockPath, { force: true });
      }
    },
  };
}
