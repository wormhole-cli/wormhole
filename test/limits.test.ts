import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativeRef } from '../src/adapters/types.js';
import { claudeLimit, codexLimit, sessionLimit } from '../src/limits.js';
import {
  claudeModelLimit,
  claudeReply,
  claudeServerError,
  claudeTrailer,
  claudeUsageLimit,
  claudeUser,
  codexMeta,
  codexReply,
  codexTokenCount,
  codexUser,
  jsonl,
  win,
} from './fixtures/limits.js';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const HIT = '2026-10-26T09:05:00.000Z';
const LATER = '2026-10-26T14:00:00.000Z';
const EARLIER = '2026-10-26T09:30:00.000Z';

const conversation = [claudeUser('build it', 'u1', null), claudeReply('built', 'a1', 'u1'), claudeUser('more', 'u2', 'a1')];

describe('claudeLimit', () => {
  it('sees a session that ended on the usage limit, with its reset', () => {
    const s = claudeLimit([...conversation, claudeUsageLimit('e1', 'u2', HIT, LATER), ...claudeTrailer('s', 'e1')], NOW);
    expect(s).toMatchObject({ limited: true, at: HIT, resetsAt: LATER });
    expect(s.reason).toContain('five-hour limit reached');
    expect(s.reason).toContain('session limit');
  });

  it('is no longer limited once the reset has passed', () => {
    const s = claudeLimit([...conversation, claudeUsageLimit('e1', 'u2', HIT, EARLIER)], NOW);
    expect(s).toMatchObject({ limited: false, resetsAt: EARLIER });
    expect(s.reason).toContain('has passed');
  });

  it('reads the reset from apiErrorParams when quotaLimits is missing', () => {
    const rec = { ...claudeUsageLimit('e1', 'u2', HIT, LATER), quotaLimits: undefined };
    expect(claudeLimit([rec], NOW)).toMatchObject({ limited: true, resetsAt: LATER });
  });

  it('counts a model limit, which has no reset time', () => {
    const s = claudeLimit([...conversation, claudeModelLimit('e1', 'u2', HIT)], NOW);
    expect(s).toMatchObject({ limited: true, at: HIT });
    expect(s.resetsAt).toBeUndefined();
    expect(s.reason).toMatch(/^model limit reached/);
  });

  it('is not limited when a reply came through after the limit', () => {
    const records = [...conversation, claudeUsageLimit('e1', 'u2', HIT, LATER), claudeUser('again', 'u3', 'e1'), claudeReply('ok', 'a3', 'u3')];
    expect(claudeLimit(records, NOW)).toMatchObject({ limited: false, reason: 'last reply came through' });
  });

  it('ignores other API errors and subagent limits', () => {
    expect(claudeLimit([...conversation, claudeServerError('e1', 'u2', HIT)], NOW).reason).toContain('server_error');
    const sidechain = { ...claudeUsageLimit('e2', 'x', HIT, LATER), isSidechain: true };
    expect(claudeLimit([...conversation.slice(0, 2), sidechain], NOW).limited).toBe(false);
    expect(claudeLimit([], NOW).reason).toContain('no reply yet');
  });
});

describe('codexLimit', () => {
  const room = codexTokenCount('2026-10-26T09:01:00.000Z', win(39, 300, LATER), win(6, 10080, '2026-10-30T00:00:00.000Z'));

  it('reports room left from the latest snapshot', () => {
    const s = codexLimit([codexMeta('t', '/p'), codexUser('hi'), codexReply('yo'), room], NOW);
    expect(s).toEqual({ limited: false, reason: 'room left (pro plan): 5h 39%, 7d 6%' });
  });

  it('sees a window at 100% and keeps its reset', () => {
    const full = codexTokenCount(HIT, win(100, 300, LATER), win(40, 10080, '2026-10-30T00:00:00.000Z'), 'primary');
    const s = codexLimit([room, full], NOW);
    expect(s).toMatchObject({ limited: true, at: HIT, resetsAt: LATER });
    expect(s.reason).toContain('5h window at 100%');
    expect(s.reason).toContain('rate_limit_reached_type primary');
  });

  it('trusts rate_limit_reached_type alone, waiting for the latest reset', () => {
    const flagged = codexTokenCount(HIT, win(97, 300, LATER), win(90, 10080, '2026-10-30T00:00:00.000Z'), 'secondary');
    expect(codexLimit([flagged], NOW)).toMatchObject({ limited: true, resetsAt: '2026-10-30T00:00:00.000Z' });
  });

  it('is not limited once the reset has passed, or when a later snapshot has room', () => {
    const full = codexTokenCount(HIT, win(100, 300, EARLIER), win(10, 10080, '2026-10-30T00:00:00.000Z'));
    expect(codexLimit([full], NOW)).toMatchObject({ limited: false, resetsAt: EARLIER });
    expect(codexLimit([full, room], NOW).limited).toBe(false);
  });

  it('counts a usage-limit error after the last snapshot', () => {
    const error = { timestamp: HIT, type: 'event_msg', payload: { type: 'error', message: "You've hit your usage limit. Try again later." } };
    expect(codexLimit([room, error], NOW)).toMatchObject({ limited: true, at: HIT });
    const other = { ...error, payload: { type: 'error', message: 'stream disconnected' } };
    expect(codexLimit([room, other], NOW).limited).toBe(false);
  });

  it('says when there is nothing to go on', () => {
    expect(codexLimit([codexMeta('t', '/p'), codexUser('hi')], NOW).reason).toContain('no rate_limits snapshot');
  });
});

describe('sessionLimit', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wormhole-limits-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ref = (tool: NativeRef['tool'], file: string): NativeRef => ({ tool, nativeId: 'x', path: file, startedAt: '', updatedAt: '' });

  it('reads only the end of a big file when that settles it', async () => {
    const file = path.join(dir, 'big.jsonl');
    const filler = Array.from({ length: 400 }, (_, i) => claudeUser('x'.repeat(2000), `f${i}`, null));
    await writeFile(file, jsonl([...filler, claudeReply('done', 'a', 'f399'), claudeUsageLimit('e', 'a', HIT, LATER)]));
    expect(await sessionLimit(ref('claude', file), NOW)).toMatchObject({ limited: true, resetsAt: LATER });
  });

  it('reads the whole file when the tail has no reply', async () => {
    const file = path.join(dir, 'tail.jsonl');
    const huge = { type: 'file-history-snapshot', snapshot: 'y'.repeat(600_000) };
    await writeFile(file, jsonl([claudeUser('go', 'u', null), claudeReply('went', 'a', 'u'), huge]));
    expect(await sessionLimit(ref('claude', file), NOW)).toMatchObject({ limited: false, reason: 'last reply came through' });
  });

  it('reads Codex rollouts and never limits opencode', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, `${jsonl([codexMeta('t', dir), codexTokenCount(HIT, win(100, 300, LATER), win(1, 10080, LATER))])}{"partial`);
    expect(await sessionLimit(ref('codex', file), NOW)).toMatchObject({ limited: true });
    expect(await sessionLimit(ref('opencode', 'nowhere'), NOW)).toMatchObject({ limited: false });
  });
});
