import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Event } from '../model/thread.js';
import { atomicWrite } from '../store/store.js';
import { cliVersion, newestByMtime, readJsonlFrom, toJsonl } from './jsonl.js';
import { CONTINUED, keep, toTurns, type Turn } from './render.js';
import type { NativeRef, ReadResult, ToolAdapter, WriteContext } from './types.js';

/** Tools whose input names the file they change. */
const FILE_TOOLS: Record<string, 'create' | 'edit'> = {
  Write: 'create',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
};

export interface ClaudeOptions {
  /** Defaults to $CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string;
  /** Recorded in written transcripts; defaults to `claude --version`. */
  version?: string;
}

/** Claude Code names a project folder after its absolute path with every non-alphanumeric char replaced by '-'. */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export class ClaudeAdapter implements ToolAdapter {
  readonly tool = 'claude' as const;
  private readonly configDir: string;

  constructor(private readonly opts: ClaudeOptions = {}) {
    this.configDir = opts.configDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
  }

  projectDir(cwd: string): string {
    return path.join(this.configDir, 'projects', encodeCwd(cwd));
  }

  async detectLatest(cwd: string): Promise<NativeRef | null> {
    const dir = this.projectDir(cwd);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const files = names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
    const newest = await newestByMtime(files);
    return newest ? this.ref(newest.file, newest.mtime) : null;
  }

  async locate(cwd: string, nativeId: string): Promise<NativeRef | null> {
    const file = path.join(this.projectDir(cwd), `${nativeId}.jsonl`);
    const stat = await fs.stat(file).catch(() => null);
    return stat ? this.ref(file, stat.mtime) : null;
  }

  private ref(file: string, mtime: Date): NativeRef {
    return {
      tool: 'claude',
      nativeId: path.basename(file, '.jsonl'),
      path: file,
      startedAt: mtime.toISOString(),
      updatedAt: mtime.toISOString(),
    };
  }

  async read(ref: NativeRef, fromOffset = 0): Promise<ReadResult> {
    // Resolve the selected branch from the complete graph, then apply the byte cursor.
    const { records, offset, positions } = await readJsonlFrom(ref.path);
    const fresh = new Set(records.filter((_, i) => positions[i]! >= fromOffset));
    const selected = selectedBranch(records as ClaudeRecord[]).filter((r) => fresh.has(r));
    const events: Event[] = [];
    for (const rec of selected) {
      // API error notices (model "<synthetic>") are Claude Code UI, not part of the conversation.
      if (rec.isSidechain || rec.isMeta || rec.isApiErrorMessage) continue;
      const ts = rec.timestamp;
      if (rec.type === 'user' && rec.message) {
        const content = rec.message.content;
        if (rec.isCompactSummary) {
          events.push({ kind: 'compact_summary', text: blocksText(content), ts });
          continue;
        }
        if (typeof content === 'string') {
          if (!isCommandNoise(content)) events.push({ kind: 'user_text', text: content, ts });
          continue;
        }
        for (const block of content ?? []) {
          if (block.type === 'text' && block.text && !isCommandNoise(block.text)) {
            events.push({ kind: 'user_text', text: block.text, ts });
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            events.push({
              kind: 'tool_result',
              callId: block.tool_use_id,
              summary: keep(blocksText(block.content)),
              isError: block.is_error === true,
              ts,
            });
          }
        }
      } else if (rec.type === 'assistant' && rec.message) {
        const content = rec.message.content;
        if (typeof content === 'string') {
          events.push({ kind: 'assistant_text', text: content, ts });
          continue;
        }
        for (const block of content ?? []) {
          if (block.type === 'text' && block.text) {
            events.push({ kind: 'assistant_text', text: block.text, ts });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            events.push({
              kind: 'tool_call',
              callId: block.id,
              name: block.name,
              inputSummary: keep(summarizeInput(block.input)),
              ts,
            });
            const op = FILE_TOOLS[block.name];
            const file = (block.input as { file_path?: unknown } | undefined)?.file_path;
            if (op && typeof file === 'string') events.push({ kind: 'file_change', path: file, op, ts });
          }
          // thinking blocks are signature-checked by Anthropic: never carried over.
        }
      }
    }
    return { events, offset };
  }

  async write(events: Event[], ctx: WriteContext): Promise<NativeRef> {
    const sessionId = randomUUID();
    const records = await this.records(toTurns(events, ctx.brief), sessionId, null, ctx);
    return this.save(sessionId, ctx.cwd, toJsonl(records));
  }

  async extend(base: NativeRef, events: Event[], ctx: WriteContext): Promise<NativeRef> {
    const { records } = await readJsonlFrom(base.path);
    const main = selectedBranch(records as ClaudeRecord[]);
    const leaf = main.findLast((r) => r.uuid)?.uuid ?? null;
    const lastMessage = main.findLast((r) => (r.type === 'user' || r.type === 'assistant') && !r.isApiErrorMessage);

    // A tool_use left without its result (the session was interrupted) makes the API reject
    // the history, so the copy closes it before anything else is appended.
    const results = new Set(main.flatMap((r) => blocks(r).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)));
    const orphans = main.flatMap((r) => blocks(r).filter((b) => b.type === 'tool_use' && b.id && !results.has(b.id)));
    const closing: ClaudeBlock[] = orphans.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: 'Not completed: the session was handed off to another tool.',
      is_error: true,
    }));

    const turns = toTurns(events, ctx.brief, CONTINUED);
    if (closing.length === 0 && lastMessage?.type === 'user') {
      turns.unshift({ role: 'assistant', text: '(The session continued in another tool; its turns follow.)' });
    }
    const sessionId = randomUUID();
    const appended = await this.records(turns, sessionId, leaf, ctx, closing);
    // Session ids appear in every record; a copy under a new id is how Claude itself forks.
    const copy = toJsonl(main.map((r) => ({ ...r, sessionId })));
    return this.save(sessionId, ctx.cwd, (copy.endsWith('\n') ? copy : `${copy}\n`) + toJsonl(appended));
  }

  /** Linked records for turns; `lead` blocks open the first user record. */
  private async records(
    turns: Turn[],
    sessionId: string,
    parent: string | null,
    ctx: WriteContext,
    lead: ClaudeBlock[] = [],
  ): Promise<unknown[]> {
    const version = this.opts.version ?? (await cliVersion('claude', '2.0.0'));
    const cwd = path.resolve(ctx.cwd);
    const base = Date.now();
    let parentUuid = parent;
    if (lead.length > 0 && turns[0]?.role !== 'user') turns = [{ role: 'user', text: '' }, ...turns];
    return turns.map((turn, i) => {
      const uuid = randomUUID();
      const common = {
        parentUuid,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId,
        version,
        gitBranch: ctx.gitBranch ?? '',
        uuid,
        // Strictly increasing timestamps keep Claude's ordering stable.
        timestamp: new Date(base + i).toISOString(),
      };
      parentUuid = uuid;
      if (turn.role === 'user') {
        const content =
          i === 0 && lead.length > 0
            ? [...lead, ...(turn.text ? [{ type: 'text', text: turn.text }] : [])]
            : turn.text;
        return { ...common, type: 'user', message: { role: 'user', content } };
      }
      return {
        ...common,
        type: 'assistant',
        message: {
          id: `msg_wormhole_${uuid.replace(/-/g, '').slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          model: 'wormhole-import',
          content: [{ type: 'text', text: turn.text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    });
  }

  private async save(sessionId: string, cwd: string, content: string): Promise<NativeRef> {
    const file = path.join(this.projectDir(cwd), `${sessionId}.jsonl`);
    await atomicWrite(file, content);
    const now = new Date().toISOString();
    return { tool: 'claude', nativeId: sessionId, path: file, startedAt: now, updatedAt: now };
  }

  launchArgs(ref: NativeRef): string[] {
    return ['claude', '--resume', ref.nativeId];
  }

  /** Claude Desktop imports a CLI session by id from this link. */
  appUrl(ref: NativeRef): string {
    return `claude://resume?session=${ref.nativeId}`;
  }
}

interface ClaudeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ClaudeBlock[];
  is_error?: boolean;
}

interface ClaudeRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  leafUuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  message?: { role: string; content?: string | ClaudeBlock[] };
}

function blocks(rec: ClaudeRecord): ClaudeBlock[] {
  const content = rec.message?.content;
  return Array.isArray(content) ? content : [];
}

function blocksText(content: string | ClaudeBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
    .join('\n');
}

/** Slash-command plumbing Claude Code stores as user text. */
function isCommandNoise(text: string): boolean {
  return /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/.test(text);
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'pattern', 'url', 'query', 'prompt', 'description']) {
      if (typeof o[key] === 'string') return o[key];
    }
  }
  return JSON.stringify(input ?? {});
}

/** Follow the latest selected leaf, rather than importing abandoned sibling branches. */
function selectedBranch(records: ClaudeRecord[]): ClaudeRecord[] {
  const main = records.filter((r) => !r.isSidechain);
  const byId = new Map(main.filter((r) => r.uuid).map((r) => [r.uuid!, r]));
  const tail = main.findLast((r) => r.leafUuid || ((r.type === 'user' || r.type === 'assistant') && r.uuid));
  let id = tail?.leafUuid ?? tail?.uuid;
  if (!id) return main; // Legacy transcripts without linked records.
  const selected = new Set<string>();
  while (id && !selected.has(id)) {
    selected.add(id);
    id = byId.get(id)?.parentUuid ?? undefined;
  }
  return main.filter((r) => !r.uuid || selected.has(r.uuid));
}
