import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Event } from '../model/thread.js';
import { atomicWrite } from '../store/store.js';
import { cliVersion, newestByMtime, readJsonlFrom, toJsonl } from './jsonl.js';
import { keep, toTurns } from './render.js';
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
    this.configDir = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  }

  projectDir(cwd: string): string {
    return path.join(this.configDir, 'projects', encodeCwd(cwd));
  }

  async detectLatest(cwd: string): Promise<NativeRef | null> {
    const dir = this.projectDir(cwd);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const files = names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
    const newest = await newestByMtime(files);
    if (!newest) return null;
    return {
      tool: 'claude',
      nativeId: path.basename(newest.file, '.jsonl'),
      path: newest.file,
      startedAt: newest.mtime.toISOString(),
    };
  }

  async read(ref: NativeRef, fromOffset = 0): Promise<ReadResult> {
    const { records, offset } = await readJsonlFrom(ref.path, fromOffset);
    const events: Event[] = [];
    for (const rec of records as ClaudeRecord[]) {
      if (rec.isSidechain || rec.isMeta) continue;
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
    const version = this.opts.version ?? (await cliVersion('claude', '2.0.0'));
    const cwd = path.resolve(ctx.cwd);
    const base = Date.now();
    let parentUuid: string | null = null;
    const records = toTurns(events, ctx.brief).map((turn, i) => {
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
      return turn.role === 'user'
        ? { ...common, type: 'user', message: { role: 'user', content: turn.text } }
        : {
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
    const file = path.join(this.projectDir(cwd), `${sessionId}.jsonl`);
    await atomicWrite(file, toJsonl(records));
    return { tool: 'claude', nativeId: sessionId, path: file, startedAt: new Date(base).toISOString() };
  }

  launchArgs(ref: NativeRef): string[] {
    return ['claude', '--resume', ref.nativeId];
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
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role: string; content?: string | ClaudeBlock[] };
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
