import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { type OcSession, type OpencodeCli, OpencodeAdapter } from '../src/adapters/opencode.js';
import { type Deps, main } from '../src/cli.js';
import type { Context } from '../src/core.js';
import { Store } from '../src/store/store.js';

let root: string;
let cwd: string;
let out: string[];
let err: string[];
let launched: string[][];
let opened: string[];
let stdin: string;
let env: NodeJS.ProcessEnv;
let withOpencode: boolean;

const claudeDir = () => path.join(root, 'claude');
const codexHome = () => path.join(root, 'codex');

class FakeOpencode implements OpencodeCli {
  sessions = new Map<string, OcSession>();
  async list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.info.id,
      directory: s.info.directory!,
      created: s.info.time!.created,
      updated: s.info.time!.updated,
    }));
  }
  async export(_cwd: string, id: string) {
    return structuredClone(this.sessions.get(id) ?? null);
  }
  async import(_cwd: string, s: OcSession) {
    this.sessions.set(s.info.id, structuredClone(s));
  }
}

function context(dir: string): Context {
  return {
    cwd: dir,
    store: new Store(path.join(root, 'wh')),
    adapters: {
      claude: new ClaudeAdapter({ configDir: claudeDir(), version: '9.9.9' }),
      codex: new CodexAdapter({ home: codexHome(), cliVersion: '0.159.2' }),
      ...(withOpencode ? { opencode: new OpencodeAdapter({ cli: new FakeOpencode(), model: 'p/m' }) } : {}),
    },
  };
}

const deps = (): Partial<Deps> => ({
  context,
  launch: async (argv) => {
    launched.push(argv);
    return 0;
  },
  openUrl: async (url) => {
    opened.push(url);
    return 0;
  },
  readStdin: async () => stdin,
});

const run = (...args: string[]) => main(['node', 'wormhole', '-C', cwd, ...args], deps());
const text = () => out.join('\n');

async function claudeSession(id: string, turns: [string, string][]) {
  const dir = path.join(claudeDir(), 'projects', encodeCwd(cwd));
  await mkdir(dir, { recursive: true });
  const records = turns.flatMap(([u, a], i) => [
    { type: 'user', uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, message: { role: 'user', content: u } },
    { type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, message: { role: 'assistant', content: [{ type: 'text', text: a }] } },
  ]);
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-cli-'));
  cwd = path.join(root, 'project');
  await mkdir(cwd);
  out = [];
  err = [];
  launched = [];
  opened = [];
  stdin = '';
  withOpencode = false;
  env = { ...process.env };
  process.env.WORMHOLE_HOME = path.join(root, 'wh');
  process.env.CLAUDE_CONFIG_DIR = claudeDir();
  process.env.CODEX_HOME = codexHome();
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(String(s)), true)) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

describe('wormhole status and import', () => {
  it('reports a directory without a thread, then the thread once imported', async () => {
    expect(await run('status')).toBe(0);
    expect(text()).toContain('No wormhole thread');
    expect(text()).toMatch(/claude\s+\(none\)/);

    await claudeSession('c1', [['plan it', 'Planned.']]);
    expect(await run('import')).toBe(0);
    expect(text()).toContain('adopted claude c1: +2 events');
    out = [];
    expect(await run('import')).toBe(0);
    expect(text()).toContain('Nothing new.');
    out = [];
    expect(await run('import', '-q')).toBe(0);
    expect(out).toEqual([]);

    expect(await run('status')).toBe(0);
    expect(text()).toContain('last   claude c1');
    expect(text()).toMatch(/claude\s+c1\s+updated/);
  });

  it('requires --from with --session', async () => {
    expect(await run('import', '--session', 'x')).toBe(1);
    expect(err.join('')).toContain('--session needs --from');
    expect(await run('switch', 'codex', '--session', 'x')).toBe(1);
  });

  it('imports a named session', async () => {
    await claudeSession('a', [['first', 'one']]);
    await claudeSession('b', [['second', 'two']]);
    expect(await run('import', '--from', 'claude', '--session', 'a')).toBe(0);
    expect(text()).toContain('adopted claude a');
  });
});

