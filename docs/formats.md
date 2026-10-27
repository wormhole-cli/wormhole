# Native session formats

Notes on what each tool needs for wormhole to synthesize a resumable session. Verified 2026-10-26.

## wormhole thread

`~/.wormhole/threads/<id>/`: `thread.json` (segments), `events.jsonl` (one event per line, schema in
`src/model/thread.ts`) and `artifacts/`. Adapters read tool text whole; `sync` cuts a `tool_call`
`inputSummary` or `tool_result` `summary` over 4,000 chars to 4,000 plus `…[truncated N chars]`, writes
the full text to `artifacts/<first 32 hex of sha256>.txt` and sets `artifact` to that file name.
Artifacts are content-addressed and written once; events without `artifact` (older threads) are
unchanged. When rendering into a native session the name becomes the absolute path.

## Codex (CLI 0.159.2)

Rollout file: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local ts>-<uuidv7>.jsonl`, one JSON object per line.

**Spike result:** a 3-line file is enough. `codex exec resume <id> "<prompt>"` found it,
answered from its history, appended its own turns to the same file and backfilled the
`threads` row in `state_5.sqlite` itself. wormhole never writes Codex's sqlite files.

Minimal file:

```jsonl
{"timestamp":"<iso>","type":"session_meta","payload":{"id":"<uuidv7>","timestamp":"<iso>","cwd":"<abs cwd>","originator":"codex_cli_rs","cli_version":"<codex --version>","source":"cli","model_provider":"openai"}}
{"timestamp":"<iso>","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"timestamp":"<iso>","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
```

Newer writers add `ordinal` per line, `turn_context`, `event_msg`, `world_state`, `reasoning`
(with `encrypted_content`, OpenAI only), `custom_tool_call` / `function_call` + `*_output`
paired by `call_id`. Readers must tolerate all of these; the writer emits only the minimal set.

Pickers (verified 2026-10-26, CLI 0.164): a never-resumed wormhole rollout is listed by the
interactive `codex resume` picker under its cwd, titled by its first user message.

### Codex Desktop (verified 2026-10-26, app-server 0.164)

Codex Desktop does not show messages straight from the rollout: it shows the turns it indexes into
`thread_history_1.sqlite` (`thread_turns`, `thread_items`). A rollout with only `response_item`
messages resumes in the CLI but has **0 turns** there, so the app shows "Couldn't load messages" or
a blank thread. wormhole therefore writes what the desktop app writes:

- `ordinal` on every line, numbered from 0; `session_meta.history_mode: "paginated"`.
- Per exchange: `event_msg task_started {turn_id}`, `turn_context {turn_id, cwd, model}`, the
  `response_item` messages, an `event_msg item_completed` per message (`UserMessage` with
  `content: [{type: "text"}]`, `AgentMessage` with `content: [{type: "Text"}]`), and
  `event_msg task_complete`.
- Copies of older CLI files are renumbered; their own `task_started` turns are indexed too.

`codex://threads/<id>` opens a thread in the app and indexes the rollout if needed. A thread
resumed by `codex resume` stays locked by the CLI's `codex app-server` daemon, and the app then
says "This is open in another app": open handoffs with `--app` instead, or run
`codex app-server daemon stop`. Turns run in the app trigger `notify` like CLI turns do.

## Claude Code

Transcript: `~/.claude/projects/<abs cwd with every non-alphanumeric char → '-'>/<uuid>.jsonl`.
No index file; `claude -r <id>` looks in the current directory's encoded folder.

**Spike result:** a 2-record file (`user` → `assistant`, linked by `parentUuid`) is found and
loaded by `claude -p -r <id>`; a made-up id gives "No conversation found". Verified 2026-10-26:
`claude -p -r` answers from both a session wormhole synthesized from Codex and a wormhole copy of
a native Claude session extended with Codex turns. With no id, `claude -c` picks the wormhole copy
as the newest session in the folder, so it is listed in the `claude -r` picker too. wormhole writes
transcripts `0600`, like Claude Code.

Claude Desktop: `claude://resume?session=<uuid>` imports a CLI session into the app
(`importCliSession`, logged as "Imported CLI session … as Desktop session local_…"). Verified: the
imported session resumes and answers from its history.

Record fields used: `type`, `uuid`, `parentUuid`, `sessionId`, `cwd`, `gitBranch`, `version`,
`timestamp`, `isSidechain: false`, `userType: "external"`, `message` (Anthropic API shape).
Content blocks: `text`, `tool_use`, `tool_result`, `thinking` (signature-checked: never forge).
Skip on read: `system`, `attachment`, `file-history-*`, `mode`, `queue-operation`, sidechains.

## opencode (1.19.0)

SQLite at `$XDG_DATA_HOME/opencode/opencode.db`. wormhole never writes it: it reads with
`opencode export <id>` and writes with `opencode import <file>`.

**Spike result:** a hand-built export (`{info, messages: [{info, parts}]}`) imports, keeps the ids
given, shows up in `opencode session list`, and `opencode run -s <id>` answers from its history.
Importing the same id again upserts, so a copy needs fresh ids for the session, every message and
every part.

- Ids: `<prefix>_` + 12 hex chars of `(ms * 0x1000 + counter) & 0xffffffffffff` + 14 random base62
  chars. Sessions (`ses_`) invert the number so newer sorts first; `msg_` and `prt_` ascend, and
  messages are ordered by id.
- `projectID`: the sorted-first root commit (`git rev-list --max-parents=0 --all`) for a git repo,
  otherwise `global`.
- User message info: `role, time.created, agent, model{providerID, modelID}`. Assistant info:
  `role, parentID, mode, agent, providerID, modelID, path{cwd, root}, cost, tokens, time{created,
  completed}, finish`. An assistant message without `time.completed` is still in flight.
- Parts: `text`, `reasoning` (dropped), `tool {callID, tool, state{status, input, output, metadata.exit}}`,
  `step-start`/`step-finish`, `patch`, `compaction`. A compaction summary is an assistant message
  with `summary: true`, `mode: "compaction"`.
- Plugins: every `{plugin,plugins}/*.{js,ts}` in the global config dir (`$XDG_CONFIG_HOME/opencode`) or
  a project's `.opencode/` is loaded; its exports are `async (input) => hooks` with `input.directory`.
  `hooks.event({event})` sees every bus event. Per turn (`opencode run`, verified 2026-10-26):
  `session.created`/`session.updated` (`properties.info` = the session, `parentID` set for subagent
  sessions), `session.status` busy → idle, then `session.idle {sessionID}` once the assistant message is
  completed. wormhole's plugin reacts to `session.idle` and passes `{type, sessionID, cwd}` as the last
  argument of `wormhole hook opencode`.
- **Gotcha:** opencode exits before draining a stdout pipe, so `export` / `session list` output over
  8 KB arrives truncated. wormhole points stdout at a file instead.

### opencode 2.x (2.1.4, verified 2026-10-27)

wormhole checks `opencode --version` once (output `opencode v2.1.4`) and uses the 2.x commands and
format from major version 2.

- Commands: `export` / `import` moved to `opencode session export <id>` / `opencode session import
  <file>` (the old spelling prints the help). `session list --format json`, `opencode --session <id>`,
  `run --session <id> --fork --format json` (still `{type: "text", sessionID, part: {text}}` lines) and
  `session delete` are unchanged. A background service (`opencode service`) now runs sessions;
  `--standalone` runs a private one.
- Export: `{info, messages}` with flat messages. `info`: `id, projectID, title, agent,
  model{id, providerID, variant}, cost, tokens, time{created, updated}, location{directory}`.
  Messages: `{type: "user", text, time}`; `{type: "assistant", agent, model, content: [blocks],
  finish, cost, tokens, time{created, completed}}`; bookkeeping types such as `idle {outcome}` and
  `agent-switched`. Blocks: `text`, `reasoning` (dropped), `tool {id, name, state{status, input,
  content: [{type: "text", text}], error}}`. File tools take `input.path` (1.x: `filePath`).
- Import rejects the 1.x shape (`Bad Request`). It needs `info.agent`, `info.model`, `info.cost`,
  `info.tokens`, a `projectID` (any value: the session is filed under `location.directory`) and
  `agent` + `model` on assistant messages. Same ids upsert ("Session already exists"), so copies
  get fresh session and message ids.
- Plugins: the 1.x module shape fails to load ("Plugin must export a default definition with an id
  and an effect or setup function"). A 2.x plugin default-exports `{ id, setup(ctx) }`; a plain
  object works, no package import needed. `setup` subscribes with `ctx.event.subscribe({signal})`
  and returns a cleanup. A turn ends with `session.execution.succeeded` (or `.failed`), `data:
  {sessionID}`; `ctx.location.directory` is the project. `hooks install` writes the plugin for the
  installed major version, and `doctor` fails when the file does not match it.
- Seen while testing: `opencode run` sometimes returned at once without running the turn, or hung,
  through the background service and with `--standalone`, with and without wormhole's plugin;
  `opencode service restart` cleared it.

## Headless summary runs (`--summarize`, verified 2026-10-26)

- **Claude Code 2.1.310:** `claude -p <prompt> --resume <id> --fork-session --no-session-persistence
  --output-format text --tools ''` answers from the session and leaves the transcript folder
  byte-for-byte unchanged (no fork file either). `--tools` is variadic: an argument after
  `--tools ''` is taken as a tool name, so the prompt has to come before it.
- **Codex 0.164.0:** `codex exec resume --ephemeral … <id> <prompt>` still appends the new turn to the
  original rollout; `--ephemeral` does not cover resume. wormhole copies the rollout into a temporary
  `CODEX_HOME/sessions/` with symlinks to the real `auth.json` and `config.toml`, sets
  `-c notify=[]` so the hook does not fire for it, and reads the reply from `-o <file>`
  (`--output-last-message`). Resume by id finds the copy without any sqlite state.
- **opencode 1.19.0:** `opencode run --session <id> --fork --format json <prompt>` prints one JSON
  event per line, each with `type` and `sessionID` (the fork's); text arrives as
  `{"type":"text","part":{"text":…}}`. The fork is a real session, so wormhole deletes it with
  `opencode session delete <fork id>`. Not run end to end here;
  the event shape for text parts is from opencode's run output, not a live capture.

## Usage limits (read by `src/limits.ts`, seen 2026-10-26)

- **Claude Code 2.1.29x** writes a synthetic assistant record when a request is refused: `model:
  "<synthetic>"`, `isApiErrorMessage: true`, `error` (`rate_limit`, `server_error`,
  `authentication_failed`, …), `apiErrorStatus: 429`. For a used-up window `apiError` is
  `usage_limit_reached` and `quotaLimits` / `apiErrorParams.rate_limit_info` carry `status:
  "rejected"`, `resetsAt` (unix seconds) and `rateLimitType` (`five_hour`); the text reads "You've hit
  your session limit · resets 8:10pm (<tz>)". A model's own limit is `apiError:
  "model_requires_usage_credits"` with no reset time. After the record come only bookkeeping lines
  (`last-prompt`, `cost-state`, `queue-operation`, …). wormhole looks at the last main-chain assistant
  record, reading the last 512 KB of the file first.
- **Codex 0.16x** logs `event_msg` `token_count` after each model call with `rate_limits: {limit_id,
  primary, secondary, credits, plan_type, rate_limit_reached_type, spend_control_reached}`; windows are
  `{used_percent, window_minutes (300, 10080), resets_at (unix seconds)}`. The latest snapshot decides.
  An `event_msg` `error` whose message mentions the usage limit, after that snapshot, also counts
  (not seen in a captured session yet).
