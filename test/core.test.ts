import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { type Context, missingFrom, switchTo, sync } from '../src/core.js';
import { latestTodos, touchedFiles } from '../src/handoff/brief.js';
import { Store } from '../src/store/store.js';

let root: string;
let c: Context;

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const text = async (file: string) => readFile(file, 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-core-'));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  c = {
    cwd,
    store: new Store(path.join(root, 'wormhole')),
    adapters: {
      claude: new ClaudeAdapter({ configDir: path.join(root, 'claude'), version: '9.9.9' }),
      codex: new CodexAdapter({ home: path.join(root, 'codex'), cliVersion: '0.159.2' }),
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function claudeSession(id: string, records: unknown[]) {
  const dir = path.join(root, 'claude', 'projects', encodeCwd(c.cwd));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, jsonl(records));
  return file;
}

const user = (t: string) => ({ type: 'user', message: { role: 'user', content: t } });
const reply = (t: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const later = (file: string, secondsAhead: number) => {
  const t = new Date(Date.now() + secondsAhead * 1000);
  return utimes(file, t, t);
};

describe('switchTo', () => {
  it('hands a Claude session to Codex and back, carrying both sides', async () => {
    await claudeSession('c1', [user('build the parser'), reply('Parser done.')]);

    const toCodex = await switchTo(c, 'codex');
    expect(toCodex.mode).toBe('synthesized');
    expect(toCodex.from).toMatchObject({ tool: 'claude', nativeId: 'c1' });
    const rollout = await text(toCodex.ref.path);
    expect(rollout).toContain('build the parser');
    expect(rollout).toContain('started in Claude Code');

    // Work continues in Codex: it appends turns to the same rollout.
    await appendFile(
      toCodex.ref.path,
      jsonl([
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now add tests' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests added.' }] } },
      ]),
    );
    await later(toCodex.ref.path, 5);

    const toClaude = await switchTo(c, 'claude');
    expect(toClaude.from).toMatchObject({ tool: 'codex', nativeId: toCodex.ref.nativeId });
    expect(toClaude).toMatchObject({ mode: 'extended', base: { nativeId: 'c1' } });
    const transcript = await text(toClaude.ref.path);
    for (const s of ['build the parser', 'Parser done.', 'now add tests', 'Tests added.']) {
      expect(transcript).toContain(s);
    }
    // The synthesized prefix must not be imported twice.
    expect(transcript.match(/build the parser/g)).toHaveLength(2); // once in history, once as the brief's goal

    const thread = (await c.store.loadForCwd(c.cwd))!;
    expect(thread.segments.map((s) => s.tool)).toEqual(['claude', 'codex', 'claude']);
    expect(await c.store.readEvents(thread.id)).toHaveLength(4);
  });

  it('keeps native tool calls when switching back, and adds only the other side', async () => {
    const original = await claudeSession('c1', [
      user('list files'),
      {
        type: 'assistant',
        uuid: 'u2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_keep', name: 'Bash', input: { command: 'ls' } }] },
      },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_keep', content: 'a.ts' }] } },
      { ...reply('One file.'), uuid: 'u4', parentUuid: 'u3' },
    ]);
    const before = await text(original);

    const toCodex = await switchTo(c, 'codex');
    await appendFile(
      toCodex.ref.path,
      jsonl([{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex was here' }] } }]),
    );
    await later(toCodex.ref.path, 5);
    const back = await switchTo(c, 'claude');

    expect(await text(original)).toBe(before);
    const recs = (await text(back.ref.path)).trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.every((r) => r.sessionId === undefined || r.sessionId === back.ref.nativeId)).toBe(true);
    expect(JSON.stringify(recs)).toContain('toolu_keep');
    const added = recs.slice(4);
    expect(added[0].parentUuid).toBe('u4');
    expect(added.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(added)).toContain('codex was here');
    // The Claude turns themselves are not repeated in the appended part.
    expect(JSON.stringify(added)).not.toContain('One file.');
  });

  it('closes a tool call the original session left open', async () => {
    await claudeSession('c1', [
      user('run it'),
      { type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_open', name: 'Bash', input: {} }] } },
    ]);
    const toCodex = await switchTo(c, 'codex');
    await later(toCodex.ref.path, 5);
    const back = await switchTo(c, 'claude');
    const recs = (await text(back.ref.path)).trim().split('\n').map((l) => JSON.parse(l));
    expect(recs[2].message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_open', is_error: true });
  });

  it('extends a Codex session too, numbering lines when the original does', async () => {
    const dir = path.join(root, 'codex', 'sessions', '2026', '10', '25');
    await mkdir(dir, { recursive: true });
    const id = '01a17000-0000-7000-8000-000000000001';
    const rollout = path.join(dir, `rollout-2026-10-25T10-00-00-${id}.jsonl`);
    await writeFile(
      rollout,
      jsonl([
        { ordinal: 0, type: 'session_meta', payload: { id, cwd: c.cwd, timestamp: 't0' } },
        { ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start in codex' }] } },
        { ordinal: 2, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'call_open' } },
      ]),
    );
    const toClaude = await switchTo(c, 'claude');
    await appendFile(toClaude.ref.path, jsonl([reply('claude was here')]));
    await later(toClaude.ref.path, 5);

    const back = await switchTo(c, 'codex');
    expect(back).toMatchObject({ mode: 'extended', base: { nativeId: id } });
    const lines = (await text(back.ref.path)).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].payload.id).toBe(back.ref.nativeId);
    expect(lines.map((l) => l.ordinal)).toEqual(lines.map((_, i) => i));
    expect(lines[3].payload).toMatchObject({ type: 'function_call_output', call_id: 'call_open' });
    // Only Claude's turn is added before the brief; Codex's own history is not repeated.
    expect(lines[4].payload.content[0].text).toBe('[The conversation continued in another tool:]');
    expect(lines[5].payload.content[0].text).toBe('claude was here');
    expect(lines[6].payload.content[0].text).toContain('back in this session after work continued in Claude Code');
  });

  it('falls back to a full session for threads recorded before source tagging', () => {
    const seg = { tool: 'claude' as const, nativeId: 'a', path: '', startedAt: '', importedUpTo: 0, eventStart: 0 };
    expect(missingFrom(seg, [{ kind: 'user_text', text: 'x' }])).toBeNull();
    expect(
      missingFrom(seg, [
        { kind: 'user_text', text: 'mine', src: 'claude:a' },
        { kind: 'user_text', text: 'theirs', src: 'codex:b' },
      ]),
    ).toEqual([{ kind: 'user_text', text: 'theirs', src: 'codex:b' }]);
  });

  it('resumes in place when the target already holds the active session', async () => {
    await claudeSession('c1', [user('hi'), reply('hello')]);
    const r = await switchTo(c, 'claude');
    expect(r).toMatchObject({ mode: 'resumed', ref: { nativeId: 'c1' } });
  });

  it('fails clearly when there is nothing to hand off', async () => {
    await expect(switchTo(c, 'codex')).rejects.toThrow(/no Claude Code or Codex session/);
  });
});