describe('wormhole switch and resume', () => {
  beforeEach(async () => {
    await claudeSession('c1', [['build the parser', 'Parser done.']]);
  });

  it('writes the target session and prints how to open it without launching', async () => {
    expect(await run('switch', 'codex', '--no-launch')).toBe(0);
    expect(text()).toMatch(/Handed off claude c1 → codex [0-9a-f-]{36}/);
    expect(text()).toContain('new session holding the whole thread');
    expect(text()).toMatch(/codex resume [0-9a-f-]{36}/);
    expect(launched).toEqual([]);
  });

  it('launches the target CLI', async () => {
    expect(await run('switch', 'codex')).toBe(0);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.slice(0, 2)).toEqual(['codex', 'resume']);
  });

  it('returns the launched program’s exit code', async () => {
    const code = await main(['node', 'wormhole', '-C', cwd, 'switch', 'codex'], { ...deps(), launch: async () => 7 });
    expect(code).toBe(7);
  });

  it('opens desktop apps with --app', async () => {
    expect(await run('switch', 'claude', '--app')).toBe(0);
    expect(text()).toContain('claude already holds the active session c1; resuming it.');
    expect(opened).toEqual(['claude://resume?session=c1']);

    expect(await run('switch', 'codex', '--app', '--no-launch')).toBe(0);
    expect(text()).toMatch(/open codex:\/\/threads\/[0-9a-f-]{36}/);
    expect(opened).toHaveLength(1);
  });

  it('says when a tool has no desktop app', async () => {
    withOpencode = true;
    expect(await run('switch', 'opencode', '--app')).toBe(1);
    expect(err.join('')).toContain('opencode has no desktop app link');
  });

  it('reports a copied session when switching back', async () => {
    await run('switch', 'codex', '--no-launch');
    out = [];
    // Make the Codex copy the newest session, then go back.
    const thread = (await new Store(path.join(root, 'wh')).loadForCwd(cwd))!;
    const codexFile = thread.segments.at(-1)!.path;
    const later = new Date(Date.now() + 60_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(codexFile, later, later);
    expect(await run('switch', 'claude', '--no-launch')).toBe(0);
    expect(text()).toContain('continues a copy of claude c1 with only the newer turns added');
  });

  it('resumes the session in use, or switches first when given a tool', async () => {
    expect(await run('resume')).toBe(0);
    expect(launched).toEqual([['claude', '--resume', 'c1']]);

    expect(await run('resume', 'codex', '--no-launch')).toBe(0);
    expect(text()).toMatch(/Handed off claude c1 → codex/);

    expect(await run('resume', '--app', '--no-launch')).toBe(0);
    expect(text()).toMatch(/open codex:\/\/threads\//);
  });

  it('rejects unknown tools and reports a missing session', async () => {
    expect(await run('switch', 'vim')).toBe(1);
    expect(err.join('')).toContain('expected one of claude, codex, opencode');
    await rm(path.join(claudeDir(), 'projects'), { recursive: true });
    expect(await run('resume')).toBe(1);
    expect(err.join('')).toContain('no Claude Code, Codex or opencode session found');
  });
});

describe('wormhole switch --summarize', () => {
  let calls: string[][];
  const summarizing = (runner: Deps['run']) => (...args: string[]) =>
    main(['node', 'wormhole', '-C', cwd, ...args], { ...deps(), run: runner });

  beforeEach(async () => {
    calls = [];
    await claudeSession('c1', [['build the parser', 'Parser done.']]);
  });

  it('puts the leaving tool’s summary into the written session’s brief', async () => {
    const runner: Deps['run'] = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: 'Parser is built; tests next.\n', stderr: '' };
    };
    expect(await summarizing(runner)('switch', 'codex', '--summarize', '--no-launch')).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['claude', '-p']);
    expect(calls[0]).toContain('c1');
    expect(err.join('')).toContain('Asking claude for a summary of c1');

    const thread = (await new Store(path.join(root, 'wh')).loadForCwd(cwd))!;
    const written = await readFile(thread.segments.at(-1)!.path, 'utf8');
    expect(written).toContain('## Summary from Claude Code\\nParser is built; tests next.');
  });

  it('falls back to the plain brief with a warning when the tool fails', async () => {
    const runner: Deps['run'] = async () => ({ code: 1, stdout: '', stderr: 'not logged in\n' });
    expect(await summarizing(runner)('switch', 'codex', '--summarize', '--no-launch')).toBe(0);
    expect(err.join('')).toContain('no summary from claude (claude exited with 1: not logged in); using the plain brief');
    expect(text()).toMatch(/Handed off claude c1 → codex/);

    const thread = (await new Store(path.join(root, 'wh')).loadForCwd(cwd))!;
    const written = await readFile(thread.segments.at(-1)!.path, 'utf8');
    expect(written).toContain('[wormhole handoff]');
    expect(written).not.toContain('Summary from');
  });

  it('does not ask when the target already holds the active session', async () => {
    const runner: Deps['run'] = async (argv) => (calls.push(argv), { code: 0, stdout: 'x', stderr: '' });
    expect(await summarizing(runner)('switch', 'claude', '--summarize', '--no-launch')).toBe(0);
    expect(calls).toEqual([]);
    expect(text()).toContain('resuming it');
  });

  it('adds the summary to `brief --summarize`', async () => {
    const runner: Deps['run'] = async () => ({ code: 0, stdout: 'Ten lines of summary.', stderr: '' });
    expect(await summarizing(runner)('brief', '--to', 'codex', '--summarize')).toBe(0);
    expect(text()).toContain('## Summary from Claude Code\nTen lines of summary.\n\n## Original goal');
  });
});

