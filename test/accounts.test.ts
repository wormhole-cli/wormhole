import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { addAccount, keyOf, loadAccounts, parseKey, removeAccount } from '../src/accounts.js';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { type Deps, main } from '../src/cli.js';
import { adapter, type Context, defaultContext, switchTo, sync } from '../src/core.js';
import { importFromHook } from '../src/hooks/handle.js';
import { accountHookInstalled, install, status, uninstall } from '../src/hooks/install.js';
import { Store } from '../src/store/store.js';

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

const dir = (name: string) => path.join(root, name);
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (t: string, uuid: string, parentUuid: string | null) => ({
  type: 'user', uuid, parentUuid, message: { role: 'user', content: t },
});
const reply = (t: string, uuid: string, parentUuid: string) => ({
  type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: t }] },
});

/** Like defaultContext, without opencode and with fixed CLI versions. */
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

async function claudeSession(configDir: string, id: string, text: string, secondsAhead = 0) {
  const folder = path.join(configDir, 'projects', encodeCwd(cwd));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  await writeFile(file, jsonl([user(text, `${id}-u`, null), reply(`Done: ${text}`, `${id}-a`, `${id}-u`)]));
  const t = new Date(Date.now() + secondsAhead * 1000);
  await utimes(file, t, t);
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-accounts-'));
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

describe('accounts.json', () => {
  it('adds, lists and removes accounts', async () => {
    expect(loadAccounts()).toEqual([]);
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    await addAccount({ name: 'work', tool: 'codex', dir: dir('codex-work') });
    expect(loadAccounts().map((a) => keyOf(a.tool, a.name))).toEqual(['claude@work', 'codex@work']);
    expect((await removeAccount('codex@work')).dir).toBe(dir('codex-work'));
    expect(loadAccounts()).toHaveLength(1);
    await expect(removeAccount('codex@work')).rejects.toThrow('no account codex@work');
  });

  it('rejects bad names, tools, duplicates and the default folder', async () => {
    await expect(addAccount({ name: 'Work!', tool: 'claude', dir: '/x' })).rejects.toThrow('lowercase');
    await expect(addAccount({ name: 'w', tool: 'opencode', dir: '/x' })).rejects.toThrow('not opencode');
    await expect(addAccount({ name: 'w', tool: 'claude', dir: dir('claude') })).rejects.toThrow("default folder");
    await addAccount({ name: 'w', tool: 'claude', dir: '~/claude-w' });
    expect(loadAccounts()[0]!.dir).toBe(path.join(process.env.HOME!, 'claude-w'));
    await expect(addAccount({ name: 'w', tool: 'claude', dir: '/y' })).rejects.toThrow('already exists');
  });

  it('parses tool@account keys', () => {
    expect(parseKey('claude')).toEqual({ tool: 'claude', account: undefined });
    expect(parseKey('codex@work')).toEqual({ tool: 'codex', account: 'work' });
    for (const bad of ['gemini', 'claude@', 'claude@a@b']) expect(() => parseKey(bad)).toThrow('expected a tool');
  });

  it('gives each account its own adapter in the default context', () => {
    const c = defaultContext(cwd, [
      { name: 'work', tool: 'claude', dir: '/acc/claude' },
      { name: 'work', tool: 'codex', dir: '/acc/codex' },
    ]);
    expect(Object.keys(c.adapters)).toEqual(['claude', 'codex', 'opencode', 'claude@work', 'codex@work']);
    const ref = { tool: 'claude' as const, nativeId: 'id', path: '', startedAt: '', updatedAt: '' };
    expect(adapter(c, 'claude@work').launchArgs(ref)).toEqual(['env', 'CLAUDE_CONFIG_DIR=/acc/claude', 'claude', '--resume', 'id']);
    expect(adapter(c, 'codex@work').launchArgs({ ...ref, tool: 'codex' })).toEqual(['env', 'CODEX_HOME=/acc/codex', 'codex', 'resume', 'id']);
    expect(adapter(c, 'claude').launchArgs(ref)).toEqual(['claude', '--resume', 'id']);
    expect(() => adapter(c, 'claude@home')).toThrow('no account claude@home');
    expect(() => adapter(c, 'claude@work').appUrl!(ref)).toThrow('only reads the default');
  });
});

describe('switching between accounts', () => {
  beforeEach(async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
  });

  it('copies a session into another account of the same tool, without a handoff note', async () => {
    await claudeSession(dir('claude'), 'p1', 'personal work');
    const c = context();
    const r = await switchTo(c, 'claude@work');
    expect(r.mode).toBe('extended');
    expect(r.ref.account).toBe('work');
    expect(r.base).toMatchObject({ nativeId: 'p1' });
    expect(r.ref.path.startsWith(dir('claude-work'))).toBe(true);
    const copy = await readFile(r.ref.path, 'utf8');
    expect(copy).toContain('personal work');
    expect(copy).not.toContain('wormhole handoff');

    const thread = (await c.store.loadForCwd(cwd))!;
    expect(thread.segments.at(-1)).toMatchObject({ tool: 'claude', account: 'work', derivedFrom: { tool: 'claude', nativeId: 'p1' } });

    // The copy is the newest session: switching to the same account again just resumes it.
    await utimes(r.ref.path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await switchTo(context(), 'claude@work')).mode).toBe('resumed');
  });

  it('carries Codex turns into the account, and picks up work done there', async () => {
    await claudeSession(dir('claude'), 'p1', 'start');
    const toCodex = await switchTo(context(), 'codex');
    await writeFile(
      toCodex.ref.path,
      (await readFile(toCodex.ref.path, 'utf8')) +
        jsonl([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex step' }] } }]),
    );
    await utimes(toCodex.ref.path, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const toWork = await switchTo(context(), 'claude@work');
    expect(toWork.mode).toBe('extended');
    expect(toWork.from).toMatchObject({ tool: 'codex' });
    const copy = await readFile(toWork.ref.path, 'utf8');
    expect(copy).toContain('codex step');
    expect(copy).toContain('wormhole handoff');

    // A session started in the work account later is found as the one in use.
    await claudeSession(dir('claude-work'), 'w2', 'work only', 60);
    const { active, imported } = await sync(context());
    expect(active).toMatchObject({ nativeId: 'w2', account: 'work' });
    expect(imported.find((i) => i.nativeId === 'w2')).toMatchObject({ account: 'work', isNew: true });
  });

  it('imports from a hook that ran in an account folder', async () => {
    await claudeSession(dir('claude'), 'p1', 'start');
    await sync(context());
    await claudeSession(dir('claude-work'), 'w1', 'in work', 30);
    expect(await importFromHook({ tool: 'claude', cwd, session: 'w1' }, context())).toBe(2);
    expect((await context().store.loadForCwd(cwd))!.segments.map((s) => s.account)).toEqual([undefined, 'work']);
    expect(await importFromHook({ tool: 'claude', cwd, session: 'nowhere' }, context())).toBe(0);
  });
});

describe('hooks in account folders', () => {
  it('installs, reports and removes hooks in every account folder', async () => {
    const accounts = [
      { tool: 'claude' as const, dir: dir('claude-work') },
      { tool: 'codex' as const, dir: dir('codex-work') },
    ];
    const self = ['/usr/bin/node', '/opt/wormhole/bin/wormhole.js'];
    const lines = await install(['claude', 'codex'], self, accounts);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(path.join(dir('claude-work'), 'settings.json'));
    expect(await status()).toMatchObject({ claude: true, codex: true });
    for (const a of accounts) expect(await accountHookInstalled(a)).toBe(true);
    expect(await uninstall(['claude', 'codex'], accounts)).toHaveLength(4);
    for (const a of accounts) expect(await accountHookInstalled(a)).toBe(false);
  });
});

describe('wormhole accounts and tool@account on the command line', () => {
  let out: string[];
  let err: string[];
  let launched: string[][];
  const deps = (): Partial<Deps> => ({
    context: (at) => context(at),
    launch: async (argv) => (launched.push(argv), 0),
    openUrl: async () => 0,
  });
  const run = (...args: string[]) => main(['node', 'wormhole', '-C', cwd, ...args], deps());

  beforeEach(() => {
    out = [];
    err = [];
    launched = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
  });

  it('adds, lists and removes accounts', async () => {
    expect(await run('accounts')).toBe(0);
    expect(out.join('\n')).toContain('No accounts');
    expect(await run('accounts', 'add', 'work', '--tool', 'claude', '--dir', dir('claude-work'))).toBe(0);
    expect(out.join('\n')).toContain(`env CLAUDE_CONFIG_DIR=${dir('claude-work')} claude`);
    expect(await run('accounts', 'add', 'work', '--tool', 'codex', '--dir', dir('codex-work'))).toBe(0);
    expect(out.join('\n')).toContain(`env CODEX_HOME=${dir('codex-work')} codex login`);
    out = [];
    expect(await run('accounts', 'list')).toBe(0);
    expect(out.join('\n')).toMatch(/claude@work\s+.*claude-work/);
    expect(await run('accounts', 'remove', 'codex@work')).toBe(0);
    expect(await run('accounts', 'add', 'x', '--tool', 'opencode', '--dir', '/x')).toBe(1);
    expect(err.join('\n')).toContain('not opencode');
  });

  it('switches into an account, launching with its folder', async () => {
    await addAccount({ name: 'work', tool: 'claude', dir: dir('claude-work') });
    await claudeSession(dir('claude'), 'p1', 'start');
    expect(await run('switch', 'claude@work')).toBe(0);
    expect(out.join('\n')).toMatch(/Handed off claude p1 → claude@work/);
    expect(launched[0]!.slice(0, 3)).toEqual(['env', `CLAUDE_CONFIG_DIR=${dir('claude-work')}`, 'claude']);

    out = [];
    expect(await run('status')).toBe(0);
    expect(out.join('\n')).toMatch(/claude@work\s+\S+\s+\(handed off from claude\)/);

    out = [];
    expect(await run('log')).toBe(0);
    expect(out.join('\n')).toMatch(/claude\s+user\s+start/);

    expect(await run('switch', 'codex', '--from', 'claude@work', '--no-launch')).toBe(0);
    expect(await run('switch', 'claude@work', '--app', '--no-launch')).toBe(1);
    expect(err.join('\n')).toContain('only reads the default');
  });

  it('explains unknown accounts and malformed targets', async () => {
    expect(await run('switch', 'claude@nope', '--no-launch')).toBe(1);
    expect(err.join('\n')).toContain('no account claude@nope');
    expect(await run('switch', 'gemini@x')).toBe(1);
    expect(err.join('\n')).toContain('optionally with @account');
  });

  it('shows account hooks in hooks status', async () => {
    await addAccount({ name: 'work', tool: 'codex', dir: dir('codex-work') });
    const script = process.argv[1];
    process.argv[1] = '/opt/wormhole/bin/wormhole.js';
    onTestFinished(() => void (process.argv[1] = script));
    expect(await run('hooks', 'install', '--codex')).toBe(0);
    out = [];
    expect(await run('hooks', 'status')).toBe(0);
    expect(out.join('\n')).toMatch(/codex@work\s+installed/);
    expect(await run('hooks', 'uninstall', '--codex')).toBe(0);
  });
});
