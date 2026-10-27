import { readdirSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import type { Context } from '../src/core.js';
import { type OcSession, OpencodeAdapter } from '../src/adapters/opencode.js';
import { importFromHook, parseClaudeHook, parseCodexNotify, parseOpencodeHook } from '../src/hooks/handle.js';
import {
  chainedFrom,
  findNotify,
  hasClaudeHook,
  hasCodexNotify,
  OPENCODE_MARKER,
  opencodePlugin,
  opencodePluginFormat,
  parseTomlStrings,
  withClaudeHook,
  withCodexNotify,
  withoutClaudeHook,
  withoutCodexNotify,
} from '../src/hooks/install.js';
import { eventTool } from '../src/model/thread.js';
import { Store } from '../src/store/store.js';

const self = ['/usr/local/bin/node', '/opt/wormhole/bin/wormhole.js'];

describe('Claude settings', () => {
  const other = { hooks: [{ type: 'command', command: '/x/cc-status' }] };

  it('adds the SessionEnd hook once and keeps other hooks', () => {
    const before = { model: 'opus', hooks: { SessionEnd: [other], Stop: [other] } };
    const once = withClaudeHook(before, self);
    const twice = withClaudeHook(once, self);
    expect(twice).toEqual(once);
    expect(once.model).toBe('opus');
    expect(once.hooks!.Stop).toEqual([other]);
    expect(once.hooks!.SessionEnd).toEqual([
      other,
      { hooks: [{ type: 'command', command: '/usr/local/bin/node /opt/wormhole/bin/wormhole.js hook claude' }] },
    ]);
    expect(hasClaudeHook(once)).toBe(true);
  });

  it('quotes paths with spaces', () => {
    const s = withClaudeHook({}, ['/Applications/My Node/node', '/w/wormhole.js']);
    expect(s.hooks!.SessionEnd![0]!.hooks[0]!.command).toBe("'/Applications/My Node/node' /w/wormhole.js hook claude");
    expect(hasClaudeHook(s)).toBe(true);
  });

  it('removes only its own hook and tidies empty containers', () => {
    expect(withoutClaudeHook(withClaudeHook({ hooks: { SessionEnd: [other] } }, self))).toEqual({
      hooks: { SessionEnd: [other] },
    });
    expect(withoutClaudeHook(withClaudeHook({ theme: 'dark' }, self))).toEqual({ theme: 'dark' });
  });
});

describe('Codex config.toml', () => {
  const computerUse = '/Apps/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient';
  const config = [
    'model = "gpt-6"',
    `notify = ["${computerUse}", "turn-ended"]`,
    '',
    '[projects."/a"]',
    'notify = "not top level"',
  ].join('\n');

  it('parses TOML string arrays', () => {
    expect(parseTomlStrings(` ["a", 'b c', "q\\"x"]`)).toEqual(['a', 'b c', 'q"x']);
  });

  it('only sees the top-level notify', () => {
    expect(findNotify(['[t]', 'notify = ["x"]'])).toBeNull();
    expect(findNotify(['notify = [', '  "a",', '  "b"', ']', '[t]'])).toEqual({ start: 0, end: 4, argv: ['a', 'b'] });
  });

  it('wraps an existing notify program and restores it on uninstall', () => {
    const installed = withCodexNotify(config, self);
    const argv = findNotify(installed.split('\n'))!.argv;
    expect(argv).toEqual([...self, 'hook', 'codex', '--then', computerUse, 'turn-ended']);
    expect(installed).toContain('[projects."/a"]\nnotify = "not top level"');
    expect(withCodexNotify(installed, self)).toBe(installed);
    expect(hasCodexNotify(installed)).toBe(true);
    expect(withoutCodexNotify(installed)).toBe(config);
  });

  it('adds notify before the first table when there is none, and removes it again', () => {
    const plain = 'model = "gpt-6"\n\n[projects."/a"]\ntrust_level = "trusted"';
    const installed = withCodexNotify(plain, self);
    const lines = installed.split('\n');
    expect(lines.findIndex((l) => l.startsWith('notify'))).toBeLessThan(lines.findIndex((l) => l.startsWith('[')));
    expect(chainedFrom(findNotify(lines)!.argv)).toEqual([]);
    expect(findNotify(withoutCodexNotify(installed).split('\n'))).toBeNull();
    const entry = 'notify = ["/usr/local/bin/node", "/opt/wormhole/bin/wormhole.js", "hook", "codex"]\n';
    expect(withCodexNotify('', self)).toBe(entry);
    expect(withCodexNotify('model = "x"', self)).toBe(`model = "x"\n${entry}`);
  });

  it('leaves a notify it does not own alone on uninstall', () => {
    expect(withoutCodexNotify(config)).toBe(config);
  });
});

describe('hook payloads', () => {
  it('reads Claude SessionEnd input', () => {
    expect(parseClaudeHook('{"session_id":"s1","cwd":"/p","reason":"exit"}')).toEqual({ tool: 'claude', cwd: '/p', session: 's1' });
    expect(parseClaudeHook('not json')).toBeNull();
  });

  it('reads Codex notify payloads and ignores other events', () => {
    expect(parseCodexNotify('{"type":"agent-turn-complete","thread-id":"t1","turn-id":"x","cwd":"/p"}')).toEqual({
      tool: 'codex',
      cwd: '/p',
      session: 't1',
    });
    expect(parseCodexNotify('{"type":"approval-requested","thread-id":"t1","cwd":"/p"}')).toBeNull();
    expect(parseCodexNotify(undefined)).toBeNull();
  });

  it('reads the opencode plugin payload and ignores other events', () => {
    expect(parseOpencodeHook('{"type":"session.idle","sessionID":"ses_1","cwd":"/p"}')).toEqual({
      tool: 'opencode',
      cwd: '/p',
      session: 'ses_1',
    });
    expect(parseOpencodeHook('{"type":"session.status","sessionID":"ses_1","cwd":"/p"}')).toBeNull();
    expect(parseOpencodeHook('{"type":"session.idle","cwd":"/p"}')).toBeNull();
    expect(parseOpencodeHook(undefined)).toBeNull();
  });
});

describe('opencode plugin', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wormhole-plugin-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Load the generated plugin with a fake wormhole that records its argv, one file per call. */
  async function load(binary = process.execPath) {
    const recorder = path.join(root, 'record.cjs');
    await writeFile(
      recorder,
      `const fs = require('fs'); fs.writeFileSync(require('path').join(${JSON.stringify(root)}, 'call-' + Date.now() + '-' + process.pid), JSON.stringify(process.argv.slice(2)));`,
    );
    const file = path.join(root, 'wormhole.mjs');
    await writeFile(file, opencodePlugin([binary, recorder]));
    const mod = (await import(file)) as { WormholePlugin: (i: { directory: string }) => Promise<{ event: (e: unknown) => Promise<void> }> };
    return mod.WormholePlugin({ directory: '/instance' });
  }
  const calls = async () => {
    for (let i = 0; i < 100; i++) {
      const files = readdirSync(root).filter((f) => f.startsWith('call-'));
      if (files.length > 0) return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(root, f), 'utf8')) as string[]));
      await new Promise((r) => setTimeout(r, 50));
    }
    return [];
  };

  it('starts with the marker uninstall looks for', () => {
    expect(opencodePlugin(self).split('\n')[0]).toBe(OPENCODE_MARKER);
  });

  it('runs wormhole hook opencode on session.idle with the session directory', async () => {
    const hooks = await load();
    const event = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
    await event('session.created', { info: { id: 'ses_main', directory: '/proj' } });
    await event('message.updated', { info: { role: 'assistant' } });
    await event('session.idle', { sessionID: 'ses_main' });
    const [argv] = await calls();
    expect(argv!.slice(0, 2)).toEqual(['hook', 'opencode']);
    expect(parseOpencodeHook(argv![2])).toEqual({ tool: 'opencode', cwd: '/proj', session: 'ses_main' });
  });

  it('skips subagent sessions and falls back to the instance directory', async () => {
    const hooks = await load();
    const event = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
    await event('session.updated', { info: { id: 'ses_child', directory: '/proj', parentID: 'ses_main' } });
    await event('session.idle', { sessionID: 'ses_child' });
    await event('session.idle', {});
    await event('session.idle', { sessionID: 'ses_unknown' });
    const all = await calls();
    expect(all.map((a) => parseOpencodeHook(a[2])?.session)).toEqual(['ses_unknown']);
    expect(parseOpencodeHook(all[0]![2])!.cwd).toBe('/instance');
  });

  it('never throws into opencode', async () => {
    const hooks = await load(path.join(root, 'no-such-node'));
    await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } })).resolves.toBeUndefined();
    await expect(hooks.event({ event: null })).resolves.toBeUndefined();
    // The spawn error arrives later; an unhandled one would fail the run.
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe('opencode 2.x plugin', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wormhole-plugin2-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Load the 2.x plugin, feed it events through a fake ctx.event.subscribe, collect the wormhole calls. */
  async function run(events: unknown[], binary = process.execPath) {
    const recorder = path.join(root, 'record.cjs');
    await writeFile(
      recorder,
      `const fs = require('fs'); fs.writeFileSync(require('path').join(${JSON.stringify(root)}, 'call-' + Date.now() + '-' + process.pid), JSON.stringify(process.argv.slice(2)));`,
    );
    const file = path.join(root, 'wormhole.mjs');
    await writeFile(file, opencodePlugin([binary, recorder], 2));
    const mod = (await import(file)) as { default: { id: string; setup: (ctx: unknown) => () => void } };
    expect(mod.default.id).toBe('wormhole');
    let aborted = false;
    const ctx = {
      location: { directory: '/instance' },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          signal.addEventListener('abort', () => (aborted = true));
          for (const e of events) yield e;
        },
      },
    };
    const stop = mod.default.setup(ctx);
    const out: string[][] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const files = readdirSync(root).filter((f) => f.startsWith('call-'));
      if (files.length >= 2 || (files.length > 0 && i > 10)) {
        for (const f of files) out.push(JSON.parse(await readFile(path.join(root, f), 'utf8')) as string[]);
        break;
      }
    }
    stop();
    expect(aborted).toBe(true);
    return out;
  }

  it('is written for the API of the installed opencode', () => {
    expect(opencodePluginFormat(opencodePlugin(self, 2))).toBe(2);
    expect(opencodePluginFormat(opencodePlugin(self, 1))).toBe(1);
    expect(opencodePlugin(self, 2).split('\n')[0]).toBe(OPENCODE_MARKER);
  });

  it('runs wormhole hook opencode when a turn finishes', async () => {
    const calls = await run([
      { type: 'session.step.ended', data: { sessionID: 'ses_a' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'ses_a' }, location: { directory: '/proj' } },
      { type: 'session.execution.failed', data: { sessionID: 'ses_b' } },
      { type: 'session.execution.succeeded', data: {} },
      null,
    ]);
    const inputs = calls.map((argv) => (expect(argv.slice(0, 2)).toEqual(['hook', 'opencode']), parseOpencodeHook(argv[2])));
    expect(inputs.sort((x, y) => x!.session.localeCompare(y!.session))).toEqual([
      { tool: 'opencode', cwd: '/proj', session: 'ses_a' },
      { tool: 'opencode', cwd: '/instance', session: 'ses_b' },
    ]);
  });

  it('never throws into opencode', async () => {
    expect(await run([{ type: 'session.execution.succeeded', data: { sessionID: 's' } }], path.join(root, 'no-such-node'))).toEqual([]);
  });
});

