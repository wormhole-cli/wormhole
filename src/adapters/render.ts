import type { Event } from '../model/thread.js';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Opens appended turns that start with the other tool's reply. */
export const CONTINUED = '[The conversation continued in another tool:]';

const INPUT_MAX = 200;
const RESULT_MAX = 300;

/** Collapse whitespace and cut to max chars. */
export function oneLine(text: string, max = INPUT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short multi-line-aware summary of tool output. */
export function summarizeOutput(text: string, max = RESULT_MAX): string {
  const lines = text.split('\n').length;
  const head = oneLine(text, max);
  return lines > 1 ? `${head} (${lines} lines)` : head;
}

/**
 * Render neutral events into strictly alternating user/assistant turns that start
 * with a user turn. Tool calls become assistant lines ("▸ Bash: ls → ok …") so the
 * target transcript carries no foreign tool ids or tool schemas.
 */
export function toTurns(
  events: Event[],
  brief?: string,
  opener = '[Conversation imported by wormhole; it continues below.]',
): Turn[] {
  const turns: Turn[] = [];
  const pending = new Map<string, number>(); // callId → index into lines of current assistant turn
  let lines: string[] = [];
  let role: Turn['role'] | null = null;

  const flush = () => {
    if (role && lines.length > 0) push(turns, role, lines.join('\n'));
    lines = [];
    role = null;
    pending.clear();
  };
  const speak = (r: Turn['role'], text: string) => {
    if (role !== r) flush();
    role = r;
    lines.push(text);
  };

  for (const e of events) {
    switch (e.kind) {
      case 'user_text':
        speak('user', e.text);
        break;
      case 'assistant_text':
        speak('assistant', e.text);
        break;
      case 'compact_summary':
        speak('user', `[Summary of earlier conversation]\n${e.text}`);
        break;
      case 'tool_call':
        speak('assistant', `▸ ${e.name}: ${oneLine(e.inputSummary)}`);
        pending.set(e.callId, lines.length - 1);
        break;
      case 'tool_result': {
        const at = pending.get(e.callId);
        const result = `${e.isError ? 'error' : 'ok'}: ${summarizeOutput(e.summary)}`;
        if (at !== undefined && role === 'assistant') {
          lines[at] = `${lines[at]} → ${result}`;
          pending.delete(e.callId);
        } else {
          speak('assistant', `▸ (tool result) → ${result}`);
        }
        break;
      }
      case 'file_change':
        // Already visible through the tool call that made the change.
        break;
    }
  }
  flush();

  if (brief) {
    push(turns, 'user', brief);
    push(turns, 'assistant', 'Understood. I have the context above and am ready to continue.');
  }
  if (turns[0]?.role === 'assistant') {
    turns.unshift({ role: 'user', text: opener });
  }
  return turns;
}

function push(turns: Turn[], role: Turn['role'], text: string) {
  const last = turns.at(-1);
  if (last && last.role === role) last.text = `${last.text}\n\n${text}`;
  else turns.push({ role, text });
}

/** Tool payloads kept in the thread store; rendering trims further. */
const KEEP_MAX = 4000;

export function keep(text: string): string {
  return text.length > KEEP_MAX ? `${text.slice(0, KEEP_MAX)}…[truncated ${text.length - KEEP_MAX} chars]` : text;
}
