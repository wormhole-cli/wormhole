import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Event } from '../model/thread.js';
import { atomicWrite } from '../store/store.js';
import { cliVersion, readJsonlFrom, toJsonl } from './jsonl.js';
import { keep, toTurns } from './render.js';
import type { NativeRef, ReadResult, ToolAdapter, WriteContext } from './types.js';

/** How many rollout files detectLatest inspects before giving up. */
const DETECT_SCAN_LIMIT = 1000;
/** Matching sessions compared by mtime when picking the one in use. */
const DETECT_MATCHES = 5;

/** User-role messages Codex injects itself; not things the person typed. */
const INJECTED_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '# AGENTS.md instructions',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<turn_aborted>',
  '<user_shell_command>',
];

export interface CodexOptions {
  /** Defaults to $CODEX_HOME or ~/.codex. */
  home?: string;
  /** Recorded in session_meta; defaults to `codex --version`. */
  cliVersion?: string;
}

export class CodexAdapter implements ToolAdapter {
  readonly tool = 'codex' as const;
  private readonly home: string;

  constructor(private readonly opts: CodexOptions = {}) {
    this.home = opts.home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  }

  /**
   * Files are named by start time, but an older session that was resumed later is
   * the one in use, so the first few matches are compared by mtime.
   */
  async detectLatest(cwd: string): Promise<NativeRef | null> {
    const matches = await this.matching(cwd, () => true, DETECT_MATCHES);
    return matches.reduce<NativeRef | null>((best, r) => (!best || r.updatedAt > best.updatedAt ? r : best), null);
  }

  async locate(cwd: string, nativeId: string): Promise<NativeRef | null> {
    const [match] = await this.matching(cwd, (file) => file.endsWith(`-${nativeId}.jsonl`), 1);
    return match ?? null;
  }

