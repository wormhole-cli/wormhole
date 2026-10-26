import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Event, Thread } from '../model/thread.js';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

export function wormholeHome(): string {
  return process.env.WORMHOLE_HOME ?? path.join(homedir(), '.wormhole');
}

/** Default thread id for a project directory: stable, so every tool finds the same thread. */
export function threadIdForCwd(cwd: string): string {
  return createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export class Store {
  constructor(private readonly root: string = wormholeHome()) {}

  threadDir(id: string): string {
    return path.join(this.root, 'threads', id);
  }

  async load(id: string): Promise<Thread | null> {
    try {
      const raw = await fs.readFile(path.join(this.threadDir(id), 'thread.json'), 'utf8');
      return Thread.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async loadForCwd(cwd: string): Promise<Thread | null> {
    return this.load(threadIdForCwd(cwd));
  }

  async loadOrCreateForCwd(cwd: string, title = path.basename(cwd)): Promise<Thread> {
    const existing = await this.loadForCwd(cwd);
    if (existing) return existing;
    const now = new Date().toISOString();
    const thread: Thread = {
      version: 1,
      id: threadIdForCwd(cwd),
      cwd: path.resolve(cwd),
      title,
      createdAt: now,
      updatedAt: now,
      segments: [],
    };
    await this.save(thread);
    return thread;
  }

  async save(thread: Thread): Promise<void> {
    const valid = Thread.parse({ ...thread, updatedAt: new Date().toISOString() });
    await this.withLock(thread.id, () =>
      atomicWrite(path.join(this.threadDir(thread.id), 'thread.json'), JSON.stringify(valid, null, 2)),
    );
  }

  async readEvents(id: string): Promise<Event[]> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.threadDir(id), 'events.jsonl'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => Event.parse(JSON.parse(line)));
  }

  /** Appends events and returns the index of the first appended event. */
  async appendEvents(id: string, events: Event[]): Promise<number> {
    return this.withLock(id, async () => {
      const file = path.join(this.threadDir(id), 'events.jsonl');
      const start = (await this.readEvents(id)).length;
      if (events.length > 0) {
        const lines = events.map((e) => JSON.stringify(Event.parse(e))).join('\n') + '\n';
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, lines, 'utf8');
      }
      return start;
    });
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.threadDir(id), '.lock');
    await fs.mkdir(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const stat = await fs.stat(lockDir).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for lock on thread ${id}`);
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}
