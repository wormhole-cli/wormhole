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
wormhole switch claude@work  # another Claude Code login (see Several accounts)
```

### Keeping threads current

```bash
wormhole hooks install    # Claude Code SessionEnd hook + Codex notify + opencode plugin
wormhole hooks status
wormhole hooks uninstall  # removes them; a wrapped Codex notify program is put back
```

The Claude hook goes into `settings.json` (`hooks.SessionEnd`), next to any hooks already there. Codex
allows one top-level `notify` program, so wormhole wraps an existing one (`… hook codex --then <old
argv>`) and still runs it, with the same payload, on every turn. opencode gets a global plugin,
`$XDG_CONFIG_HOME/opencode/plugins/wormhole.js` (default `~/.config/opencode`), that starts `wormhole hook
opencode` in the background whenever a turn finishes (`session.idle`), skipping subagent sessions; uninstall
deletes only that file, and install refuses to overwrite a `wormhole.js` it did not write. Plain `hooks
install` includes opencode only when `opencode` is on PATH (`--opencode` installs it regardless; `--claude`,
`--codex`, `--opencode` pick tools). The first install keeps a copy of each
config file as `*.before-wormhole`. Hooks only update projects that already have a thread, and log failures to
`~/.wormhole/hook.log` instead of disturbing the tool.

`wh` is a short alias. `-C <dir>` runs against another project directory; `--no-launch` writes the
session and prints the resume command instead of opening it; `--app` opens it in the desktop app
(Claude Desktop via `claude://resume?session=<id>`, Codex Desktop via `codex://threads/<id>`)
instead of the terminal.

`switch --summarize` (and `brief --summarize`) first asks the tool being left for a ~10-line summary
of the work and adds it to the brief under "Summary from <tool>". The question never lands in your
session: Claude runs `claude -p --resume <id> --fork-session --no-session-persistence --tools ''`,
Codex runs `codex exec resume` against a copy of the rollout in a throwaway `CODEX_HOME`, opencode
runs `opencode run --session <id> --fork` and the fork is deleted afterwards. If the call fails or
takes over 120 s, wormhole warns on stderr and uses the plain brief.

### Several accounts

Claude Code and Codex keep each login, with its sessions, in one folder (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`). Register extra folders as named accounts and use them as `tool@name`:

```bash
wormhole accounts add work --tool claude --dir ~/.claude-work   # then log in once: env CLAUDE_CONFIG_DIR=~/.claude-work claude
wormhole accounts add alt --tool codex --dir ~/.codex-alt       # env CODEX_HOME=~/.codex-alt codex login
wormhole switch claude@work   # e.g. personal Claude hit its limit: carry on in the work login
wormhole switch codex@alt
wormhole accounts             # list; `accounts remove claude@work` forgets one (its folder is left alone)
```

Plain `claude` / `codex` is the default folder. Moving between accounts of one tool with nothing from
other tools in between is a plain copy of the native session into the other folder, with no handoff
note; otherwise it works like any switch, extending the tool's latest session from whichever account
holds it. Sessions are launched as `env CLAUDE_CONFIG_DIR=<dir> claude --resume <id>` (or `CODEX_HOME`).
Accounts are listed in `~/.wormhole/accounts.json`; `hooks install` also installs into every account's
folder, and status and log show `tool@account`. `--app` works only for the default folder:
the desktop apps read only that one. opencode has no account folders.

## How it works

Each project directory has one **thread** in `~/.wormhole/threads/<id>/` (override with `WORMHOLE_HOME`):
`thread.json` lists the native sessions (segments) it spans, `events.jsonl` holds the conversation as
tool-neutral events. Tool inputs and outputs longer than 4,000 characters are cut in `events.jsonl`
and saved whole in `artifacts/<sha256>.txt` (once per distinct text); `wormhole log` marks such events
with `[full: artifacts/…]`, and a handed-off session points the model at the file
(`▸ Bash: cat big.log → ok: … (full output: ~/.wormhole/threads/<id>/artifacts/<hash>.txt)`).

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
