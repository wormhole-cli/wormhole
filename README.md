# wormhole

Move a coding session between Claude Code, Codex and opencode, and resume it on the other side.

```bash
wormhole switch codex     # hand the current Claude Code session to Codex and open it
wormhole switch claude    # …and back, carrying what happened in Codex
wormhole resume           # reopen whichever session is in use
wormhole status           # thread for this directory, its sessions, newest per tool
wormhole log              # the thread, one line per event
wormhole brief --to codex # the handoff note a switch would add
wormhole import           # pull new turns without switching
```

`wh` is a short alias. `-C <dir>` runs against another project directory; `--no-launch` writes the
session and prints the resume command instead of opening it.

## How it works

Each project directory has one **thread** in `~/.wormhole/threads/<id>/` (override with `WORMHOLE_HOME`):
`thread.json` lists the native sessions (segments) it spans, `events.jsonl` holds the conversation as
tool-neutral events.

`switch <tool>`:

1. imports new turns from every session the thread tracks, and adopts the session currently in use;
2. writes a native session for the target tool:
   - **switching back** to a tool the thread already used: a copy of that tool's last session (under a
     new id, the original untouched) with only the turns from the other tools appended, so its own
     native tool calls and results survive;
   - **first time** in a tool: a new session holding the whole thread;

   in both cases foreign turns carry user and assistant text verbatim, each tool call flattened to one
   line (`▸ Bash: npm test → error: …`), then a handoff brief (goal, latest request, open tasks, files
   touched, git state). A tool call the copied session left open is closed with an error result first;
3. opens it with `claude --resume <id>`, `codex resume <id>` or `opencode --session <id>`.

opencode sessions are read with `opencode export` and written with `opencode import`; wormhole never
touches its database. Written opencode messages use `WORMHOLE_OPENCODE_MODEL` (`provider/model`) if
set, else the model last used in that project, else `model` from opencode's config.

Reasoning is never copied (Claude thinking signatures and Codex encrypted reasoning only verify with
their own provider), and wormhole never edits or deletes an existing native session. See
[docs/formats.md](docs/formats.md) for the on-disk formats.

## Develop

```bash
npm install
npm run build
npm test          # vitest, 2 workers
npm link          # puts wormhole / wh on PATH
```
