import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Event } from '../model/thread.js';
import { CONTINUED, keep, toTurns, type Turn } from './render.js';
import type { NativeRef, ReadResult, ToolAdapter, WriteContext } from './types.js';

/**
 * opencode keeps sessions in SQLite. wormhole never touches the database: it reads
 * through `opencode export` and writes through `opencode import`, which upserts by id.
 */
export interface OpencodeCli {
  list(cwd: string): Promise<OcListed[]>;
  export(cwd: string, id: string): Promise<OcSession | null>;
  import(cwd: string, session: OcSession): Promise<void>;
}

export interface OcListed {
  id: string;
  directory: string;
  projectId?: string;
  created: number;
  updated: number;
}

export interface OcSession {
  info: { id: string; directory?: string; projectID?: string; version?: string; time?: { created: number; updated: number } } & Record<string, unknown>;
  messages: OcMessage[];
}

interface OcMessage {
  info: {
    id: string;
    role: 'user' | 'assistant';
    parentID?: string;
    mode?: string;
    summary?: unknown;
    modelID?: string;
    providerID?: string;
    model?: { providerID: string; modelID: string };
    time?: { created: number; completed?: number };
    error?: unknown;
  } & Record<string, unknown>;
  parts: OcPart[];
}

interface OcPart {
  id: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    metadata?: { exit?: number };
    time?: { start?: number; end?: number };
  };
}

interface Model {
  providerID: string;
  modelID: string;
}

const FILE_TOOLS: Record<string, 'create' | 'edit'> = { write: 'create', edit: 'edit', multiedit: 'edit' };
const NOT_COMPLETED = 'Not completed: the session was handed off to another tool.';

export interface OpencodeOptions {
  cli?: OpencodeCli;
  /** "provider/model" for written messages; defaults to the model last used in this project. */
  model?: string;
  version?: string;
}

export class OpencodeAdapter implements ToolAdapter {
  readonly tool = 'opencode' as const;
  private readonly cli: OpencodeCli;

  constructor(private readonly opts: OpencodeOptions = {}) {
    this.cli = opts.cli ?? execCli;
  }

  async detectLatest(cwd: string): Promise<NativeRef | null> {
    const want = path.resolve(cwd);
    const mine = (await this.cli.list(want)).filter((s) => path.resolve(s.directory) === want);
    const newest = mine.reduce<OcListed | null>((best, s) => (!best || s.updated > best.updated ? s : best), null);
    return newest ? listedRef(newest) : null;
  }

  async locate(cwd: string, nativeId: string): Promise<NativeRef | null> {
    const session = await this.cli.export(path.resolve(cwd), nativeId);
    if (!session) return null;
    const t = session.info.time ?? { created: 0, updated: 0 };
    return listedRef({ id: nativeId, directory: cwd, created: t.created, updated: t.updated });
  }

  /** The offset is a count of finished messages, not bytes. */
  async read(ref: NativeRef, fromOffset = 0): Promise<ReadResult> {
    const session = await this.cli.export(path.dirname(ref.path) || '.', ref.nativeId);
    if (!session) return { events: [], offset: fromOffset };
    const done = finishedPrefix(session.messages);
    const events: Event[] = [];
    for (const msg of session.messages.slice(fromOffset, done)) {
      const ts = msg.info.time?.created ? new Date(msg.info.time.created).toISOString() : undefined;
      const compaction = msg.info.role === 'assistant' && (msg.info.summary === true || msg.info.mode === 'compaction');
      for (const part of msg.parts) {
        if (part.type === 'text' && part.text && !part.synthetic) {
          const kind = compaction ? 'compact_summary' : msg.info.role === 'user' ? 'user_text' : 'assistant_text';
          events.push({ kind, text: part.text, ts });
        } else if (part.type === 'tool' && part.callID && part.tool) {
          const input = part.state?.input ?? {};
          events.push({ kind: 'tool_call', callId: part.callID, name: part.tool, inputSummary: keep(summarizeInput(input)), ts });
          const op = FILE_TOOLS[part.tool];
          if (op && typeof input.filePath === 'string') events.push({ kind: 'file_change', path: input.filePath, op, ts });
          const status = part.state?.status;
          if (status === 'completed' || status === 'error') {
            const exit = part.state?.metadata?.exit;
            events.push({
              kind: 'tool_result',
              callId: part.callID,
              summary: keep(part.state?.output ?? part.state?.error ?? ''),
              isError: status === 'error' || (typeof exit === 'number' && exit !== 0),
              ts,
            });
          }
        }
        // reasoning, step-*, patch, file and compaction parts carry no conversation text.
      }
    }
    return { events, offset: done };
  }

