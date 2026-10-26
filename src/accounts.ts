import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Tool } from './model/thread.js';
import { atomicWrite, wormholeHome } from './store/store.js';

/** Tools whose login and sessions live in one folder that an env var can point elsewhere. */
export const ACCOUNT_TOOLS = ['claude', 'codex'] as const;
export type AccountTool = (typeof ACCOUNT_TOOLS)[number];

/** The variable that points each tool at an account's folder. */
export const ACCOUNT_ENV: Record<AccountTool, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A second login of a tool: `claude@work` is Claude Code run with CLAUDE_CONFIG_DIR=<dir>. */
export const Account = z.object({
  name: z.string().regex(NAME),
  tool: z.enum(ACCOUNT_TOOLS),
  dir: z.string(),
});
export type Account = z.infer<typeof Account>;

const File = z.object({
  accounts: z.array(Account).default([]),
  /** Order `wormhole next` tries when the session in use hits its usage limit (keys: `claude`, `codex@alt`). */
  fallback: z.array(z.string()).optional(),
  /** When true, the hooks write the fallback session as soon as a session is found limited. */
  auto: z.boolean().optional(),
});
type File = z.infer<typeof File>;

export function accountsPath(): string {
  return path.join(wormholeHome(), 'accounts.json');
}

/** Sync so contexts can be built without awaiting; a missing file means no accounts. */
export function loadAccounts(file = accountsPath()): Account[] {
  return loadFile(file).accounts;
}

/** The whole accounts.json, settings included. */
export function loadFile(file = accountsPath()): File {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [] };
    throw err;
  }
  return File.parse(JSON.parse(raw));
}

/** Change part of accounts.json, keeping the rest. */
async function update(change: Partial<File>, file = accountsPath()): Promise<void> {
  const next = { ...loadFile(file), ...change };
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
}

async function saveAccounts(accounts: Account[]): Promise<void> {
  await update({ accounts });
}

/** Set the fallback order; an empty list goes back to the default order. */
export async function setFallback(keys: string[]): Promise<string[] | undefined> {
  const accounts = loadAccounts();
  for (const key of keys) {
    const { tool, account } = parseKey(key);
    if (account && !accounts.some((a) => a.tool === tool && a.name === account)) throw new Error(`no account ${key}`);
  }
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) throw new Error(`${dupe} is listed twice`);
  const fallback = keys.length > 0 ? keys : undefined;
  await update({ fallback });
  return fallback;
}

export async function setAuto(on: boolean): Promise<void> {
  await update({ auto: on });
}

export async function addAccount(input: { name: string; tool: string; dir: string }): Promise<Account> {
  if (!NAME.test(input.name)) throw new Error(`account names are lowercase letters, digits and dashes: ${input.name}`);
  const tool = z.enum(ACCOUNT_TOOLS).safeParse(input.tool);
  if (!tool.success) throw new Error(`accounts are for ${ACCOUNT_TOOLS.join(' and ')}, not ${input.tool}`);
  const account: Account = { name: input.name, tool: tool.data, dir: expandHome(input.dir) };
  const accounts = loadAccounts();
  if (accounts.some((a) => a.tool === account.tool && a.name === account.name)) {
    throw new Error(`${keyOf(account.tool, account.name)} already exists`);
  }
  if (path.resolve(account.dir) === defaultDir(account.tool)) {
    throw new Error(`${account.dir} is ${account.tool}'s default folder; use plain "${account.tool}" for it`);
  }
  await saveAccounts([...accounts, account]);
  return account;
}

export async function removeAccount(key: string): Promise<Account> {
  const { tool, account } = parseKey(key);
  const accounts = loadAccounts();
  const found = accounts.find((a) => a.tool === tool && a.name === account);
  if (!found) throw new Error(`no account ${key}`);
  // Take it out of the fallback order too, so the list never names a missing account.
  const { fallback } = loadFile();
  const gone = keyOf(found.tool, found.name);
  await update({
    accounts: accounts.filter((a) => a !== found),
    ...(fallback?.includes(gone) ? { fallback: fallback.filter((k) => k !== gone) } : {}),
  });
  return found;
}

/** `claude` or `claude@work`: how a tool plus account is named on the command line and in contexts. */
export function keyOf(tool: Tool, account?: string): string {
  return account ? `${tool}@${account}` : tool;
}

export function parseKey(key: string): { tool: Tool; account?: string } {
  const [tool, account, extra] = key.split('@');
  const parsed = Tool.safeParse(tool);
  if (!parsed.success || extra !== undefined || account === '') {
    throw new Error(`expected a tool (${Tool.options.join(', ')}), optionally with @account: ${key}`);
  }
  return { tool: parsed.data, account };
}

/** The folder a tool uses when no account is given: its env var, else the usual place. */
export function defaultDir(tool: AccountTool): string {
  const fromEnv = process.env[ACCOUNT_ENV[tool]];
  return path.resolve(fromEnv || path.join(homedir(), tool === 'claude' ? '.claude' : '.codex'));
}

function expandHome(dir: string): string {
  return path.resolve(dir === '~' ? homedir() : dir.startsWith('~/') ? path.join(homedir(), dir.slice(2)) : dir);
}
