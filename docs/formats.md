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
loaded by `claude -p -r <id>`; a made-up id gives "No conversation found". The model turn
itself was not completed because the CLI's login had expired, so answer-from-history is still
to be confirmed.

Record fields used: `type`, `uuid`, `parentUuid`, `sessionId`, `cwd`, `gitBranch`, `version`,
`timestamp`, `isSidechain: false`, `userType: "external"`, `message` (Anthropic API shape).
Content blocks: `text`, `tool_use`, `tool_result`, `thinking` (signature-checked: never forge).
Skip on read: `system`, `attachment`, `file-history-*`, `mode`, `queue-operation`, sidechains.

## opencode

SQLite at `~/.local/share/opencode/opencode.db`. Use `opencode export <id>` / `opencode import <file>`;
never write the db.
