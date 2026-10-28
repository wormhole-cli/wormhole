import { readFileSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { oneLine } from './adapters/render.js';
import type { NativeRef } from './adapters/types.js';
import { type Account, addAccount, loadAccounts, loadFile, parseKey, removeAccount, setAuto, setFallback } from './accounts.js';
import { type Check, failed, formatChecks, type Probes, runDoctor } from './doctor.js';
import { adapter, type Context, defaultContext, makeBrief, refKey, type SwitchResult, switchTo, sync } from './core.js';
import {
  handleHook,
  logHookError,
  parseClaudeHook,
  parseCodexNotify,
  parseOpencodeHook,
  readStdin,
  runChained,
  THEN,
} from './hooks/handle.js';
import {
  accountHookInstalled,
  claudeSettingsPath,
  codexConfigPath,
  install,
  opencodeOnPath,
  opencodePluginPath,
  status as hookStatus,
  type Target,
  uninstall,
} from './hooks/install.js';
import { type Runner, runCapture, summarize } from './handoff/summary.js';
import { fallbackNote, fallbackOrder, pickFallback, resets } from './fallback.js';
import { launch, openUrl, shellLine } from './launch.js';
import { sessionLimit } from './limits.js';
import { activeSegment, type Event, eventTool, srcKey, TOOLS, Tool } from './model/thread.js';

/** From package.json, one level up from both src/ (tests) and dist/ (installed), so `npm version` is the only bump. */
const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** What the CLI reaches outside itself; tests replace these. */
export interface Deps {
  context: (cwd: string) => Context;
  launch: (argv: string[], cwd: string) => Promise<number>;
  openUrl: (url: string) => Promise<number>;
  readStdin: () => Promise<string>;
  /** Runs a tool headless for `--summarize`. */
  run: Runner;
  /** Replaces what `doctor` probes. */
  doctorProbes?: Probes;
}

const defaults: Deps = { context: defaultContext, launch, openUrl, readStdin, run: runCapture };

/** Run the CLI on a full argv (node, script, …args) and return its exit code. */
export async function main(argv: string[] = process.argv, deps: Partial<Deps> = {}): Promise<number> {
  const state = { exitCode: 0 };
  const program = buildProgram({ ...defaults, ...deps }, argv, state);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    console.error(`wormhole: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return state.exitCode;
}

function buildProgram(deps: Deps, argv: string[], state: { exitCode: number }): Command {
  const program = new Command();

  program
    .name('wormhole')
    .description('Move a coding session between Claude Code, Codex and opencode, and resume it on the other side.')
    .version(VERSION)
    .option('-C, --cwd <dir>', 'project directory (default: current directory)')
    .exitOverride();

  function ctx(): Context {
    return deps.context(program.opts<{ cwd?: string }>().cwd ?? process.cwd());
  }

  function parseTool(value: string): Tool {
    const parsed = Tool.safeParse(value);
    if (!parsed.success) throw new InvalidArgumentError(`expected one of ${TOOLS.join(', ')}`);
    return parsed.data;
  }

  /** A tool, or a tool's named account: `claude`, `claude@work`. */
  function parseTarget(value: string): string {
    try {
      parseKey(value);
      return value;
    } catch {
      throw new InvalidArgumentError(`expected one of ${TOOLS.join(', ')}, optionally with @account`);
    }
  }

  const fromOption = () =>
    new Option('--from <tool>', 'tool (or tool@account) that owns --session').argParser(parseTarget);

  /** The leaving tool's own summary of `ref`, or undefined (with a warning) when it cannot give one. */
  async function askSummary(c: Context, ref: NativeRef | null, to?: Tool) {
    if (!ref || ref.tool === to) return undefined;
    console.error(`Asking ${refKey(ref)} for a summary of ${ref.nativeId}…`);
    try {
      return { tool: ref.tool, text: await summarize(ref, c.cwd, deps.run, undefined, adapter(c, refKey(ref)).env) };
    } catch (err) {
      console.error(`wormhole: no summary from ${ref.tool} (${err instanceof Error ? err.message : String(err)}); using the plain brief`);
      return undefined;
    }
  }

  async function run(c: Context, ref: NativeRef, opts: { launch: boolean; app?: boolean }) {
    const a = adapter(c, refKey(ref));
    if (opts.app) {
      if (!a.appUrl) throw new Error(`${ref.tool} has no desktop app link; drop --app to open it in the terminal`);
      const url = a.appUrl(ref);
      console.log(`  open ${url}`);
      if (opts.launch) state.exitCode = await deps.openUrl(url);
      return;
    }
    const argv = a.launchArgs(ref);
    console.log(`  ${shellLine(argv)}`);
    if (opts.launch) state.exitCode = await deps.launch(argv, c.cwd);
  }

  program
    .command('status')
    .description('Show the thread for this directory and the newest session in each tool')
    .action(async () => {
      const c = ctx();
      const thread = await c.store.loadForCwd(c.cwd);
      if (thread) {
        const active = activeSegment(thread);
        console.log(`thread ${thread.id}  ${thread.title}`);
        console.log(`cwd    ${thread.cwd}`);
        console.log(`last   ${active ? `${refKey(active)} ${active.nativeId}` : '(none)'}`);
        for (const seg of thread.segments) {
          const via = seg.derivedFrom ? `  (handed off from ${refKey(seg.derivedFrom)})` : '';
          console.log(`  ${seg.startedAt}  ${refKey(seg).padEnd(10)} ${seg.nativeId}${via}`);
        }
        for (const line of await fallbackNote(c, thread)) console.log(line);
      } else {
        console.log(`No wormhole thread for ${c.cwd} yet.`);
      }
      console.log('newest native sessions:');
      for (const [key, a] of Object.entries(c.adapters)) {
        const ref = await a!.detectLatest(c.cwd);
        const limit = ref && (await sessionLimit(ref).catch(() => null));
        const note = limit?.limited ? `  LIMITED (${limit.reason}${resets(limit.resetsAt)})` : '';
        console.log(`  ${key.padEnd(10)} ${ref ? `${ref.nativeId}  updated ${ref.updatedAt}${note}` : '(none)'}`);
      }
    });

  program
    .command('import')
    .description('Pull new turns from the sessions this thread tracks, and adopt the one in use')
    .addOption(fromOption())
    .option('-s, --session <id>', 'import this session (needs --from)')
    .option('-q, --quiet', 'print nothing')
    .action(async (opts: { from?: string; session?: string; quiet?: boolean }) => {
      if (opts.session && !opts.from) throw new Error('--session needs --from');
      const { imported } = await sync(ctx(), { tool: opts.from, session: opts.session });
      if (opts.quiet) return;
      if (imported.length === 0) console.log('Nothing new.');
      for (const i of imported) {
        console.log(`${i.isNew ? 'adopted' : 'updated'} ${refKey(i)} ${i.nativeId}: +${i.events} events`);
      }
    });

  program
    .command('switch')
    .description('Hand the thread off to another tool and open it there')
    .argument('<tool>', `${TOOLS.join(' | ')}, or tool@account`, parseTarget)
    .addOption(fromOption())
    .option('-s, --session <id>', 'hand off this session instead of the newest (needs --from)')
    .option('--no-launch', 'write the session and print the command, but do not open it')
    .option('--app', 'open it in the desktop app (Claude Desktop, Codex Desktop) instead of the terminal')
    .option('--summarize', 'ask the tool being left for a short summary and add it to the brief')
    .option('--lean', 'start from the brief alone, with the conversation in a file it points to (fewer tokens)')
    .action(async (to: string, opts: { from?: string; session?: string; launch: boolean; app?: boolean; summarize?: boolean; lean?: boolean }) => {
      if (opts.session && !opts.from) throw new Error('--session needs --from');
      const c = ctx();
      adapter(c, to);
      const from = { tool: opts.from, session: opts.session };
      const summary = opts.summarize ? await askSummary(c, (await sync(c, from)).active, parseKey(to).tool) : undefined;
      const result = await switchTo(c, to, { ...from, summary, lean: opts.lean });
      report(result, to);
      await run(c, result.ref, opts);
    });

  program
    .command('resume')
    .description('Reopen the session in use; with a tool, switch to it first if needed')
    .argument('[tool]', `${TOOLS.join(' | ')}, or tool@account`, parseTarget)
    .option('--no-launch', 'print the command, but do not open it')
    .option('--app', 'open it in the desktop app instead of the terminal')
    .action(async (tool: string | undefined, opts: { launch: boolean; app?: boolean }) => {
      const c = ctx();
      if (tool) {
        const result = await switchTo(c, tool);
        report(result, tool);
        return run(c, result.ref, opts);
      }
      const { thread, active } = await sync(c);
      if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${c.cwd}`);
      for (const line of await fallbackNote(c, thread)) console.log(line);
      await run(c, active, opts);
    });

  program
    .command('next')
    .description('If the session in use hit its usage limit, move it to the next account or tool with room')
    .option('--force', 'move it even if it is not limited')
    .option('--lean', 'start from the brief alone, with the conversation in a file it points to')
    .option('--no-launch', 'write the session and print the command, but do not open it')
    .option('--app', 'open it in the desktop app instead of the terminal')
    .action(async (opts: { force?: boolean; launch: boolean; app?: boolean; lean?: boolean }) => {
      const c = ctx();
      const { active } = await sync(c);
      if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${c.cwd}`);
      const key = refKey(active);
      const limit = await sessionLimit(active);
      const state = limit.limited ? `limited, ${limit.reason}${resets(limit.resetsAt)}` : `not limited, ${limit.reason}`;
      console.log(`${key} ${active.nativeId}: ${state}`);
      if (!limit.limited && !opts.force) {
        console.log('Nothing to do; --force moves it anyway.');
        return;
      }
      const pick = await pickFallback(c, key, loadFile().fallback);
      for (const s of pick.skipped) console.log(`  skipped ${s.key}: ${s.why}`);
      if (!pick.target) {
        throw new Error('no other account or tool has room; add one (wormhole accounts add) or wait for the reset');
      }
      const result = await switchTo(c, pick.target, {
        tool: key,
        session: active.nativeId,
        lean: opts.lean,
        ...(limit.limited ? { limit } : {}),
      });
      report(result, pick.target);
      await run(c, result.ref, opts);
    });

  program
    .command('log')
    .description('Print the thread as one line per event')
    .option('-n, --limit <n>', 'last n events', (v) => Number.parseInt(v, 10), 40)
    .action(async (opts: { limit: number }) => {
      const c = ctx();
      const { thread } = await sync(c);
      const events = await c.store.readEvents(thread.id);

      // Label by the session an event came from, so named accounts show as tool@account.
      const bySrc = new Map(thread.segments.map((s) => [srcKey(s), refKey(s)]));
      const label = (e: Event, i: number) => (e.src && bySrc.get(e.src)) || eventTool(e, i, thread.segments) || '?';
      const from = Math.max(0, events.length - opts.limit);
      events.slice(from).forEach((e, k) => {
        console.log(`${String(from + k).padStart(5)} ${label(e, from + k).padEnd(10)} ${describe(e)}`);
      });
    });

  program
    .command('brief')
    .description('Print the handoff note a switch would add')
    .addOption(new Option('--to <tool>', 'target tool').argParser(parseTool).default('codex'))
    .option('--summarize', 'ask the session in use for a short summary and add it')
    .action(async (opts: { to: Tool; summarize?: boolean }) => {
      const c = ctx();
      const { thread, active } = await sync(c);
      const summary = opts.summarize ? await askSummary(c, active, opts.to) : undefined;
      console.log(await makeBrief(c, thread, opts.to, undefined, false, summary));
    });

  const hooks = program.command('hooks').description('Keep threads up to date automatically');

  type HookOpts = { claude?: boolean; codex?: boolean; opencode?: boolean };
  const ALL_HOOKS: Target[] = ['claude', 'codex', 'opencode'];

  /** Explicit flags win; otherwise every tool (install: opencode only when it is on PATH). */
  async function hookTargets(opts: HookOpts, forInstall: boolean): Promise<Target[]> {
    const picked = ALL_HOOKS.filter((t) => opts[t]);
    if (picked.length > 0) return picked;
    return forInstall && !(await opencodeOnPath()) ? ['claude', 'codex'] : ALL_HOOKS;
  }

  hooks
    .command('install')
    .description('Import new turns when a Claude Code session ends and after each Codex or opencode turn')
    .option('--claude', 'only Claude Code')
    .option('--codex', 'only Codex')
    .option('--opencode', 'only opencode (default: included when opencode is on PATH)')
    .action(async (opts: HookOpts) => {
      for (const line of await install(await hookTargets(opts, true), undefined, loadAccounts())) console.log(line);
      console.log('Hooks only update projects that already have a wormhole thread.');
    });

  hooks
    .command('uninstall')
    .description('Remove the hooks; a wrapped Codex notify program is put back')
    .option('--claude', 'only Claude Code')
    .option('--codex', 'only Codex')
    .option('--opencode', 'only opencode')
    .action(async (opts: HookOpts) => {
      const done = await uninstall(await hookTargets(opts, false), loadAccounts());
      for (const line of done) console.log(line);
      if (done.length === 0) console.log('No wormhole hooks installed.');
    });

  hooks
    .command('status')
    .description('Show which hooks are installed')
    .action(async () => {
      const s = await hookStatus();
      const where = { claude: claudeSettingsPath(), codex: codexConfigPath(), opencode: opencodePluginPath() };
      for (const t of ALL_HOOKS) console.log(`${t.padEnd(14)}${s[t] ? 'installed' : 'not installed'}  (${where[t]})`);
      for (const a of loadAccounts()) {
        const key = `${a.tool}@${a.name}`;
        console.log(`${key.padEnd(14)}${(await accountHookInstalled(a)) ? 'installed' : 'not installed'}  (${a.dir})`);
      }
    });

  const accounts = program
    .command('accounts')
    .description('Extra Claude Code or Codex logins, each in its own folder; use them as tool@name');

  accounts
    .command('list', { isDefault: true })
    .description('Show the accounts')
    .action(() => {
      const list = loadAccounts();
      if (list.length === 0) console.log('No accounts. Add one with: wormhole accounts add <name> --tool claude --dir <folder>');
      for (const a of list) console.log(`${`${a.tool}@${a.name}`.padEnd(20)} ${a.dir}`);
      const { fallback, auto } = loadFile();
      console.log(`fallback order: ${fallback ? fallback.join(' → ') : 'default (other accounts of the same tool, then the other tools)'}`);
      console.log(`auto fallback from hooks: ${auto ? 'on' : 'off'}`);
    });

  accounts
    .command('fallback')
    .description('Set the order `wormhole next` tries when a session hits its usage limit')
    .argument('[keys...]', 'tools or tool@account, best first (e.g. claude claude@work codex)')
    .option('--default', 'forget the list: other accounts of the same tool, then the other tools')
    .action(async (keys: string[], opts: { default?: boolean }) => {
      if (keys.length > 0 || opts.default) await setFallback(opts.default ? [] : keys);
      const { fallback } = loadFile();
      if (fallback) {
        console.log(`Fallback order: ${fallback.join(' → ')} (after the last, back to the first).`);
      } else {
        const keys = Object.keys(ctx().adapters);
        console.log('Default fallback order: the other accounts of the same tool, then the other tools.');
        for (const from of keys.filter((k) => !k.includes('@'))) console.log(`  from ${from}: ${fallbackOrder(from, keys).join(' → ')}`);
      }
    });

  accounts
    .command('auto')
    .description('Let the hooks write the fallback session when a session hits its usage limit')
    .argument('[state]', 'on or off')
    .action(async (state: string | undefined) => {
      if (state !== undefined && state !== 'on' && state !== 'off') throw new Error(`expected on or off, not ${state}`);
      if (state) await setAuto(state === 'on');
      const on = loadFile().auto === true;
      console.log(`Auto fallback is ${on ? 'on' : 'off'}.`);
      if (on) {
        console.log('When a hook finds a session limited, it writes the fallback session (nothing is opened);');
        console.log('`wormhole resume` then opens it. Needs `wormhole hooks install`.');
      }
    });

  accounts
    .command('add')
    .description("Register a folder holding another login (Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME)")
    .argument('<name>', 'short name: lowercase letters, digits, dashes')
    .requiredOption('--tool <tool>', 'claude or codex')
    .requiredOption('--dir <folder>', 'the account folder')
    .action(async (name: string, opts: { tool: string; dir: string }) => {
      const a: Account = await addAccount({ name, tool: opts.tool, dir: opts.dir });
      const env = a.tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
      console.log(`Added ${a.tool}@${a.name} (${a.dir}).`);
      console.log(`Log in once with: env ${env}=${a.dir} ${a.tool === 'claude' ? 'claude' : 'codex login'}`);
      console.log('Run `wormhole hooks install` again to add the hooks to it.');
    });

  accounts
    .command('remove')
    .description('Forget an account (its folder and sessions are left alone)')
    .argument('<account>', 'tool@name')
    .action(async (key: string) => {
      const a = await removeAccount(key);
      console.log(`Removed ${a.tool}@${a.name}; ${a.dir} is untouched.`);
    });

  program
    .command('doctor')
    .description('Check tools, logins, hooks, accounts and the store; exits 1 if anything fails')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const checks: Check[] = await runDoctor(deps.doctorProbes);
      if (opts.json) console.log(JSON.stringify({ ok: !failed(checks), checks }, null, 2));
      else for (const line of formatChecks(checks)) console.log(line);
      if (failed(checks)) state.exitCode = 1;
    });

  // Called by the tools themselves; argv after the tool is parsed by hand because
  // Codex appends its JSON payload after any chained notify program.
  program
    .command('hook', { hidden: true })
    .argument('<tool>')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (tool: string) => {
      const rest = argv.slice(argv.indexOf('hook') + 2);
      try {
        if (tool === 'claude') {
          const input = parseClaudeHook(await deps.readStdin());
          if (input) await handleHook(input, deps.context(input.cwd));
        } else if (tool === 'codex') {
          const payload = rest.at(-1);
          const then = rest[0] === THEN ? rest.slice(1, -1) : [];
          runChained(then, payload);
          const input = parseCodexNotify(payload);
          if (input) await handleHook(input, deps.context(input.cwd));
        } else if (tool === 'opencode') {
          const input = parseOpencodeHook(rest.at(-1));
          if (input) await handleHook(input, deps.context(input.cwd));
        }
      } catch (err) {
        await logHookError(err);
      }
    });

  return program;
}

function report({ ref, mode, from, base, transcript }: SwitchResult, to: string) {
  if (mode === 'resumed') {
    console.log(`${to} already holds the active session ${ref.nativeId}; resuming it.`);
    return;
  }
  console.log(`Handed off ${refKey(from!)} ${from!.nativeId} → ${to} ${ref.nativeId}`);
  console.log(
    mode === 'extended'
      ? `  continues a copy of ${refKey(base!)} ${base!.nativeId} with only the newer turns added`
      : mode === 'lean'
        ? `  new session holding only the brief; the conversation is in ${transcript}`
        : '  new session holding the whole thread',
  );
}

function full(artifact: string | undefined): string {
  return artifact ? `  [full: artifacts/${artifact}]` : '';
}

function describe(e: Event): string {
  switch (e.kind) {
    case 'user_text':
      return `user       ${oneLine(e.text, 100)}`;
    case 'assistant_text':
      return `assistant  ${oneLine(e.text, 100)}`;
    case 'tool_call':
      return `call       ${e.name}: ${oneLine(e.inputSummary, 90)}${full(e.artifact)}`;
    case 'tool_result':
      return `${(e.isError ? 'error' : 'result').padEnd(11)}${oneLine(e.summary, 90)}${full(e.artifact)}`;
    case 'file_change':
      return `file       ${e.op} ${e.path}`;
    case 'compact_summary':
      return `summary    ${oneLine(e.text, 100)}`;
  }
}
