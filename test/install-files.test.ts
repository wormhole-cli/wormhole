import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logHookError, runChained } from '../src/hooks/handle.js';
import { claudeSettingsPath, codexConfigPath, install, selfArgv, status, uninstall } from '../src/hooks/install.js';

let root: string;
let env: NodeJS.ProcessEnv;
const self = ['/usr/bin/node', '/opt/wormhole/bin/wormhole.js'];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-install-'));
  env = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  process.env.WORMHOLE_HOME = path.join(root, 'wh');
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
    expect(codexConfigPath()).toMatch(/\.codex\/config\.toml$/);
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
    expect(await status()).toEqual({ claude: true, codex: true });
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
    expect(await status()).toEqual({ claude: false, codex: false });
    expect(await uninstall(['claude', 'codex'])).toEqual([]);
  });

  it('installs one tool at a time', async () => {
    await install(['codex'], self);
    expect(await status()).toEqual({ claude: false, codex: true });
  });
});

describe('install without existing files', () => {
  it('creates the config files', async () => {
    await install(['claude', 'codex'], self);
    expect(await status()).toEqual({ claude: true, codex: true });
    expect(existsSync(`${claudeSettingsPath()}.before-wormhole`)).toBe(false);
    expect(await readFile(codexConfigPath(), 'utf8')).toBe(
      'notify = ["/usr/bin/node", "/opt/wormhole/bin/wormhole.js", "hook", "codex"]\n',
    );
  });

  it('reports nothing installed when there are no files', async () => {
    expect(await status()).toEqual({ claude: false, codex: false });
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
