/**
 * Records shaped like the ones Claude Code 2.1.29x and Codex 0.16x wrote on a real machine
 * (keys and value types copied, content made up).
 */

export const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const claudeUser = (text: string, uuid: string, parentUuid: string | null, timestamp = '2026-10-26T09:00:00.000Z') => ({
  parentUuid, isSidechain: false, type: 'user', uuid, timestamp, userType: 'external', entrypoint: 'cli',
  message: { role: 'user', content: text },
});

export const claudeReply = (text: string, uuid: string, parentUuid: string, timestamp = '2026-10-26T09:00:05.000Z') => ({
  parentUuid, isSidechain: false, type: 'assistant', uuid, timestamp, userType: 'external',
  message: { id: `msg_${uuid}`, model: 'claude-opus-5-5', role: 'assistant', type: 'message', content: [{ type: 'text', text }] },
});

/** The synthetic record Claude Code writes when the 5-hour (or weekly) window is used up. */
export function claudeUsageLimit(uuid: string, parentUuid: string, timestamp: string, resetsAt: string, extra: object = {}) {
  const info = {
    status: 'rejected', resetsAt: unix(resetsAt), rateLimitType: 'five_hour', overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled', isUsingOverage: false,
  };
  return {
    parentUuid, isSidechain: false, type: 'assistant', uuid, timestamp,
    message: {
      id: `synthetic-${uuid}`, container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence',
      stop_sequence: '', type: 'message', usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: "You've hit your session limit · resets 8:10pm (UTC)" }],
    },
    requestId: 'req_x', apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: info },
    quotaLimits: { ...info, unifiedRateLimitFallbackAvailable: false },
    error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, userType: 'external', entrypoint: 'cli',
    ...extra,
  };
}

/** A model's own limit: no quotaLimits, so no reset time. */
export const claudeModelLimit = (uuid: string, parentUuid: string, timestamp: string) => ({
  parentUuid, isSidechain: false, type: 'assistant', uuid, timestamp,
  message: {
    id: `synthetic-${uuid}`, model: '<synthetic>', role: 'assistant', type: 'message',
    content: [{ type: 'text', text: "You've reached your model limit. Switch to another model, or manage usage credits." }],
  },
  apiError: 'model_requires_usage_credits', errorDetails: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
});

export const claudeServerError = (uuid: string, parentUuid: string, timestamp: string) => ({
  parentUuid, isSidechain: false, type: 'assistant', uuid, timestamp,
  message: { id: `synthetic-${uuid}`, model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'API Error: connection reset' }] },
  error: 'server_error', isApiErrorMessage: true,
});

/** Bookkeeping Claude Code appends after the last turn; `last-prompt` names the leaf record. */
export const claudeTrailer = (sessionId: string, leafUuid: string) => [
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-26T09:10:00.000Z', sessionId },
  { type: 'last-prompt', lastPrompt: 'go on', leafUuid, sessionId },
  { type: 'cost-state', sessionId, totalCostUSD: 0, totalAPIDuration: 0, startTime: 0, modelUsage: {} },
];

export interface Window {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

/** Codex's per-turn `token_count` event with its rate_limits snapshot. */
export function codexTokenCount(
  timestamp: string,
  primary: Window,
  secondary: Window,
  reached: string | null = null,
): object {
  const usage = { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 };
  return {
    timestamp, ordinal: 7, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex', limit_name: null, primary, secondary,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null, spend_control_reached: null, plan_type: 'pro', rate_limit_reached_type: reached,
      },
    },
  };
}

export const win = (used: number, minutes: number, resetsAt: string): Window => ({
  used_percent: used, window_minutes: minutes, resets_at: unix(resetsAt),
});

export const codexMeta = (id: string, cwd: string) => ({
  timestamp: '2026-10-26T09:00:00.000Z', type: 'session_meta',
  payload: { id, timestamp: '2026-10-26T09:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.164.0', source: 'cli', model_provider: 'openai' },
});

export const codexUser = (text: string) => ({
  timestamp: '2026-10-26T09:00:01.000Z', type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

export const codexReply = (text: string) => ({
  timestamp: '2026-10-26T09:00:04.000Z', type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

export const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
