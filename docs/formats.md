# Native session formats

Notes on what each tool needs for wormhole to synthesize a resumable session. Verified 2026-10-26.

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

Not yet checked: whether a never-resumed synthetic rollout appears in the interactive
`codex resume` picker (resume by id works).

## Claude Code

Transcript: `~/.claude/projects/<abs cwd with every non-alphanumeric char → '-'>/<uuid>.jsonl`.
No index file; `claude -r <id>` looks in the current directory's encoded folder.

**Spike result:** a 2-record file (`user` → `assistant`, linked by `parentUuid`) is found and
loaded by `claude -p -r <id>`; a made-up id gives "No conversation found". Verified 2026-10-26:
`claude -p -r` answers from both a session wormhole synthesized from Codex and a wormhole copy of
a native Claude session extended with Codex turns.

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
- **Gotcha:** opencode exits before draining a stdout pipe, so `export` / `session list` output over
  8 KB arrives truncated. wormhole points stdout at a file instead.
