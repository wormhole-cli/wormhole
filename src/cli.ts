import { Command } from 'commander';
import { activeSegment } from './model/thread.js';
import { Store } from './store/store.js';

const program = new Command();

program
  .name('wormhole')
  .description('Move a coding session between Claude Code, Codex and opencode, and resume it on the other side.')
  .version('0.1.0');

program
  .command('status')
  .description('Show the wormhole thread for this directory')
  .action(async () => {
    const thread = await new Store().loadForCwd(process.cwd());
    if (!thread) {
      console.log('No wormhole thread for this directory yet.');
      return;
    }
    const active = activeSegment(thread);
    console.log(`thread ${thread.id}  ${thread.title}`);
    console.log(`cwd    ${thread.cwd}`);
    console.log(`active ${active ? `${active.tool} ${active.nativeId}` : '(none)'}`);
    for (const seg of thread.segments) {
      const via = seg.derivedFrom ? `  (from ${seg.derivedFrom.tool})` : '';
      console.log(`  ${seg.startedAt}  ${seg.tool.padEnd(8)} ${seg.nativeId}${via}`);
    }
  });

for (const name of ['switch', 'resume', 'import', 'log', 'brief']) {
  program
    .command(name)
    .allowUnknownOption()
    .allowExcessArguments()
    .description('not implemented yet')
    .action(() => {
      console.error(`wormhole ${name}: not implemented yet`);
      process.exitCode = 2;
    });
}

await program.parseAsync();