  private async matching(cwd: string, accept: (file: string) => boolean, limit: number): Promise<NativeRef[]> {
    const want = path.resolve(cwd);
    const found: NativeRef[] = [];
    let scanned = 0;
    for await (const file of this.rolloutsNewestFirst()) {
      if (++scanned > DETECT_SCAN_LIMIT || found.length >= limit) break;
      if (!accept(file)) continue;
      const meta = await readSessionMeta(file);
      if (!meta || path.resolve(meta.cwd) !== want) continue;
      const stat = await fs.stat(file);
      found.push({
        tool: 'codex',
        nativeId: meta.id,
        path: file,
        startedAt: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return found;
  }

  async read(ref: NativeRef, fromOffset = 0): Promise<ReadResult> {
    const { records, offset } = await readJsonlFrom(ref.path, fromOffset);
    const events: Event[] = [];
    for (const rec of records as CodexLine[]) {
      const ts = rec.timestamp;
      const p = rec.payload;
      if (!p) continue;
      if (rec.type === 'compacted') {
        if (typeof p.message === 'string' && p.message) events.push({ kind: 'compact_summary', text: p.message, ts });
        continue;
      }
      if (rec.type !== 'response_item') continue;
      switch (p.type) {
        case 'message': {
          const text = contentText(p.content);
          if (!text) break;
          if (p.role === 'user' && !INJECTED_PREFIXES.some((pre) => text.trimStart().startsWith(pre))) {
            events.push({ kind: 'user_text', text, ts });
          } else if (p.role === 'assistant') {
            events.push({ kind: 'assistant_text', text, ts });
          }
          // developer/system messages are Codex's own instructions.
          break;
        }
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call': {
          const callId = p.call_id ?? p.id;
          if (!callId) break;
          const input = callInput(p);
          events.push({ kind: 'tool_call', callId, name: p.name ?? 'shell', inputSummary: keep(input), ts });
          for (const change of patchChanges(input)) events.push({ ...change, ts });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          if (!p.call_id) break;
          const { text, isError } = callOutput(p.output);
          events.push({ kind: 'tool_result', callId: p.call_id, summary: keep(text), isError, ts });
          break;
        }
        // reasoning carries encrypted_content that only OpenAI can read: never carried over.
      }
    }
    return { events, offset };
  }

  async write(events: Event[], ctx: WriteContext): Promise<NativeRef> {
    const now = new Date();
    const id = uuidv7(now.getTime());
    const iso = now.toISOString();
    const cwd = path.resolve(ctx.cwd);
    const version = this.opts.cliVersion ?? (await cliVersion('codex', '0.0.0'));
    const records: unknown[] = [
      {
        timestamp: iso,
        type: 'session_meta',
        payload: {
          id,
          timestamp: iso,
          cwd,
          originator: 'codex_cli_rs',
          cli_version: version,
          source: 'cli',
          model_provider: 'openai',
          ...(ctx.gitBranch ? { git: { branch: ctx.gitBranch } } : {}),
        },
      },
      ...toTurns(events, ctx.brief).map((turn) => ({
        timestamp: iso,
        type: 'response_item',
        payload: {
          type: 'message',
          role: turn.role,
          content: [{ type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text }],
        },
      })),
    ];
    const file = path.join(this.home, 'sessions', ...datePath(now), `rollout-${localStamp(now)}-${id}.jsonl`);
    await atomicWrite(file, toJsonl(records));
    return { tool: 'codex', nativeId: id, path: file, startedAt: iso, updatedAt: iso };
  }

  launchArgs(ref: NativeRef): string[] {
    return ['codex', 'resume', ref.nativeId];
  }

  /** sessions/YYYY/MM/DD/rollout-*.jsonl, newest day and newest file first. */
  private async *rolloutsNewestFirst(): AsyncGenerator<string> {
    const root = path.join(this.home, 'sessions');
    const desc = async (dir: string) =>
      (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse();
    for (const y of await desc(root)) {
      for (const m of await desc(path.join(root, y))) {
        for (const d of await desc(path.join(root, y, m))) {
          const dir = path.join(root, y, m, d);
          for (const name of await desc(dir)) {
            if (name.startsWith('rollout-') && name.endsWith('.jsonl')) yield path.join(dir, name);
          }
        }
      }
    }
  }
}

interface CodexPayload {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  input?: string;
  action?: { command?: string[] };
  call_id?: string;
  id?: string;
  output?: unknown;
  message?: string;
}

interface CodexLine {
  timestamp?: string;
  type: string;
  payload?: CodexPayload;
}

/** session_meta is always the first line; it can be large (base_instructions). */
async function readSessionMeta(file: string): Promise<{ id: string; cwd: string; timestamp: string } | null> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < 4 * 1024 * 1024) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(buf.subarray(0, nl === -1 ? bytesRead : nl));
      if (nl !== -1) break;
      pos += bytesRead;
    }
    const line = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CodexLine;
    const p = line.payload as { id?: string; cwd?: string; timestamp?: string } | undefined;
    if (line.type !== 'session_meta' || !p?.id || !p.cwd) return null;
    return { id: p.id, cwd: p.cwd, timestamp: p.timestamp ?? line.timestamp ?? '' };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function callInput(p: CodexPayload): string {
  if (p.type === 'local_shell_call') return (p.action?.command ?? []).join(' ');
  if (p.type === 'custom_tool_call') return p.input ?? '';
  try {
    const args = JSON.parse(p.arguments ?? '{}') as Record<string, unknown>;
    const cmd = args.cmd ?? args.command;
    if (Array.isArray(cmd)) return cmd.join(' ');
    if (typeof cmd === 'string') return cmd;
    return p.arguments ?? '';
  } catch {
    return p.arguments ?? '';
  }
}

function callOutput(output: unknown): { text: string; isError: boolean } {
  if (Array.isArray(output)) return { text: contentText(output), isError: false };
  if (typeof output !== 'string') return { text: JSON.stringify(output ?? ''), isError: false };
  try {
    const parsed = JSON.parse(output) as { output?: unknown; metadata?: { exit_code?: number } };
    if (parsed && typeof parsed === 'object' && 'output' in parsed) {
      const code = parsed.metadata?.exit_code;
      return { text: String(parsed.output ?? ''), isError: typeof code === 'number' && code !== 0 };
    }
  } catch {
    // plain text output
  }
  const exit = output.match(/Process exited with code (\d+)/);
  return { text: output, isError: exit ? exit[1] !== '0' : false };
}

/** File operations named in an apply_patch body, wherever it appears in the input. */
export function patchChanges(input: string): Extract<Event, { kind: 'file_change' }>[] {
  const ops = { Add: 'create', Update: 'edit', Delete: 'delete' } as const;
  const out: Extract<Event, { kind: 'file_change' }>[] = [];
  for (const m of input.matchAll(/\*\*\* (Add|Update|Delete) File: (.+)/g)) {
    out.push({ kind: 'file_change', path: m[2]!.trim(), op: ops[m[1] as keyof typeof ops] });
  }
  return out;
}

/** RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10, random rest. */
export function uuidv7(ms: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Codex files sessions by local date. */
function datePath(d: Date): string[] {
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
}

function localStamp(d: Date): string {
  return `${datePath(d).join('-')}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
