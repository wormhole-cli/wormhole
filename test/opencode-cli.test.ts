import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpencodeAdapter } from '../src/adapters/opencode.js';

/**
 * A stand-in `opencode` on PATH: sessions live as JSON files in $FAKE_OPENCODE_DIR.
 * Like the real one, `export` prints a "progress" line on stderr, and output is large
 * enough (> 8 KB) that a pipe-truncation bug would show.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = process.env.FAKE_OPENCODE_DIR;
const [cmd, ...args] = process.argv.slice(2);
const all = () => fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
if (cmd === 'session' && args[0] === 'list') {
  if (process.env.FAKE_OPENCODE_FAIL_LIST) process.exit(2);
  process.stdout.write(JSON.stringify(all().map((s) => ({ id: s.info.id, directory: s.info.directory, projectId: s.info.projectID, created: s.info.time.created, updated: s.info.time.updated }))));
} else if (cmd === 'export') {
  const file = path.join(dir, args[0] + '.json');
  if (!fs.existsSync(file)) { process.stderr.write('Session not found'); process.exit(1); }
  process.stderr.write('Exporting session: ' + args[0]);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
} else if (cmd === 'import') {
  const s = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  fs.writeFileSync(path.join(dir, s.info.id + '.json'), JSON.stringify(s, null, 2));
  process.stdout.write('Imported session: ' + s.info.id);
} else process.exit(64);
`;

let root: string;
let cwd: string;
let store: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-occli-'));
  cwd = path.join(root, 'project');
  store = path.join(root, 'store');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(cwd), mkdir(store), mkdir(bin)]);
  // An executable script on POSIX; on Windows a .cmd wrapper, as npm installs CLIs there.
  await writeFile(path.join(bin, 'opencode.js'), FAKE.replace(/^#!.*\n/, ''));
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'opencode.cmd'), `@"${process.execPath}" "%~dp0opencode.js" %*\r\n`);
  } else {
    await writeFile(path.join(bin, 'opencode'), FAKE);
    await chmod(path.join(bin, 'opencode'), 0o755);
  }
  env = { ...process.env };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_OPENCODE_DIR = store;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  delete process.env.WORMHOLE_OPENCODE_MODEL;
});
afterEach(async () => {
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

const big = 'x'.repeat(20_000);

describe('OpencodeAdapter through the opencode CLI', () => {
  it('imports, lists and exports sessions larger than a pipe buffer', async () => {
    const oc = new OpencodeAdapter({ model: 'p/m' });
    const ref = await oc.write(
      [
        { kind: 'user_text', text: big },
        { kind: 'assistant_text', text: 'done' },
      ],
      { cwd },
    );
    expect(await readdir(store)).toEqual([`${ref.nativeId}.json`]);
    expect((await oc.detectLatest(cwd))?.nativeId).toBe(ref.nativeId);

    const { events, offset } = await oc.read((await oc.locate(cwd, ref.nativeId))!);
    expect(offset).toBe(2);
    expect(events[0]).toMatchObject({ kind: 'user_text', text: big });

    // The temp file handed to `opencode import` is cleaned up.
    expect((await readdir(tmpdir())).some((f) => f.startsWith(`wormhole-${ref.nativeId}`))).toBe(false);
  });

  it('treats a failing export or list as no session', async () => {
    const oc = new OpencodeAdapter({ model: 'p/m' });
    expect(await oc.locate(cwd, 'ses_missing')).toBeNull();
    process.env.FAKE_OPENCODE_FAIL_LIST = '1';
    expect(await oc.detectLatest(cwd)).toBeNull();
  });

  it('extends a copy through the CLI', async () => {
    const oc = new OpencodeAdapter({ model: 'p/m' });
    const ref = await oc.write([{ kind: 'user_text', text: 'start' }], { cwd });
    const copy = await oc.extend(ref, [{ kind: 'assistant_text', text: 'more' }], { cwd });
    const saved = JSON.parse(await readFile(path.join(store, `${copy.nativeId}.json`), 'utf8'));
    expect(saved.messages.map((m: { parts: { text: string }[] }) => m.parts[0]!.text)).toContain('more');
    await expect(oc.extend({ ...ref, nativeId: 'ses_gone' }, [], { cwd })).rejects.toThrow('ses_gone not found');
  });
});

describe('model and project for written sessions', () => {
  it('uses WORMHOLE_OPENCODE_MODEL, then the project’s last model, then opencode’s config', async () => {
    await mkdir(path.join(root, 'config', 'opencode'), { recursive: true });
    await writeFile(path.join(root, 'config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'cfg/model-a' }));
    const oc = new OpencodeAdapter();
    const modelOf = async (id: string) =>
      JSON.parse(await readFile(path.join(store, `${id}.json`), 'utf8')).messages[0].info.model;

    const first = await oc.write([{ kind: 'user_text', text: 'a' }], { cwd });
    expect(await modelOf(first.nativeId)).toEqual({ providerID: 'cfg', modelID: 'model-a' });

    // A later session reuses the model of the last assistant reply in this project.
    const s = JSON.parse(await readFile(path.join(store, `${first.nativeId}.json`), 'utf8'));
    s.messages.push({ info: { id: 'msg_zz', role: 'assistant', providerID: 'used', modelID: 'model-b', time: { created: 1, completed: 1 } }, parts: [] });
    s.info.time.updated = Date.now() + 60_000;
    await writeFile(path.join(store, `${first.nativeId}.json`), JSON.stringify(s));
    const second = await oc.write([{ kind: 'user_text', text: 'b' }], { cwd });
    expect(await modelOf(second.nativeId)).toEqual({ providerID: 'used', modelID: 'model-b' });

    process.env.WORMHOLE_OPENCODE_MODEL = 'env/model-c';
    const third = await oc.write([{ kind: 'user_text', text: 'c' }], { cwd });
    expect(await modelOf(third.nativeId)).toEqual({ providerID: 'env', modelID: 'model-c' });
  });

  it('falls back to a placeholder model without any config', async () => {
    const ref = await new OpencodeAdapter().write([{ kind: 'user_text', text: 'a' }], { cwd });
    const saved = JSON.parse(await readFile(path.join(store, `${ref.nativeId}.json`), 'utf8'));
    expect(saved.messages[0].info.model).toEqual({ providerID: 'opencode', modelID: 'default' });
    expect(saved.info.projectID).toBe('global');
  });

  it('names a git project after its root commit', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
      })
        .toString()
        .trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'root');
    const rootCommit = git('rev-list', '--max-parents=0', 'HEAD');
    const ref = await new OpencodeAdapter({ model: 'p/m' }).write([{ kind: 'user_text', text: 'a' }], { cwd });
    const saved = JSON.parse(await readFile(path.join(store, `${ref.nativeId}.json`), 'utf8'));
    expect(saved.info.projectID).toBe(rootCommit);
  });
});
