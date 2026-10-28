# Launch checklist

For the day the repo goes public. Nothing here has been done yet.

## 1. Before flipping visibility

- [ ] `wormhole doctor` clean on a fresh machine or user account; `npm pack --dry-run` lists only
      `bin/`, `dist/`, `README.md`, `LICENSE`.
- [ ] Record the demo GIF (below) and put it at the top of the README, under the pitch.
- [ ] Publish `v0.1.0` (see [releasing.md](releasing.md)) so `npm i -g @wormhole-cli/wormhole` works when
      people arrive.

## 2. Repo settings

```bash
gh repo edit ashutosh091/wormhole --visibility public --accept-visibility-change-consequences
gh repo edit ashutosh091/wormhole \
  --description "Move a coding session between Claude Code, Codex and opencode, and resume it on the other side" \
  --homepage "https://ashutosh091.github.io/wormhole/" \
  --add-topic claude-code --add-topic codex --add-topic opencode --add-topic ai-agents \
  --add-topic coding-agents --add-topic llm --add-topic cli --add-topic developer-tools \
  --add-topic anthropic --add-topic openai
```

- [ ] Settings → Pages → Source: GitHub Actions; then run the `pages` workflow (or push to `site/`).
- [ ] Upload `site/og.png` as the social preview (Settings → General → Social preview).
- [ ] Pin the repo on your GitHub profile.

## 3. Demo GIF

`docs/demo.tape` is a [vhs](https://github.com/charmbracelet/vhs) script. It needs real logins, a
scratch project and a few minutes:

```bash
brew install vhs
vhs docs/demo.tape        # writes docs/demo.gif
```

Keep it under 20 seconds: one Claude Code turn, `wormhole switch codex`, Codex answering from the
Claude turn, `wormhole switch claude`.

## 4. Posts

Post when you can answer comments for a few hours. Lead with the problem, not the tool.

**Show HN**

> Show HN: Wormhole – move a coding session between Claude Code, Codex and opencode
>
> I bounce between Claude Code and Codex: one hits a usage limit, or I want the other's take. Each
> switch meant re-explaining the project. wormhole reads the session you are in and writes a real
> native session for the other tool (the files `claude --resume` / `codex resume` / `opencode
> --session` open), with the conversation, a one-line record of each tool call, and a handoff note
> (goal, open tasks, files touched, git state). Switching back extends a copy of the original
> session, so its own tool calls survive. It also handles several logins per tool and can move on
> when one hits its limit. Everything is local; it never edits existing sessions.

**Reddit** (r/ClaudeAI, r/ChatGPTCoding, r/codex, r/opencodeCLI): the same story in the first person,
with the GIF, and a question at the end ("which other agents should it support?").

**X / Bluesky / LinkedIn**: the GIF plus one line: "Out of Claude usage mid-task? `wormhole switch
codex` and Codex picks up the same conversation. Back again with `wormhole switch claude`."

## 5. Lists and directories

Open a short PR (one line, link, description) to lists people browse:

- [ ] awesome-claude-code style lists (search GitHub for "awesome claude code")
- [ ] awesome Codex / OpenAI Codex CLI lists
- [ ] opencode community lists and its Discord showcase channel
- [ ] awesome-cli-apps (under developer tools)

## 6. After launch

- [ ] Answer issues fast in the first week; label good first issues.
- [ ] Note which tool versions people run (from `doctor --json` in bug reports) and keep
      `docs/formats.md` current.
- [ ] Cut a release for each fix so `npm i -g @wormhole-cli/wormhole` stays the answer.