describe('wormhole log and brief', () => {
  it('prints events labelled by tool, and the handoff note', async () => {
    await claudeSession('c1', [['goal one', 'reply one']]);
    expect(await run('log', '-n', '5')).toBe(0);
    expect(out[0]).toMatch(/^\s+0 claude\s+user\s+goal one/);
    expect(out[1]).toMatch(/^\s+1 claude\s+assistant\s+reply one/);

    out = [];
    expect(await run('brief', '--to', 'codex')).toBe(0);
    expect(text()).toContain('[wormhole handoff] You are Codex');
    expect(text()).toContain('## Original goal\ngoal one');
  });

  it('marks events whose full text is in an artifact', async () => {
    const dir = path.join(claudeDir(), 'projects', encodeCwd(cwd));
    await mkdir(dir, { recursive: true });
    const records = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'read it' } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'z'.repeat(5000) }] } },
    ];
    await writeFile(path.join(dir, 'c1.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(await run('log')).toBe(0);
    expect(out[2]).toMatch(/result\s+z+….*\[full: artifacts\/[0-9a-f]{32}\.txt\]$/);
    expect(out[1]).not.toContain('[full:');
  });

  it('prints the version and exits 0', async () => {
    expect(await main(['node', 'wormhole', '--version'], deps())).toBe(0);
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(out.join('')).toContain(version);
  });
});

