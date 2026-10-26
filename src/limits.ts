import { promises as fs } from 'node:fs';
import type { NativeRef } from './adapters/types.js';

/** Whether a session stopped because its account ran out of usage. */
export interface LimitStatus {
  limited: boolean;
  /** When the limit lifts, if the tool said. */
  resetsAt?: string;
  /** When the limit was hit: the error record's (Claude) or snapshot's (Codex) timestamp. */
  at?: string;
  /** One line for people: why it counts as limited or not. */
  reason: string;
}

/** Enough of a session's end to see how it stopped; a bigger file is read whole only if the tail says nothing. */
const TAIL_BYTES = 512 * 1024;

/** Detection reads only the native file; opencode keeps no usage data wormhole can see. */
export async function sessionLimit(ref: NativeRef, now = new Date()): Promise<LimitStatus> {
  if (ref.tool === 'opencode') return { limited: false, reason: 'opencode reports no usage limits' };
  const detect = ref.tool === 'claude' ? claudeLimit : codexLimit;
  const { records, whole } = await readTail(ref.path, TAIL_BYTES);
  const status = detect(records, now);
  if (whole || status.limited || !status.reason.startsWith(UNKNOWN)) return status;
  return detect((await readTail(ref.path, Infinity)).records, now);
}

const UNKNOWN = 'nothing to go on';

/**
 * Claude Code writes a synthetic assistant record (`isApiErrorMessage`, model `<synthetic>`)
 * when a request fails. A session is limited when its last reply on the main chain is one with
 * `error: "rate_limit"`: `apiError` is `usage_limit_reached` (session or weekly window, with
 * `quotaLimits.resetsAt` in unix seconds) or `model_requires_usage_credits` (a model's own limit).
 */
export function claudeLimit(records: unknown[], now = new Date()): LimitStatus {
  const last = (records as ClaudeRecord[]).findLast(
    (r) => r?.type === 'assistant' && !r.isSidechain && !r.isMeta && r.message,
  );
  if (!last) return { limited: false, reason: `${UNKNOWN}: no reply yet` };
  if (!last.isApiErrorMessage) return { limited: false, reason: 'last reply came through' };
  if (last.error !== 'rate_limit') {
    return { limited: false, reason: `last reply was an API error (${last.error ?? 'unknown'}), not a usage limit` };
  }
  const info = last.quotaLimits ?? last.apiErrorParams?.rate_limit_info;
  const resetsAt = typeof info?.resetsAt === 'number' ? fromUnix(info.resetsAt) : undefined;
  const what = last.apiError === 'model_requires_usage_credits' ? 'model limit' : `${info?.rateLimitType ?? 'usage'} limit`;
  return verdict(`${what.replace('_', '-')} reached: ${firstText(last) || last.apiError || 'rate_limit'}`, last.timestamp, resetsAt, now);
}

/**
 * Codex logs a `rate_limits` snapshot with every `event_msg` `token_count`: `primary` and
 * `secondary` windows (`used_percent`, `window_minutes`, `resets_at` in unix seconds),
 * `rate_limit_reached_type` once one is exhausted. The latest snapshot decides, unless an
 * `error` event about the usage limit came after it.
 */
export function codexLimit(records: unknown[], now = new Date()): LimitStatus {
  const lines = records as CodexLine[];
  const i = lines.findLastIndex((l) => l?.type === 'event_msg' && l.payload?.type === 'token_count' && l.payload.rate_limits);
  const error = lines.findLast(
    (l, k) => k > i && l?.type === 'event_msg' && l.payload?.type === 'error' && /usage limit/i.test(l.payload.message ?? ''),
  );
  if (error) return verdict(`usage limit reached: ${error.payload!.message}`, error.timestamp, undefined, now);
  if (i < 0) return { limited: false, reason: `${UNKNOWN}: no rate_limits snapshot` };

  const rl = lines[i]!.payload!.rate_limits!;
  const windows = (['primary', 'secondary'] as const).flatMap((k) => (rl[k] ? [{ name: k, ...rl[k] }] : []));
  const full = windows.filter((w) => (w.used_percent ?? 0) >= 100);
  const plan = rl.plan_type ? ` (${rl.plan_type} plan)` : '';
  if (!rl.rate_limit_reached_type && full.length === 0 && !rl.spend_control_reached) {
    const used = windows.map((w) => `${span(w.window_minutes)} ${w.used_percent ?? 0}%`).join(', ');
    return { limited: false, reason: `room left${plan}: ${used || 'no windows reported'}` };
  }
  // Every exhausted window has to reset; when only the flag is set, the latest window's reset is the safe guess.
  const resets = (full.length > 0 ? full : windows).map((w) => w.resets_at).filter((t): t is number => typeof t === 'number');
  const resetsAt = resets.length > 0 ? fromUnix(Math.max(...resets)) : undefined;
  const which = full.map((w) => `${span(w.window_minutes)} window at ${w.used_percent}%`);
  if (rl.rate_limit_reached_type) which.unshift(`rate_limit_reached_type ${rl.rate_limit_reached_type}`);
  if (rl.spend_control_reached) which.push('spend control reached');
  return verdict(`usage limit reached${plan}: ${which.join(', ')}`, lines[i]!.timestamp, resetsAt, now);
}

/** Limited, unless the reset time has already passed. */
function verdict(reason: string, at: string | undefined, resetsAt: string | undefined, now: Date): LimitStatus {
  const when = { ...(at ? { at } : {}), ...(resetsAt ? { resetsAt } : {}) };
  if (resetsAt && Date.parse(resetsAt) <= now.getTime()) {
    return { limited: false, ...when, reason: `${reason}; reset at ${resetsAt} has passed` };
  }
  return { limited: true, ...when, reason };
}

function fromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function span(minutes: number | undefined): string {
  if (!minutes) return '?';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function firstText(r: ClaudeRecord): string {
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  return c?.find((b) => b.type === 'text' && b.text)?.text ?? '';
}

/** JSON lines in the last `bytes` of a file; a cut first line is dropped. */
async function readTail(file: string, bytes: number): Promise<{ records: unknown[]; whole: boolean }> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const records: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A line mid-append, or a corrupt one: not evidence either way.
      }
    }
    return { records, whole: start === 0 };
  } finally {
    await handle.close();
  }
}

interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  error?: string;
  apiError?: string;
  quotaLimits?: RateLimitInfo;
  apiErrorParams?: { rate_limit_info?: RateLimitInfo };
  message?: { content?: string | { type: string; text?: string }[] };
}

interface RateLimitInfo {
  resetsAt?: number;
  rateLimitType?: string;
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    message?: string;
    rate_limits?: {
      primary?: CodexWindow | null;
      secondary?: CodexWindow | null;
      plan_type?: string | null;
      rate_limit_reached_type?: string | null;
      spend_control_reached?: unknown;
    };
  };
}
