import { parseKey } from './accounts.js';
import { type Context, refKey } from './core.js';
import { shellLine } from './launch.js';
import { sessionLimit } from './limits.js';
import { activeSegment, type Thread, TOOLS } from './model/thread.js';

/**
 * Keys to try, best first, when the session of `current` is out of usage. With a `list`
 * (accounts.json `fallback`), the entries after `current`, wrapping around; without one,
 * the other accounts of the same tool, then each other tool with its accounts.
 */
export function fallbackOrder(current: string, keys: string[], list?: string[]): string[] {
  if (list && list.length > 0) {
    const at = list.indexOf(current);
    return (at < 0 ? list : [...list.slice(at + 1), ...list.slice(0, at)]).filter((k) => k !== current);
  }
  const tool = (key: string) => parseKey(key).tool;
  const own = tool(current);
  const others = TOOLS.filter((t) => t !== own);
  return [own, ...others].flatMap((t) => keys.filter((k) => tool(k) === t && k !== current));
}

export interface Pick {
  /** First candidate that has room, if any. */
  target?: string;
  /** Candidates passed over before it, with why. */
  skipped: { key: string; why: string }[];
}

/**
 * The first fallback candidate that is set up and whose own latest session in this project
 * is not limited too. Stops at the first good one, so later candidates (opencode spawns its
 * CLI to look) are only probed when needed.
 */
export async function pickFallback(ctx: Context, current: string, list?: string[], now = new Date()): Promise<Pick> {
  const skipped: Pick['skipped'] = [];
  for (const key of fallbackOrder(current, Object.keys(ctx.adapters), list)) {
    const a = ctx.adapters[key];
    if (!a) {
      skipped.push({ key, why: 'not set up here' });
      continue;
    }
    try {
      const latest = await a.detectLatest(ctx.cwd);
      const limit = latest && (await sessionLimit(latest, now));
      if (limit?.limited) {
        skipped.push({ key, why: `its latest session here is limited too (${limit.reason}${resets(limit.resetsAt)})` });
        continue;
      }
    } catch (err) {
      skipped.push({ key, why: `could not check it: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    return { target: key, skipped };
  }
  return { skipped };
}

export function resets(at: string | undefined): string {
  return at ? `, resets ${at}` : '';
}

/**
 * Lines telling the user that a limit moved their session, while the session it wrote has
 * not been used yet; empty otherwise.
 */
export async function fallbackNote(ctx: Context, thread: Thread): Promise<string[]> {
  const f = thread.fallback;
  const last = activeSegment(thread);
  if (!f || !last || last.nativeId !== f.to.nativeId || last.importedUpTo > f.offset) return [];
  const when = f.limitedAt ? ` at ${f.limitedAt}` : '';
  const lines = [
    `${refKey(f.from)} hit its limit${when}${resets(f.resetsAt)}: ${f.reason}`,
    `wormhole wrote ${refKey(f.to)} session ${f.to.nativeId} to carry on; continue with: wormhole resume`,
  ];
  const a = ctx.adapters[refKey(f.to)];
  const ref = await a?.locate(ctx.cwd, f.to.nativeId).catch(() => null);
  if (a && ref) lines.push(`  (or: ${shellLine(a.launchArgs(ref))})`);
  return lines;
}
