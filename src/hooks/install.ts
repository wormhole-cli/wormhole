import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../store/store.js';
import { THEN } from './handle.js';

/** argv that runs this wormhole install: absolute, because hooks run without the user's PATH. */
export function selfArgv(): string[] {
  const bin = process.argv[1];
  if (!bin) throw new Error('cannot tell where wormhole is installed');
  return [process.execPath, path.resolve(bin)];
}

export function claudeSettingsPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json');
}

export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
}

// ---- Claude Code: settings.json hooks.SessionEnd ----

interface HookCommand {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const isOurs = (command: string) => /wormhole.* hook claude$/.test(command);

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Settings with our SessionEnd hook present exactly once; other hooks untouched. */
export function withClaudeHook(settings: Settings, self: string[]): Settings {
  const command = [...self, 'hook', 'claude'].map(shellQuote).join(' ');
  const out = withoutClaudeHook(settings);
  const hooks = { ...(out.hooks ?? {}) };
  hooks.SessionEnd = [...(hooks.SessionEnd ?? []), { hooks: [{ type: 'command', command }] }];
  return { ...out, hooks };
}

export function withoutClaudeHook(settings: Settings): Settings {
  if (!settings.hooks?.SessionEnd) return settings;
  const groups = settings.hooks.SessionEnd.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) })).filter(
    (g) => g.hooks.length > 0,
  );
  const hooks = { ...settings.hooks };
  if (groups.length > 0) hooks.SessionEnd = groups;
  else delete hooks.SessionEnd;
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

export function hasClaudeHook(settings: Settings): boolean {
  return (settings.hooks?.SessionEnd ?? []).some((g) => g.hooks.some((h) => isOurs(h.command)));
}

// ---- Codex: config.toml top-level notify ----

interface NotifyLine {
  /** Line range [start, end) the notify key spans; absent when there is none. */
  start: number;
  end: number;
  argv: string[];
}

/** The top-level `notify = [...]` entry: keys after the first [table] header belong to that table. */
export function findNotify(lines: string[]): NotifyLine | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) return null;
    if (!/^\s*notify\s*=/.test(line)) continue;
    let end = i + 1;
    for (;;) {
      const text = lines.slice(i, end).join('\n');
      try {
        return { start: i, end, argv: parseTomlStrings(text.slice(text.indexOf('=') + 1)) };
      } catch (err) {
        if (end >= lines.length) throw err;
        end++;
      }
    }
  }
  return null;
}

/** Strings of a TOML array of basic ("…") or literal ('…') strings. */
export function parseTomlStrings(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  const skip = () => {
    while (i < value.length) {
      if (/\s/.test(value[i]!)) { i++; continue; }
      if (value[i] === '#') { while (i < value.length && value[i] !== '\n') i++; continue; }
      break;
    }
  };
  skip();
  if (value[i++] !== '[') throw new Error('notify must be a TOML string array');
  for (;;) {
    skip();
    if (value[i] === ']') { i++; break; }
    const quote = value[i++];
    if (quote !== '"' && quote !== "'") throw new Error('invalid notify string');
    const multiline = value.slice(i, i + 2) === quote.repeat(2);
    if (multiline) i += 2;
    if (multiline && value[i] === '\n') i++;
    let text = '', closed = false;
    while (i < value.length) {
      if (value.slice(i, i + (multiline ? 3 : 1)) === quote.repeat(multiline ? 3 : 1)) {
        i += multiline ? 3 : 1; closed = true; break;
      }
      const ch = value[i++]!;
      if (!multiline && /[\r\n]/.test(ch)) throw new Error('newline in notify string');
      if (ch !== '\\' || quote === "'") { text += ch; continue; }
      const esc = value[i++];
      const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (esc && esc in escapes) text += escapes[esc];
      else if (esc === 'u' || esc === 'U') {
        const n = esc === 'u' ? 4 : 8;
        const hex = value.slice(i, i + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) throw new Error('invalid TOML unicode escape');
        const cp = Number.parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('invalid TOML unicode scalar');
        text += String.fromCodePoint(cp); i += n;
      } else if (multiline && esc && /\s/.test(esc)) {
        while (i < value.length && /\s/.test(value[i]!)) i++;
      } else throw new Error('invalid TOML escape');
    }
    if (!closed) throw new Error('unterminated notify string');
    out.push(text);
    skip();
    if (value[i] === ']') { i++; break; }
    if (value[i++] !== ',') throw new Error('expected comma in notify');
  }
  skip();
  if (i !== value.length) throw new Error('unexpected text after notify');
  return out;
}

