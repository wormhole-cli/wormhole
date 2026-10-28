import { oneLine } from '../adapters/render.js';
import type { Event, Tool } from '../model/thread.js';
import type { GitInfo } from './git.js';

const TOOL_NAMES: Record<Tool, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode' };
const FILES_MAX = 30;
const LAST_REPLY_MAX = 1500;

export interface BriefInput {
  events: Event[];
  from: Tool[];
  to: Tool;
  git: GitInfo | null;
  /** The target's own earlier session is being continued, not a fresh import. */
  continuing?: boolean;
  /** What the tool being left said about the session when asked (`--summarize`). */
  summary?: { tool: Tool; text: string };
  /** The conversation was not copied (`--lean`): the full text is in this file. */
  transcript?: string;
}

/**
 * Deterministic handoff note, appended as the last user turn of the synthesized
 * session so the target model reads it first on resume.
 */
export function buildBrief({ events, from, to, git, continuing, summary, transcript }: BriefInput): string {
  const users = events.filter((e) => e.kind === 'user_text');
  const lastReply = events.findLast((e) => e.kind === 'assistant_text');
  const sources = [...new Set(from)].map((t) => TOOL_NAMES[t]).join(' and ') || 'another tool';

  const out: string[] = transcript
    ? [
        `[wormhole handoff] You are ${TOOL_NAMES[to]}, continuing work that was started in ${sources}.`,
        'The earlier conversation was not copied here; the notes below cover where it stands.',
        `The full conversation is in ${transcript}. Read the parts you need, not the whole file.`,
        'Re-read files before editing them.',
      ]
    : continuing
    ? [
        `[wormhole handoff] You are ${TOOL_NAMES[to]}, back in this session after work continued in ${sources}.`,
        'The turns after your last reply were imported from there.',
      ]
    : [
        `[wormhole handoff] You are ${TOOL_NAMES[to]}, continuing work that was started in ${sources}.`,
        'The conversation above was imported.',
      ];
  if (!transcript) out.push(
    'Lines like "▸ Name: input → ok: result" record tool calls the other tool made; they are history,',
    'not tools you can call. Re-read files before editing them.',
  );

  if (summary) out.push('', `## Summary from ${TOOL_NAMES[summary.tool]}`, summary.text);
  if (users[0]) out.push('', '## Original goal', oneLine(users[0].text, 600));
  const latest = users.at(-1);
  if (latest && latest !== users[0]) out.push('', '## Latest request', oneLine(latest.text, 600));
  if (lastReply) out.push('', '## Last reply', clip(lastReply.text, LAST_REPLY_MAX));

  const todos = latestTodos(events);
  if (todos.length > 0) out.push('', '## Open tasks', ...todos);

  const files = touchedFiles(events);
  if (files.length > 0) out.push('', '## Files touched', ...files.map((f) => `- ${f}`));

  if (git) {
    out.push('', `## Git (branch ${git.branch || 'detached'})`);
    if (git.status.length > 0) out.push('Uncommitted:', '```', ...git.status, '```');
    else out.push('Working tree clean.');
    if (git.diffStat) out.push('Diff vs HEAD:', '```', git.diffStat, '```');
    if (git.recentCommits.length > 0) out.push('Recent commits:', ...git.recentCommits.map((c) => `- ${c}`));
  }

  out.push('', 'Pick up from the latest request. If anything above is unclear, check the files and git state first.');
  return out.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Most recently touched files first, de-duplicated. */
export function touchedFiles(events: Event[]): string[] {
  const seen = new Set<string>();
  for (let i = events.length - 1; i >= 0 && seen.size < FILES_MAX; i--) {
    const e = events[i]!;
    if (e.kind === 'file_change') seen.add(e.op === 'delete' ? `${e.path} (deleted)` : e.path);
  }
  return [...seen];
}

/** Unfinished items from the last Claude TodoWrite or Codex update_plan call. */
export function latestTodos(events: Event[]): string[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'tool_call' || !/^(TodoWrite|update_plan)$/.test(e.name)) continue;
    try {
      const input = JSON.parse(e.inputSummary) as {
        todos?: { content?: string; status?: string }[];
        plan?: { step?: string; status?: string }[];
      };
      const items = (input.todos ?? []).map((t) => ({ text: t.content, status: t.status }))
        .concat((input.plan ?? []).map((p) => ({ text: p.step, status: p.status })));
      return items
        .filter((t) => t.text && t.status !== 'completed')
        .map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.text}`);
    } catch {
      return [];
    }
  }
  return [];
}
