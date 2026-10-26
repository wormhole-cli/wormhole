import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativeRef } from '../src/adapters/types.js';
import { buildBrief } from '../src/handoff/brief.js';
import { parseOpencodeEvents, type RunOptions, runCapture, summarize, SUMMARY_PROMPT } from '../src/handoff/summary.js';
import type { Tool } from '../src/model/thread.js';

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wormhole-summary-test-'));
  env = { ...process.env };
});

afterEach(async () => {
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

const ref = (tool: Tool, p = ''): NativeRef => ({ tool, nativeId: 'S1', path: p, startedAt: '', updatedAt: '' });

describe('summarize', () => {
  it('asks Claude on a fork that is not persisted, with tools off', async () => {
    const calls: [string[], RunOptions][] = [];
    const text = await summarize(ref('claude'), '/proj', async (argv, opts) => {
      calls.push([argv, opts]);
      return { code: 0, stdout: '  summary  \n', stderr: '' };
    });
    expect(text).toBe('summary');
    const [argv, opts] = calls[0]!;
    expect(argv).toEqual([
      'claude', '-p', SUMMARY_PROMPT, '--resume', 'S1', '--fork-session', '--no-session-persistence',
      '--output-format', 'text', '--tools', '',
    ]);
    expect(opts).toEqual({ cwd: '/proj', timeoutMs: 120_000 });
  });

  it('runs Codex on a copy of the rollout in a throwaway CODEX_HOME', async () => {
    const realHome = path.join(root, 'codex');
    await mkdir(realHome);
    await writeFile(path.join(realHome, 'auth.json'), '{}');
    process.env.CODEX_HOME = realHome;
    const rollout = path.join(root, 'rollout-x-S1.jsonl');
    await writeFile(rollout, 'original\n');

    let home = '';
    const text = await summarize(ref('codex', rollout), '/proj', async (argv, opts) => {
      home = opts.env!.CODEX_HOME!;
      expect(argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
      expect(argv).toContain('notify=[]');
      expect(argv.slice(-2)).toEqual(['S1', SUMMARY_PROMPT]);
      const copy = path.join(home, 'sessions', 'rollout-x-S1.jsonl');
      expect(await readFile(copy, 'utf8')).toBe('original\n');
      expect(await readlink(path.join(home, 'auth.json'))).toBe(path.join(realHome, 'auth.json'));
      await writeFile(copy, 'original\nsummary turn\n');
      await writeFile(argv[argv.indexOf('-o') + 1]!, 'codex summary\n');
      return { code: 0, stdout: '', stderr: '' };
    });
    expect(text).toBe('codex summary');
    expect(await readFile(rollout, 'utf8')).toBe('original\n');
    expect(existsSync(home)).toBe(false);
  });

  it('reports a Codex run that wrote no last message', async () => {
    const rollout = path.join(root, 'r.jsonl');
    await writeFile(rollout, '');
    await expect(summarize(ref('codex', rollout), '/proj', async () => ({ code: 0, stdout: '', stderr: '' }))).rejects.toThrow(
      'codex returned an empty summary',
    );
  });

  it('runs opencode on a fork and deletes the fork', async () => {
    const calls: string[][] = [];
    const text = await summarize(ref('opencode'), '/proj', async (argv) => {
      calls.push(argv);
      if (argv[1] === 'session') throw new Error('delete failed');
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'step_start', sessionID: 'ses_fork' }),
          JSON.stringify({ type: 'text', sessionID: 'ses_fork', part: { type: 'text', text: 'line one' } }),
          'not json',
          JSON.stringify({ type: 'text', sessionID: 'ses_fork', part: { type: 'text', text: 'line two' } }),
        ].join('\n'),
        stderr: '',
      };
    });
    expect(text).toBe('line one\nline two');
    expect(calls[0]).toEqual(['opencode', 'run', '--session', 'S1', '--fork', '--format', 'json', SUMMARY_PROMPT]);
    expect(calls[1]).toEqual(['opencode', 'session', 'delete', 'ses_fork']);
  });

  it('never deletes the original opencode session', async () => {
    const calls: string[][] = [];
    const stdout = JSON.stringify({ type: 'text', sessionID: 'S1', part: { text: 'hi' } });
    await summarize(ref('opencode'), '/proj', async (argv) => (calls.push(argv), { code: 0, stdout, stderr: '' }));
    expect(calls).toHaveLength(1);
  });

  it('fails on a non-zero exit with the last stderr line', async () => {
    const run = async () => ({ code: 2, stdout: 'partial', stderr: 'warn\nboom\n' });
    await expect(summarize(ref('claude'), '/p', run)).rejects.toThrow('claude exited with 2: boom');
    await expect(summarize(ref('claude'), '/p', async () => ({ code: 3, stdout: '', stderr: '' }))).rejects.toThrow(
      /^claude exited with 3$/,
    );
  });
});

describe('parseOpencodeEvents', () => {
  it('returns nothing for empty output', () => {
    expect(parseOpencodeEvents('\n')).toEqual({ text: '', sessionId: undefined });
  });
});

describe('runCapture', () => {
  it('captures output, exit code and env', async () => {
    const r = await runCapture(
      [process.execPath, '-e', 'process.stdout.write(process.env.WH_X); process.stderr.write("e"); process.exit(4)'],
      { cwd: root, timeoutMs: 10_000, env: { ...process.env, WH_X: 'hello' } },
    );
    expect(r).toEqual({ code: 4, stdout: 'hello', stderr: 'e' });
  });

  it('kills a run that takes too long', async () => {
    await expect(
      runCapture([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], { cwd: root, timeoutMs: 200 }),
    ).rejects.toThrow('timed out after 0s');
  });

  it('reports a missing program and an empty command', async () => {
    await expect(runCapture(['wormhole-no-such-bin'], { cwd: root, timeoutMs: 1000 })).rejects.toThrow(
      'wormhole-no-such-bin is not on PATH',
    );
    expect(await runCapture([], { cwd: root, timeoutMs: 1000 })).toEqual({ code: 1, stdout: '', stderr: 'empty command' });
  });
});

describe('buildBrief summary', () => {
  it('adds the summary under its own heading', () => {
    const brief = buildBrief({ events: [], from: ['codex'], to: 'claude', git: null, summary: { tool: 'codex', text: 'S.' } });
    expect(brief).toContain('## Summary from Codex\nS.');
    expect(buildBrief({ events: [], from: ['codex'], to: 'claude', git: null })).not.toContain('Summary from');
  });
});
