import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { type Context, switchTo, sync } from '../src/core.js';
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
    expect(toCodex.reused).toBe(false);
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

  it('resumes in place when the target already holds the active session', async () => {
    await claudeSession('c1', [user('hi'), reply('hello')]);
    const r = await switchTo(c, 'claude');
    expect(r).toMatchObject({ reused: true, ref: { nativeId: 'c1' } });
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
