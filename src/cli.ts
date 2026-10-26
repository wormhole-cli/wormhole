import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { oneLine } from './adapters/render.js';
import type { NativeRef } from './adapters/types.js';
import { adapter, type Context, defaultContext, makeBrief, type SwitchResult, switchTo, sync } from './core.js';
import {
  importFromHook,
  logHookError,
  parseClaudeHook,
  parseCodexNotify,
  parseOpencodeHook,
  readStdin,
  runChained,
  THEN,
} from './hooks/handle.js';
import {
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
import { launch, openUrl, shellLine } from './launch.js';
import { activeSegment, type Event, eventTool, TOOLS, Tool } from './model/thread.js';

/** What the CLI reaches outside itself; tests replace these. */
export interface Deps {
  context: (cwd: string) => Context;
  launch: (argv: string[], cwd: string) => Promise<number>;
  openUrl: (url: string) => Promise<number>;
  readStdin: () => Promise<string>;
  /** Runs a tool headless for `--summarize`. */
  run: Runner;
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
    .version('0.1.0')
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

  const fromOption = () =>
    new Option('--from <tool>', 'tool that owns --session').argParser(parseTool);

  /** The leaving tool's own summary of `ref`, or undefined (with a warning) when it cannot give one. */
  async function askSummary(c: Context, ref: NativeRef | null, to?: Tool) {
    if (!ref || ref.tool === to) return undefined;
    console.error(`Asking ${ref.tool} for a summary of ${ref.nativeId}…`);
    try {
      return { tool: ref.tool, text: await summarize(ref, c.cwd, deps.run) };
    } catch (err) {
      console.error(`wormhole: no summary from ${ref.tool} (${err instanceof Error ? err.message : String(err)}); using the plain brief`);
      return undefined;
    }
  }

  async function run(c: Context, ref: NativeRef, opts: { launch: boolean; app?: boolean }) {
    const a = adapter(c, ref.tool);
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
        console.log(`last   ${active ? `${active.tool} ${active.nativeId}` : '(none)'}`);
        for (const seg of thread.segments) {
          const via = seg.derivedFrom ? `  (handed off from ${seg.derivedFrom.tool})` : '';
          console.log(`  ${seg.startedAt}  ${seg.tool.padEnd(8)} ${seg.nativeId}${via}`);
        }
      } else {
        console.log(`No wormhole thread for ${c.cwd} yet.`);
      }
      console.log('newest native sessions:');
      for (const [tool, a] of Object.entries(c.adapters)) {
        const ref = await a.detectLatest(c.cwd);
        console.log(`  ${tool.padEnd(8)} ${ref ? `${ref.nativeId}  updated ${ref.updatedAt}` : '(none)'}`);
      }
    });

  program
    .command('import')
    .description('Pull new turns from the sessions this thread tracks, and adopt the one in use')
    .addOption(fromOption())
    .option('-s, --session <id>', 'import this session (needs --from)')
    .option('-q, --quiet', 'print nothing')
    .action(async (opts: { from?: Tool; session?: string; quiet?: boolean }) => {
      if (opts.session && !opts.from) throw new Error('--session needs --from');
      const { imported } = await sync(ctx(), { tool: opts.from, session: opts.session });
      if (opts.quiet) return;
      if (imported.length === 0) console.log('Nothing new.');
      for (const i of imported) {
        console.log(`${i.isNew ? 'adopted' : 'updated'} ${i.tool} ${i.nativeId}: +${i.events} events`);
      }
    });

  program
    .command('switch')
    .description('Hand the thread off to another tool and open it there')
    .argument('<tool>', TOOLS.join(' | '), parseTool)
    .addOption(fromOption())
    .option('-s, --session <id>', 'hand off this session instead of the newest (needs --from)')
    .option('--no-launch', 'write the session and print the command, but do not open it')
    .option('--app', 'open it in the desktop app (Claude Desktop, Codex Desktop) instead of the terminal')
    .option('--summarize', 'ask the tool being left for a short summary and add it to the brief')
    .action(async (to: Tool, opts: { from?: Tool; session?: string; launch: boolean; app?: boolean; summarize?: boolean }) => {
      if (opts.session && !opts.from) throw new Error('--session needs --from');
      const c = ctx();
      const from = { tool: opts.from, session: opts.session };
      const summary = opts.summarize ? await askSummary(c, (await sync(c, from)).active, to) : undefined;
      const result = await switchTo(c, to, { ...from, summary });
      report(result, to);
      await run(c, result.ref, opts);
    });

  program
    .command('resume')
    .description('Reopen the session in use; with a tool, switch to it first if needed')
    .argument('[tool]', TOOLS.join(' | '), parseTool)
    .option('--no-launch', 'print the command, but do not open it')
    .option('--app', 'open it in the desktop app instead of the terminal')
    .action(async (tool: Tool | undefined, opts: { launch: boolean; app?: boolean }) => {
      const c = ctx();
      if (tool) {
        const result = await switchTo(c, tool);
        report(result, tool);
        return run(c, result.ref, opts);
      }
      const { active } = await sync(c);
      if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${c.cwd}`);
      await run(c, active, opts);
    });

  program
    .command('log')
    .description('Print the thread as one line per event')
    .option('-n, --limit <n>', 'last n events', (v) => Number.parseInt(v, 10), 40)
    .action(async (opts: { limit: number }) => {
      const c = ctx();
      const { thread } = await sync(c);
      const events = await c.store.readEvents(thread.id);

      const from = Math.max(0, events.length - opts.limit);
      events.slice(from).forEach((e, k) => {
        console.log(`${String(from + k).padStart(5)} ${(eventTool(e, from + k, thread.segments) ?? '?').padEnd(8)} ${describe(e)}`);
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
      for (const line of await install(await hookTargets(opts, true))) console.log(line);
      console.log('Hooks only update projects that already have a wormhole thread.');
    });

  hooks
    .command('uninstall')
    .description('Remove the hooks; a wrapped Codex notify program is put back')
    .option('--claude', 'only Claude Code')
    .option('--codex', 'only Codex')
    .option('--opencode', 'only opencode')
    .action(async (opts: HookOpts) => {
      const done = await uninstall(await hookTargets(opts, false));
      for (const line of done) console.log(line);
      if (done.length === 0) console.log('No wormhole hooks installed.');
    });

  hooks
    .command('status')
    .description('Show which hooks are installed')
    .action(async () => {
      const s = await hookStatus();
      const where = { claude: claudeSettingsPath(), codex: codexConfigPath(), opencode: opencodePluginPath() };
      for (const t of ALL_HOOKS) console.log(`${t.padEnd(10)}${s[t] ? 'installed' : 'not installed'}  (${where[t]})`);
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
          if (input) await importFromHook(input, deps.context(input.cwd));
        } else if (tool === 'codex') {
          const payload = rest.at(-1);
          const then = rest[0] === THEN ? rest.slice(1, -1) : [];
          runChained(then, payload);
          const input = parseCodexNotify(payload);
          if (input) await importFromHook(input, deps.context(input.cwd));
        } else if (tool === 'opencode') {
          const input = parseOpencodeHook(rest.at(-1));
          if (input) await importFromHook(input, deps.context(input.cwd));
        }
      } catch (err) {
        await logHookError(err);
      }
    });

  return program;
}

function report({ ref, mode, from, base }: SwitchResult, to: Tool) {
  if (mode === 'resumed') {
    console.log(`${to} already holds the active session ${ref.nativeId}; resuming it.`);
    return;
  }
  console.log(`Handed off ${from!.tool} ${from!.nativeId} → ${to} ${ref.nativeId}`);
  console.log(
    mode === 'extended'
      ? `  continues a copy of ${to} ${base!.nativeId} with only the newer turns added`
      : '  new session holding the whole thread',
  );
}

function describe(e: Event): string {
  switch (e.kind) {
    case 'user_text':
      return `user       ${oneLine(e.text, 100)}`;
    case 'assistant_text':
      return `assistant  ${oneLine(e.text, 100)}`;
    case 'tool_call':
      return `call       ${e.name}: ${oneLine(e.inputSummary, 90)}`;
    case 'tool_result':
      return `${(e.isError ? 'error' : 'result').padEnd(11)}${oneLine(e.summary, 90)}`;
    case 'file_change':
      return `file       ${e.op} ${e.path}`;
    case 'compact_summary':
      return `summary    ${oneLine(e.text, 100)}`;
  }
}
