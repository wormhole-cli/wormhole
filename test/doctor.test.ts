import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { type Check, type ExecResult, failed, formatChecks, type Probes, realProbes, runDoctor, shellWords } from '../src/doctor.js';
import { opencodePlugin, OPENCODE_MARKER, withClaudeHook, withCodexNotify } from '../src/hooks/install.js';

let root: string;
let node: string;
let self: string[];
/** Fake binaries: name → path, or absent when not on PATH. */
let bins: Record<string, string>;
/** Fake command results, keyed by `bin args…`; a function sees the extra env. */
let results: Record<string, ExecResult | null | ((env?: Record<string, string>) => ExecResult | null)>;
let calls: { cmd: string; env?: Record<string, string> }[];
const NOW = Date.parse('2026-10-26T12:00:00Z');

const home = () => path.join(root, 'home');
const claudeDir = () => path.join(home(), '.claude');
const codexDir = () => path.join(home(), '.codex');
const wh = () => path.join(home(), '.wormhole');
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

function probes(over: Partial<Probes> = {}): Probes {
  return {
    ...realProbes(),
    env: { PATH: '/nowhere' },
    home: home(),
    now: () => NOW,
    which: async (bin) => bins[bin] ?? null,
    exec: async (bin, args, env) => {
      const cmd = [path.basename(bin), ...args].join(' ');
      calls.push({ cmd, env });
      const r = results[cmd];
      return typeof r === 'function' ? r(env) : r === undefined ? null : r;
    },
    ...over,
  };
}