  async write(events: Event[], ctx: WriteContext): Promise<NativeRef> {
    const cwd = path.resolve(ctx.cwd);
    const ids = new IdGen();
    const model = await this.model(cwd);
    const session: OcSession = {
      info: {
        id: ids.next('ses', true),
        slug: `wormhole-${randomBytes(3).toString('hex')}`,
        projectID: await this.projectId(cwd),
        directory: cwd,
        title: titleFrom(events),
        version: this.opts.version ?? '1.0.0',
        time: { created: ids.ms, updated: ids.ms },
      },
      messages: [],
    };
    appendTurns(session, toTurns(events, ctx.brief), model, cwd, ids);
    return this.save(cwd, session);
  }

  async extend(base: NativeRef, events: Event[], ctx: WriteContext): Promise<NativeRef> {
    const cwd = path.resolve(ctx.cwd);
    const original = await this.cli.export(cwd, base.nativeId);
    if (!original) throw new Error(`opencode session ${base.nativeId} not found`);
    const ids = new IdGen();

    // Import upserts by id, so the copy gets fresh ids for the session, every message and part.
    const map = new Map<string, string>([[original.info.id, ids.next('ses', true)]]);
    for (const msg of original.messages) {
      map.set(msg.info.id, ids.next('msg'));
      for (const part of msg.parts) map.set(part.id, ids.next('prt'));
    }
    const session = remap(original, map) as OcSession;
    session.info.time = { created: session.info.time?.created ?? ids.ms, updated: ids.ms };
    session.info.title = `${String(session.info.title ?? 'session')} (wormhole)`;

    // An unfinished assistant message or tool call would leave the history half-open.
    session.messages = session.messages.slice(0, finishedPrefix(session.messages));
    for (const part of session.messages.flatMap((m) => m.parts)) {
      if (part.type === 'tool' && part.state && part.state.status !== 'completed' && part.state.status !== 'error') {
        part.state = { ...part.state, status: 'error', error: NOT_COMPLETED, time: { start: ids.ms, end: ids.ms } };
      }
    }

    const last = session.messages.findLast((m) => m.info.role === 'assistant');
    const model = last?.info.providerID && last.info.modelID
      ? { providerID: last.info.providerID, modelID: last.info.modelID }
      : await this.model(cwd);
    appendTurns(session, toTurns(events, ctx.brief, CONTINUED), model, cwd, ids);
    return this.save(cwd, session);
  }

  launchArgs(ref: NativeRef): string[] {
    return ['opencode', '--session', ref.nativeId];
  }

  private async save(cwd: string, session: OcSession): Promise<NativeRef> {
    await this.cli.import(cwd, session);
    const t = session.info.time!;
    return {
      ...listedRef({ id: session.info.id, directory: cwd, created: t.created, updated: t.updated }),
      offset: finishedPrefix(session.messages),
    };
  }

  /** Model for written messages: option, else the last one used in this project, else opencode's default. */
  private async model(cwd: string): Promise<Model> {
    const configured = this.opts.model ?? process.env.WORMHOLE_OPENCODE_MODEL;
    if (configured?.includes('/')) return splitModel(configured);
    const recent = await this.detectLatest(cwd);
    if (recent) {
      const s = await this.cli.export(cwd, recent.nativeId);
      const m = s?.messages.findLast((x) => x.info.role === 'assistant' && x.info.modelID && x.info.providerID);
      if (m) return { providerID: m.info.providerID!, modelID: m.info.modelID! };
    }
    const config = await readConfigModel();
    return config ? splitModel(config) : { providerID: 'opencode', modelID: 'default' };
  }

  /** opencode names a git project after its sorted-first root commit; anything else is "global". */
  private async projectId(cwd: string): Promise<string> {
    const listed = (await this.cli.list(cwd)).find((s) => path.resolve(s.directory) === cwd && s.projectId);
    if (listed?.projectId) return listed.projectId;
    try {
      const { stdout } = await promisify(execFile)('git', ['rev-list', '--max-parents=0', '--all'], { cwd, timeout: 10_000 });
      return stdout.split('\n').filter(Boolean).sort()[0] ?? 'global';
    } catch {
      return 'global';
    }
  }
}

/**
 * Leading messages that are complete: users always, assistants once they finished
 * or errored. Anything after an in-flight assistant waits for the next read.
 */
function finishedPrefix(messages: OcMessage[]): number {
  const i = messages.findIndex((m) => m.info.role === 'assistant' && !m.info.time?.completed && !m.info.error);
  return i === -1 ? messages.length : i;
}

