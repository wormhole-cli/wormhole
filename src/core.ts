import { promises as fs } from 'node:fs';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import type { NativeRef, ToolAdapter } from './adapters/types.js';
import { buildBrief } from './handoff/brief.js';
import { type GitInfo, gitInfo } from './handoff/git.js';
import type { Thread, Tool } from './model/thread.js';
import { Store } from './store/store.js';

export type Adapters = Partial<Record<Tool, ToolAdapter>>;

export interface Context {
  cwd: string;
  store: Store;
  adapters: Adapters;
}

export function defaultContext(cwd = process.cwd()): Context {
  return { cwd, store: new Store(), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() } };
}

export function adapter(ctx: Context, tool: Tool): ToolAdapter {
  const a = ctx.adapters[tool];
  if (!a) throw new Error(`${tool} is not supported yet`);
  return a;
}

export interface SyncOptions {
  /** Import this session of `tool` instead of auto-detecting. */
  tool?: Tool;
  session?: string;
}

export interface SyncResult {
  thread: Thread;
  /** The session most recently in use, across all tools. */
  active: NativeRef | null;
  imported: { tool: Tool; nativeId: string; events: number; isNew: boolean }[];
}

/**
 * Bring the thread up to date: append whatever was said since the last import in
 * every session the thread already tracks, and adopt the session currently in use
 * if the thread does not know it yet. Older sessions the thread never tracked are
 * left alone so unrelated history does not leak in.
 */
export async function sync(ctx: Context, opts: SyncOptions = {}): Promise<SyncResult> {
  const thread = await ctx.store.loadOrCreateForCwd(ctx.cwd);
  const refs: NativeRef[] = [];
  for (const [tool, a] of Object.entries(ctx.adapters) as [Tool, ToolAdapter][]) {
    const ref =
      opts.session && opts.tool === tool ? await a.locate(ctx.cwd, opts.session) : await a.detectLatest(ctx.cwd);
    if (opts.session && opts.tool === tool && !ref) throw new Error(`no ${tool} session ${opts.session} for ${ctx.cwd}`);
    if (ref) refs.push(ref);
  }
  // Known segments whose file is no longer the newest still get their new turns.
  for (const seg of thread.segments) {
    if (refs.some((r) => r.tool === seg.tool && r.nativeId === seg.nativeId)) continue;
    const ref = await ctx.adapters[seg.tool]?.locate(ctx.cwd, seg.nativeId);
    if (ref) refs.push(ref);
  }

  const explicit = opts.session ? refs.find((r) => r.nativeId === opts.session) : undefined;
  const active =
    explicit ?? refs.reduce<NativeRef | null>((best, r) => (!best || r.updatedAt > best.updatedAt ? r : best), null);

  const imported: SyncResult['imported'] = [];
  for (const ref of refs) {
    const seg = thread.segments.find((s) => s.tool === ref.tool && s.nativeId === ref.nativeId);
    if (!seg && ref !== active) continue;
    const { events, offset } = await adapter(ctx, ref.tool).read(ref, seg?.importedUpTo ?? 0);
    const start = await ctx.store.appendEvents(thread.id, events);
    if (seg) {
      seg.importedUpTo = offset;
    } else {
      thread.segments.push({
        tool: ref.tool,
        nativeId: ref.nativeId,
        path: ref.path,
        startedAt: ref.startedAt,
        importedUpTo: offset,
        eventStart: start,
      });
    }
    if (events.length > 0 || !seg) imported.push({ tool: ref.tool, nativeId: ref.nativeId, events: events.length, isNew: !seg });
  }
  await ctx.store.save(thread);
  return { thread, active, imported };
}

export async function makeBrief(ctx: Context, thread: Thread, to: Tool, git?: GitInfo | null): Promise<string> {
  const events = await ctx.store.readEvents(thread.id);
  const from = thread.segments.map((s) => s.tool).filter((t) => t !== to);
  return buildBrief({ events, from, to, git: git === undefined ? await gitInfo(ctx.cwd) : git });
}

export interface SwitchResult {
  ref: NativeRef;
  /** True when the target already held the active session, so nothing was written. */
  reused: boolean;
  from: NativeRef | null;
}

/** Synthesize a session in `to` that carries the whole thread, and record it. */
export async function switchTo(ctx: Context, to: Tool, opts: SyncOptions = {}): Promise<SwitchResult> {
  const target = adapter(ctx, to);
  const { thread, active } = await sync(ctx, opts);
  if (!active) throw new Error(`no Claude Code or Codex session found for ${ctx.cwd}`);
  if (active.tool === to) return { ref: active, reused: true, from: active };

  const events = await ctx.store.readEvents(thread.id);
  const git = await gitInfo(ctx.cwd);
  const brief = await makeBrief(ctx, thread, to, git);
  const ref = await target.write(events, { cwd: ctx.cwd, gitBranch: git?.branch, brief });
  const { size } = await fs.stat(ref.path);
  thread.segments.push({
    tool: to,
    nativeId: ref.nativeId,
    path: ref.path,
    startedAt: ref.startedAt,
    // The synthesized prefix is already in the thread; only later turns get imported.
    importedUpTo: size,
    eventStart: events.length,
    derivedFrom: { tool: active.tool, nativeId: active.nativeId },
  });
  await ctx.store.save(thread);
  return { ref, reused: false, from: active };
}
