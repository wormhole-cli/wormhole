import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { type Account, ACCOUNT_ENV, type AccountTool, loadAccounts } from './accounts.js';
import { chainedFrom, findNotify, OPENCODE_MARKER, opencodePluginFormat } from './hooks/install.js';
import { Thread } from './model/thread.js';
import { capture, findOnPath } from './proc.js';

/** `wormhole doctor` only looks: every probe reads, none writes. */

export type Level = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  level: Level;
  detail: string;
  /** What to do about it; set on every warn and fail. */
  fix?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What doctor reaches outside itself; tests replace these. */
export interface Probes {
  env: NodeJS.ProcessEnv;
  home: string;
  now: () => number;
  /** Absolute path of an executable on PATH, or null. */
  which: (bin: string) => Promise<string | null>;
  /** Run a command; null when it cannot be started at all. */
  exec: (bin: string, args: string[], env?: Record<string, string>) => Promise<ExecResult | null>;
  /** File text, or null when it does not exist. */
  readFile: (file: string) => Promise<string | null>;
  stat: (file: string) => Promise<{ isDirectory: boolean; mtimeMs: number } | null>;
  readdir: (dir: string) => Promise<string[]>;
  writable: (file: string) => Promise<boolean>;
  loadAccounts: (file: string) => Account[];
}

const LOCK_STALE_MS = 30_000;
const RECENT_HOOK_ERROR_MS = 7 * 24 * 3600_000;
const EXEC_TIMEOUT_MS = 10_000;

export function realProbes(): Probes {
  const env = process.env;
  return {
    env,
    home: homedir(),
    now: Date.now,
    which: (bin) => findOnPath(bin, env),
    async exec(bin, args, extra) {
      const r = await capture(bin, args, { env: { ...env, ...extra }, timeoutMs: EXEC_TIMEOUT_MS });
      return r && { code: r.code, stdout: r.stdout, stderr: r.timedOut ? 'timed out' : r.stderr };
    },
    readFile: (file) => fs.readFile(file, 'utf8').catch(() => null),
    stat: (file) =>
      fs.stat(file).then(
        (s) => ({ isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }),
        () => null,
      ),
    readdir: (dir) => fs.readdir(dir).catch(() => []),
    writable: (file) => fs.access(file, fsConstants.W_OK).then(() => true, () => false),
    loadAccounts,
  };
}

/** One account folder to check: the default one (no name) or a named account. */
interface Folder {
  tool: AccountTool;
  key: string;
  dir: string;
  env: Record<string, string>;
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
const shellEnv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `env ${k}=${v} `)
    .join('');

