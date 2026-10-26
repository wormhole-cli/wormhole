import { describe, expect, it } from 'vitest';
import { toTurns } from '../src/adapters/render.js';
import type { Event } from '../src/model/thread.js';

function roles(turns: { role: string }[]) {
  return turns.map((t) => t.role).join(',');
}

describe('toTurns', () => {
  it('flattens tool calls and results into the assistant turn', () => {
    const events: Event[] = [
      { kind: 'user_text', text: 'run the tests' },
      { kind: 'tool_call', callId: 'c1', name: 'Bash', inputSummary: 'npm test' },
      { kind: 'tool_result', callId: 'c1', summary: 'FAIL\nexpected 1', isError: true },
      { kind: 'assistant_text', text: 'One test fails.' },
    ];
    const turns = toTurns(events);
    expect(roles(turns)).toBe('user,assistant');
    expect(turns[1]!.text).toContain('▸ Bash: npm test → error: FAIL expected 1 (2 lines)');
    expect(turns[1]!.text).toContain('One test fails.');
  });

  it('always alternates and starts with a user turn', () => {
    const events: Event[] = [
      { kind: 'assistant_text', text: 'a' },
      { kind: 'assistant_text', text: 'b' },
      { kind: 'user_text', text: 'c' },
      { kind: 'user_text', text: 'd' },
      { kind: 'compact_summary', text: 'e' },
    ];
    const turns = toTurns(events, 'brief');
    expect(roles(turns)).toBe('user,assistant,user,assistant');
    expect(turns[2]!.text).toContain('brief');
  });

  it('ends with an assistant acknowledgement after the brief', () => {
    const turns = toTurns([{ kind: 'user_text', text: 'hi' }], 'BRIEF');
    expect(turns.at(-1)!.role).toBe('assistant');
    expect(turns.at(-2)!.text).toContain('BRIEF');
  });

  it('keeps a result whose call is not in the same turn', () => {
    const turns = toTurns([
      { kind: 'user_text', text: 'x' },
      { kind: 'tool_result', callId: 'orphan', summary: 'done', isError: false },
    ]);
    expect(turns[1]!.text).toBe('▸ (tool result) → ok: done');
  });
});
