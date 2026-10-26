import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeRef } from '../adapters/types.js';
import { spawnProgram } from '../proc.js';

export const SUMMARY_TIMEOUT_MS = 120_000;

export const SUMMARY_PROMPT = [
  'wormhole is handing this session to another coding agent.',
  'Without calling any tools, write a summary of about 10 lines of the work in this conversation (not your standing instructions): the goal, what is done,',
  'decisions and their reasons, what is in progress or left, and anything that would trip up a newcomer.',
  'Reply with the summary only.',
].join(' ');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs a headless CLI to completion and captures its output; tests replace it. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

/**
 * Ask the tool that owns `ref` for a summary of the session, without leaving a turn in it:
 * Claude forks and does not persist, Codex runs ephemeral, opencode forks and the fork is
 * deleted afterwards.
 */
export async function summarize(
  ref: NativeRef,
  cwd: string,
  run: Runner,
  timeoutMs = SUMMARY_TIMEOUT_MS,
  /** Points the CLI at a named account's folder (the adapter's `env`). */
  accountEnv: Record<string, string> = {},
): Promise<string> {
  const opts = { cwd, timeoutMs, ...(Object.keys(accountEnv).length > 0 ? { env: { ...process.env, ...accountEnv } } : {}) };
  switch (ref.tool) {
    case 'claude': {
      const r = await run(
        // The prompt goes first: --tools is variadic and would swallow it.
        ['claude', '-p', SUMMARY_PROMPT, '--resume', ref.nativeId, '--fork-session', '--no-session-persistence',
          '--output-format', 'text', '--tools', ''],
        opts,
      );
      return result('claude', r, r.stdout);
    }
    case 'codex': {
      // `codex exec resume` appends to the rollout even with --ephemeral, so it runs in a
      // throwaway CODEX_HOME holding a copy of the rollout, with the real auth and config.
      const home = await fs.mkdtemp(path.join(tmpdir(), 'wormhole-summary-'));
      try {
        const realHome = accountEnv.CODEX_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
        const sessions = path.join(home, 'sessions');
        await fs.mkdir(sessions);
        await fs.copyFile(ref.path, path.join(sessions, path.basename(ref.path)));
        for (const f of ['auth.json', 'config.toml']) {
          await fs.symlink(path.join(realHome, f), path.join(home, f)).catch(() => undefined);
        }
        const file = path.join(home, 'last-message.txt');
        const r = await run(
          ['codex', 'exec', 'resume', '--ephemeral', '--skip-git-repo-check', '-c', 'notify=[]',
            '-c', 'sandbox_mode="read-only"', '-o', file, ref.nativeId, SUMMARY_PROMPT],
          { ...opts, env: { ...process.env, CODEX_HOME: home } },
        );
        return result('codex', r, await fs.readFile(file, 'utf8').catch(() => ''));
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    }
    case 'opencode': {
      const r = await run(['opencode', 'run', '--session', ref.nativeId, '--fork', '--format', 'json', SUMMARY_PROMPT], opts);
      const { text, sessionId } = parseOpencodeEvents(r.stdout);
      if (sessionId && sessionId !== ref.nativeId) {
        await run(['opencode', 'session', 'delete', sessionId], { cwd, timeoutMs: 30_000 }).catch(() => undefined);
      }
      return result('opencode', r, text);
    }
  }
}

function result(bin: string, r: RunResult, text: string): string {
  if (r.code !== 0) throw new Error(`${bin} exited with ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').at(-1)}` : ''}`);
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${bin} returned an empty summary`);
  return trimmed;
}

/** Text parts and the (forked) session id from `opencode run --format json` output. */
export function parseOpencodeEvents(stdout: string): { text: string; sessionId?: string } {
  const texts: string[] = [];
  let sessionId: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; sessionID?: string; part?: { type?: string; text?: string } };
      sessionId ??= e.sessionID;
      if (e.type === 'text' && e.part?.text) texts.push(e.part.text);
    } catch {
      // not an event line
    }
  }
  return { text: texts.join('\n'), sessionId };
}

/** Default Runner: no stdin, output captured, killed after the timeout. */
export function runCapture(argv: string[], { cwd, timeoutMs, env }: RunOptions): Promise<RunResult> {
  const [bin, ...args] = argv;
  if (!bin) return Promise.resolve({ code: 1, stdout: '', stderr: 'empty command' });
  return new Promise((resolve, reject) => {
    const child = spawnProgram(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${bin} is not on PATH`) : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`));
      else resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}
