import { promises as fs } from 'node:fs';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpencodeAdapter } from './adapters/opencode.js';
import { KEEP_MAX, keep } from './adapters/render.js';
import type { NativeRef, ToolAdapter } from './adapters/types.js';
import { buildBrief } from './handoff/brief.js';
import { type GitInfo, gitInfo } from './handoff/git.js';
import { type Event, type Segment, srcKey, type Thread, type Tool } from './model/thread.js';
import { Store } from './store/store.js';

export type Adapters = Partial<Record<Tool, ToolAdapter>>;

export interface Context {
  cwd: string;
  store: Store;
  adapters: Adapters;
}

export function defaultContext(cwd = process.cwd()): Context {
  return {
    cwd,
    store: new Store(),
    adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter(), opencode: new OpencodeAdapter() },
  };
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
  return ctx.store.transaction(ctx.cwd, (store) => syncUnlocked({ ...ctx, store }, opts, ctx.store));
}

/**
 * Cut tool text that is too long for the store and save it whole as an artifact.
 * Artifacts go to `home`, the real store, not the transaction's staging copy: they
 * are immutable and content-addressed, so writing them before the commit is safe.
 */
async function stash(home: Store, threadId: string, e: Event): Promise<Event> {
  if (e.kind === 'tool_call' && e.inputSummary.length > KEEP_MAX) {
    return { ...e, inputSummary: keep(e.inputSummary), artifact: await home.writeArtifact(threadId, e.inputSummary) };
  }
  if (e.kind === 'tool_result' && e.summary.length > KEEP_MAX) {
    return { ...e, summary: keep(e.summary), artifact: await home.writeArtifact(threadId, e.summary) };
  }
  return e;
}

/** Events with artifact names swapped for absolute paths, for writing into a native session. */
export function withArtifactPaths(home: Store, threadId: string, events: Event[]): Event[] {
  return events.map((e) =>
    (e.kind === 'tool_call' || e.kind === 'tool_result') && e.artifact
      ? { ...e, artifact: home.artifactPath(threadId, e.artifact) }
      : e,
  );
}

async function syncUnlocked(ctx: Context, opts: SyncOptions, home: Store): Promise<SyncResult> {
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
    const src = srcKey(ref);
    const kept: Event[] = [];
    for (const e of events) kept.push({ ...(await stash(home, thread.id, e)), src });
    const start = await ctx.store.appendEvents(thread.id, kept);
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

export async function makeBrief(
  ctx: Context,
  thread: Thread,
  to: Tool,
  git?: GitInfo | null,
  continuing = false,
): Promise<string> {
  const events = await ctx.store.readEvents(thread.id);
  const from = thread.segments.map((s) => s.tool).filter((t) => t !== to);
  return buildBrief({ events, from, to, git: git === undefined ? await gitInfo(ctx.cwd) : git, continuing });
}

export interface SwitchResult {
  ref: NativeRef;
  /**
   * resumed: the target already held the active session, nothing written.
   * extended: a copy of the target's last session with only the other tools' turns added.
   * synthesized: a new session holding the whole thread.
   */
  mode: 'resumed' | 'extended' | 'synthesized';
  from: NativeRef | null;
  /** For extended: the session that was copied. */
  base?: NativeRef;
}

/**
 * Turns the target's native session `seg` does not hold yet: everything after what
 * it covers that some other session contributed. Null when events predate source
 * tagging, so the caller falls back to a full synthesis.
 */
export function missingFrom(seg: Segment, events: Event[]): Event[] | null {
  if (events.some((e) => !e.src)) return null;
  const covered = seg.derivedFrom ? seg.eventStart : 0;
  const own = srcKey(seg);
  return events.filter((e, i) => i >= covered && e.src !== own);
}

/**
 * Hand the thread to `to`. When `to` already has a session in this thread, a copy of
 * it is extended with what happened elsewhere, so its native tool calls survive;
 * otherwise a new session is synthesized from the whole thread.
 */
export async function switchTo(ctx: Context, to: Tool, opts: SyncOptions = {}): Promise<SwitchResult> {
  return ctx.store.transaction(ctx.cwd, (store) => switchUnlocked({ ...ctx, store }, to, opts, ctx.store));
}

async function switchUnlocked(ctx: Context, to: Tool, opts: SyncOptions, home: Store): Promise<SwitchResult> {
  const target = adapter(ctx, to);
  const { thread, active } = await syncUnlocked(ctx, opts, home);
  if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${ctx.cwd}`);
  if (active.tool === to) return { ref: active, mode: 'resumed', from: active };

  const events = withArtifactPaths(home, thread.id, await ctx.store.readEvents(thread.id));
  const last = thread.segments.findLast((s) => s.tool === to);
  const delta = last ? missingFrom(last, events) : null;
  const base = last && delta ? ((await target.locate(ctx.cwd, last.nativeId)) ?? undefined) : undefined;

  const git = await gitInfo(ctx.cwd);
  const brief = await makeBrief(ctx, thread, to, git, base !== undefined);
  const wctx = { cwd: ctx.cwd, gitBranch: git?.branch, brief };
  const ref = base && delta ? await target.extend(base, delta, wctx) : await target.write(events, wctx);
  const mode = base ? 'extended' : 'synthesized';

  const offset = ref.offset ?? (await fs.stat(ref.path)).size;
  thread.segments.push({
    tool: to,
    nativeId: ref.nativeId,
    path: ref.path,
    startedAt: ref.startedAt,
    // Everything written so far is already in the thread; only later turns get imported.
    importedUpTo: offset,
    eventStart: events.length,
    derivedFrom: { tool: active.tool, nativeId: active.nativeId },
  });
  await ctx.store.save(thread);
  return { ref, mode, from: active, base };
}