describe('wormhole hooks', () => {
  beforeEach(() => {
    // No opencode on PATH unless a test puts one there.
    process.env.PATH = path.join(root, 'bin');
  });

  it('installs, reports and removes both hooks', async () => {
    // The hook command names the running wormhole script; under vitest that is vitest itself.
    const script = process.argv[1];
    process.argv[1] = '/opt/wormhole/bin/wormhole.js';
    onTestFinished(() => {
      process.argv[1] = script;
    });
    await mkdir(claudeDir(), { recursive: true });
    await mkdir(codexHome(), { recursive: true });
    await writeFile(path.join(codexHome(), 'config.toml'), 'notify = ["/bin/old", "x"]\n');

    expect(await run('hooks', 'install')).toBe(0);
    expect(text()).toContain('still runs old');
    expect(text()).not.toContain('opencode');
    out = [];
    expect(await run('hooks', 'status')).toBe(0);
    expect(text()).toMatch(/claude\s+installed/);
    expect(text()).toMatch(/codex\s+installed/);
    expect(text()).toMatch(/opencode\s+not installed/);

    out = [];
    expect(await run('hooks', 'uninstall', '--codex')).toBe(0);
    expect(text()).toContain('Codex: restored notify');
    expect(await readFile(path.join(codexHome(), 'config.toml'), 'utf8')).toBe('notify = ["/bin/old", "x"]\n');

    out = [];
    expect(await run('hooks', 'uninstall')).toBe(0);
    expect(text()).toContain('Claude Code: removed SessionEnd hook');
    out = [];
    expect(await run('hooks', 'uninstall')).toBe(0);
    expect(text()).toContain('No wormhole hooks installed.');
  });

  it('imports through the Claude hook', async () => {
    await claudeSession('c1', [['hello', 'hi']]);
    await new Store(path.join(root, 'wh')).loadOrCreateForCwd(cwd);
    stdin = JSON.stringify({ session_id: 'c1', cwd, reason: 'exit' });
    expect(await main(['node', 'wormhole', 'hook', 'claude'], deps())).toBe(0);
    const thread = (await new Store(path.join(root, 'wh')).loadForCwd(cwd))!;
    expect(thread.segments.map((s) => s.nativeId)).toEqual(['c1']);
  });

  it('runs the chained notify program and logs hook failures instead of throwing', async () => {
    const marker = path.join(root, 'chained.txt');
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'nope', cwd });
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.at(-1))`;
    const argv = ['node', 'wormhole', 'hook', 'codex', '--then', process.execPath, '-e', script, payload];
    expect(await main(argv, deps())).toBe(0);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(marker, 'utf8')).toBe(payload);

    stdin = '{"session_id":"s","cwd":"/x"}';
    const failing = { ...deps(), context: () => { throw new Error('boom'); } };
    expect(await main(['node', 'wormhole', 'hook', 'claude'], failing)).toBe(0);
    expect(await readFile(path.join(root, 'wh', 'hook.log'), 'utf8')).toContain('Error: boom');
  });

  it('includes opencode by default once it is on PATH, and removes only its plugin', async () => {
    const script = process.argv[1];
    process.argv[1] = '/opt/wormhole/bin/wormhole.js';
    onTestFinished(() => {
      process.argv[1] = script;
    });
    await mkdir(path.join(root, 'bin'));
    // An executable opencode: a .cmd file on Windows, a +x file elsewhere.
    const fakeOpencode = path.join(root, 'bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    await writeFile(fakeOpencode, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\n');
    await chmod(fakeOpencode, 0o755);
    const plugin = path.join(root, 'xdg', 'opencode', 'plugins', 'wormhole.js');

    expect(await run('hooks', 'install')).toBe(0);
    expect(text()).toContain(`opencode: plugin ${plugin}`);
    expect(await readFile(plugin, 'utf8')).toContain(JSON.stringify(path.resolve('/opt/wormhole/bin/wormhole.js')));
    out = [];
    expect(await run('hooks', 'status')).toBe(0);
    expect(text()).toMatch(/opencode\s+installed/);

    out = [];
    expect(await run('hooks', 'uninstall', '--opencode')).toBe(0);
    expect(text()).toBe(`opencode: removed plugin ${plugin}`);
    expect(existsSync(plugin)).toBe(false);
    expect(existsSync(path.join(claudeDir(), 'settings.json'))).toBe(true);
  });

  it('installs only opencode with --opencode, even when it is not on PATH', async () => {
    expect(await run('hooks', 'install', '--opencode')).toBe(0);
    expect(text()).not.toContain('Claude Code');
    expect(existsSync(path.join(root, 'xdg', 'opencode', 'plugins', 'wormhole.js'))).toBe(true);
    expect(existsSync(path.join(codexHome(), 'config.toml'))).toBe(false);
  });

  it('imports through the opencode hook', async () => {
    withOpencode = true;
    const c = context(cwd);
    const oc = c.adapters.opencode as OpencodeAdapter;
    const fake = (oc as unknown as { cli: FakeOpencode }).cli;
    fake.sessions.set('ses_1', {
      info: { id: 'ses_1', directory: cwd, time: { created: 1, updated: 2 } },
      messages: [
        { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hello' }] },
        { info: { id: 'msg_2', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    } as OcSession);
    await new Store(path.join(root, 'wh')).loadOrCreateForCwd(cwd);
    const payload = JSON.stringify({ type: 'session.idle', sessionID: 'ses_1', cwd });
    expect(await main(['node', 'wormhole', 'hook', 'opencode', payload], { ...deps(), context: () => c })).toBe(0);
    const thread = (await new Store(path.join(root, 'wh')).loadForCwd(cwd))!;
    expect(thread.segments.map((s) => `${s.tool}:${s.nativeId}`)).toEqual(['opencode:ses_1']);
  });
});
