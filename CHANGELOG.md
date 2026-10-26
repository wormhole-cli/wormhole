# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

First release.

### Added

- `wormhole switch <tool>`: hand the session in use to Claude Code, Codex or opencode as a real native
  session, with the conversation, a one-line record of each tool call, and a handoff brief (goal,
  latest request, open tasks, files touched, git state). Opens it in the terminal, or in Claude
  Desktop / Codex Desktop with `--app`.
- Round trips: switching back to a tool extends a copy of its own earlier session with only the
  newer turns, so its native tool calls survive.
- `resume`, `status`, `log`, `brief`, `import`.
- Adapters for Claude Code transcripts, Codex rollouts (including the Codex Desktop format) and
  opencode (through `opencode export` / `import`).
- `wormhole hooks install`: Claude Code SessionEnd hook, Codex notify (chaining an existing notify
  program) and an opencode plugin keep threads up to date after every turn.
- `--summarize`: asks the tool being left for a short summary for the brief, without adding a turn
  to your session.
- Long tool output is cut in the thread and kept whole in the thread's `artifacts/` folder.
- Named accounts (`wormhole accounts`, `claude@work`, `codex@alt`) for several logins per tool.
- Usage limits: detection from Claude Code and Codex session files, `wormhole next` to move on to
  the next account or tool with room, and opt-in automatic fallback from the hooks.
- `wormhole doctor`: checks tools, logins, hooks, accounts and the store, with `--json`.
- Crash-safe, incremental thread store with locking.
- Runs on macOS, Linux and Windows; CI tests all three.

[Unreleased]: https://github.com/ashutosh091/wormhole/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ashutosh091/wormhole/releases/tag/v0.1.0
