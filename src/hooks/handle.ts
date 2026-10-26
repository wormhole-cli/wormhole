import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type Context, defaultContext, sync } from '../core.js';
import type { Tool } from '../model/thread.js';
import { wormholeHome } from '../store/store.js';

/** Marks the argv of a notify program wormhole wrapped, so it can be chained and restored. */
export const THEN = '--then';

export interface HookInput {
  tool: Tool;
  cwd: string;
  session: string;
}

/** Claude Code SessionEnd sends {session_id, transcript_path, cwd, reason, …} on stdin. */
export function parseClaudeHook(stdin: string): HookInput | null {
  try {
    const p = JSON.parse(stdin) as { session_id?: string; cwd?: string };
    return p.session_id && p.cwd ? { tool: 'claude', cwd: p.cwd, session: p.session_id } : null;
  } catch {
    return null;
  }
}

/** Codex notify passes {type: "agent-turn-complete", "thread-id", cwd, …} as the last argument. */
export function parseCodexNotify(payload: string | undefined): HookInput | null {
  try {
    const p = JSON.parse(payload ?? '') as { type?: string; 'thread-id'?: string; cwd?: string };
    if (p.type !== 'agent-turn-complete' || !p['thread-id'] || !p.cwd) return null;
    return { tool: 'codex', cwd: p.cwd, session: p['thread-id'] };
  } catch {
    return null;
  }
}

/**
 * Import one session's new turns into its project's thread. Projects without a
 * thread, and sessions the adapter cannot find, are left alone.
 */
export async function importFromHook(input: HookInput, base: Context = defaultContext(input.cwd)): Promise<number> {
  if (!(await base.store.loadForCwd(input.cwd))) return 0;
  // Only the reporting tool: probing the others (opencode spawns a CLI) would slow every turn.
  const ctx: Context = { ...base, cwd: input.cwd, adapters: { [input.tool]: base.adapters[input.tool] } };
  // Tools also report helper threads wormhole does not follow (Codex subagents, unsaved threads).
  if (!(await base.adapters[input.tool]?.locate(input.cwd, input.session))) return 0;
  const { imported } = await sync(ctx, { tool: input.tool, session: input.session });
  return imported.reduce((n, i) => n + i.events, 0);
}

/** Run the notify program wormhole wrapped, without waiting for it. */
export function runChained(argv: string[], payload: string | undefined) {
  const [bin, ...args] = argv;
  if (!bin) return;
  const child = spawn(bin, payload === undefined ? args : [...args, payload], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Hooks must never disturb the tool that called them: failures go to a log file. */
export async function logHookError(err: unknown) {
  const line = `${new Date().toISOString()} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
  const file = path.join(wormholeHome(), 'hook.log');
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await fs.appendFile(file, line).catch(() => {});
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
