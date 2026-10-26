import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { IdGen, type OcSession, type OpencodeCli, OpencodeAdapter } from '../src/adapters/opencode.js';
import { type Context, switchTo } from '../src/core.js';
import { Store } from '../src/store/store.js';

/** In-memory stand-in for the opencode CLI: import upserts by id, export deep-copies. */
class FakeCli implements OpencodeCli {
  sessions = new Map<string, OcSession>();
  async list(_cwd: string) {
    return [...this.sessions.values()].map((s) => ({
      id: s.info.id,
      directory: s.info.directory!,
      projectId: s.info.projectID,
      created: s.info.time!.created,
      updated: s.info.time!.updated,
    }));
  }
  async export(_cwd: string, id: string) {
    const s = this.sessions.get(id);
    return s ? (structuredClone(s) as OcSession) : null;
  }
  async import(_cwd: string, session: OcSession) {
    this.sessions.set(session.info.id, structuredClone(session));
  }
}

let root: string;
let cwd: string;
let cli: FakeCli;
let oc: OpencodeAdapter;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-oc-'));
  cwd = path.join(root, 'project');
  await mkdir(cwd);
  cli = new FakeCli();
  oc = new OpencodeAdapter({ cli, model: 'prov/model-1', version: '1.19.0' });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const T = 1_791_781_134_730;
function session(id: string, messages: OcSession['messages'], updated = T): OcSession {
  return { info: { id, directory: cwd, projectID: 'global', time: { created: T, updated } }, messages };
}
const userMsg = (id: string, text: string) => ({
  info: { id, role: 'user' as const, time: { created: T } },
  parts: [{ id: `${id}p`, type: 'text', text }],
});