const tomlArray = (argv: string[]) => `[${argv.map((a) => JSON.stringify(a)).join(', ')}]`;

/** The notify program wormhole wraps, if `argv` is our own notify entry. */
export function chainedFrom(argv: string[]): string[] | null {
  const i = argv.indexOf('hook');
  if (i < 0 || argv[i + 1] !== 'codex' || !argv.slice(0, i).some((a) => a.includes('wormhole'))) return null;
  const t = argv.indexOf(THEN, i);
  return t < 0 ? [] : argv.slice(t + 1);
}

/** Config text with notify pointing at wormhole, chaining to whatever notify was there before. */
export function withCodexNotify(toml: string, self: string[]): string {
  const lines = toml.split('\n');
  const found = findNotify(lines);
  const previous = found ? (chainedFrom(found.argv) ?? found.argv) : [];
  const argv = [...self, 'hook', 'codex', ...(previous.length > 0 ? [THEN, ...previous] : [])];
  const entry = `notify = ${tomlArray(argv)}`;
  if (found) {
    lines.splice(found.start, found.end - found.start, entry);
    return lines.join('\n');
  }
  const table = lines.findIndex((l) => /^\s*\[/.test(l));
  if (table >= 0) {
    lines.splice(table, 0, entry, '');
    return lines.join('\n');
  }
  return toml.trim() === '' ? `${entry}\n` : `${toml.replace(/\n*$/, '\n')}${entry}\n`;
}

/** Config text with the notify program from before wormhole restored (or no notify at all). */
export function withoutCodexNotify(toml: string): string {
  const lines = toml.split('\n');
  const found = findNotify(lines);
  const previous = found && chainedFrom(found.argv);
  if (!found || previous === null) return toml;
  lines.splice(found.start, found.end - found.start, ...(previous.length > 0 ? [`notify = ${tomlArray(previous)}`] : []));
  return lines.join('\n');
}

export function hasCodexNotify(toml: string): boolean {
  const found = findNotify(toml.split('\n'));
  return !!found && chainedFrom(found.argv) !== null;
}

// ---- file IO ----

async function readOr(file: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Keep the first pre-wormhole version of a config file next to it. */
async function backupOnce(file: string) {
  const backup = `${file}.before-wormhole`;
  const exists = await fs.stat(backup).then(() => true, () => false);
  if (!exists) await fs.copyFile(file, backup).catch(() => {});
}

export type Target = 'claude' | 'codex';

export async function install(targets: Target[], self = selfArgv()): Promise<string[]> {
  const done: string[] = [];
  if (targets.includes('claude')) {
    const file = claudeSettingsPath();
    const settings = JSON.parse(await readOr(file, '{}')) as Settings;
    await backupOnce(file);
    await atomicWrite(file, `${JSON.stringify(withClaudeHook(settings, self), null, 2)}\n`);
    done.push(`Claude Code: SessionEnd hook in ${file}`);
  }
  if (targets.includes('codex')) {
    const file = codexConfigPath();
    const toml = await readOr(file, '');
    await backupOnce(file);
    const chained = findNotify(toml.split('\n'));
    await atomicWrite(file, withCodexNotify(toml, self));
    const prev = chained ? (chainedFrom(chained.argv) ?? chained.argv) : [];
    done.push(`Codex: notify in ${file}${prev.length > 0 ? ` (still runs ${path.basename(prev[0]!)})` : ''}`);
  }
  return done;
}

export async function uninstall(targets: Target[]): Promise<string[]> {
  const done: string[] = [];
  if (targets.includes('claude')) {
    const file = claudeSettingsPath();
    const settings = JSON.parse(await readOr(file, '{}')) as Settings;
    if (hasClaudeHook(settings)) {
      await atomicWrite(file, `${JSON.stringify(withoutClaudeHook(settings), null, 2)}\n`);
      done.push(`Claude Code: removed SessionEnd hook from ${file}`);
    }
  }
  if (targets.includes('codex')) {
    const file = codexConfigPath();
    const toml = await readOr(file, '');
    if (hasCodexNotify(toml)) {
      await atomicWrite(file, withoutCodexNotify(toml));
      done.push(`Codex: restored notify in ${file}`);
    }
  }
  return done;
}

export async function status(): Promise<{ claude: boolean; codex: boolean }> {
  const settings = JSON.parse(await readOr(claudeSettingsPath(), '{}')) as Settings;
  return { claude: hasClaudeHook(settings), codex: hasCodexNotify(await readOr(codexConfigPath(), '')) };
}
