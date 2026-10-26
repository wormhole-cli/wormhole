import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliVersion, newestByMtime } from '../src/adapters/jsonl.js';
import { gitInfo } from '../src/handoff/git.js';
import { launch, openUrl, shellLine, splitEnv } from '../src/launch.js';
import { capture, findOnPath } from '../src/proc.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-sys-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('launch', () => {
  it('returns the program’s exit code', async () => {
    expect(await launch([process.execPath, '-e', 'process.exit(3)'], root)).toBe(3);
    expect(await launch([process.execPath, '-e', ''], root)).toBe(0);
  });

  it('runs in the given directory', async () => {
    const out = path.join(root, 'cwd.txt');
    await launch([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.cwd())`], root);
    const { realpathSync, readFileSync } = await import('node:fs');
    expect(readFileSync(out, 'utf8')).toBe(realpathSync(root));
  });

  it('explains a missing program', async () => {
    await expect(launch(['wormhole-no-such-program'], root)).rejects.toThrow('wormhole-no-such-program is not on PATH');
    expect(await launch([], root)).toBe(1);
  });

  it('quotes arguments for printing', () => {
    expect(shellLine(['codex', 'resume', 'abc-123'], 'linux')).toBe('codex resume abc-123');
    expect(shellLine(['open', "it's here", 'a b'], 'darwin')).toBe(`open 'it'\\''s here' 'a b'`);
    expect(shellLine(['env', 'CODEX_HOME=/x/y', 'codex', 'resume', 'id'], 'linux')).toBe('env CODEX_HOME=/x/y codex resume id');
    // PowerShell on Windows: variables set first, single quotes doubled.
    expect(shellLine(['env', "CLAUDE_CONFIG_DIR=C:\\U\\o'k", 'claude', '--resume', 'id'], 'win32')).toBe(
      "$env:CLAUDE_CONFIG_DIR='C:\\U\\o''k'; claude --resume id",
    );
    expect(shellLine(['codex', 'it is'], 'win32')).toBe("codex 'it is'");
  });

  it('opens links with the platform opener', async () => {
    const seen: string[][] = [];
    const run = async (argv: string[]) => (seen.push(argv), 0);
    await openUrl('codex://threads/x', run, 'darwin');
    await openUrl('codex://threads/x', run, 'linux');
    await openUrl('codex://threads/x', run, 'win32');
    expect(seen.map((a) => a[0])).toEqual(['open', 'xdg-open', 'explorer']);
    expect(seen[0]).toEqual(['open', 'codex://threads/x']);
  });
});

describe('cliVersion and newestByMtime', () => {
  it('reads a version number, falling back when the program is missing', async () => {
    expect(await cliVersion(process.execPath, 'x')).toBe(process.versions.node);
    expect(await cliVersion('wormhole-no-such-program', '1.2.3')).toBe('1.2.3');
  });

  it('picks the most recently modified file and skips missing ones', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await writeFile(a, '');
    await writeFile(b, '');
    const { utimes } = await import('node:fs/promises');
    await utimes(a, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect((await newestByMtime([b, a, path.join(root, 'gone')]))?.file).toBe(a);
    expect(await newestByMtime([])).toBeNull();
  });
});

describe('gitInfo', () => {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
    });

  it('is null outside a repository', async () => {
    expect(await gitInfo(root)).toBeNull();
  });

  it('reports branch, uncommitted changes, diff stat and recent commits', async () => {
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first commit');
    await writeFile(path.join(root, 'a.txt'), 'two\n');
    await writeFile(path.join(root, 'new.txt'), 'x');

    const info = (await gitInfo(root))!;
    expect(info.branch).toBe('main');
    expect(info.status).toEqual([' M a.txt', '?? new.txt']);
    expect(info.diffStat).toContain('a.txt');
    expect(info.recentCommits).toHaveLength(1);
    expect(info.recentCommits[0]).toMatch(/^[0-9a-f]+ first commit$/);
  });

  it('caps a long status list', async () => {
    git('init', '-q');
    for (let i = 0; i < 45; i++) await writeFile(path.join(root, `f${String(i).padStart(2, '0')}.txt`), '');
    const info = (await gitInfo(root))!;
    expect(info.status).toHaveLength(41);
    expect(info.status.at(-1)).toBe('… 5 more');
    expect(info.recentCommits).toEqual([]);
  });
});

describe('finding and running programs', () => {
  it('finds executables on PATH, with PATHEXT extensions on Windows', async () => {
    const { chmod } = await import('node:fs/promises');
    await writeFile(path.join(root, 'tool'), '');
    await writeFile(path.join(root, 'tool.CMD'), '');
    // POSIX: only an executable file counts (Windows has no execute bit to check).
    if (process.platform !== 'win32') {
      expect(await findOnPath('tool', { PATH: root }, 'linux')).toBeNull();
      await chmod(path.join(root, 'tool'), 0o755);
      expect(await findOnPath('tool', { PATH: root }, 'linux')).toBe(path.join(root, 'tool'));
    }
    // Windows: a name matches with an extension from PATHEXT; `Path` works as the variable name.
    expect(await findOnPath('tool', { Path: root, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(root, 'tool.cmd'));
    expect(await findOnPath('tool.CMD', { Path: root }, 'win32')).toBe(path.join(root, 'tool.CMD'));
    expect(await findOnPath('missing', { PATH: root }, 'win32')).toBeNull();
    expect(await findOnPath('tool', {}, 'linux')).toBeNull();
  });

  it('captures output, exit codes and timeouts; null for a missing program', async () => {
    expect(await capture(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(2)'])).toMatchObject({ code: 2, stdout: 'hi', timedOut: false });
    expect(await capture(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 })).toMatchObject({ timedOut: true });
    expect(await capture('wormhole-no-such-program', [])).toBeNull();
  });

  it('launches with variables from a leading env prefix', async () => {
    const out = path.join(root, 'env.txt');
    const code = await launch(
      ['env', 'WORMHOLE_TEST_A=1', `WORMHOLE_TEST_B=x y`, process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.WORMHOLE_TEST_A + process.env.WORMHOLE_TEST_B)`],
      root,
    );
    expect(code).toBe(0);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(out, 'utf8')).toBe('1x y');
    expect(splitEnv(['env', 'A=1', 'cmd', 'B=2'])).toEqual({ env: { A: '1' }, command: ['cmd', 'B=2'] });
    expect(splitEnv(['cmd'])).toEqual({ env: {}, command: ['cmd'] });
  });
});