describe('IdGen', () => {
  it('matches the ids opencode itself writes', () => {
    expect(new IdGen(1_791_781_134_730).next('msg').slice(0, 16)).toBe('msg_12e7a618a001');
    expect(new IdGen(1_791_781_134_694).next('ses', true).slice(0, 16)).toBe('ses_ed1859e99ffe');
  });

  it('sorts in creation order', () => {
    const g = new IdGen();
    const a = g.next('msg');
    const b = g.next('msg');
    expect(a < b).toBe(true);
    expect(a).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});

describe('OpencodeAdapter', () => {
  it('reads text and tool parts, and stops before an unfinished reply', async () => {
    cli.sessions.set(
      'ses_1',
      session('ses_1', [
        userMsg('msg_1', 'fix the build'),
        {
          info: { id: 'msg_2', role: 'assistant', time: { created: T, completed: T + 1 } },
          parts: [
            { id: 'p1', type: 'step-start' },
            { id: 'p2', type: 'reasoning', text: 'secret thoughts' },
            { id: 'p3', type: 'text', text: 'Looking.' },
            {
              id: 'p4',
              type: 'tool',
              tool: 'bash',
              callID: 'call_a',
              state: { status: 'completed', input: { command: 'npm run build' }, output: 'boom', metadata: { exit: 1 } },
            },
            { id: 'p5', type: 'tool', tool: 'edit', callID: 'call_b', state: { status: 'completed', input: { filePath: '/p/a.ts' }, output: 'ok' } },
          ],
        },
        { info: { id: 'msg_3', role: 'assistant', summary: true, mode: 'compaction', time: { created: T, completed: T } }, parts: [{ id: 'p6', type: 'text', text: 'so far' }] },
        userMsg('msg_4', 'continue'),
        { info: { id: 'msg_5', role: 'assistant', time: { created: T } }, parts: [{ id: 'p7', type: 'text', text: 'still typing' }] },
      ]),
    );
    const ref = await oc.detectLatest(cwd);
    expect(ref?.nativeId).toBe('ses_1');
    const { events, offset } = await oc.read(ref!);
    expect(offset).toBe(4);
    expect(events.map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text',
      'tool_call',
      'tool_result',
      'tool_call',
      'file_change',
      'tool_result',
      'compact_summary',
      'user_text',
    ]);
    expect(events[3]).toMatchObject({ summary: 'boom', isError: true });
    expect(JSON.stringify(events)).not.toContain('secret thoughts');
    expect((await oc.read(ref!, offset)).events).toEqual([]);
  });

  it('writes an importable session with linked, ordered messages', async () => {
    const ref = await oc.write(
      [
        { kind: 'user_text', text: 'hello there' },
        { kind: 'assistant_text', text: 'hi' },
      ],
      { cwd, brief: 'BRIEF' },
    );
    const s = cli.sessions.get(ref.nativeId)!;
    expect(s.info).toMatchObject({ directory: cwd, title: 'hello there (wormhole)' });
    expect(s.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const ids = s.messages.map((m) => m.info.id);
    expect([...ids].sort()).toEqual(ids);
    expect(s.messages[1]!.info).toMatchObject({ parentID: ids[0], providerID: 'prov', modelID: 'model-1', finish: 'stop' });
    expect(s.messages[0]!.info.model).toEqual({ providerID: 'prov', modelID: 'model-1' });
    expect(ref.offset).toBe(4);
    expect((await oc.detectLatest(cwd))?.nativeId).toBe(ref.nativeId);
  });

  it('extends a copy with fresh ids and closes unfinished tool calls', async () => {
    cli.sessions.set(
      'ses_orig',
      session('ses_orig', [
        userMsg('msg_1', 'start here'),
        {
          info: { id: 'msg_2', role: 'assistant', parentID: 'msg_1', providerID: 'acme', modelID: 'model-1', time: { created: T, completed: T } },
          parts: [{ id: 'p1', type: 'tool', tool: 'bash', callID: 'c', state: { status: 'running', input: { command: 'sleep 9' } } }],
        },
      ]),
    );
    const before = JSON.stringify(cli.sessions.get('ses_orig'));
    const base = (await oc.locate(cwd, 'ses_orig'))!;
    const ref = await oc.extend(base, [{ kind: 'assistant_text', text: 'claude did X' }], { cwd, brief: 'BRIEF' });

    expect(JSON.stringify(cli.sessions.get('ses_orig'))).toBe(before);
    const copy = cli.sessions.get(ref.nativeId)!;
    expect(JSON.stringify(copy)).not.toMatch(/ses_orig|"msg_1"|"msg_2"|"p1"/);
    expect(copy.messages[1]!.info.parentID).toBe(copy.messages[0]!.info.id);
    expect(copy.messages[1]!.parts[0]!.state).toMatchObject({ status: 'error' });
    const added = copy.messages.slice(2);
    expect(added.map((m) => m.parts[0]!.text)).toEqual([
      '[The conversation continued in another tool:]',
      'claude did X',
      'BRIEF',
      'Understood. I have the context above and am ready to continue.',
    ]);
    // New replies keep the model the session was using.
    expect(added[1]!.info).toMatchObject({ providerID: 'acme', modelID: 'model-1' });
  });
});

describe('switching with opencode', () => {
  it('goes Claude → opencode → Claude, carrying opencode turns back', async () => {
    const claude = new ClaudeAdapter({ configDir: path.join(root, 'claude'), version: '9.9.9' });
    const ctx: Context = { cwd, store: new Store(path.join(root, 'wh')), adapters: { claude, opencode: oc } };
    const dir = path.join(root, 'claude', 'projects', encodeCwd(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'c1.jsonl'),
      [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'plan the release' } },
        { type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Plan ready.' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );

    const toOc = await switchTo(ctx, 'opencode');
    expect(toOc.mode).toBe('synthesized');

    // Work continues in opencode, later than anything in Claude.
    const s = cli.sessions.get(toOc.ref.nativeId)!;
    s.messages.push(userMsg('msg_zz1', 'ship it'), {
      info: { id: 'msg_zz2', role: 'assistant', time: { created: T, completed: T } },
      parts: [{ id: 'pz', type: 'text', text: 'Shipped v2.' }],
    });
    s.info.time!.updated = Date.now() + 60_000;

    const back = await switchTo(ctx, 'claude');
    expect(back).toMatchObject({ mode: 'extended', base: { nativeId: 'c1' } });
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(back.ref.path, 'utf8');
    expect(text).toContain('ship it');
    expect(text).toContain('Shipped v2.');
  });
});