describe('importFromHook', () => {
  let root: string;
  let ctx: Context;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wormhole-hooks-'));
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    ctx = {
      cwd,
      store: new Store(path.join(root, 'wh')),
      adapters: { claude: new ClaudeAdapter({ configDir: path.join(root, 'claude'), version: '9.9.9' }) },
    };
    const dir = path.join(root, 'claude', 'projects', encodeCwd(cwd));
    await mkdir(dir, { recursive: true });
    file = path.join(dir, 's1.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does nothing for a project without a thread', async () => {
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(0);
    expect(await ctx.store.loadForCwd(ctx.cwd)).toBeNull();
  });

  it('skips sessions it cannot find instead of failing', async () => {
    await ctx.store.loadOrCreateForCwd(ctx.cwd);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 'missing' }, ctx)).toBe(0);
    expect((await ctx.store.loadForCwd(ctx.cwd))!.segments).toEqual([]);
  });

  it('never adopts a Codex subagent thread', async () => {
    const home = path.join(root, 'codex');
    const dir = path.join(home, 'sessions', '2026', '10', '26');
    await mkdir(dir, { recursive: true });
    const meta = (id: string, source: unknown) =>
      `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: ctx.cwd, timestamp: 't', source } })}\n`;
    await writeFile(path.join(dir, 'rollout-2026-10-26T10-00-00-main.jsonl'), meta('main', 'cli'));
    await writeFile(path.join(dir, 'rollout-2026-10-26T11-00-00-guard.jsonl'), meta('guard', { subagent: { other: 'guardian' } }));
    const codex = new CodexAdapter({ home, cliVersion: '0.159.2' });
    expect((await codex.detectLatest(ctx.cwd))?.nativeId).toBe('main');
    expect(await codex.locate(ctx.cwd, 'guard')).toBeNull();

    const withCodex: Context = { ...ctx, adapters: { codex } };
    await ctx.store.loadOrCreateForCwd(ctx.cwd);
    expect(await importFromHook({ tool: 'codex', cwd: ctx.cwd, session: 'guard' }, withCodex)).toBe(0);
    expect((await ctx.store.loadForCwd(ctx.cwd))!.segments).toEqual([]);
  });

  it('imports new turns into an existing thread', async () => {
    await ctx.store.loadOrCreateForCwd(ctx.cwd);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(1);
    await appendFile(file, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } })}\n`);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(1);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(0);
  });
});

describe('importFromHook with opencode', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wormhole-hooks-oc-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('imports finished turns of a session that exists, and skips one that does not', async () => {
    const cwd = path.join(root, 'project');
    const session: OcSession = {
      info: { id: 'ses_1', directory: cwd, time: { created: 1, updated: 2 } },
      messages: [
        { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { id: 'msg_2', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'yo' }] },
      ],
    } as OcSession;
    const exported: string[] = [];
    const cli = {
      list: async () => [],
      export: async (_cwd: string, id: string) => (exported.push(id), id === 'ses_1' ? structuredClone(session) : null),
      import: async () => {},
    };
    const claude = { locate: () => { throw new Error('only the reporting tool is asked'); } };
    const ctx = {
      cwd,
      store: new Store(path.join(root, 'wh')),
      adapters: { opencode: new OpencodeAdapter({ cli, model: 'p/m' }), claude },
    } as unknown as Context;

    expect(await importFromHook({ tool: 'opencode', cwd, session: 'ses_1' }, ctx)).toBe(0);
    expect(exported).toEqual([]);
    await ctx.store.loadOrCreateForCwd(cwd);
    expect(await importFromHook({ tool: 'opencode', cwd, session: 'nope' }, ctx)).toBe(0);
    expect(await importFromHook({ tool: 'opencode', cwd, session: 'ses_1' }, ctx)).toBe(2);
    expect((await ctx.store.loadForCwd(cwd))!.segments.map((s) => `${s.tool}:${s.nativeId}`)).toEqual(['opencode:ses_1']);
  });
});

describe('eventTool', () => {
  const segments = [
    { tool: 'claude' as const, nativeId: 'c', path: '', startedAt: '', importedUpTo: 0, eventStart: 0 },
    { tool: 'codex' as const, nativeId: 'x', path: '', startedAt: '', importedUpTo: 0, eventStart: 2, derivedFrom: { tool: 'claude' as const, nativeId: 'c' } },
  ];

  it('labels an event by the session it came from, not by position', () => {
    // A Claude turn imported after the Codex handoff sits past Codex's eventStart.
    expect(eventTool({ kind: 'user_text', text: 'late', src: 'claude:c' }, 5, segments)).toBe('claude');
    expect(eventTool({ kind: 'user_text', text: 'x', src: 'codex:x' }, 5, segments)).toBe('codex');
  });

  it('falls back to segment ranges for untagged events', () => {
    expect(eventTool({ kind: 'user_text', text: 'old' }, 1, segments)).toBe('claude');
    expect(eventTool({ kind: 'user_text', text: 'old' }, 3, segments)).toBe('codex');
  });
});