describe('sync', () => {
  it('adopts only the session in use, then imports incrementally', async () => {
    const old = await claudeSession('old', [user('unrelated old work')]);
    const cur = await claudeSession('cur', [user('current work')]);
    await later(old, -60);

    const first = await sync(c);
    expect(first.active?.nativeId).toBe('cur');
    expect(first.imported).toEqual([{ tool: 'claude', nativeId: 'cur', events: 1, isNew: true }]);

    await appendFile(cur, jsonl([reply('ok')]));
    const second = await sync(c);
    expect(second.imported).toEqual([{ tool: 'claude', nativeId: 'cur', events: 1, isNew: false }]);
    expect(await c.store.readEvents(second.thread.id)).toHaveLength(2);

    expect((await sync(c)).imported).toEqual([]);
  });

  it('imports an explicitly named session', async () => {
    await claudeSession('a', [user('first')]);
    const b = await claudeSession('b', [user('second')]);
    await later(b, 60);
    const r = await sync(c, { tool: 'claude', session: 'a' });
    expect(r.active?.nativeId).toBe('a');
    await expect(sync(c, { tool: 'claude', session: 'missing' })).rejects.toThrow(/no claude session missing/);
  });
});

describe('brief helpers', () => {
  it('lists unfinished todos from the latest TodoWrite or update_plan', () => {
    expect(
      latestTodos([
        { kind: 'tool_call', callId: '1', name: 'TodoWrite', inputSummary: '{"todos":[{"content":"old","status":"pending"}]}' },
        {
          kind: 'tool_call',
          callId: '2',
          name: 'update_plan',
          inputSummary: '{"plan":[{"step":"a","status":"completed"},{"step":"b","status":"in_progress"},{"step":"c","status":"pending"}]}',
        },
      ]),
    ).toEqual(['- [~] b', '- [ ] c']);
  });

  it('lists touched files newest first without duplicates', () => {
    expect(
      touchedFiles([
        { kind: 'file_change', path: 'a.ts', op: 'edit' },
        { kind: 'file_change', path: 'b.ts', op: 'create' },
        { kind: 'file_change', path: 'a.ts', op: 'edit' },
        { kind: 'file_change', path: 'c.ts', op: 'delete' },
      ]),
    ).toEqual(['c.ts (deleted)', 'a.ts', 'b.ts']);
  });
});
