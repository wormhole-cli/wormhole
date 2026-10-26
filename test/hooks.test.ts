import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, encodeCwd } from '../src/adapters/claude.js';
import type { Context } from '../src/core.js';
import { importFromHook, parseClaudeHook, parseCodexNotify } from '../src/hooks/handle.js';
import {
  chainedFrom,
  findNotify,
  hasClaudeHook,
  hasCodexNotify,
  parseTomlStrings,
  withClaudeHook,
  withCodexNotify,
  withoutClaudeHook,
  withoutCodexNotify,
} from '../src/hooks/install.js';
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

  it('imports new turns into an existing thread', async () => {
    await ctx.store.loadOrCreateForCwd(ctx.cwd);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(1);
    await appendFile(file, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } })}\n`);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(1);
    expect(await importFromHook({ tool: 'claude', cwd: ctx.cwd, session: 's1' }, ctx)).toBe(0);
  });
});
