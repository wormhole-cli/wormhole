import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, threadIdForCwd } from '../src/store/store.js';

let root: string;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-test-'));
  store = new Store(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Store', () => {
  it('gives the same thread id for the same directory', () => {
    expect(threadIdForCwd('/a/b')).toBe(threadIdForCwd('/a/b/'));
    expect(threadIdForCwd('/a/b')).not.toBe(threadIdForCwd('/a/c'));
  });

  it('creates a thread once and reloads it', async () => {
    const t1 = await store.loadOrCreateForCwd('/proj/demo');
    const t2 = await store.loadOrCreateForCwd('/proj/demo');
    expect(t2.id).toBe(t1.id);
    expect(t2.title).toBe('demo');
  });

  it('appends events and reports where each batch starts', async () => {
    const t = await store.loadOrCreateForCwd('/proj/demo');
    expect(await store.appendEvents(t.id, [{ kind: 'user_text', text: 'hi' }])).toBe(0);
    const start = await store.appendEvents(t.id, [
      { kind: 'assistant_text', text: 'hello' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', inputSummary: 'ls' },
    ]);
    expect(start).toBe(1);
    expect(await store.readEvents(t.id)).toHaveLength(3);
  });

  it('serialises concurrent appends', async () => {
    const t = await store.loadOrCreateForCwd('/proj/demo');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.appendEvents(t.id, [{ kind: 'user_text', text: `m${i}` }])),
    );
    expect(await store.readEvents(t.id)).toHaveLength(10);
  });

  it('records segments', async () => {
    const t = await store.loadOrCreateForCwd('/proj/demo');
    t.segments.push({
      tool: 'claude',
      nativeId: 'abc',
      path: '/x.jsonl',
      startedAt: new Date().toISOString(),
      importedUpTo: 0,
      eventStart: 0,
    });
    await store.save(t);
    expect((await store.load(t.id))?.segments).toHaveLength(1);
  });
});

describe('Store.transaction', () => {
  const cwd = '/proj/tx';
  const file = (name: string) => path.join(store.threadDir(threadIdForCwd(cwd)), name);

  it('stages appends and thread changes until it commits', async () => {
    const t = await store.loadOrCreateForCwd(cwd);
    await store.appendEvents(t.id, [{ kind: 'user_text', text: 'one' }]);
    await store.transaction(cwd, async (tx) => {
      expect(await tx.appendEvents(t.id, [{ kind: 'assistant_text', text: 'two' }])).toBe(1);
      expect(await tx.appendEvents(t.id, [{ kind: 'user_text', text: 'three' }])).toBe(2);
      expect((await tx.readEvents(t.id)).map((e) => e.kind)).toEqual(['user_text', 'assistant_text', 'user_text']);
      await tx.save({ ...(await tx.load(t.id))!, title: 'renamed' });
      expect((await tx.load(t.id))!.title).toBe('renamed');
      // Nothing reaches disk before the commit.
      expect(await store.readEvents(t.id)).toHaveLength(1);
      expect((await store.load(t.id))!.title).toBe('tx');
    });
    expect(await store.readEvents(t.id)).toHaveLength(3);
    expect((await store.load(t.id))!.title).toBe('renamed');
    await expect(stat(file('pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes nothing when nothing changed', async () => {
    const t = await store.loadOrCreateForCwd(cwd);
    const before = await stat(file('thread.json'));
    expect(await store.transaction(cwd, async (tx) => (await tx.readEvents(t.id)).length)).toBe(0);
    expect((await stat(file('thread.json'))).mtimeMs).toBe(before.mtimeMs);
    await expect(stat(file('events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds a missing final newline before appending', async () => {
    const t = await store.loadOrCreateForCwd(cwd);
    await writeFile(file('events.jsonl'), JSON.stringify({ kind: 'user_text', text: 'one' }));
    await store.transaction(cwd, (tx) => tx.appendEvents(t.id, [{ kind: 'user_text', text: 'two' }]));
    expect((await store.readEvents(t.id)).map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
  });

  it('replays a commit that crashed halfway through the append', async () => {
    const t = await store.loadOrCreateForCwd(cwd);
    await store.appendEvents(t.id, [{ kind: 'user_text', text: 'one' }]);
    const base = (await stat(file('events.jsonl'))).size;
    const append = `${JSON.stringify({ kind: 'assistant_text', text: 'two' })}\n`;
    const thread = JSON.stringify({ ...t, title: 'committed' });
    await writeFile(file('pending.json'), JSON.stringify({ base, append, 'thread.json': thread }));
    await appendFile(file('events.jsonl'), append.slice(0, 10)); // torn write
    await store.transaction(cwd, async (tx) => {
      expect((await tx.readEvents(t.id)).map((e) => e.kind)).toEqual(['user_text', 'assistant_text']);
      expect((await tx.load(t.id))!.title).toBe('committed');
    });
    expect(await readFile(file('events.jsonl'), 'utf8')).toMatch(/"two"\}\n$/);
    await expect(stat(file('pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
