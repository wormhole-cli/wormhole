import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadFile } from '../accounts.js';
import type { NativeRef, ToolAdapter } from '../adapters/types.js';
import { type Context, defaultContext, refKey, switchTo, sync } from '../core.js';
import { pickFallback } from '../fallback.js';
import { sessionLimit } from '../limits.js';
import { spawnProgram } from '../proc.js';
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

/** wormhole's opencode plugin passes {type: "session.idle", sessionID, cwd} as the last argument. */
export function parseOpencodeHook(payload: string | undefined): HookInput | null {
  try {
    const p = JSON.parse(payload ?? '') as { type?: string; sessionID?: string; cwd?: string };
    if (p.type !== 'session.idle' || !p.sessionID || !p.cwd) return null;
    return { tool: 'opencode', cwd: p.cwd, session: p.sessionID };
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
  const found = await findSession(input, base);
  if (!found) return 0;
  // Only the reporting tool: probing the others (opencode spawns a CLI) would slow every turn.
  const [key, a] = found;
  const ctx: Context = { ...base, cwd: input.cwd, adapters: { [key]: a } };
  const { imported } = await sync(ctx, { tool: key, session: input.session });
  return imported.reduce((n, i) => n + i.events, 0);
}

/** The account adapter holding the hook's session: the hook does not say which folder it ran from. */
async function findSession(input: HookInput, base: Context): Promise<[string, ToolAdapter, NativeRef] | undefined> {
  for (const [key, a] of Object.entries(base.adapters) as [string, ToolAdapter][]) {
    if (a.tool !== input.tool) continue;
    // Tools also report helper threads wormhole does not follow (Codex subagents, unsaved threads).
    const ref = await a.locate(input.cwd, input.session);
    if (ref) return [key, a, ref];
  }
  return undefined;
}

/**
 * With `accounts auto on`: when the hook's session hit its usage limit, write the fallback
 * session and record it on the thread, for resume and status to point at. Never launches:
 * a hook has no terminal to open it in. Returns the key it moved to, if any.
 */
export async function fallbackFromHook(
  input: HookInput,
  base: Context = defaultContext(input.cwd),
  now = new Date(),
): Promise<string | undefined> {
  const settings = loadFile();
  // opencode reports no usage limits.
  if (!settings.auto || input.tool === 'opencode') return undefined;
  const thread = await base.store.loadForCwd(input.cwd);
  const found = thread && (await findSession(input, base));
  if (!found) return undefined;
  const [key, , ref] = found;
  const limit = await sessionLimit(ref, now);
  if (!limit.limited) return undefined;
  // Codex notifies every turn: one fallback per limit hit.
  const f = thread.fallback;
  if (f && f.from.nativeId === input.session && f.limitedAt === limit.at) return undefined;

  const pick = await pickFallback({ ...base, cwd: input.cwd }, key, settings.fallback, now);
  if (!pick.target) {
    const why = pick.skipped.map((s) => `${s.key}: ${s.why}`).join('; ');
    throw new Error(`${key} ${input.session} hit its limit and nothing has room${why ? ` (${why})` : ''}`);
  }
  // Only the adapters the switch reads or writes, so opencode's CLI is not run for nothing.
  const keys = new Set([key, pick.target, ...thread.segments.map((s) => refKey(s))]);
  const adapters = Object.fromEntries([...keys].flatMap((k) => (base.adapters[k] ? [[k, base.adapters[k]]] : [])));
  await switchTo({ ...base, cwd: input.cwd, adapters }, pick.target, { tool: key, session: input.session, limit });
  return pick.target;
}

/** What every hook does after parsing its payload: import, then maybe fall back. */
export async function handleHook(input: HookInput, ctx: Context): Promise<void> {
  await importFromHook(input, ctx);
  await fallbackFromHook(input, ctx);
}

/** Run the notify program wormhole wrapped, without waiting for it. */
export function runChained(argv: string[], payload: string | undefined) {
  const [bin, ...args] = argv;
  if (!bin) return;
  const child = spawnProgram(bin, payload === undefined ? args : [...args, payload], { detached: true, stdio: 'ignore' });
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
