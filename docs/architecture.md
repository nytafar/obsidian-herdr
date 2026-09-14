# How the plugin talks to herdr

Two seams, both read from herdr's own CLI and never from its internals.

## Workspace state and actions: the JSON API

herdr's Unix socket serves newline-delimited JSON, one request per connection.
Every call opens its own connection; only `events.subscribe` holds one open, and
it reconnects with backoff when the server restarts. On the connected edge the
plugin loads `session.snapshot` (workspaces, panes, agent names) and then keeps
the picture current from events. Reads: `ping`, `workspace.list`, `pane.list`,
`tab.list`, `agent.list`, `session.snapshot`, `events.subscribe`. Writes only on
your action: `pane.focus`, `tab.create`, `pane.split`, `agent.start`.

Everything is filtered to one workspace on the plugin side. The list reacts to
agent status transitions, never to the raw `pane.updated` stream, which is about
ten events per second across a busy session; the scope collapses it to the
handful of changes a row can show.

## Pane terminals: the session bridge

A terminal tab spawns `herdr terminal session control|observe <pane> --cols N
--rows M` as a child process and speaks newline-delimited JSON on its pipes:
frames out (`terminal.frame`, base64 ANSI), input, resize and scroll in. Not a
PTY, and not the API socket. Remote terminals run the same command through
`ssh -T`.

Three facts about that seam, measured against herdr 0.8.0, shape what the plugin
can do:

- **Frames are cell repaints.** herdr sends cursor moves and attribute changes,
  never line scrolls, so the terminal in Obsidian holds one screen and history
  stays in herdr. Scrolling therefore goes to herdr as `terminal.scroll` with
  the cell under the pointer, and herdr decides whether that scrolls the
  viewport or becomes a mouse report for an application that asked for one.
- **Modes are not relayed.** Whether an application enabled mouse reporting or
  a keyboard protocol is known to herdr but not sent to session clients. That is
  why shift+enter uses the legacy `ESC CR` encoding and why clicks are not yet
  forwarded.
- **Input bytes reach the PTY raw**, so what the plugin encodes is what the agent
  sees.

## Renderers

