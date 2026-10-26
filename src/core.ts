import { promises as fs } from 'node:fs';
import { type Account, keyOf, loadAccounts, parseKey } from './accounts.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpencodeAdapter } from './adapters/opencode.js';
import { KEEP_MAX, keep } from './adapters/render.js';
import type { NativeRef, ToolAdapter } from './adapters/types.js';
import { type BriefInput, buildBrief } from './handoff/brief.js';
import { type GitInfo, gitInfo } from './handoff/git.js';
import { type Event, type Segment, srcKey, type Thread, type Tool } from './model/thread.js';
import type { LimitStatus } from './limits.js';
import { Store } from './store/store.js';

/** Adapters by key: a tool (`claude`) or a tool's named account (`claude@work`). */
export type Adapters = Partial<Record<string, ToolAdapter>>;

export interface Context {
  cwd: string;
  store: Store;
  adapters: Adapters;
}

export function defaultContext(cwd = process.cwd(), accounts: Account[] = loadAccounts()): Context {
  const adapters: Adapters = { claude: new ClaudeAdapter(), codex: new CodexAdapter(), opencode: new OpencodeAdapter() };
  for (const a of accounts) {
    adapters[keyOf(a.tool, a.name)] =
      a.tool === 'claude'
        ? new ClaudeAdapter({ configDir: a.dir, account: a.name })
        : new CodexAdapter({ home: a.dir, account: a.name });
  }
  return { cwd, store: new Store(), adapters };
}

/** The adapter for a key: `claude`, or `claude@work` for a named account. */
export function adapter(ctx: Context, key: string): ToolAdapter {
  const a = ctx.adapters[key];
  if (a) return a;
  const { tool, account } = parseKey(key);
  throw new Error(account ? `no account ${key}; add it with: wormhole accounts add ${account} --tool ${tool} --dir <folder>` : `${tool} is not supported yet`);
}

/** Key of the tool and account a session or segment belongs to. */
export function refKey(r: { tool: Tool; account?: string }): string {
  return keyOf(r.tool, r.account);
}

export interface SyncOptions {
  /** Import this session of `tool` (a key: `claude`, `claude@work`) instead of auto-detecting. */
  tool?: string;
  session?: string;
}