export async function runDoctor(p: Probes = realProbes()): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, level: Level, detail: string, fix?: string) => checks.push({ name, level, detail, ...(fix ? { fix } : {}) });

  const wormholeHome = p.env.WORMHOLE_HOME || path.join(p.home, '.wormhole');
  const defaults: Record<AccountTool, string> = {
    claude: path.resolve(p.env[ACCOUNT_ENV.claude] || path.join(p.home, '.claude')),
    codex: path.resolve(p.env[ACCOUNT_ENV.codex] || path.join(p.home, '.codex')),
  };

  // ---- tools ----
  const bins: Record<string, string | null> = {};
  const versions: Record<string, string> = {};
  for (const tool of ['claude', 'codex', 'opencode'] as const) {
    const bin = await p.which(tool);
    bins[tool] = bin;
    if (!bin) {
      const optional = tool === 'opencode';
      add(`${tool} on PATH`, optional ? 'warn' : 'fail', `${tool} not found on PATH`, `install ${tool}, or add it to PATH${optional ? ' (only needed to switch to opencode)' : ''}`);
      continue;
    }
    const version = await p.exec(bin, ['--version']);
    const match = version?.stdout.match(/\d+\.\d+\.\d+[\w.-]*/);
    if (match) versions[tool] = match[0];
    if (match) add(`${tool} on PATH`, 'pass', `${match[0]} (${bin})`);
    else add(`${tool} on PATH`, 'warn', `${bin} did not report a version`, `run \`${tool} --version\` to see why`);
  }

  // ---- accounts ----
  let accounts: Account[] = [];
  const accountsFile = path.join(wormholeHome, 'accounts.json');
  try {
    accounts = p.loadAccounts(accountsFile);
    if (accounts.length === 0) add('accounts', 'pass', 'none registered');
  } catch (err) {
    add('accounts', 'fail', `${accountsFile} does not load: ${err instanceof Error ? firstLine(err.message) : String(err)}`, 'fix or delete the file, then re-add accounts with `wormhole accounts add`');
  }
  const seenKeys = new Set<string>();
  const seenDirs = new Map<string, string>();
  const folders: Folder[] = [
    { tool: 'claude', key: 'claude', dir: defaults.claude, env: {} },
    { tool: 'codex', key: 'codex', dir: defaults.codex, env: {} },
  ];
  for (const a of accounts) {
    const key = `${a.tool}@${a.name}`;
    const dir = path.resolve(a.dir);
    const name = `account ${key}`;
    const other = seenDirs.get(`${a.tool}:${dir}`);
    if (seenKeys.has(key)) add(name, 'fail', 'listed twice in accounts.json', `remove the extra entry from ${accountsFile}`);
    else if (dir === defaults[a.tool]) add(name, 'fail', `${dir} is ${a.tool}'s default folder`, `wormhole accounts remove ${key}; use plain "${a.tool}" for that folder`);
    else if (other) add(name, 'fail', `same folder as ${other} (${dir})`, `wormhole accounts remove ${key}`);
    else if (!(await p.stat(dir))?.isDirectory) add(name, 'fail', `folder ${dir} does not exist`, `log in once with: env ${ACCOUNT_ENV[a.tool]}=${dir} ${a.tool === 'claude' ? 'claude' : 'codex login'}`);
    else {
      add(name, 'pass', dir);
      folders.push({ tool: a.tool, key, dir, env: { [ACCOUNT_ENV[a.tool]]: dir } });
    }
    seenKeys.add(key);
    if (!other) seenDirs.set(`${a.tool}:${dir}`, key);
  }

  // ---- logins ----
  for (const f of folders) {
    const bin = bins[f.tool];
    const name = `${f.key} login`;
    if (f.tool === 'claude') {
      if (!bin) { add(name, 'warn', "can't check: claude is not on PATH", 'install Claude Code'); continue; }
      const res = await p.exec(bin, ['auth', 'status', '--json'], f.env);
      let status: { loggedIn?: boolean; email?: string; authMethod?: string } | null = null;
      try { status = res ? JSON.parse(res.stdout) : null; } catch { status = null; }
      if (!status || typeof status.loggedIn !== 'boolean') {
        add(name, 'warn', `can't check: \`claude auth status\` gave no answer${res?.stderr ? ` (${firstLine(res.stderr)})` : ''}`, `${shellEnv(f.env)}claude auth status`);
      } else if (status.loggedIn) {
        add(name, 'pass', `logged in${status.email ? ` as ${status.email}` : ''}${status.authMethod ? ` (${status.authMethod})` : ''}`);
      } else {
        add(name, 'fail', `not logged in (${f.dir})`, `${shellEnv(f.env)}claude auth login`);
      }
      continue;
    }
    const auth = path.join(f.dir, 'auth.json');
    const hasAuth = (await p.readFile(auth)) !== null;
    const res = bin ? await p.exec(bin, ['login', 'status'], f.env) : null;
    if (res && res.code === 0) add(name, 'pass', firstLine(res.stdout || res.stderr) || 'logged in');
    else if (res) add(name, 'fail', `not logged in: ${firstLine(res.stderr || res.stdout) || `codex login status exited ${res.code}`}`, `${shellEnv(f.env)}codex login`);
    else if (hasAuth) add(name, 'pass', `${auth} present`);
    else add(name, 'fail', `no ${auth}`, `${shellEnv(f.env)}codex login`);
  }

  // ---- hooks ----
  const hookFix = 'wormhole hooks install';
  /** Paths in a hook's argv before `hook` that no longer exist (a moved repo or reinstalled node). */
  const missingPaths = async (argv: string[]) => {
    const head = argv.slice(0, Math.max(0, argv.indexOf('hook')));
    const missing: string[] = [];
    for (const a of head) if (path.isAbsolute(a) && !(await p.stat(a))) missing.push(a);
    return { head, missing };
  };
  const checkArgv = async (name: string, argv: string[], where: string) => {
    const { head, missing } = await missingPaths(argv);
    if (head.length === 0) add(name, 'fail', `hook in ${where} has no program`, hookFix);
    else if (missing.length > 0) add(name, 'fail', `hook in ${where} runs ${missing.join(', ')}, which no longer exists`, `${hookFix} (from the wormhole you use now)`);
    else return true;
    return false;
  };

  for (const f of folders) {
    const name = `${f.key} hook`;
    if (f.tool === 'claude') {
      const file = path.join(f.dir, 'settings.json');
      const raw = await p.readFile(file);
      let settings: { hooks?: { SessionEnd?: { hooks?: { command?: string }[] }[] } } = {};
      try { settings = raw === null ? {} : JSON.parse(raw); } catch {
        add(name, 'fail', `${file} is not valid JSON`, `fix ${file} by hand`); continue;
      }
      const command = (settings.hooks?.SessionEnd ?? [])
        .flatMap((g) => g.hooks ?? [])
        .map((h) => h.command ?? '')
        .find((c) => /wormhole.* hook claude$/.test(c));
      if (!command) { add(name, 'warn', `no SessionEnd hook in ${file}`, hookFix); continue; }
      if (await checkArgv(name, shellWords(command), file)) add(name, 'pass', `SessionEnd hook in ${file}`);
      continue;
    }
    const file = path.join(f.dir, 'config.toml');
    const toml = (await p.readFile(file)) ?? '';
    let notify: string[] | null = null;
    try { notify = findNotify(toml.split('\n'))?.argv ?? null; } catch {
      add(name, 'fail', `notify in ${file} does not parse`, `fix notify in ${file} by hand, then ${hookFix}`); continue;
    }
    const chained = notify && chainedFrom(notify);
    if (!notify || chained === null) { add(name, 'warn', `notify in ${file} is not wormhole's`, hookFix); continue; }
    if (!(await checkArgv(name, notify, file))) continue;
    // The program wormhole wrapped: still there, and still the one from before wormhole.
    let before: string[] = [];
    try { before = findNotify(((await p.readFile(`${file}.before-wormhole`)) ?? '').split('\n'))?.argv ?? []; } catch { before = []; }
    if (chainedFrom(before) !== null) before = [];
    if (chained!.length > 0 && path.isAbsolute(chained![0]!) && !(await p.stat(chained![0]!))) {
      add(name, 'warn', `notify chains ${chained![0]}, which no longer exists`, `remove it from notify in ${file}, or reinstall it and run ${hookFix}`);
    } else if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(chained)) {
      add(name, 'warn', `the notify program from before wormhole (${path.basename(before[0]!)}) is no longer chained`, `add it back with: ${hookFix}, after restoring notify in ${file}`);
    } else {
      add(name, 'pass', `notify in ${file}${chained!.length > 0 ? ` (still runs ${path.basename(chained![0]!)})` : ''}`);
    }
  }

  const plugin = path.join(p.env.XDG_CONFIG_HOME || path.join(p.home, '.config'), 'opencode', 'plugins', 'wormhole.js');
  const pluginText = await p.readFile(plugin);
  if (pluginText === null) {
    if (bins.opencode) add('opencode hook', 'warn', `no plugin at ${plugin}`, `${hookFix} --opencode`);
  } else if (!pluginText.startsWith(OPENCODE_MARKER)) {
    add('opencode hook', 'warn', `${plugin} was not written by wormhole`, `move it aside, then ${hookFix} --opencode`);
  } else {
    let argv: string[] = [];
    try { argv = JSON.parse(pluginText.match(/const WORMHOLE = (\[.*\]);/)?.[1] ?? '[]') as string[]; } catch { argv = []; }
    const major = versions.opencode ? Number.parseInt(versions.opencode, 10) : undefined;
    const wanted = major === undefined ? undefined : major >= 2 ? 2 : 1;
    const written = opencodePluginFormat(pluginText);
    if (wanted !== undefined && written !== wanted) {
      add('opencode hook', 'fail', `${plugin} is written for the opencode ${written}.x plugin API, but opencode ${versions.opencode} is installed and will not load it`, `${hookFix} --opencode`);
    } else if (await checkArgv('opencode hook', [...argv, 'hook'], plugin)) add('opencode hook', 'pass', `plugin ${plugin}`);
  }

  // ---- store ----
  const home = await p.stat(wormholeHome);
  if (home) {
    if (await p.writable(wormholeHome)) add('store', 'pass', `${wormholeHome} writable`);
    else add('store', 'fail', `${wormholeHome} is not writable`, `chmod u+w ${wormholeHome}, or set WORMHOLE_HOME`);
  } else {
    // Created on first use; the nearest existing parent has to be writable.
    let parent = path.dirname(wormholeHome);
    while (!(await p.stat(parent)) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    if (await p.writable(parent)) add('store', 'pass', `${wormholeHome} not created yet (no threads)`);
    else add('store', 'fail', `${wormholeHome} does not exist and ${parent} is not writable`, 'set WORMHOLE_HOME to a writable folder');
  }

  const threadsDir = path.join(wormholeHome, 'threads');
  let good = 0;
  for (const id of (await p.readdir(threadsDir)).sort()) {
    const dir = path.join(threadsDir, id);
    if (!(await p.stat(dir))?.isDirectory) continue;
    const raw = await p.readFile(path.join(dir, 'thread.json'));
    let thread: Thread | null = null;
    let problem = false;
    try {
      thread = raw === null ? null : Thread.parse(JSON.parse(raw));
      if (!thread) { add(`thread ${id}`, 'warn', 'no thread.json', `remove ${dir} if it is left over`); problem = true; }
    } catch (err) {
      add(`thread ${id}`, 'fail', `thread.json does not load: ${firstLine(err instanceof Error ? err.message : String(err))}`, `move ${dir} aside; the next \`wormhole import\` in that project starts a new thread`);
      problem = true;
    }
    const where = thread ? ` (${thread.cwd})` : '';
    if ((await p.readFile(path.join(dir, 'pending.json'))) !== null) {
      add(`thread ${id}`, 'warn', `an interrupted commit is waiting in pending.json${where}`, `run \`wormhole import\`${thread ? ` in ${thread.cwd}` : ''} to finish it`);
      problem = true;
    }
    const lock = await p.stat(path.join(dir, '.lock'));
    if (lock && p.now() - lock.mtimeMs > LOCK_STALE_MS) {
      add(`thread ${id}`, 'warn', `stale lock, ${Math.round((p.now() - lock.mtimeMs) / 1000)} s old${where}`, `rm -r ${path.join(dir, '.lock')} (if no wormhole is running)`);
      problem = true;
    }
    if (!problem) good++;
  }
  if (good > 0 || checks.every((c) => !c.name.startsWith('thread '))) add('threads', 'pass', `${good} thread${good === 1 ? ' loads' : 's load'} cleanly`);

  const log = await p.readFile(path.join(wormholeHome, 'hook.log'));
  const entries = (log ?? '').split(/\n(?=\d{4}-\d\d-\d\dT)/).filter((e) => e.trim() !== '');
  const last = entries.at(-1);
  if (!last) add('hook.log', 'pass', 'no hook errors');
  else {
    const when = Date.parse(last.slice(0, 24));
    const recent = !Number.isNaN(when) && p.now() - when < RECENT_HOOK_ERROR_MS;
    if (recent) add('hook.log', 'warn', `last hook error: ${firstLine(last)}`, `see ${path.join(wormholeHome, 'hook.log')}`);
    else add('hook.log', 'pass', `no hook errors in the last 7 days (${entries.length} older)`);
  }

  return checks;
}

/** Words of a POSIX shell command as wormhole writes them (plain words and '…' quoting). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? command.length : end;
      inWord = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

export function formatChecks(checks: Check[]): string[] {
  const label: Record<Level, string> = { pass: 'pass', warn: 'WARN', fail: 'FAIL' };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${label[c.level]}  ${c.name.padEnd(width)}  ${c.detail}${c.fix ? `  → ${c.fix}` : ''}`);
}

export const failed = (checks: Check[]) => checks.some((c) => c.level === 'fail');
