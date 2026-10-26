import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { KEEP_MAX, toTurns } from '../src/adapters/render.js';
import { type Context, switchTo, sync } from '../src/core.js';
import { Event } from '../src/model/thread.js';
import { Store, threadIdForCwd } from '../src/store/store.js';

let root: string;
let c: Context;

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const artifactsDir = () => path.join(root, 'wormhole', 'threads', threadIdForCwd(c.cwd), 'artifacts');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-artifacts-'));
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

/** A Claude session whose one tool call prints `output`. */
async function claudeSession(id: string, output: string, command = 'cat big.log') {
  const dir = path.join(root, 'claude', 'projects', encodeCwd(c.cwd));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(
    file,
    jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'show the log' } },
      {
        type: 'assistant',
        uuid: 'u2',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }] },
      },
      { type: 'assistant', uuid: 'u4', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]),
  );
  return file;
}

const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');

describe('artifacts', () => {
  it('saves long tool output once in full and keeps a cut copy in the event', async () => {
    await claudeSession('c1', long);
    const { thread } = await sync(c);

    const events = await c.store.readEvents(thread.id);
    const result = events.find((e) => e.kind === 'tool_result');
    expect(result?.kind).toBe('tool_result');
    if (result?.kind !== 'tool_result') return;
    expect(result.summary.length).toBeLessThan(long.length);
    expect(result.summary).toContain(`[truncated ${long.length - KEEP_MAX} chars]`);
    expect(result.artifact).toMatch(/^[0-9a-f]{32}\.txt$/);
    expect(await readFile(path.join(artifactsDir(), result.artifact!), 'utf8')).toBe(long);

    // Short text is stored whole, with no artifact.
    const call = events.find((e) => e.kind === 'tool_call');
    expect(call).toMatchObject({ inputSummary: 'cat big.log' });
    expect(call && 'artifact' in call ? call.artifact : undefined).toBeUndefined();
  });

  it('cuts a long tool input too', async () => {
    const command = `echo ${'x'.repeat(KEEP_MAX + 10)}`;
    await claudeSession('c1', 'ok', command);
    const { thread } = await sync(c);
    const call = (await c.store.readEvents(thread.id)).find((e) => e.kind === 'tool_call');
    expect(call?.kind === 'tool_call' && call.artifact).toBeTruthy();
    if (call?.kind !== 'tool_call') return;
    expect(await readFile(path.join(artifactsDir(), call.artifact!), 'utf8')).toBe(command);
  });

  it('does not duplicate artifacts when the same text is imported again', async () => {
    await claudeSession('c1', long);
    await sync(c);
    // A second session in the thread carrying the same output.
    const file = await claudeSession('c2', long);
    const t = new Date(Date.now() + 5000);
    await utimes(file, t, t);
    const { imported } = await sync(c);
    expect(imported).toMatchObject([{ nativeId: 'c2', isNew: true }]);
    await sync(c);

    expect(await readdir(artifactsDir())).toHaveLength(1);
  });

  it('still reads events recorded before artifacts existed', () => {
    const old = { kind: 'tool_result', callId: 'c1', summary: 'ok', isError: false, src: 'claude:x' };
    expect(Event.parse(old)).toEqual(old);
    expect(Event.parse({ kind: 'tool_call', callId: 'c1', name: 'Bash', inputSummary: 'ls' })).not.toHaveProperty('artifact');
  });

  it('points the rendered line at the full text', () => {
    const turns = toTurns([
      { kind: 'tool_call', callId: 'c1', name: 'Bash', inputSummary: 'echo …', artifact: '/w/artifacts/in.txt' },
      { kind: 'tool_result', callId: 'c1', summary: 'big', isError: false, artifact: '/w/artifacts/out.txt' },
    ]);
    expect(turns[1]!.text).toBe('▸ Bash: echo … (full input: /w/artifacts/in.txt) → ok: big (full output: /w/artifacts/out.txt)');
  });

  it('writes the absolute artifact path into the handed-off session', async () => {
    await claudeSession('c1', long);
    const { ref } = await switchTo(c, 'codex');
    const rollout = await readFile(ref.path, 'utf8');
    const [name] = await readdir(artifactsDir());
    // The rollout is JSON: compare against the path as JSON writes it (backslashes doubled on Windows).
    expect(rollout).toContain(`(full output: ${JSON.stringify(path.join(artifactsDir(), name!)).slice(1, -1)})`);
  });
});
