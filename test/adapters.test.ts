import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter, patchChanges, uuidv7 } from '../src/adapters/codex.js';
import type { Event } from '../src/model/thread.js';

let root: string;
const cwd = '/work/demo.app';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-adapters-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const lines = async (file: string) =>
  (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

const sample: Event[] = [
  { kind: 'user_text', text: 'add a hello script' },
  { kind: 'tool_call', callId: 'x1', name: 'Write', inputSummary: 'hello.ts' },
  { kind: 'tool_result', callId: 'x1', summary: 'created', isError: false },
  { kind: 'assistant_text', text: 'Added hello.ts.' },
];

describe('ClaudeAdapter', () => {
  const claude = () => new ClaudeAdapter({ configDir: root, version: '9.9.9' });

  it('encodes the project folder like Claude Code', () => {
    expect(encodeCwd('/Users/a/my.proj')).toBe('-Users-a-my-proj');
  });

  it('reads text, tool calls and results; skips thinking, meta and sidechains', async () => {
    const dir = path.join(root, 'projects', encodeCwd(cwd));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
        { type: 'user', message: { role: 'user', content: 'fix the bug' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret', signature: 'sig' },
              { type: 'text', text: 'Looking.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/work/demo.app/a.ts' } },
            ],
          },
        },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
        },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
        {
          type: 'assistant',
          isApiErrorMessage: true,
          message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate' }] },
        },
        { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary so far' } },
        { type: 'system', subtype: 'compact_boundary' },
      ]),
    );
    const a = claude();
    const ref = await a.detectLatest(cwd);
    expect(ref?.nativeId).toBe('s1');
    const { events, offset } = await a.read(ref!);
    expect(events.map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text',
      'tool_call',
      'file_change',
      'tool_result',
      'compact_summary',
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');

    // Incremental read picks up only what was appended.
    await writeFile(file, jsonl([{ type: 'user', message: { role: 'user', content: 'next' } }]), { flag: 'a' });
    const more = await a.read(ref!, offset);
    expect(more.events).toEqual([{ kind: 'user_text', text: 'next', ts: undefined }]);
  });

  it('writes a linked, alternating transcript in the project folder', async () => {
    const ref = await claude().write(sample, { cwd, gitBranch: 'main', brief: 'BRIEF' });
    expect(ref.path).toBe(path.join(root, 'projects', encodeCwd(cwd), `${ref.nativeId}.jsonl`));
    const recs = await lines(ref.path);
    expect(recs.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(recs[0].parentUuid).toBeNull();
    for (let i = 1; i < recs.length; i++) expect(recs[i].parentUuid).toBe(recs[i - 1].uuid);
    for (const r of recs) {
      expect(r).toMatchObject({ sessionId: ref.nativeId, cwd, version: '9.9.9', gitBranch: 'main', isSidechain: false });
    }
    expect(JSON.stringify(recs)).not.toContain('tool_use');
    expect(recs[1].message.content[0].text).toContain('▸ Write: hello.ts → ok: created');
  });

  it('round-trips its own output', async () => {
    const a = claude();
    const ref = await a.write(sample, { cwd });
    const { events } = await a.read(ref);
    expect(events.filter((e) => e.kind === 'user_text')[0]).toMatchObject({ text: 'add a hello script' });
  });
});

describe('CodexAdapter', () => {
  const codex = () => new CodexAdapter({ home: root, cliVersion: '0.159.2' });

  it('makes valid v7 uuids that sort by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('parses apply_patch file operations', () => {
    expect(patchChanges('*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** Delete File: c.ts')).toEqual([
      { kind: 'file_change', path: 'a.ts', op: 'create' },
      { kind: 'file_change', path: 'b.ts', op: 'edit' },
      { kind: 'file_change', path: 'c.ts', op: 'delete' },
    ]);
  });

  it('reads messages and tool calls; skips injected context, developer and reasoning', async () => {
    const dir = path.join(root, 'sessions', '2026', '10', '25');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-10-25T10-00-00-abc.jsonl');
    await writeFile(
      file,
      jsonl([
        { type: 'session_meta', payload: { id: 'abc', cwd, timestamp: 't0', base_instructions: 'x'.repeat(100_000) } },
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] } },
        { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'enc', summary: [] } },
        { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls","-la"]}', call_id: 'call_1' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"a.ts","metadata":{"exit_code":2}}' } },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Update File: a.ts', call_id: 'call_2' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'Done' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listed.' }] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'Listed.' } },
        { type: 'compacted', payload: { message: 'earlier summary' } },
      ]),
    );
    // A newer session in another directory must not be picked.
    await writeFile(
      path.join(dir, 'rollout-2026-10-25T11-00-00-zzz.jsonl'),
      jsonl([{ type: 'session_meta', payload: { id: 'zzz', cwd: '/elsewhere', timestamp: 't1' } }]),
    );

    const a = codex();
    const ref = await a.detectLatest(cwd);
    expect(ref?.nativeId).toBe('abc');
    const { events } = await a.read(ref!);
    expect(events.map((e) => e.kind)).toEqual([
      'user_text',
      'tool_call',
      'tool_result',
      'tool_call',
      'file_change',
      'tool_result',
      'assistant_text',
      'compact_summary',
    ]);
    expect(events[1]).toMatchObject({ inputSummary: 'ls -la' });
    expect(events[2]).toMatchObject({ summary: 'a.ts', isError: true });
    expect(events[5]).toMatchObject({ summary: 'Done', isError: false });
  });

  it('writes a minimal rollout that it can find and read back', async () => {
    const a = codex();
    const ref = await a.write(sample, { cwd, gitBranch: 'main', brief: 'BRIEF' });
    expect(path.basename(ref.path)).toMatch(new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${ref.nativeId}\\.jsonl$`));
    const recs = await lines(ref.path);
    expect(recs[0]).toMatchObject({
      type: 'session_meta',
      payload: { id: ref.nativeId, cwd, cli_version: '0.159.2', source: 'cli', originator: 'codex_cli_rs', history_mode: 'paginated' },
    });
    // Codex Desktop pages history by line number and indexes turns from these events.
    expect(recs.map((r) => r.ordinal)).toEqual(recs.map((_, i) => i));
    const messages = recs.filter((r) => r.type === 'response_item' && r.payload.type === 'message');
    expect(messages.map((r) => `${r.payload.role}:${r.payload.content[0].type}`)).toEqual([
      'user:input_text',
      'assistant:output_text',
      'user:input_text',
      'assistant:output_text',
    ]);
    const events = (t: string) => recs.filter((r) => r.type === 'event_msg' && r.payload.type === t);
    expect(events('task_started')).toHaveLength(2);
    expect(events('task_complete')).toHaveLength(2);
    expect(events('item_completed').map((r) => r.payload.item.type)).toEqual(['UserMessage', 'AgentMessage', 'UserMessage', 'AgentMessage']);
    expect(recs.filter((r) => r.type === 'turn_context')).toHaveLength(2);
    const turnIds = new Set(events('item_completed').map((r) => r.payload.turn_id));
    expect(turnIds).toEqual(new Set(events('task_started').map((r) => r.payload.turn_id)));
    expect((await a.detectLatest(cwd))?.nativeId).toBe(ref.nativeId);
    const read = await a.read(ref);
    expect(read.events.filter((e) => e.kind === 'user_text')).toHaveLength(2);
    expect(read.events[0]).toMatchObject({ kind: 'user_text', text: 'add a hello script' });
  });
});