const byName = (checks: Check[], name: string) => {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check ${name}: ${checks.map((c) => c.name).join(', ')}`);
  return found;
};

async function put(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A healthy machine: all three tools, logged in, hooks installed, one clean thread. */
async function healthy() {
  bins = { claude: '/bin/claude', codex: '/bin/codex', opencode: '/bin/opencode' };
  results = {
    'claude --version': ok('2.1.310 (Claude Code)\n'),
    'codex --version': ok('codex-cli 0.164.0\n'),
    'opencode --version': ok('1.19.0\n'),
    'claude auth status --json': ok(JSON.stringify({ loggedIn: true, email: 'me@example.com', authMethod: 'claude.ai' })),
    'codex login status': ok('Logged in using ChatGPT\n'),
  };
  await put(path.join(claudeDir(), 'settings.json'), JSON.stringify(withClaudeHook({}, self)));
  await put(path.join(codexDir(), 'config.toml'), withCodexNotify('', self));
  await put(path.join(codexDir(), 'auth.json'), '{}');
  await put(path.join(home(), '.config', 'opencode', 'plugins', 'wormhole.js'), opencodePlugin(self));
  const now = new Date().toISOString();
  await put(
    path.join(wh(), 'threads', 't1', 'thread.json'),
    JSON.stringify({ version: 1, id: 't1', cwd: '/p', title: 'p', createdAt: now, updatedAt: now, segments: [] }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-doctor-'));
  node = path.join(root, 'node');
  await writeFile(node, '');
  await writeFile(path.join(root, 'wormhole.js'), '');
  self = [node, path.join(root, 'wormhole.js')];
  calls = [];
  await healthy();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('doctor on a healthy setup', () => {
  it('passes every check', async () => {
    const checks = await runDoctor(probes());
    expect(checks.filter((c) => c.level !== 'pass')).toEqual([]);
    expect(byName(checks, 'claude on PATH').detail).toContain('2.1.310');
    expect(byName(checks, 'claude login').detail).toBe('logged in as me@example.com (claude.ai)');
    expect(byName(checks, 'codex login').detail).toBe('Logged in using ChatGPT');
    expect(byName(checks, 'threads').detail).toBe('1 thread loads cleanly');
    expect(byName(checks, 'hook.log').detail).toBe('no hook errors');
    expect(failed(checks)).toBe(false);
  });

  it('never runs anything but version and login-status commands', async () => {
    await runDoctor(probes());
    for (const { cmd } of calls) expect(cmd).toMatch(/--version$|auth status --json$|login status$/);
  });
});

describe('tools', () => {
  it('fails on missing claude or codex, warns on missing opencode', async () => {
    bins = {};
    const checks = await runDoctor(probes());
    expect(byName(checks, 'claude on PATH').level).toBe('fail');
    expect(byName(checks, 'codex on PATH').level).toBe('fail');
    expect(byName(checks, 'opencode on PATH')).toMatchObject({ level: 'warn', fix: expect.stringContaining('only needed') });
    expect(byName(checks, 'claude login')).toMatchObject({ level: 'warn', detail: expect.stringContaining("can't check") });
    // Without the codex CLI, auth.json decides.
    expect(byName(checks, 'codex login')).toMatchObject({ level: 'pass', detail: expect.stringContaining('auth.json present') });
    // opencode not installed and no plugin: nothing to say about its hook.
    await rm(path.join(home(), '.config'), { recursive: true });
    expect((await runDoctor(probes())).some((c) => c.name === 'opencode hook')).toBe(false);
  });

  it('warns when a tool does not report a version', async () => {
    results['codex --version'] = { code: 1, stdout: '', stderr: 'boom' };
    expect(byName(await runDoctor(probes()), 'codex on PATH').level).toBe('warn');
  });
});

describe('logins', () => {
  it('fails when Claude Code says it is logged out', async () => {
    results['claude auth status --json'] = { code: 1, stdout: '{"loggedIn": false}', stderr: '' };
    const c = byName(await runDoctor(probes()), 'claude login');
    expect(c).toMatchObject({ level: 'fail', fix: 'claude auth login' });
  });

  it("warns that it can't check when claude has no auth status", async () => {
    results['claude auth status --json'] = { code: 1, stdout: '', stderr: "error: unknown command 'auth'" };
    const c = byName(await runDoctor(probes()), 'claude login');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain("unknown command 'auth'");
    results['claude auth status --json'] = null;
    expect(byName(await runDoctor(probes()), 'claude login').level).toBe('warn');
  });

  it('fails when codex login status fails, or without auth.json and CLI', async () => {
    results['codex login status'] = { code: 1, stdout: '', stderr: 'Not logged in\n' };
    expect(byName(await runDoctor(probes()), 'codex login')).toMatchObject({ level: 'fail', detail: 'not logged in: Not logged in' });
    results['codex login status'] = { code: 1, stdout: '', stderr: '' };
    expect(byName(await runDoctor(probes()), 'codex login').detail).toContain('exited 1');
    delete bins.codex;
    await rm(path.join(codexDir(), 'auth.json'));
    expect(byName(await runDoctor(probes()), 'codex login')).toMatchObject({ level: 'fail', fix: 'codex login' });
  });

  it('checks each account with its folder in the env', async () => {
    const work = path.join(root, 'claude-work');
    const alt = path.join(root, 'codex-alt');
    await mkdir(work);
    await mkdir(alt);
    results['claude auth status --json'] = (env) => ok(JSON.stringify({ loggedIn: !env?.CLAUDE_CONFIG_DIR }));
    results['codex login status'] = (env) => (env?.CODEX_HOME ? { code: 1, stdout: 'Not logged in', stderr: '' } : ok('Logged in'));
    const checks = await runDoctor(
      probes({
        loadAccounts: () => [
          { name: 'work', tool: 'claude', dir: work },
          { name: 'alt', tool: 'codex', dir: alt },
        ],
      }),
    );
    expect(byName(checks, 'account claude@work').level).toBe('pass');
    expect(byName(checks, 'claude@work login')).toMatchObject({ level: 'fail', fix: `env CLAUDE_CONFIG_DIR=${work} claude auth login` });
    expect(byName(checks, 'codex@alt login')).toMatchObject({ level: 'fail', fix: `env CODEX_HOME=${alt} codex login` });
    expect(byName(checks, 'claude@work hook').level).toBe('warn');
    expect(byName(checks, 'codex@alt hook').level).toBe('warn');
    expect(calls.find((c) => c.cmd === 'claude auth status --json' && c.env?.CLAUDE_CONFIG_DIR === work)).toBeTruthy();
  });
});

describe('accounts', () => {
  it('fails on a missing folder, the default folder, a duplicate and a shared folder', async () => {
    const dir = path.join(root, 'x');
    await mkdir(dir);
    const checks = await runDoctor(
      probes({
        loadAccounts: () => [
          { name: 'gone', tool: 'claude', dir: path.join(root, 'missing') },
          { name: 'same', tool: 'codex', dir: codexDir() },
          { name: 'a', tool: 'claude', dir },
          { name: 'a', tool: 'claude', dir: path.join(root, 'y') },
          { name: 'b', tool: 'claude', dir },
        ],
      }),
    );
    expect(byName(checks, 'account claude@gone')).toMatchObject({ level: 'fail', detail: expect.stringContaining('does not exist') });
    expect(byName(checks, 'account codex@same').detail).toContain("default folder");
    expect(checks.filter((c) => c.name === 'account claude@a').map((c) => c.level)).toEqual(['pass', 'fail']);
    expect(byName(checks, 'account claude@b').detail).toContain('same folder as claude@a');
    // Broken accounts get no login or hook checks.
    expect(checks.some((c) => c.name === 'claude@gone login')).toBe(false);
  });

  it('fails when accounts.json does not load', async () => {
    const c = byName(await runDoctor(probes({ loadAccounts: () => { throw new Error('bad json'); } })), 'accounts');
    expect(c).toMatchObject({ level: 'fail', detail: expect.stringContaining('bad json') });
    const c2 = byName(await runDoctor(probes({ loadAccounts: () => { throw 'odd'; } })), 'accounts');
    expect(c2.detail).toContain('odd');
  });

  it('reads accounts.json under WORMHOLE_HOME by default', async () => {
    await put(path.join(root, 'w', 'accounts.json'), JSON.stringify({ accounts: [{ name: 'n', tool: 'claude', dir: path.join(root, 'nope') }] }));
    const checks = await runDoctor(probes({ env: { WORMHOLE_HOME: path.join(root, 'w'), PATH: '' }, loadAccounts: realProbes().loadAccounts }));
    expect(byName(checks, 'account claude@n').level).toBe('fail');
  });
});

describe('hooks', () => {
  it('warns when hooks are not installed', async () => {
    await rm(path.join(claudeDir(), 'settings.json'));
    await put(path.join(codexDir(), 'config.toml'), 'model = "x"\n');
    await rm(path.join(home(), '.config'), { recursive: true });
    const checks = await runDoctor(probes());
    expect(byName(checks, 'claude hook')).toMatchObject({ level: 'warn', fix: 'wormhole hooks install' });
    expect(byName(checks, 'codex hook').level).toBe('warn');
    expect(byName(checks, 'opencode hook')).toMatchObject({ level: 'warn', fix: 'wormhole hooks install --opencode' });
    expect(failed(checks)).toBe(false);
  });

  it('fails when a hook points at a node or wormhole.js that is gone', async () => {
    await rm(node);
    const checks = await runDoctor(probes());
    for (const name of ['claude hook', 'codex hook', 'opencode hook']) {
      expect(byName(checks, name)).toMatchObject({ level: 'fail', detail: expect.stringContaining(`runs ${node}`) });
    }
  });

  it('reads quoted hook commands', async () => {
    const spaced = path.join(root, 'with space');
    await mkdir(spaced);
    await writeFile(path.join(spaced, 'wormhole.js'), '');
    await put(path.join(claudeDir(), 'settings.json'), JSON.stringify(withClaudeHook({}, [node, path.join(spaced, 'wormhole.js')])));
    expect(byName(await runDoctor(probes()), 'claude hook').level).toBe('pass');
    expect(shellWords(`a 'b c' d\\ e  'it'\\''s'`)).toEqual(['a', 'b c', 'd e', "it's"]);
    expect(shellWords(`'open`)).toEqual(['open']);
  });

  it('fails on unreadable config files', async () => {
    await put(path.join(claudeDir(), 'settings.json'), '{not json');
    await put(path.join(codexDir(), 'config.toml'), 'notify = ["unterminated\n');
    const checks = await runDoctor(probes());
    expect(byName(checks, 'claude hook')).toMatchObject({ level: 'fail', detail: expect.stringContaining('not valid JSON') });
    expect(byName(checks, 'codex hook')).toMatchObject({ level: 'fail', detail: expect.stringContaining('does not parse') });
  });

  it('fails on a hook with no program', async () => {
    await put(path.join(claudeDir(), 'settings.json'), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hook wormhole hook claude' }] }] } }));
    expect(byName(await runDoctor(probes()), 'claude hook').detail).toContain('has no program');
  });

  it('checks the Codex notify program wormhole chains', async () => {
    const prog = path.join(root, 'notifier');
    await writeFile(prog, '');
    const before = `notify = ["${prog}", "turn-ended"]\n`;
    await put(path.join(codexDir(), 'config.toml.before-wormhole'), before);
    await put(path.join(codexDir(), 'config.toml'), withCodexNotify(before, self));
    expect(byName(await runDoctor(probes()), 'codex hook')).toMatchObject({ level: 'pass', detail: expect.stringContaining('still runs notifier') });

    // The chained program was uninstalled.
    await rm(prog);
    expect(byName(await runDoctor(probes()), 'codex hook')).toMatchObject({ level: 'warn', detail: expect.stringContaining('no longer exists') });

    // Someone rewrote notify and dropped the old program from the chain.
    await writeFile(prog, '');
    await put(path.join(codexDir(), 'config.toml'), withCodexNotify('', self));
    expect(byName(await runDoctor(probes()), 'codex hook')).toMatchObject({ level: 'warn', detail: expect.stringContaining('no longer chained') });

    // Backups that are wormhole's own or unparsable say nothing about the old program.
    await put(path.join(codexDir(), 'config.toml.before-wormhole'), withCodexNotify('', self));
    expect(byName(await runDoctor(probes()), 'codex hook').level).toBe('pass');
    await put(path.join(codexDir(), 'config.toml.before-wormhole'), 'notify = [oops]\n');
    expect(byName(await runDoctor(probes()), 'codex hook').level).toBe('pass');
  });

  it('leaves a bare command name in the chain alone', async () => {
    await put(path.join(codexDir(), 'config.toml'), withCodexNotify('notify = ["notify-send", "x"]\n', self));
    expect(byName(await runDoctor(probes()), 'codex hook').level).toBe('pass');
  });

  it('warns about an opencode plugin wormhole did not write, and reads ours', async () => {
    const file = path.join(home(), '.config', 'opencode', 'plugins', 'wormhole.js');
    await put(file, 'export const Mine = 1;\n');
    expect(byName(await runDoctor(probes()), 'opencode hook').detail).toContain('not written by wormhole');
    await put(file, `${OPENCODE_MARKER}\nconst WORMHOLE = [broken];\n`);
    expect(byName(await runDoctor(probes()), 'opencode hook').level).toBe('fail');
    await put(file, `${OPENCODE_MARKER}\n`);
    expect(byName(await runDoctor(probes()), 'opencode hook').level).toBe('fail');
  });

  it('finds the opencode plugin under XDG_CONFIG_HOME', async () => {
    const xdg = path.join(root, 'xdg');
    await put(path.join(xdg, 'opencode', 'plugins', 'wormhole.js'), opencodePlugin(self));
    await rm(path.join(home(), '.config'), { recursive: true });
    expect(byName(await runDoctor(probes({ env: { XDG_CONFIG_HOME: xdg } })), 'opencode hook').level).toBe('pass');
  });
});

