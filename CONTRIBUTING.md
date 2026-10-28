# Contributing

Thanks for helping. Bug reports, format findings from new tool versions and pull requests are all
welcome.

## Setup

```bash
git clone https://github.com/wormhole-cli/wormhole.git
cd wormhole
npm install
npm run build
npm link          # puts wormhole / wh on PATH, running your build
```

Node 22 or newer. `npm run dev` rebuilds on change.

## Tests

```bash
npm test          # vitest, capped at 2 workers
npm run coverage  # fails under 90% lines/functions, 80% branches
npm run typecheck
```

Run one test command at a time: the suites spawn real child processes and temp directories, and
several runs in parallel slow a laptop to a crawl. Tests never touch your real `~/.claude`,
`~/.codex`, opencode data or `~/.wormhole`; they point `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`XDG_CONFIG_HOME` and `WORMHOLE_HOME` at temp folders. Keep it that way, and build fixtures by hand
instead of copying real transcripts.

## Where things are

- `src/adapters/`: one `ToolAdapter` per tool (`types.ts`): find, read, write and extend native sessions.
- `src/core.ts`: `sync` (import into the thread) and `switchTo` (write the target session).
- `src/store/`: the thread store under `~/.wormhole`, with locking and a crash-safe journal.
- `src/handoff/`: the handoff brief, git state and `--summarize`.
- `src/hooks/`: hook install/uninstall and the hidden `wormhole hook <tool>` entry point.
- `src/accounts.ts`, `src/limits.ts`, `src/fallback.ts`: named accounts and usage-limit fallback.
- `src/doctor.ts`: `wormhole doctor`.
- `docs/formats.md`: what each tool writes on disk, and what was checked against which version.

## Adding a tool

1. Write `src/adapters/<tool>.ts` implementing `ToolAdapter`; reuse `toTurns` from `render.ts` so
   tool calls flatten the same way everywhere.
2. Add the tool to `Tool` in `src/model/thread.ts` and to `defaultContext` in `src/core.ts`.
3. Record the native format in `docs/formats.md`, including the version you checked.
4. Add adapter tests with synthetic fixtures, and a hook if the tool has a turn-finished event.

## Tool format changes

Claude Code, Codex and opencode change their files often. If a new version breaks reading or
resuming, open an issue with the version (`claude --version`, `codex --version`,
`opencode --version`) and the shape of the record that changed, with any private content removed.

## Pull requests

Keep changes focused, add tests, and update the README or `docs/formats.md` when behavior or formats
change. `npm run coverage` must pass.
