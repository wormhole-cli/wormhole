import { mkdtemp, rm } from 'node:fs/promises';
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