describe('store', () => {
  const thread = (id: string) => path.join(wh(), 'threads', id);

  it('fails when WORMHOLE_HOME is not writable', async () => {
    const c = byName(await runDoctor(probes({ writable: async () => false })), 'store');
    expect(c).toMatchObject({ level: 'fail', detail: expect.stringContaining('not writable') });
  });

  it('accepts a store not created yet when its parent is writable', async () => {
    const env = { WORMHOLE_HOME: path.join(root, 'new', 'deeper', '.wormhole') };
    const checks = await runDoctor(probes({ env }));
    expect(byName(checks, 'store')).toMatchObject({ level: 'pass', detail: expect.stringContaining('not created yet') });
    expect(byName(checks, 'threads').detail).toBe('0 threads load cleanly');
    expect(byName(await runDoctor(probes({ env, writable: async () => false })), 'store').level).toBe('fail');
  });

  it('fails on a thread that does not load, warns on journals, stale locks and empty folders', async () => {
    await put(path.join(thread('bad'), 'thread.json'), '{"version": 2}');
    await put(path.join(thread('t1'), 'pending.json'), '{}');
    await mkdir(path.join(thread('t1'), '.lock'));
    await utimes(path.join(thread('t1'), '.lock'), new Date(NOW - 60_000), new Date(NOW - 60_000));
    await mkdir(thread('empty'));
    await put(path.join(wh(), 'threads', 'stray-file'), '');
    const checks = await runDoctor(probes());
    const lines = checks.filter((c) => c.name.startsWith('thread'));
    expect(lines.map((c) => [c.name, c.level])).toEqual([
      ['thread bad', 'fail'],
      ['thread empty', 'warn'],
      ['thread t1', 'warn'],
      ['thread t1', 'warn'],
    ]);
    expect(lines[2]!.fix).toBe('run `wormhole import` in /p to finish it');
    expect(lines[3]!.detail).toContain('stale lock, 60 s old (/p)');
    expect(lines[3]!.fix).toContain(`rm -r ${path.join(thread('t1'), '.lock')}`);
    expect(failed(checks)).toBe(true);
  });

  it('treats a fresh lock as a wormhole at work, and journals in unloadable threads plainly', async () => {
    await mkdir(path.join(thread('t1'), '.lock'));
    await utimes(path.join(thread('t1'), '.lock'), new Date(NOW - 5_000), new Date(NOW - 5_000));
    await put(path.join(thread('x'), 'pending.json'), '{}');
    const checks = await runDoctor(probes());
    expect(byName(checks, 'threads').detail).toBe('1 thread loads cleanly');
    expect(checks.filter((c) => c.name === 'thread x').map((c) => c.fix)).toEqual([
      expect.stringContaining('left over'),
      'run `wormhole import` to finish it',
    ]);
  });

  it('warns on a recent hook error and shows it, passes on old ones', async () => {
    const log = path.join(wh(), 'hook.log');
    await put(log, '2026-10-01T00:00:00.000Z Error: old\n    at x\n2026-10-26T11:00:00.000Z Error: no codex session abc\n    at y (z.js:1:1)\n');
    const c = byName(await runDoctor(probes()), 'hook.log');
    expect(c).toMatchObject({ level: 'warn', detail: 'last hook error: 2026-10-26T11:00:00.000Z Error: no codex session abc' });
    await put(log, '2026-10-01T00:00:00.000Z Error: old\n');
    expect(byName(await runDoctor(probes()), 'hook.log')).toMatchObject({ level: 'pass', detail: expect.stringContaining('1 older') });
  });
});

