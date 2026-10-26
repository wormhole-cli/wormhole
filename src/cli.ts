import { Command, InvalidArgumentError, Option } from 'commander';
import { oneLine } from './adapters/render.js';
import { adapter, type Context, defaultContext, makeBrief, type SwitchResult, switchTo, sync } from './core.js';
import { launch, shellLine } from './launch.js';
import { importFromHook, logHookError, parseClaudeHook, parseCodexNotify, readStdin, runChained, THEN } from './hooks/handle.js';
import {
  claudeSettingsPath,
  codexConfigPath,
  install,
  status as hookStatus,
  type Target,
  uninstall,
} from './hooks/install.js';
import { activeSegment, type Event, eventTool, TOOLS, Tool } from './model/thread.js';

const program = new Command();

program
  .name('wormhole')
  .description('Move a coding session between Claude Code, Codex and opencode, and resume it on the other side.')
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'project directory (default: current directory)');

function ctx(): Context {
  return defaultContext(program.opts<{ cwd?: string }>().cwd ?? process.cwd());
}

function parseTool(value: string): Tool {
  const parsed = Tool.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(`expected one of ${TOOLS.join(', ')}`);
  return parsed.data;
}

const fromOption = () =>
  new Option('--from <tool>', 'tool that owns --session').argParser(parseTool);

async function run(c: Context, argv: string[], noLaunch: boolean | undefined) {
  console.log(`  ${shellLine(argv)}`);
  if (noLaunch) return;
  process.exitCode = await launch(argv, c.cwd);
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
    if (opts.session && !opts.from) throw new InvalidArgumentError('--session needs --from');
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
  .action(async (to: Tool, opts: { from?: Tool; session?: string; launch: boolean }) => {
    if (opts.session && !opts.from) throw new InvalidArgumentError('--session needs --from');
    const c = ctx();
    const result = await switchTo(c, to, { tool: opts.from, session: opts.session });
    report(result, to);
    await run(c, adapter(c, to).launchArgs(result.ref), !opts.launch);
  });

program
  .command('resume')
  .description('Reopen the session in use; with a tool, switch to it first if needed')
  .argument('[tool]', TOOLS.join(' | '), parseTool)
  .option('--no-launch', 'print the command, but do not open it')
  .action(async (tool: Tool | undefined, opts: { launch: boolean }) => {
    const c = ctx();
    if (tool) {
      const result = await switchTo(c, tool);
      report(result, tool);
      return run(c, adapter(c, tool).launchArgs(result.ref), !opts.launch);
    }
    const { active } = await sync(c);
    if (!active) throw new Error(`no Claude Code, Codex or opencode session found for ${c.cwd}`);
    await run(c, adapter(c, active.tool).launchArgs(active), !opts.launch);
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
  .action(async (opts: { to: Tool }) => {
    const c = ctx();
    const { thread } = await sync(c);
    console.log(await makeBrief(c, thread, opts.to));
  });

const hooks = program.command('hooks').description('Keep threads up to date automatically');

function hookTargets(opts: { claude?: boolean; codex?: boolean }): Target[] {
  const picked = (['claude', 'codex'] as const).filter((t) => opts[t]);
  return picked.length > 0 ? [...picked] : ['claude', 'codex'];
}

hooks
  .command('install')
  .description('Import new turns when a Claude Code session ends and after each Codex turn')
  .option('--claude', 'only Claude Code')
  .option('--codex', 'only Codex')
  .action(async (opts: { claude?: boolean; codex?: boolean }) => {
    for (const line of await install(hookTargets(opts))) console.log(line);
    console.log('Hooks only update projects that already have a wormhole thread.');
  });

hooks
  .command('uninstall')
  .description('Remove the hooks; a wrapped Codex notify program is put back')
  .option('--claude', 'only Claude Code')
  .option('--codex', 'only Codex')
  .action(async (opts: { claude?: boolean; codex?: boolean }) => {
    const done = await uninstall(hookTargets(opts));
    for (const line of done) console.log(line);
    if (done.length === 0) console.log('No wormhole hooks installed.');
  });

hooks
  .command('status')
  .description('Show which hooks are installed')
  .action(async () => {
    const s = await hookStatus();
    console.log(`claude  ${s.claude ? 'installed' : 'not installed'}  (${claudeSettingsPath()})`);
    console.log(`codex   ${s.codex ? 'installed' : 'not installed'}  (${codexConfigPath()})`);
  });

// Called by the tools themselves; argv after the tool is parsed by hand because
// Codex appends its JSON payload after any chained notify program.
program
  .command('hook', { hidden: true })
  .argument('<tool>')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (tool: string) => {
    const rest = process.argv.slice(process.argv.indexOf('hook') + 2);
    try {
      if (tool === 'claude') {
        const input = parseClaudeHook(await readStdin());
        if (input) await importFromHook(input);
      } else if (tool === 'codex') {
        const payload = rest.at(-1);
        const then = rest[0] === THEN ? rest.slice(1, -1) : [];
        runChained(then, payload);
        const input = parseCodexNotify(payload);
        if (input) await importFromHook(input);
      }
    } catch (err) {
      await logHookError(err);
    }
  });

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

try {
  await program.parseAsync();
} catch (err) {
  console.error(`wormhole: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
