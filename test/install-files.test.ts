import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logHookError, runChained } from '../src/hooks/handle.js';
import {
  claudeSettingsPath,
  codexConfigPath,
  install,
  OPENCODE_MARKER,
  opencodeOnPath,
  opencodePluginPath,
  selfArgv,
  status,
  uninstall,
} from '../src/hooks/install.js';

let root: string;
let env: NodeJS.ProcessEnv;
const self = ['/usr/bin/node', '/opt/wormhole/bin/wormhole.js'];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-install-'));
  env = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  process.env.WORMHOLE_HOME = path.join(root, 'wh');
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
});
afterEach(async () => {
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

describe('config paths', () => {
  it('follow CLAUDE_CONFIG_DIR and CODEX_HOME, treating empty as unset', () => {
    expect(claudeSettingsPath()).toBe(path.join(root, 'claude', 'settings.json'));
    expect(codexConfigPath()).toBe(path.join(root, 'codex', 'config.toml'));
    process.env.CODEX_HOME = '';
    expect(codexConfigPath().replaceAll('\\', '/')).toMatch(/\.codex\/config\.toml$/);
  });

  it('names the running node and script for hooks', () => {
    const [node, script] = selfArgv();
    expect(node).toBe(process.execPath);
    expect(path.isAbsolute(script!)).toBe(true);
  });
});

describe('install and uninstall on disk', () => {
  const settings = { theme: 'dark', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: '/x/cc-status' }] }] } };
  const toml = 'model = "gpt"\nnotify = ["/bin/old", "turn-ended"]\n\n[projects."/a"]\ntrust_level = "trusted"\n';

  beforeEach(async () => {
    await mkdir(path.join(root, 'claude'), { recursive: true });
    await mkdir(path.join(root, 'codex'), { recursive: true });
    await writeFile(claudeSettingsPath(), JSON.stringify(settings, null, 2));
    await writeFile(codexConfigPath(), toml);
  });

  it('installs both hooks, keeping a backup of each original once', async () => {
    const lines = await install(['claude', 'codex'], self);
    expect(lines).toEqual([
      `Claude Code: SessionEnd hook in ${claudeSettingsPath()}`,
      `Codex: notify in ${codexConfigPath()} (still runs old)`,
    ]);
    expect(await status()).toEqual({ claude: true, codex: true, opencode: false });
    expect(JSON.parse(await readFile(`${claudeSettingsPath()}.before-wormhole`, 'utf8'))).toEqual(settings);
    expect(await readFile(`${codexConfigPath()}.before-wormhole`, 'utf8')).toBe(toml);

    // A second install changes nothing and keeps the first backup.
    const once = await readFile(codexConfigPath(), 'utf8');
    await install(['claude', 'codex'], self);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(once);
    expect(await readFile(`${codexConfigPath()}.before-wormhole`, 'utf8')).toBe(toml);
  });

  it('uninstalls back to the original files', async () => {
    await install(['claude', 'codex'], self);
    expect(await uninstall(['claude', 'codex'])).toHaveLength(2);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(toml);
    expect(JSON.parse(await readFile(claudeSettingsPath(), 'utf8'))).toEqual(settings);
    expect(await status()).toEqual({ claude: false, codex: false, opencode: false });
    expect(await uninstall(['claude', 'codex'])).toEqual([]);
  });

  it('installs one tool at a time', async () => {
    await install(['codex'], self);
    expect(await status()).toEqual({ claude: false, codex: true, opencode: false });
  });
});

describe('install without existing files', () => {
  it('creates the config files', async () => {
    await install(['claude', 'codex'], self);
    expect(await status()).toEqual({ claude: true, codex: true, opencode: false });
    expect(existsSync(`${claudeSettingsPath()}.before-wormhole`)).toBe(false);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(
      'notify = ["/usr/bin/node", "/opt/wormhole/bin/wormhole.js", "hook", "codex"]\n',
    );
  });

  it('reports nothing installed when there are no files', async () => {
    expect(await status()).toEqual({ claude: false, codex: false, opencode: false });
  });
});

describe('opencode plugin on disk', () => {
  it('follows XDG_CONFIG_HOME', () => {
    expect(opencodePluginPath()).toBe(path.join(root, 'xdg', 'opencode', 'plugins', 'wormhole.js'));
    process.env.XDG_CONFIG_HOME = '';
    expect(opencodePluginPath().replaceAll('\\', '/')).toMatch(/\.config\/opencode\/plugins\/wormhole\.js$/);
  });

  it('writes, reports and removes only its own plugin file', async () => {
    const other = path.join(path.dirname(opencodePluginPath()), 'mine.js');
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, 'export const Mine = async () => ({});\n');

    expect(await install(['opencode'], self)).toEqual([`opencode: plugin ${opencodePluginPath()}`]);
    const text = await readFile(opencodePluginPath(), 'utf8');
    expect(text.startsWith(OPENCODE_MARKER)).toBe(true);
    expect(text).toContain(JSON.stringify(self));
    expect(await status()).toEqual({ claude: false, codex: false, opencode: true });
    await install(['opencode'], self);
    expect(await readFile(opencodePluginPath(), 'utf8')).toBe(text);

    expect(await uninstall(['opencode'])).toEqual([`opencode: removed plugin ${opencodePluginPath()}`]);
    expect(existsSync(opencodePluginPath())).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(await uninstall(['opencode'])).toEqual([]);
  });

  it('leaves a wormhole.js it did not write alone', async () => {
    await mkdir(path.dirname(opencodePluginPath()), { recursive: true });
    await writeFile(opencodePluginPath(), '// someone else\n');
    await expect(install(['opencode'], self)).rejects.toThrow('was not written by wormhole');
    expect(await uninstall(['opencode'])).toEqual([]);
    expect(await readFile(opencodePluginPath(), 'utf8')).toBe('// someone else\n');
    expect((await status()).opencode).toBe(false);
  });

  it('finds opencode on PATH only as an executable', async () => {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    process.env.PATH = bin;
    expect(await opencodeOnPath()).toBe(false);
    // A plain file does not count: no execute bit, or (Windows) no PATHEXT extension.
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\n');
    expect(await opencodeOnPath()).toBe(false);
    if (process.platform === 'win32') await writeFile(path.join(bin, 'opencode.cmd'), '@exit /b 0\r\n');
    else await chmod(path.join(bin, 'opencode'), 0o755);
    expect(await opencodeOnPath()).toBe(true);
    delete process.env.PATH;
    expect(await opencodeOnPath()).toBe(false);
  });
});

describe('hook runtime helpers', () => {
  it('starts the chained program with the payload last, without waiting', async () => {
    const marker = path.join(root, 'chained.txt');
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join('|'))`;
    runChained([process.execPath, '-e', script, 'turn-ended'], '{"p":1}');
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(marker, 'utf8')).toBe('turn-ended|{"p":1}');
  });

  it('ignores an empty or missing chained program', () => {
    expect(() => runChained([], '{}')).not.toThrow();
    expect(() => runChained(['wormhole-no-such-program'], undefined)).not.toThrow();
  });

  it('appends failures to hook.log', async () => {
    await logHookError(new Error('first'));
    await logHookError('second');
    const log = await readFile(path.join(root, 'wh', 'hook.log'), 'utf8');
    expect(log).toContain('Error: first');
    expect(log).toMatch(/Z second\n$/);
  });
});
