import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { sync, switchTo, type Context } from '../src/core.js';
import { importFromHook } from '../src/hooks/handle.js';
import { findNotify, withCodexNotify, withoutCodexNotify } from '../src/hooks/install.js';
import { Store } from '../src/store/store.js';

let root: string;
let cwd: string;
const jsonl = (rs: unknown[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n';
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'wh-review-')); cwd = root; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('serializes overlapping hook imports and switches without duplicating history', async () => {
  const claude = new ClaudeAdapter({ configDir: path.join(root, 'claude'), version: '1.0.0' });
  const ref = await claude.write([{ kind: 'user_text', text: 'exactly once' }], { cwd });
  const c: Context = { cwd, store: new Store(path.join(root, 'wh')), adapters: { claude, codex: new CodexAdapter({ home: path.join(root, 'codex'), cliVersion: '1.0.0' }) } };
  await c.store.loadOrCreateForCwd(cwd);
  await Promise.all([
    importFromHook({ tool: 'claude', cwd, session: ref.nativeId }, c),
    switchTo(c, 'codex'),
    sync(c),
  ]);
  const thread = (await c.store.loadForCwd(cwd))!;
  expect(await c.store.readEvents(thread.id)).toHaveLength(1);
  expect(thread.segments.map(s => s.tool)).toEqual(['claude', 'codex']);
});

it('rolls back a failed update before publishing either file', async () => {
  const store = new Store(path.join(root, 'wh'));
  const thread = await store.loadOrCreateForCwd(cwd);
  await expect(store.transaction(cwd, async staged => {
    await staged.appendEvents(thread.id, [{ kind: 'user_text', text: 'uncommitted' }]);
    throw new Error('interrupted');
  })).rejects.toThrow('interrupted');
  expect(await store.readEvents(thread.id)).toEqual([]);
});

it('replays an interrupted two-file commit before reading the next cursor', async () => {
  const store = new Store(path.join(root, 'wh'));
  const thread = await store.loadOrCreateForCwd(cwd);
  const committed = { ...thread, title: 'recovered' };
  const events = jsonl([{ kind: 'user_text', text: 'committed once' }]);
  await writeFile(path.join(store.threadDir(thread.id), 'pending.json'), JSON.stringify({ 'thread.json': JSON.stringify(committed), 'events.jsonl': events }));
  // Simulate a crash after only the events file reached its new version.
  await writeFile(path.join(store.threadDir(thread.id), 'events.jsonl'), events);
  await store.transaction(cwd, async staged => {
    expect((await staged.loadForCwd(cwd))!.title).toBe('recovered');
    expect(await staged.readEvents(thread.id)).toHaveLength(1);
  });
  expect(await store.readEvents(thread.id)).toHaveLength(1);
  await expect(readFile(path.join(store.threadDir(thread.id), 'pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('finds a resumed sixth Codex session by mtime', async () => {
  const adapter = new CodexAdapter({ home: root });
  const dir = path.join(root, 'sessions/2026/01/01'); await mkdir(dir, { recursive: true });
  for (let i = 1; i <= 6; i++) {
    const file = path.join(dir, `rollout-2026-01-01T00-00-0${i}-id${i}.jsonl`);
    await writeFile(file, jsonl([{ type: 'session_meta', payload: { id: `id${i}`, cwd, timestamp: 't' } }]));
    await utimes(file, i === 1 ? 2000 : 1000 + i, i === 1 ? 2000 : 1000 + i);
  }
  expect((await adapter.detectLatest(cwd))!.nativeId).toBe('id1');
});

it('locates an explicit session beyond 1000 unrelated rollouts', async () => {
  const adapter = new CodexAdapter({ home: root });
  const dir = path.join(root, 'sessions/2026/01/01'); await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(path.join(dir, `rollout-z${i}-other.jsonl`), '{}\n')));
  await writeFile(path.join(dir, 'rollout-a-target.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'target', cwd, timestamp: 't' } }]));
  expect((await adapter.locate(cwd, 'target'))!.nativeId).toBe('target');
});

it('preserves notify argv with comments, multiline arrays and TOML escapes', () => {
  const original = `notify = [\n "notifier", # "not an argument"\n 'literal#value',\n "\\U0001F680",\n "a\\tb",\n] # "another comment"\n[other]\nx = 1\n`;
  const self = ['node', '/repo/wormhole.js'];
  const installed = withCodexNotify(original, self);
  const expected = [...self, 'hook', 'codex', '--then', 'notifier', 'literal#value', '🚀', 'a\tb'];
  expect(findNotify(installed.split('\n'))!.argv).toEqual(expected);
  expect(findNotify(withoutCodexNotify(installed).split('\n'))!.argv).toEqual(expected.slice(5));
  expect(installed).toContain('[other]\nx = 1');
  expect(withCodexNotify(installed, self)).toBe(installed);
});

it('rejects unsupported notify values instead of silently dropping them', () => {
  expect(() => withCodexNotify('notify = [42]\n', ['node', 'wormhole.js'])).toThrow();
});

it('imports and extends only the selected Claude ancestry, preserving literal ids', async () => {
  const adapter = new ClaudeAdapter({ configDir: root, version: '1.0.0' });
  const dir = adapter.projectDir(cwd); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'original.jsonl');
  await writeFile(file, jsonl([
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'original', message: { role: 'user', content: 'original must stay literal' } },
    { type: 'assistant', uuid: 'abandoned', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'Bash', input: {} }] } },
    { type: 'assistant', uuid: 'selected', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'selected reply' }] } },
    { type: 'last-prompt', leafUuid: 'selected' },
  ]));
  const ref = (await adapter.locate(cwd, 'original'))!;
  const first = await adapter.read(ref);
  expect(first.events.map(e => e.kind)).toEqual(['user_text', 'assistant_text']);
  expect(JSON.stringify(first.events)).not.toContain('orphan');
  await appendFile(file, jsonl([{ type: 'user', uuid: 'next', parentUuid: 'selected', message: { role: 'user', content: 'delta' } }]));
  expect((await adapter.read(ref, first.offset)).events).toMatchObject([{ kind: 'user_text', text: 'delta' }]);
  const copy = await adapter.extend(ref, [{ kind: 'user_text', text: 'foreign work' }], { cwd });
  const records = (await readFile(copy.path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(records[0].sessionId).toBe(copy.nativeId);
  expect(records[0].message.content).toBe('original must stay literal');
  expect(records.some(r => r.uuid === 'abandoned')).toBe(false);
  expect(records.find(r => r.message?.content === 'foreign work').parentUuid).not.toBe('abandoned');
  expect(JSON.stringify(records)).not.toContain('tool_result');
});

it('changes Codex metadata references without rewriting messages or tool output', async () => {
  const adapter = new CodexAdapter({ home: root, cliVersion: '1.0.0' });
  const ref = await adapter.write([{ kind: 'user_text', text: 'start' }], { cwd });
  await appendFile(ref.path, jsonl([
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `literal ${ref.nativeId}` }] } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x', output: ref.nativeId } },
    { type: 'turn_context', payload: { session_id: ref.nativeId, thread_id: ref.nativeId } },
  ]));
  const copy = await adapter.extend(ref, [{ kind: 'user_text', text: 'delta' }], { cwd });
  const records = (await readFile(copy.path, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(records[0].payload.id).toBe(copy.nativeId);
  expect(records[2].payload.content[0].text).toBe(`literal ${ref.nativeId}`);
  expect(records[3].payload.output).toBe(ref.nativeId);
  expect(records[4].payload).toEqual({ session_id: copy.nativeId, thread_id: copy.nativeId });
});
