import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Event, Thread } from '../model/thread.js';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

export function wormholeHome(): string {
  return process.env.WORMHOLE_HOME || path.join(homedir(), '.wormhole');
}

/** Default thread id for a project directory: stable, so every tool finds the same thread. */
export function threadIdForCwd(cwd: string): string {
  return createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export class Store {
  constructor(private readonly root: string = wormholeHome(), private readonly unlocked = false) {}

  /**
   * Serialize a read/modify/write cycle. Appended events and the new thread.json are buffered,
   * then journalled as (events size before, appended text, thread.json) and applied, so a crash
   * mid-commit is replayed on the next transaction. Cost grows with the change, not the thread.
   */
  async transaction<T>(cwd: string, fn: (store: Store) => Promise<T>): Promise<T> {
    if (this.unlocked) return fn(this);
    const id = threadIdForCwd(cwd);
    return this.withLock(id, async () => {
      const dir = this.threadDir(id);
      const journal = path.join(dir, 'pending.json');
      await recover(dir, journal);
      const staged = new StagedStore(this.root);
      const result = await fn(staged);
      const change = staged.pending(id);
      if (!change) return result;
      const events = path.join(dir, 'events.jsonl');
      const base = await fs.stat(events).then((s) => s.size, (err) => {
        if (err.code === 'ENOENT') return 0;
        throw err;
      });
      let append = change.append;
      if (append && base > 0 && (await lastByte(events)) !== '\n') append = `\n${append}`;
      await atomicWrite(journal, JSON.stringify({ base, append, 'thread.json': change.thread }));
      await recover(dir, journal);
      return result;
    });
  }

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

  /**
   * Saves text in the thread's `artifacts/` directory and returns its file name.
   * Content-addressed, so the same text is written once however often it is imported.
   */
  async writeArtifact(id: string, text: string): Promise<string> {
    const name = `${createHash('sha256').update(text).digest('hex').slice(0, 32)}.txt`;
    const file = this.artifactPath(id, name);
    const exists = await fs.access(file).then(
      () => true,
      () => false,
    );
    // Tool output can hold secrets: owner-only, like the transcripts it came from.
    if (!exists) await atomicWrite(file, text, 0o600);
    return name;
  }

  artifactPath(id: string, name: string): string {
    return path.join(this.threadDir(id), 'artifacts', name);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.unlocked) return fn();
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
    const heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(lockDir, now, now).catch(() => {});
    }, 5000);
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }
}

/** Changes a transaction made, held back until it commits. */
class StagedStore extends Store {
  private readonly threads = new Map<string, Thread>();
  private readonly appended = new Map<string, Event[]>();
  private readonly committed = new Map<string, number>();

  constructor(root: string) {
    super(root, true);
  }

  override async load(id: string): Promise<Thread | null> {
    return structuredClone(this.threads.get(id)) ?? super.load(id);
  }

  override async save(thread: Thread): Promise<void> {
    this.threads.set(thread.id, Thread.parse({ ...thread, updatedAt: new Date().toISOString() }));
  }

  override async readEvents(id: string): Promise<Event[]> {
    const on = await super.readEvents(id);
    this.committed.set(id, on.length);
    return [...on, ...(this.appended.get(id) ?? [])];
  }

  override async appendEvents(id: string, events: Event[]): Promise<number> {
    const committed = this.committed.get(id) ?? (await super.readEvents(id)).length;
    this.committed.set(id, committed);
    const list = this.appended.get(id) ?? [];
    const start = committed + list.length;
    list.push(...events.map((e) => Event.parse(e)));
    this.appended.set(id, list);
    return start;
  }

  pending(id: string): { append: string; thread: string | null } | null {
    const events = this.appended.get(id) ?? [];
    const thread = this.threads.get(id);
    if (events.length === 0 && !thread) return null;
    return {
      append: events.map((e) => `${JSON.stringify(e)}\n`).join(''),
      thread: thread ? JSON.stringify(thread, null, 2) : null,
    };
  }
}

/** Apply a journalled commit, if one is waiting. Safe to repeat. */
async function recover(dir: string, journal: string): Promise<void> {
  const raw = await fs.readFile(journal, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!raw) return;
  const data = JSON.parse(raw) as { base?: number; append?: string; 'events.jsonl'?: string; 'thread.json'?: string | null };
  const events = path.join(dir, 'events.jsonl');
  if (data.base !== undefined) {
    if (data.append) {
      const handle = await fs.open(events, 'a+');
      try {
        await handle.truncate(data.base);
        await handle.write(data.append, data.base, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } else if (data['events.jsonl'] !== undefined) {
    // Journal from an older wormhole: whole files.
    await atomicWrite(events, data['events.jsonl']);
  }
  if (data['thread.json']) await atomicWrite(path.join(dir, 'thread.json'), data['thread.json']);
  await fs.rm(journal);
}

async function lastByte(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode });
  await fs.rename(tmp, file);
}