function appendTurns(session: OcSession, turns: Turn[], model: Model, cwd: string, ids: IdGen) {
  let parent = session.messages.findLast((m) => m.info.role === 'user')?.info.id;
  for (const turn of turns) {
    const id = ids.next('msg');
    const created = ids.ms;
    const info: OcMessage['info'] =
      turn.role === 'user'
        ? { id, sessionID: session.info.id, role: 'user', time: { created }, agent: 'build', model }
        : {
            id,
            sessionID: session.info.id,
            role: 'assistant',
            parentID: parent,
            mode: 'build',
            agent: 'build',
            ...model,
            path: { cwd, root: cwd },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created, completed: created },
            finish: 'stop',
          };
    if (turn.role === 'user') parent = id;
    const part = { id: ids.next('prt'), sessionID: session.info.id, messageID: id, type: 'text', text: turn.text };
    session.messages.push({ info, parts: [part] });
  }
  session.info.time = { created: session.info.time?.created ?? ids.ms, updated: ids.ms };
}

/** Replace every string that is an old id, wherever it appears (messageID, parentID, tail_start_id, …). */
function remap(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remap(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, map)]));
  }
  return value;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * opencode ids: prefix, 12 hex chars of (ms * 0x1000 + counter) truncated to 48 bits,
 * then 14 random base62 chars. Sessions invert the number so newer sort first.
 */
export class IdGen {
  readonly ms: number;
  private counter = 0;

  constructor(ms = Date.now()) {
    this.ms = ms;
  }

  next(prefix: 'ses' | 'msg' | 'prt', descending = false): string {
    const mask = (1n << 48n) - 1n;
    let n = (BigInt(this.ms) * 0x1000n + BigInt(++this.counter)) & mask;
    if (descending) n = ~n & mask;
    const rand = [...randomBytes(14)].map((b) => BASE62[b % 62]).join('');
    return `${prefix}_${n.toString(16).padStart(12, '0')}${rand}`;
  }
}

function listedRef(s: OcListed): NativeRef {
  // There is no file; the path keeps the directory export must run in.
  return {
    tool: 'opencode',
    nativeId: s.id,
    path: path.join(path.resolve(s.directory), s.id),
    startedAt: new Date(s.created).toISOString(),
    updatedAt: new Date(s.updated).toISOString(),
  };
}

function splitModel(s: string): Model {
  const i = s.indexOf('/');
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

function titleFrom(events: Event[]): string {
  const first = events.find((e) => e.kind === 'user_text');
  const text = first?.kind === 'user_text' ? first.text.replace(/\s+/g, ' ').trim() : 'session';
  return `${text.slice(0, 60)} (wormhole)`;
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'filePath', 'pattern', 'url', 'query', 'prompt', 'description']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return JSON.stringify(input);
}

async function readConfigModel(): Promise<string | undefined> {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  try {
    const config = JSON.parse(await fs.readFile(path.join(base, 'opencode', 'opencode.json'), 'utf8')) as { model?: string };
    return config.model;
  } catch {
    return undefined;
  }
}

const run = promisify(execFile);

/**
 * opencode exits before draining a stdout pipe, so large output arrives cut at 8 KB.
 * Pointing stdout at a file avoids that.
 */
async function stdoutViaFile(bin: string, args: string[], cwd: string): Promise<string> {
  const file = path.join(tmpdir(), `wormhole-out-${randomBytes(6).toString('hex')}.json`);
  const fh = await fs.open(file, 'w', 0o600);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, stdio: ['ignore', fh.fd, 'ignore'], timeout: 60_000 });
      child.on('error', reject);
      child.on('exit', resolve);
    });
    if (code !== 0) throw new Error(`${bin} ${args.join(' ')} exited with ${code}`);
    return await fs.readFile(file, 'utf8');
  } finally {
    await fh.close();
    await fs.rm(file, { force: true });
  }
}

const execCli: OpencodeCli = {
  async list(cwd) {
    try {
      return JSON.parse(await stdoutViaFile('opencode', ['session', 'list', '--format', 'json'], cwd)) as OcListed[];
    } catch {
      return [];
    }
  },
  async export(cwd, id) {
    try {
      return JSON.parse(await stdoutViaFile('opencode', ['export', id], cwd)) as OcSession;
    } catch {
      return null;
    }
  },
  async import(cwd, session) {
    const file = path.join(tmpdir(), `wormhole-${session.info.id}.json`);
    await fs.writeFile(file, JSON.stringify(session), { mode: 0o600 });
    try {
      await run('opencode', ['import', file], { cwd, timeout: 60_000 });
    } finally {
      await fs.rm(file, { force: true });
    }
  },
};