export interface SyncResult {
  thread: Thread;
  /** The session most recently in use, across all tools. */
  active: NativeRef | null;
  imported: { tool: Tool; account?: string; nativeId: string; events: number; isNew: boolean }[];
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

function sessionKey(r: { tool: Tool; account?: string; nativeId: string }) {
  return { tool: r.tool, ...(r.account ? { account: r.account } : {}), nativeId: r.nativeId };
}

/** A ref as core passes it around: marked with the account of the adapter that found it. */
function tagged(ref: NativeRef, a: ToolAdapter): NativeRef {
  return a.account ? { ...ref, account: a.account } : ref;
}

async function syncUnlocked(ctx: Context, opts: SyncOptions, home: Store): Promise<SyncResult> {
  const thread = await ctx.store.loadOrCreateForCwd(ctx.cwd);
  const refs: NativeRef[] = [];
  if (opts.tool) adapter(ctx, opts.tool);
  for (const [key, a] of Object.entries(ctx.adapters) as [string, ToolAdapter][]) {
    const ref =
      opts.session && opts.tool === key ? await a.locate(ctx.cwd, opts.session) : await a.detectLatest(ctx.cwd);
    if (opts.session && opts.tool === key && !ref) throw new Error(`no ${key} session ${opts.session} for ${ctx.cwd}`);
    if (ref) refs.push(tagged(ref, a));
  }
  // Known segments whose file is no longer the newest still get their new turns.
  for (const seg of thread.segments) {
    if (refs.some((r) => r.tool === seg.tool && r.nativeId === seg.nativeId)) continue;
    const a = ctx.adapters[refKey(seg)];
    const ref = await a?.locate(ctx.cwd, seg.nativeId);
    if (a && ref) refs.push(tagged(ref, a));
  }

  const explicit = opts.session ? refs.find((r) => r.nativeId === opts.session) : undefined;
  const active =
    explicit ?? refs.reduce<NativeRef | null>((best, r) => (!best || r.updatedAt > best.updatedAt ? r : best), null);

  const imported: SyncResult['imported'] = [];
  for (const ref of refs) {
    const seg = thread.segments.find((s) => s.tool === ref.tool && s.nativeId === ref.nativeId);
    if (!seg && ref !== active) continue;
    const { events, offset } = await adapter(ctx, refKey(ref)).read(ref, seg?.importedUpTo ?? 0);
    const src = srcKey(ref);
    const kept: Event[] = [];
    for (const e of events) kept.push({ ...(await stash(home, thread.id, e)), src });
    const start = await ctx.store.appendEvents(thread.id, kept);
    if (seg) {
      seg.importedUpTo = offset;
    } else {
      thread.segments.push({
        tool: ref.tool,
        ...(ref.account ? { account: ref.account } : {}),
        nativeId: ref.nativeId,
        path: ref.path,
        startedAt: ref.startedAt,
        importedUpTo: offset,
        eventStart: start,
      });
    }
    if (events.length > 0 || !seg) {
      imported.push({ tool: ref.tool, account: ref.account, nativeId: ref.nativeId, events: events.length, isNew: !seg });
    }
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
  summary?: BriefInput['summary'],
): Promise<string> {
  const events = await ctx.store.readEvents(thread.id);
  const from = thread.segments.map((s) => s.tool).filter((t) => t !== to);
  return buildBrief({ events, from, to, git: git === undefined ? await gitInfo(ctx.cwd) : git, continuing, summary });
}

export interface SwitchOptions extends SyncOptions {
  /** Added to the brief under its own heading. */
  summary?: BriefInput['summary'];
  /** The session being left hit this limit: recorded on the thread as its fallback. */
  limit?: LimitStatus;
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
 * Hand the thread to `to` (a tool, or `tool@account`). When that tool already has a
 * session in this thread, in any account, a copy of it is extended with what happened
 * elsewhere, so its native tool calls survive; otherwise a new session is synthesized
 * from the whole thread. Moving between accounts of one tool is a plain native copy.
 */
export async function switchTo(ctx: Context, to: string, opts: SwitchOptions = {}): Promise<SwitchResult> {
  return ctx.store.transaction(ctx.cwd, (store) => switchUnlocked({ ...ctx, store }, to, opts, ctx.store));
}

async function switchUnlocked(ctx: Context, to: string, opts: SwitchOptions, home: Store): Promise<SwitchResult> {
  const target = adapter(ctx, to);
  const tool = target.tool;
  const { thread, active } = await syncUnlocked(ctx, opts, home);
  if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${ctx.cwd}`);
  if (refKey(active) === to) return { ref: active, mode: 'resumed', from: active };

  const events = withArtifactPaths(home, thread.id, await ctx.store.readEvents(thread.id));
  // The tool's latest session, whichever account it is in: the target account gets a copy.
  const last = thread.segments.findLast((s) => s.tool === tool && ctx.adapters[refKey(s)]);
  const delta = last ? missingFrom(last, events) : null;
  const base = last && delta ? ((await adapter(ctx, refKey(last)).locate(ctx.cwd, last.nativeId)) ?? undefined) : undefined;

  const git = await gitInfo(ctx.cwd);
  // Only another account of the same tool is being left: a plain copy needs no handoff note.
  const brief =
    base && delta?.length === 0 ? undefined : await makeBrief(ctx, thread, tool, git, base !== undefined, opts.summary);
  const wctx = { cwd: ctx.cwd, gitBranch: git?.branch, brief };
  const ref = base && delta ? await target.extend(base, delta, wctx) : await target.write(events, wctx);
  const mode = base ? 'extended' : 'synthesized';

  const offset = ref.offset ?? (await fs.stat(ref.path)).size;
  thread.segments.push({
    tool,
    ...(target.account ? { account: target.account } : {}),
    nativeId: ref.nativeId,
    path: ref.path,
    startedAt: ref.startedAt,
    // Everything written so far is already in the thread; only later turns get imported.
    importedUpTo: offset,
    eventStart: events.length,
    derivedFrom: sessionKey(active),
  });
  const { limit } = opts;
  thread.fallback = limit && {
    from: sessionKey(active),
    to: sessionKey(tagged(ref, target)),
    ...(limit.at ? { limitedAt: limit.at } : {}),
    ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
    reason: limit.reason,
    offset,
  };
  await ctx.store.save(thread);
  return { ref: tagged(ref, target), mode, from: active, base: base && tagged(base, adapter(ctx, refKey(last!))) };
}
