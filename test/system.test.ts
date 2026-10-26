import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliVersion, newestByMtime } from '../src/adapters/jsonl.js';
import { gitInfo } from '../src/handoff/git.js';
import { launch, openUrl, shellLine } from '../src/launch.js';

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
    expect(shellLine(['codex', 'resume', 'abc-123'])).toBe('codex resume abc-123');
    expect(shellLine(['open', "it's here", 'a b'])).toBe(`open 'it'\\''s here' 'a b'`);
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