describe('realProbes', () => {
  it('finds executables, runs commands and reads files', async () => {
    const p = realProbes();
    expect(await p.which('node')).toBeTruthy();
    expect(await p.which('surely-not-a-real-binary-xyz')).toBeNull();
    expect(await p.exec(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    expect(await p.exec(process.execPath, ['-e', 'console.error("e"); process.exit(3)'])).toMatchObject({ code: 3, stderr: 'e\n' });
    expect(await p.exec(path.join(root, 'no-such-bin'), [])).toBeNull();
    expect(await p.readFile(path.join(root, 'nope'))).toBeNull();
    expect(await p.stat(path.join(root, 'nope'))).toBeNull();
    expect((await p.stat(root))?.isDirectory).toBe(true);
    expect(await p.readdir(path.join(root, 'nope'))).toEqual([]);
    expect(await p.writable(root)).toBe(true);
  });
});

describe('wormhole doctor', () => {
  let out: string[];
  const run = (...args: string[]) => main(['node', 'wormhole', 'doctor', ...args], { doctorProbes: probes() });

  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  });

  it('prints one line per check and exits 0 with only warnings', async () => {
    delete bins.opencode;
    expect(await run()).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^pass {2}claude on PATH +2\.1\.310/m);
    expect(text).toMatch(/^WARN {2}opencode on PATH .*→ install opencode/m);
  });

  it('exits 1 when a check fails', async () => {
    results['claude auth status --json'] = ok('{"loggedIn": false}');
    expect(await run()).toBe(1);
    expect(out.join('\n')).toMatch(/^FAIL {2}claude login +not logged in .*→ claude auth login$/m);
  });

  it('prints JSON with --json', async () => {
    expect(await run('--json')).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; checks: Check[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((c) => c.name === 'codex login')).toEqual({ name: 'codex login', level: 'pass', detail: 'Logged in using ChatGPT' });
    results['codex login status'] = { code: 1, stdout: 'Not logged in', stderr: '' };
    out = [];
    expect(await run('--json')).toBe(1);
    expect(JSON.parse(out.join('\n')).ok).toBe(false);
  });

  it('formats aligned lines', () => {
    expect(formatChecks([
      { name: 'a', level: 'pass', detail: 'fine' },
      { name: 'longer', level: 'fail', detail: 'bad', fix: 'do x' },
    ])).toEqual(['pass  a       fine', 'FAIL  longer  bad  → do x']);
  });
});
