import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAccount, keyOf, loadAccounts, loadFile, removeAccount, setAuto, setFallback } from '../src/accounts.js';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { type Deps, main } from '../src/cli.js';
import { type Context, switchTo, sync } from '../src/core.js';
import { fallbackNote, fallbackOrder, pickFallback } from '../src/fallback.js';
import { fallbackFromHook } from '../src/hooks/handle.js';
import { Store } from '../src/store/store.js';
import {
  claudeReply,
  claudeTrailer,
  claudeUsageLimit,
  claudeUser,
  codexMeta,
  codexReply,
  codexTokenCount,
  codexUser,
  jsonl,
  win,
} from './fixtures/limits.js';

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

const dir = (name: string) => path.join(root, name);
/** Resets far ahead, so these sessions stay limited whenever the tests run. */
const FUTURE = '2099-01-01T00:00:00.000Z';

function context(at = cwd): Context {
  const adapters: Context['adapters'] = {
    claude: new ClaudeAdapter({ configDir: dir('claude'), version: '9.9.9' }),
    codex: new CodexAdapter({ home: dir('codex'), cliVersion: '0.159.2' }),
  };
  for (const a of loadAccounts()) {
    adapters[keyOf(a.tool, a.name)] =
      a.tool === 'claude'
        ? new ClaudeAdapter({ configDir: a.dir, account: a.name, version: '9.9.9' })
        : new CodexAdapter({ home: a.dir, account: a.name, cliVersion: '0.159.2' });
  }
  return { cwd: at, store: new Store(dir('wh')), adapters };
}

/** A Claude session in `configDir`, ending on the usage limit when `limited`. */
async function claudeSession(configDir: string, id: string, limited: boolean, secondsAhead = 0) {
  const folder = path.join(configDir, 'projects', encodeCwd(cwd));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  const records: unknown[] = [claudeUser(`task ${id}`, `${id}-u`, null), claudeReply(`working on ${id}`, `${id}-a`, `${id}-u`)];
  if (limited) records.push(claudeUser('keep going', `${id}-u2`, `${id}-a`), claudeUsageLimit(`${id}-e`, `${id}-u2`, '2026-10-26T09:05:00.000Z', FUTURE), ...claudeTrailer(id, `${id}-e`));
  await writeFile(file, jsonl(records));
  const t = new Date(Date.now() + secondsAhead * 1000);
  await utimes(file, t, t);
  return file;
}