The terminal view depends on one small renderer interface. Two implementations
ship: ghostty-web (libghostty's VT in WebAssembly, canvas output) and xterm.js.
ghostty-web is the default; its WebAssembly memory is shared and only grows, so
hidden tabs are torn down after thirty seconds to cap it. The benchmark that
compares them is `scripts/bench-renderers.mjs`.

What a settings change does to an open terminal is a table, not a call path:
`TERMINAL_SETTING_EFFECTS` in `src/views/paneTerminal.ts` maps each setting to
one named effect — `theme`, `cursor`, `engine`, `title`, `next-mount` — and the
plugin calls one entry point per terminal leaf with the setting that moved.
Theme and cursor refresh the renderer, in place when the engine can and by
remount otherwise; the session is preserved either way, so a palette change can
never reclaim a pane another controller took over. Only an engine change
restarts the bridge. A hidden leaf holds every effect the renderer would show
until it is revealed, except the title, whose tab header is on screen anyway.

## The settings tab

The tab itself is an assembler. Seven section builders — connection, remote,
notifications, agents, file explorer, agent list, terminal — are plain functions
over a container, the settings object and a bundle of callbacks, listed in
`SETTINGS_SECTIONS` in `src/settings.ts`; none of them ever sees the plugin. The
callbacks bundle is the whole of what a control may do besides write into the
settings: save, save and reconnect, redisplay, refresh the agent list or the
folder hover buttons, or hand one changed setting to the open terminals. The tab
builds that bundle from the plugin once and then just runs the list, which is
what makes a section renderable on a bare container in a test.

## Agent prompts and session identity

Measured on 2026-09-14 against herdr 0.8.2 and Claude Code 2.1.266, in a
scratch pane created with `tab create` and `agent start`.

- **`agent prompt` delivers text and Enter in one operation, and the text
  arrives intact.** A three-line argument with a blank line became one `user`
  transcript line whose content was the exact string, newlines included. No
  bracketed-paste or Enter-delay workaround is needed.
- **A leading `/command` is executed as a command**, not typed as text. `/help`
  opened Claude's help overlay and `/clear`, `/exit` did what they do at the
  keyboard. Local commands that change no agent status make `--wait` fail with
  `agent_prompt_stalled` even though the command ran, so a caller must not
  read that error as "not delivered". Overlays such as `/help` stay open until
  an `esc` is sent with `agent send-keys`.
- **A prompt sent while the agent is `working` is accepted, not rejected.**
  Claude queues it and consumes it inside the running turn. The transcript
  records this as a `queue-operation` line (`operation: enqueue`, then
  `remove`) and a `queued_command` attachment, never as a `user` line, so a
  reducer that only starts turns at `user` lines never shows the queued
  prompt. The `--wait` result of the second prompt is the end of the turn
  already in flight. Only `blocked` rejects, with `agent_blocked`.
- **`agent_session` appears after the first prompt, not at startup.** A freshly
  started Claude sits `idle` with no `agent_session` field until the first
  turn begins; the transcript file is created at that moment.
- **A new directory blocks at startup** with the workspace trust prompt:
  `agent start` returns `agent_not_ready` and the status is `blocked` with
  `launch_pending: true`. `send-keys Down Enter` clears it.
- **`/clear` rotates the session id and herdr follows within seconds.** Each
  `/clear` produced a new uuid, a new transcript file in the same project
  folder, and a new `agent_session.value`, observed before the next prompt.
- **`--resume <id>` restores the original id and appends to the original
  file.** herdr reported the resumed uuid as soon as Claude was detected,
  briefly with status `unknown`, then `idle` a few seconds later.
- **Session rotation has no event of its own.** It shows as `pane.updated`
  events carrying the new `agent_session`, bracketed by two
  `pane.agent_detected` events, one with `released: true` and `final_status`,
  then a fresh detection. A view that follows a pane must therefore watch the
  `agent_session` field on `pane.updated` for its own pane, which is the one
  exception to reacting only to status transitions.
- **Transcript line types seen in one short session:** `user`, `assistant`,
  `system` (subtype `turn_duration`), `attachment`, `queue-operation`,
  `last-prompt`, `ai-title`, `mode`, `permission-mode`, `atis-latch`,
  `file-history-snapshot`. Across all transcripts on this machine the `system`
  subtypes are `turn_duration`, `away_summary`, `local_command`,
  `informational`, `bridge_status` and `scheduled_task_fire`. No
  `compact_boundary` line exists on this machine, so its shape is unverified.
- **Not every string-content `user` line is a human prompt.** A background
  subagent's completion arrives as a `queue-operation` enqueue followed by a
  `user` line whose string content is a `<task-notification>` block, with
  `isMeta` unset. The human steer above, by contrast, never became a `user`
  line at all. A human prompt is therefore recognised by the
  `queued_command` attachment with `origin.kind: "human"`, or by being a
  string `user` line that is not preceded by a queue enqueue of the same
  content, not by `isMeta` alone. The launch `tool_result` of an async
  `Agent` call holds only a "launched" notice; the report lives in the
  notification's `<output-file>` under `/tmp/claude-<uid>/…/tasks/` and in
  `<session>/subagents/agent-<id>.jsonl`. A synchronous `Agent` call puts the
  report straight into its `tool_result`.
- **A process started by Claude Code can find its own transcript.** Every
  child gets `CLAUDE_CODE_SESSION_ID`, and its value matched the uuid of the
  live transcript of the session that ran the check, at
  `~/.claude/projects/<encoded cwd>/<id>.jsonl`. A test run from inside a
  session can therefore parse a real, current transcript; the file does not
  grow during the run, because the tool result that spawned it lands after
  it exits.