/** A Codex rollout under `home` whose last snapshot has the 5h window at `used`%. */
async function codexSession(home: string, id: string, used: number, secondsAhead = 0) {
  const folder = path.join(home, 'sessions', '2026', '10', '26');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-10-26T09-00-00-${id}.jsonl`);
  const snapshot = codexTokenCount('2026-10-26T09:02:00.000Z', win(used, 300, FUTURE), win(10, 10080, FUTURE));
  await writeFile(file, jsonl([codexMeta(id, cwd), codexUser(`task ${id}`), codexReply(`on it ${id}`), snapshot]));
  const t = new Date(Date.now() + secondsAhead * 1000);
  await utimes(file, t, t);
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-fallback-'));
  cwd = dir('project');
  await mkdir(cwd);
  env = { ...process.env };
  process.env.WORMHOLE_HOME = dir('wh');
  process.env.CLAUDE_CONFIG_DIR = dir('claude');
  process.env.CODEX_HOME = dir('codex');
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

describe('fallbackOrder', () => {
  const keys = ['claude', 'codex', 'opencode', 'claude@work', 'codex@alt'];

  it('defaults to the other accounts of the same tool, then the other tools', () => {
    expect(fallbackOrder('claude', keys)).toEqual(['claude@work', 'codex', 'codex@alt', 'opencode']);
    expect(fallbackOrder('claude@work', keys)).toEqual(['claude', 'codex', 'codex@alt', 'opencode']);
    expect(fallbackOrder('codex', keys)).toEqual(['codex@alt', 'claude', 'claude@work', 'opencode']);
  });

  it('follows a configured list from after the current key, wrapping around', () => {
    const list = ['claude', 'claude@work', 'codex', 'codex@alt'];
    expect(fallbackOrder('claude', keys, list)).toEqual(['claude@work', 'codex', 'codex@alt']);
    expect(fallbackOrder('codex', keys, list)).toEqual(['codex@alt', 'claude', 'claude@work']);
    expect(fallbackOrder('opencode', keys, list)).toEqual(list);
  });
});

describe('fallback settings in accounts.json', () => {
  it('stores the order and the auto switch next to the accounts', async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    expect(await setFallback(['claude@work', 'claude', 'codex'])).toEqual(['claude@work', 'claude', 'codex']);
    await setAuto(true);
    expect(loadFile()).toMatchObject({ fallback: ['claude@work', 'claude', 'codex'], auto: true });
    // Adding an account keeps the settings; removing one takes it out of the order.
    await addAccount({ name: 'alt', tool: 'codex', dir: dir('codex-alt') });
    await removeAccount('claude@work');
    expect(loadFile()).toMatchObject({ fallback: ['claude', 'codex'], auto: true, accounts: [{ name: 'alt' }] });
    expect(await setFallback([])).toBeUndefined();
    expect(loadFile().fallback).toBeUndefined();
  });

  it('rejects unknown accounts, bad keys and repeats', async () => {
    await expect(setFallback(['claude@nope'])).rejects.toThrow('no account claude@nope');
    await expect(setFallback(['vim'])).rejects.toThrow('expected a tool');
    await expect(setFallback(['claude', 'claude'])).rejects.toThrow('listed twice');
  });
});

describe('pickFallback', () => {
  it('skips candidates whose own latest session here is limited, and ones not set up', async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    await claudeSession(dir('claude'), 'p1', true);
    await claudeSession(dir('claude-work'), 'w1', true);
    await codexSession(dir('codex'), 'c1', 40);
    const pick = await pickFallback(context(), 'claude', ['claude', 'codex@gone', 'claude@work', 'codex']);
    expect(pick.target).toBe('codex');
    expect(pick.skipped.map((s) => s.key)).toEqual(['codex@gone', 'claude@work']);
    expect(pick.skipped[0]!.why).toBe('not set up here');
    expect(pick.skipped[1]!.why).toContain(`limited too (five-hour limit reached`);
    expect(pick.skipped[1]!.why).toContain(`resets ${FUTURE}`);
  });

  it('takes a candidate with no session here, and reports when nothing has room', async () => {
    expect((await pickFallback(context(), 'claude')).target).toBe('codex');
    await codexSession(dir('codex'), 'c1', 100);
    const none = await pickFallback(context(), 'claude');
    expect(none.target).toBeUndefined();
    expect(none.skipped.map((s) => s.key)).toEqual(['codex']);
  });

  it('skips a candidate it cannot check', async () => {
    const c = context();
    c.adapters.codex = { ...c.adapters.codex!, detectLatest: async () => { throw new Error('boom'); } };
    expect(await pickFallback(c, 'claude')).toMatchObject({ skipped: [{ key: 'codex', why: 'could not check it: boom' }] });
  });
});

describe('wormhole next', () => {
  let out: string[];
  let err: string[];
  let launched: string[][];
  let stdin: string;
  const deps = (): Partial<Deps> => ({
    context: (at) => context(at),
    launch: async (argv) => (launched.push(argv), 0),
    openUrl: async () => 0,
    readStdin: async () => stdin,
  });
  const run = (...args: string[]) => main(['node', 'wormhole', '-C', cwd, ...args], deps());
  const text = () => out.join('\n');

  beforeEach(() => {
    out = [];
    err = [];
    launched = [];
    stdin = '';
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  });

  it('does nothing when the session in use has room, unless forced', async () => {
    await claudeSession(dir('claude'), 'p1', false);
    expect(await run('next')).toBe(0);
    expect(text()).toContain('claude p1: not limited, last reply came through');
    expect(text()).toContain('Nothing to do');
    expect(launched).toEqual([]);

    expect(await run('next', '--force', '--no-launch')).toBe(0);
    expect(text()).toContain('Handed off claude p1 → codex');
    expect((await context().store.loadForCwd(cwd))!.fallback).toBeUndefined();
  });

  it('moves a limited session to the next account with room and opens it there', async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    await addAccount({ name: 'alt', tool: 'codex', dir: dir('codex-alt') });
    await claudeSession(dir('claude-work'), 'w0', true, -60);
    await claudeSession(dir('claude'), 'p1', true);
    expect(await run('next')).toBe(0);
    expect(text()).toContain('claude p1: limited, five-hour limit reached');
    expect(text()).toContain('skipped claude@work: its latest session here is limited too');
    expect(text()).toContain('Handed off claude p1 → codex');
    expect(launched[0]!.slice(0, 2)).toEqual(['codex', 'resume']);

    const thread = (await context().store.loadForCwd(cwd))!;
    expect(thread.fallback).toMatchObject({ from: { tool: 'claude', nativeId: 'p1' }, to: { tool: 'codex' }, resetsAt: FUTURE });
  });

  it('uses the configured order and fails when nothing has room', async () => {
    await addAccount({ name: 'alt', tool: 'codex', dir: dir('codex-alt') });
    expect(await run('accounts', 'fallback', 'codex', 'codex@alt', 'claude')).toBe(0);
    expect(text()).toContain('Fallback order: codex → codex@alt → claude');
    await codexSession(dir('codex'), 'c1', 100);
    expect(await run('next', '--no-launch')).toBe(0);
    expect(text()).toContain('Handed off codex c1 → codex@alt');

    await codexSession(dir('codex-alt'), 'a2', 100, 120);
    await claudeSession(dir('claude'), 'p9', true, -120);
    out = [];
    expect(await run('next', '--no-launch')).toBe(1);
    expect(text()).toContain('skipped claude');
    expect(err.join('\n')).toContain('no other account or tool has room');
  });

  it('shows and resets the order, and turns auto on and off', async () => {
    expect(await run('accounts', 'fallback')).toBe(0);
    expect(text()).toContain('from claude: codex');
    expect(await run('accounts', 'fallback', 'codex', 'claude')).toBe(0);
    expect(await run('accounts', 'fallback', '--default')).toBe(0);
    expect(loadFile().fallback).toBeUndefined();
    expect(await run('accounts', 'fallback', 'claude@nope')).toBe(1);

    expect(await run('accounts', 'auto', 'on')).toBe(0);
    expect(text()).toContain('Auto fallback is on.');
    expect(await run('accounts', 'list')).toBe(0);
    expect(text()).toContain('auto fallback from hooks: on');
    expect(await run('accounts', 'auto', 'off')).toBe(0);
    expect(loadFile().auto).toBe(false);
    expect(await run('accounts', 'auto', 'maybe')).toBe(1);
    expect(err.join('\n')).toContain('expected on or off');
  });

  it('writes the fallback from the Claude hook, and resume and status point at it', async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    await setAuto(true);
    await claudeSession(dir('claude'), 'p1', false);
    await sync(context());
    await claudeSession(dir('claude'), 'p1', true, 5);

    stdin = JSON.stringify({ session_id: 'p1', cwd, reason: 'prompt_input_exit' });
    expect(await run('hook', 'claude')).toBe(0);
    expect(launched).toEqual([]);
    const thread = (await context().store.loadForCwd(cwd))!;
    expect(thread.fallback).toMatchObject({ from: { nativeId: 'p1' }, to: { tool: 'claude', account: 'work' } });
    const copy = thread.fallback!.to.nativeId;
    expect(await readFile(path.join(dir('claude-work'), 'projects', encodeCwd(cwd), `${copy}.jsonl`), 'utf8')).toContain('keep going');

    // A second SessionEnd for the same limit writes nothing new.
    expect(await run('hook', 'claude')).toBe(0);
    expect((await context().store.loadForCwd(cwd))!.segments).toHaveLength(2);

    out = [];
    expect(await run('status')).toBe(0);
    expect(text()).toContain(`claude hit its limit at 2026-10-26T09:05:00.000Z, resets ${FUTURE}`);
    expect(text()).toMatch(/claude\s+p1 .*LIMITED/);
    out = [];
    expect(await run('resume', '--no-launch')).toBe(0);
    expect(text()).toContain(`wormhole wrote claude@work session ${copy} to carry on; continue with: wormhole resume`);
    expect(text()).toContain(`(or: env CLAUDE_CONFIG_DIR=${dir('claude-work')} claude --resume ${copy})`);
    expect(launched).toEqual([]);

    // Once the fallback session has turns of its own, the note goes away.
    const file = path.join(dir('claude-work'), 'projects', encodeCwd(cwd), `${copy}.jsonl`);
    await writeFile(file, (await readFile(file, 'utf8')) + jsonl([claudeUser('next step', 'n1', null)]));
    await utimes(file, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
    out = [];
    expect(await run('resume', '--no-launch')).toBe(0);
    expect(text()).not.toContain('hit its limit');
  });

  it('writes the fallback from the Codex notify hook', async () => {
    await setAuto(true);
    await codexSession(dir('codex'), 'c1', 50);
    await sync(context());
    await codexSession(dir('codex'), 'c1', 100, 5);
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'c1', cwd });
    expect(await run('hook', 'codex', payload)).toBe(0);
    expect((await context().store.loadForCwd(cwd))!.fallback).toMatchObject({ from: { tool: 'codex' }, to: { tool: 'claude' } });
  });
});

describe('fallbackFromHook', () => {
  const input = { tool: 'claude' as const, cwd: '', session: 'p1' };

  it('does nothing while auto is off, without a thread, or when the session has room', async () => {
    const at = { ...input, cwd };
    await claudeSession(dir('claude'), 'p1', true);
    expect(await fallbackFromHook(at, context())).toBeUndefined();
    await setAuto(true);
    expect(await fallbackFromHook(at, context())).toBeUndefined();
    await claudeSession(dir('claude'), 'p1', false);
    await sync(context());
    expect(await fallbackFromHook(at, context())).toBeUndefined();
    expect(await fallbackFromHook({ ...at, session: 'missing' }, context())).toBeUndefined();
    expect(await fallbackFromHook({ ...at, tool: 'opencode' }, context())).toBeUndefined();
  });

  it('throws, for the hook log, when nothing has room', async () => {
    await setAuto(true);
    await setFallback(['claude', 'codex']);
    await claudeSession(dir('claude'), 'p1', true);
    await codexSession(dir('codex'), 'c1', 100, -60);
    await sync(context(), { tool: 'claude', session: 'p1' });
    await expect(fallbackFromHook({ ...input, cwd }, context())).rejects.toThrow(/claude p1 hit its limit and nothing has room \(codex: /);
  });

  it('is replaced by a later plain switch', async () => {
    await setAuto(true);
    await claudeSession(dir('claude'), 'p1', true);
    await sync(context(), { tool: 'claude', session: 'p1' });
    expect(await fallbackFromHook({ ...input, cwd }, context())).toBe('codex');
    const c = context();
    expect(await fallbackNote(c, (await c.store.loadForCwd(cwd))!)).toHaveLength(3);
    await switchTo(c, 'claude');
    const thread = (await c.store.loadForCwd(cwd))!;
    expect(thread.fallback).toBeUndefined();
    expect(await fallbackNote(c, thread)).toEqual([]);
  });
});
