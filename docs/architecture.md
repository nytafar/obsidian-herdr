# How the plugin talks to herdr

Two seams, both read from herdr's own CLI and never from its internals.

## Workspace state and actions: the JSON API

herdr's Unix socket serves newline-delimited JSON, one request per connection.
Every call opens its own connection; only `events.subscribe` holds one open, and
it reconnects with backoff when the server restarts. On the connected edge the
plugin loads `session.snapshot` (workspaces, panes, agent names) and then keeps
the picture current from events. Reads: `ping`, `workspace.list`, `pane.list`,
`tab.list`, `agent.list`, `session.snapshot`, `events.subscribe`. Writes only on
your action: `pane.focus`, `tab.create`, `pane.split`, `agent.start`,
`agent.prompt`, `agent.send_keys`. The last takes `{target, keys}` and nothing
else, checked against the schema the installed 0.8.2 prints (`herdr api schema
--json`, protocol 20), where both fields are required. The generated types
(`src/herdr/types.gen.ts`) are read from herdr 0.9.5's schema; none of these
methods changed between 0.8.2 and 0.9.5.

Everything is filtered to one workspace on the plugin side. The list reacts to
agent status transitions, never to the raw `pane.updated` stream, which is about
ten events per second across a busy session; the scope collapses it to the
handful of changes a row can show.

### What the event stream does not say

Measured on 2026-09-15 against herdr 0.8.2, protocol 20, on scratch panes of
their own.

- **A status change has no event a workspace can subscribe to.** A whole turn
  (idle → working → done → idle) on a scoped pane produced three
  `pane.agent_status_changed` events and not one `pane.updated`. `pane.updated`
  fires on a `PaneInfo` revision bump, and a status change alone is not one, so
  the `agent_status` the stream carries stays at whatever it was when a
  renderable field last moved: the pane sat at `working`, revision 3, in every
  event while `pane.list` answered `done` and then `idle`. The same on a pane
  that had never been moved, and the same with a `terminal session observe`
  client attached. `pane.agent_status_changed` is subscribed **per pane id** —
  `*`, `""` and `w2:*` all come back `pane_not_found`, and one id that no longer
  exists fails the whole `events.subscribe` — so the plugin's single stream
  cannot cover a workspace with it. Hence the one poll in the plugin: the scope
  re-reads `pane.list` for the scoped workspace every two seconds
  (`PANE_REFRESH_MS` in `src/main.ts`, `WorkspaceScope.refresh`), 4.6 KB against
  56 KB for `session.snapshot` here and about 11 ms. Nothing downstream learns
  that it is a poll — the scope still diffs, so a refresh that finds nothing
  emits nothing and the rule above holds.
- **A freshly opened stream replays the inventory**, `pane.created` and
  `pane.updated` for every pane herdr holds, at its stored revision, before any
  live event. That replay is how the stale `agent_status` above was read back.
- **The replay is per event type, not one timeline, and it outlives the pane.**
  194 events over 8.5 s in one measurement, at about ten a second, then
  silence — which is also where the "about ten events per second" above comes
  from. Within a pane, its `pane.created` and all four of its
  `pane.agent_detected` events arrived before any of its ten `pane.updated`
  frames, which is not the order they happened in. And a pane whose tab had
  been closed while its agent was running, for which `pane.get` now answers
  `pane_not_found`, was still replayed as `pane.created`, an agent detection
  and `pane.updated` frames carrying `agent: "claude"`, with no `pane.closed`,
  no `pane.exited` and no release anywhere in the stream. So a row raised from
  a `pane.updated` frame can be a corpse that no later event will ever take
  down: membership in the scoped list comes from `session.snapshot`, from the
  poll above and from transitions, and `pane.updated` only refreshes a pane the
  list already holds (`WorkspaceScope.upsert`).
- **A replayed transition raises corpses too, and whether one ever comes down
  is luck.** Measured again on 2026-09-15 on workspace `w2`: opening a stream
  replayed `pane.moved` for `w2:pK` — the whole `PaneInfo`, `agent: "claude"`,
  `agent_status: "idle"`, an `agent_session` — for a pane `pane.list` does not
  carry and whose tab had been closed. `pane.moved` and `pane.created` are
  transitions, so the scope admitted it, exactly as a live move should. What
  took it down again, half a second later, was the replayed `tab.closed` for its
  old tab happening to arrive after it; in the same capture another pane's
  `tab.closed` arrived *before* its frames, and that one would have stayed on
  screen for good. That is the ghost row of issue #90: a pane herdr does not
  have, shown as working, that nothing on the stream will ever remove.
  So `pane.list` decides who is in the list, not only what they are doing: a row
  the answer has stopped carrying is taken down after **two consecutive**
  answers without it (`POLL_MISSES_BEFORE_REMOVAL`, `WorkspaceScope.reap`),
  counted only for rows that were already there when the question went out —
  a pane admitted while the answer was in flight is missing from it through no
  fault of its own. It leaves as an ordinary `removed` transition, so nothing
  downstream learns that a poll was involved. Verified against the live session:
  a corpse raised from a replayed `pane.moved` survived one answer and was gone
  on the second, about four seconds.
- **Closing a tab announces the tab, not its panes**: `tab.closed` and no
  `pane.closed` for what was in it. Closing a pane does emit `pane.closed`.
  Nor is the agent in such a pane released: no `pane.agent_detected` with
  `released` follows, and `pane.list` simply stops carrying the pane. The scope
  therefore drops a tab's panes on `tab.closed` itself, which is the only
  notice it gets.
- **An agent that stops on its own *is* announced as a release, whatever
  stopped it.** Both `/exit` inside Claude and `kill -9` of the `claude`
  process produced `pane.agent_detected` with `released: true`,
  `final_status: "idle"` and `agent: "claude"` — the kind, not null — followed
  by a status change to `unknown`; `pane.updated` frames for the pane then stop
  carrying the `agent` field, and `pane.get` and `agent.list` drop the agent at
  once. The order of the release and the first agentless frame differs by
  cause: `/exit` released first, the kill sent the frame first. So a listener
  must take either order, and must read `released`, not `agent === null`.
- **There is no `agent.stop`.** The CLI has no such subcommand and the schema
  no such method; terminating an agent is `pane.close` on its pane. For a pane
  id herdr does not have, that answers
  `{"code":"pane_not_found","message":"pane w2:pZZ not found"}`, while
  `agent.get` and `agent.focus` for a pane whose agent has been released answer
  `agent_not_found`. The plugin treats `pane_not_found` from a close as the
  outcome asked for, not as a failure, and takes the row with it.

### What `pane move` emits

A pane id carries its workspace, so moving a pane across workspaces renames it:
`w1:pF` became `w2:pK`. herdr emits one `pane.moved` holding the whole new
`PaneInfo` — `agent_status` current, `agent_session` unchanged — plus
`previous_pane_id`, `previous_tab_id`, `previous_workspace_id`, and
`created_tab` / `closed_tab_id` when the move made or emptied a tab, followed by
`pane.focused`, `tab.created` and `tab.closed`. To the scope that is one pane
leaving under its old id and another arriving under the new one, which is why
`ingest` forgets `previous_pane_id` before it upserts. A view pointed at the old
id is pointed at a pane that no longer exists; there is no rename to follow.

### Versions and protocol

Measured on 2026-11-05: `herdr api schema --json` on 0.9.0, 0.9.1, 0.9.3 and
0.9.5 (and the 2026-10-14 preview, which reports `0.9.4-preview`) all print
**protocol 22**, schema version 1, yet the schemas differ: 0.9.2 removed
`pane.graphics.info|set|clear` and added `pane.clear`, `pane.link.resolve`,
`server.ssh_agent.register` and a few optional fields (`PaneInfo.restore_error`,
`AgentInfo.completion_seq`, `resume_argv`, `ServerCapabilities.ssh_agent_registration`).
0.9.4 was not run. 0.8.x is protocol 20. So the protocol number cannot tell
the 0.9 releases apart, and the client keeps the `version` string of the last
`ping` next to the protocol it compares (`HerdrClient.serverInfo`). A feature
that needs a newer build gates on `HerdrClient.supportsVersion("0.9.2")`
(`src/herdr/version.ts`); only the numeric core is compared, so a preview
counts as the release it names, and an unknown version gates off. A protocol
mismatch still only warns.

The 0.9.5 pong, verbatim from the running server:
`{"type":"pong","version":"0.9.5","protocol":22,"capabilities":{"live_handoff":true,"detached_server_daemon":true,"endpoint_protocol_generation":1,"surface_interest":true,"health_check":true,"ssh_agent_registration":true}}`.

An unknown method comes back two ways on 0.9.5, and both count as unsupported
(`HerdrError.isUnsupportedMethod`): a name herdr never had fails
deserialisation as `invalid_request` with "unknown variant `x`, expected one
of …", while a removed one answers `{"code":"unknown_method","message":"unknown
method: pane.graphics.info"}`.

### When the stream loses events

herdr 0.9.2 and later keep the last 512 events per server (`EventHub::MAX_EVENTS`
in `src/api/event_hub.rs`, source at `ee5bfb5`). A subscriber whose position has
fallen out of that window no longer skips silently: the server writes one error
response carrying the `events.subscribe` request's id and closes the
connection (`src/api/server.rs`, the subscription loop):

`{"id":"<subscribe id>","error":{"code":"events_lost","message":"event subscription fell behind retained history; resubscribe and resync with session.snapshot"}}`

The same path carries `server_unavailable` ("event history is unavailable").
The message string is in the installed 0.9.5 binary and absent from 0.9.1;
the error itself was not provoked against the live server, because that takes
a burst of more than 512 events while the reader stalls. The client treats any
error line on an acknowledged stream as the end of it. For `events_lost` it
emits `eventsLost`, reports the disconnect without an error and resubscribes
at once instead of after backoff; the new subscription's `connected` edge is
where the connection re-primes from `session.snapshot`, as after any reconnect,
so the scope never carries on with the gap. Other codes are reported as errors
and reconnect with the usual backoff. Up to 0.9.1 a lagging reader just missed
events, which the two-second `pane.list` poll above papers over.

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
one named effect — `theme`, `cursor`, `engine`, `view`, `title`, `next-mount` —
and the plugin calls one entry point per terminal leaf with the setting that
moved. Theme and cursor refresh the renderer, in place when the engine can and
by remount otherwise; the session is preserved either way, so a palette change
can never reclaim a pane another controller took over. `view` is the vault's
default view (#104), which reaches only a tab that is following it into a view
it is not already showing, and swaps that tab's surface without touching the
lifecycle. Only an engine change restarts the bridge. A hidden leaf holds every effect the renderer would show
until it is revealed, except the title, whose tab header is on screen anyway.

## Runtimes and the kind seam

Since ADR-0004 the plugin connects to one **runtime** of a registry at a time
(`src/runtimes.ts`): a kind (`herdr`, `herdr-core`) on a target (`local`,
`ssh`), with a stable id. The id is what everything downstream keys on: the
connection's endpoint carries the runtime snapshot under it, terminal tabs
persist it as `endpointId`, and `pinnedPanes` is keyed by it. The local herdr
is `local` and a migrated remote keeps `ssh:<host>:<socket>`; a runtime added
later gets a generated `rt-…` id that never follows an edit.

Everything that differs by kind sits behind `RuntimeKindAdapter`
(`src/runtime/kind.ts`): the connection driver the coordinator runs (discovery,
transport, client, scope, and how the scope is primed and fed), the terminal
tab's argv and bridge, the folder and row actions, the native view's prompt and
key senders, the tab-label source, the settings status lines, and the
capabilities the UI reads to leave out what a kind cannot do. The herdr kind
(`src/runtime/herdrKind.ts`) is the two seams above; the herdr-core kind
(`src/runtime/herdrCoreKind.ts`) is the next section.

A terminal tab is spawned from its pinned runtime, not from whatever is
active, so each kind finds its own local binary: the runtime's override with
a leading `~` expanded (the bridge spawns without a shell), else what that
kind's own last discovery of that runtime found, else a discovery run when
the tab starts (`resolveCommand` on the herdr bridge, an argv thunk on the hc
session). The active connection's discovery is never borrowed: it may be the
other kind's binary, or none at all for an SSH runtime. Over SSH the binary is
passed as typed, and the remote shell expands a `~`.

What the coordinator, the sessions and the views hold is the shared slice:
`ConnectionClient` (ping, request, the `connected`/`disconnected` edges,
dispose) and `ConnectionScope` (the rows, `get`, `list`, the four scope
events, `forget`, `refresh`, the taken names), both in `src/connection.ts`.
What only herdr has stays behind its driver: `session.snapshot` priming and the
coalesced `agent.list` refresh live in `src/herdr/connect.ts`, the `pane.list`
lookup is the herdr scope's own, and the native view narrows its session to
`HerdrClient` and `WorkspaceScope` because only herdr reports agent sessions.
Pins follow `capabilities.sharedPins`: herdr's stay in the plugin's
`pinnedPanes`, herdr-core's are the runtime's own `herdr.pinned` label.

## herdr-core: the framed `hc connect` seam

ADR-0005 records the seam; the API reference it rests on is the finding
`herdr-core-api` in the docs root (`findings/herdr-core-api.md`). The facts the
code relies on, and what was measured building it against `hc` 0.1.18 on this
machine and 0.1.17 on `asher` on 2026-11-05:

- **Transport.** A child process with plain pipes on both targets:
  `hc connect` locally (the binary is searched for like herdr's, by the name
  `hc`), `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o
  ServerAliveInterval=15 -o ServerAliveCountMax=4 <host> sh -c '…'` remotely,
  where the script is the runtime's binary or herdr-core's own lookup (`hc` or
  `herdr-core` on the PATH, then `~/.local/bin/herdr-core`), as the core dials
  machines itself. Measured: asher's non-interactive SSH PATH has no `hc`, so
  the fallback is what finds it. `hc connect` starts the core if none runs.
- **Framed mode** (`src/hc/frames.ts`, `src/hc/connection.ts`). `hello
  {generation: 1, framed: true}` goes as one plain line; its reply is the last
  plain line and the decoder switches to frames inside the same chunk. Frames
  are `[channel u32 LE][kind u8][len u32 LE][payload]`, at most 16 MiB; channel
  0 is JSON-RPC, concurrent. `unsupported_generation` is retried without a
  generation and, like any generation other than 1, reported as a mismatch
  (a notice and a status line), never refused.
- **Early frames.** The core can put a channel's first frame right behind the
  reply that names it; frames for an unregistered channel are buffered and
  handed over on registration, so neither an attach's first paint nor the
  first event is lost.
- **Events** (`src/hc/streams.ts`). `events.subscribe {}` answers with `{seq,
  terminals, channel}`; the channel carries JSON lines, several per DATA frame
  and split across frames, so it goes through the line splitter. Credit is 1
  MiB up front, then each frame's length once handled. `missed` replaces the
  whole state. Measured: a heartbeat came 15002 ms after subscribing, and the
  client treats 50 s of silence as a dropped stream.
- **Reconnect** (`src/hc/client.ts`). When the process exits, the event channel
  closes or the watchdog fires, the client redials with a backoff (1 s,
  doubling to 30 s), says `hello` again, resubscribes and emits `connected`,
  which re-primes. seq restarts per core process, so the new snapshot replaces
  everything. Measured: killing the `hc connect` child redialled after 1 s and
  the row came back from the new snapshot.
- **Scope** (`src/hc/scope.ts`, `src/hc/model.ts`). Spaces come from `doc.get
  {name: "herdr-app"}` (live: `{value: {spaces: [{id, name, folder, tabs:
  [{id, name, root}]}]}, version}`), re-read on its `doc` event; a core without
  the document has no spaces. Order: the runtime's space (id or name), the
  space named like the vault, then terminals whose cwd (`foreground.cwd`, else
  `cwd`) is under the vault root. Members of a space carry `herdr.space=<id>`.
  The scope stays unresolved until the document has been read once. Terminals
  addressed `machine/tN` (federated) are left out on both targets, and so are
  finished ones. Rows group by `herdr.tab`, labelled with the space's tab
  names, or the tab's 1-based position when unnamed, as herdr-app writes
  `where` ("sysadmin / 1").
- **Agents and status.** A terminal is an agent when it reported `status.app`
  (`claude-code` is shown as `claude`) or its foreground program is a known
  agent, looking through `node`/`bun`/`python`/`env`. Measured on asher: `t7`
  and `t8` never reported (`status: null`), have `env …` in `argv` and
  `claude` in the foreground, and show as claude with status unknown. Status
  is ADR-0005's mapping: `working`; `blocked`/`error` as blocked; `done`/`idle`
  as done when `turn > herdr.seen`, else idle, and as reported without the
  label; never reported as unknown. Measured: asher `t1` reports `done` at turn
  17 with `herdr.seen=17`, so it shows idle, as herdr-app shows it.
- **Actions** (`src/hc/actions.ts`). Start agent is `terminal.run {line, cwd,
  name, labels}` with `herdr.seen=0` and `herdr.space` when a space resolved;
  the line runs the agent in the user's own interactive shell and leaves that
  shell when it exits (`SHELL="${SHELL:-/bin/sh}"; export SHELL; exec "$SHELL"
  -ic '<agent>; exec "$SHELL" -i'`). Measured with `true` as the program: the
  terminal's foreground became `/usr/bin/bash -i` in the asked cwd. Close is
  `terminal.kill` then `terminal.rm`; `not_found` counts as closed. Pins write
  `herdr.pinned=1` and remove it with an empty value: measured, the `labels`
  event came back and the row repainted pinned, then unpinned. Prompts are
  `terminal.send {terminal, text}`; keys are `terminal.keys` with hc's names
  (`Down` becomes `down`, `C-c` becomes `ctrl+c`).
- **Terminal tabs** (`src/hc/terminalSession.ts`, behind `PaneSession`). One
  `hc connect` child per tab (`ssh -T …` on an `ssh` target), one
  `terminal.attach {terminal, cols, rows, history: 2000}` on it, plus
  `observe: true, resize_notifications: true` in observe mode, and one
  `events.subscribe {terminal: <address>}` on the same connection for the
  record (turn, labels, size, restarts). A local runtime's tab uses its
  override (`~` expanded), else the binary its last discovery found, else
  searches for `hc` when it starts, so a tab pinned to an hc runtime opens
  whichever runtime is active. The
  native view stays off for hc panes (ADR-0005, `nativeUnavailable`).
  Measured against `hc` 0.1.18 on 2026-11-05 with throwaway `oh-test-*`
  terminals running `sh`, driving the session class from a script, and
  rendering the bytes into `@xterm/headless` and the ghostty-web WASM terminal:
  - **First paint.** The paint arrives in the first DATA frame (CAN, reset,
    screen, history) and both engines showed the shell's earlier output and
    prompt from it. The session prefixes the first paint of every attach with
    `ESC[3J`, so the core's history, colours included, replaces any text the
    tab replayed from before a suspend; every frame starting with CAN is a
    `full` frame, which drops bytes still buffered behind it.
  - **Input and replies.** Typing is DATA (`echo hi-$((6*7))` echoed `hi-42`
    on both engines). Emulator replies go through `reply`: AUTOMATIC_INPUT
    when both `hello.features` and the attach result say `automatic_input`
    (0.1.18 here), DATA otherwise (asher's 0.1.17 has no `automatic_input`).
    The renderers tell replies from typing (`TerminalRenderer.onReply`,
    `src/views/renderer/replies.ts`): ghostty-web answers synchronously
    inside `write()`, xterm.js fires its internal `coreService.onUserInput`
    before every `onData` a person caused and not before a reply (checked
    against the real xterm core: DA and DSR came without it, `input(…, true)`
    with it). herdr sessions have no `reply`, so their replies still go as
    input.
  - **Size ownership.** A control attach at 80x24 resized the terminal from
    its headless 200x120 to 80x24 at once; RESIZE 100x30 made it 100x30. A
    second controller at 90x25 took the size (last active viewer wins); the
    first tab then gets `grid 90x25` from the `size` event and draws at it,
    and its next RESIZE (101x31) took the size back and ended the foreign
    grid. Cell size goes as FACTS `{cell: [w, h]}` and with the attach as
    `display`.
  - **Observe.** The observer got RESIZE 100x30 before its paint and follows
    every later one (90x25, 101x31, 200x120 when the controller's process was
    killed, back to 101x31 on its redial); its renderer draws at that grid and
    it never sends RESIZE, DATA or AUTOMATIC_INPUT (input sent anyway was
    verified dropped by the core in the finding). Without confirmed
    notifications it follows the attach record's `cols`/`rows` and `size`
    events. asher 0.1.17 over SSH, observe-only on an existing terminal:
    features `framed,attach,events,status,shell,resize_notifications`, RESIZE
    191x42 then the paint (first byte CAN, 7.6 KB), rendered on both engines.
  - **Credit.** Bytes are credited back once written into the renderer (and
    when a full repaint drops buffered ones), never more than was delivered. A
    3,000,000-byte burst arrived whole (3,000,103 bytes, no repaint) through
    the crediting tab; an observer that credited nothing received exactly
    262,148 bytes (256 KiB plus the 4-byte `ESC[3J`) and stopped, then caught
    up once it credited.
  - **Ends.** `exit 3` gave CLOSE `{reason: "exited", exit_code: 3}` on both
    tabs, shown as "the program exited with code 3", then the `finished` event
    ended the session; attaching to the finished terminal answered `finished`
    ("t13 has finished"), shown as a final close. A CLOSE with a loss reason
    shows "waiting for herdr-core to restart it" and the `restarted` event
    attaches again with `resumed: true` (fake core only; not provoked live).
    Killing the tab's `hc connect` child showed "herdr-core connection lost …;
    trying again", redialled after 1 s (backoff to 30 s), attached with
    `resumed: true` and took typing again. A theme rebuild under a live
    session asks for a fresh paint the same way (attach resumed, then let the
    old channel go). The tab detaches (CLOSE) and closes stdin on close.
  - **Scrolling.** hc has no scroll method, so the wheel is the renderer's own
    (local scrollback, or the engine's mouse reports to a program that asked).
- **`herdr.seen`** (`src/hc/seen.ts`). A tab writes `terminal.label
  {herdr.seen: <turn>}` while a person is in front of it: the view says so
  when its window has the focus and is visible, the terminal is the surface
  shown and its host has a box. Once per turn while it stays on screen, only
  to raise it (or when the label is missing), never for a terminal that has
  not reported a status, decided on the `turn` event (herdr-app
  `docs/labels.md`, `share_seen`). Measured: a fake 7501 report (working, then
  done) moved turn 0 to 1 and the looking tab wrote `herdr.seen=1`; a mark
  unread (`hc label … herdr.seen=0`) while it stayed on screen was left at 0;
  looking away and back raised it to 1 again. The agent list reads the label
  through the scope, so the done row clears; herdr rows are unchanged.

## The settings tab

The tab itself is an assembler. Its section builders — runtimes, connection,
notifications, agents, file explorer, agent list, terminal, native view — are plain functions
over a container, the settings object and a bundle of callbacks, listed in
`SETTINGS_SECTIONS` in `src/settings.ts`; none of them ever sees the plugin. The
callbacks bundle is the whole of what a control may do besides write into the
settings: save, save and reconnect, redisplay, refresh the agent list or the
folder hover buttons, hand one changed setting to the open terminals, or switch,
open and remove runtimes. Which runtime's form is open is the tab's state, handed
in through the same bundle. The tab
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
  report straight into its `tool_result`. Measured 2026-09-15: all 137 async
  agent output files still on this machine are symlinks to that same
  `subagents/agent-<id>.jsonl`, so the output file is a JSONL transcript and
  its report is the last assistant text, not plain text. A background shell
  task's output file, by contrast, is a plain file holding its stdout.
- **The shapes a tool call's outcome comes in.** Measured 2026-09-15 over every
  transcript on this machine. A steer's queue enqueue always precedes its
  `queued_command` attachment and carries the identical string, so the two pair
  by content. An async `Agent` call's launch notice always opens with `Async
  agent launched successfully.`, which is the only thing that tells it from a
  synchronous call's report before the notification arrives. A task
  notification's `<status>` is `completed`, `failed` or `killed`. A failed call
  and one the user refused both arrive as a `tool_result` block with
  `is_error: true`. A `WebSearch` result is a string that opens `Web search
  results for query: "…"`, then one line `Links: [{"title":…,"url":…}, …]`, then
  the model's prose: the sources are there and nowhere in the call's input.
- **A process started by Claude Code can find its own transcript.** Every
  child gets `CLAUDE_CODE_SESSION_ID`, and its value matched the uuid of the
  live transcript of the session that ran the check, at
  `~/.claude/projects/<encoded cwd>/<id>.jsonl`. A test run from inside a
  session can therefore parse a real, current transcript; the file does not
  grow during the run, because the tool result that spawned it lands after
  it exits.
- **The project folder is the session's cwd with every character that is not a
  letter or a digit replaced by a dash.** Measured 2026-09-15 on all 24 project
  folders under `~/.claude/projects`, each compared with the `cwd` its own
  transcript records: `/home/lasse/.claude` is `-home-lasse--claude`, case and
  existing dashes survive. Claude Code 2.1.266 caps the name at 200 characters
  and appends `-<hash>`, the hash being `h = h * 31 + c` over the whole path,
  wrapped to int32, `Math.abs(...).toString(36)`. The cwd is the session's, not
  the process's: an agent started from one directory and working in another
  writes under the first.
- **What a bare Enter selects on each of Claude's blocking dialogs.** Measured
  2026-09-15 against herdr 0.8.2 and Claude Code 2.1.266, in a scratch pane
  started with `--permission-mode default` (this machine's Claude defaults to
  auto mode, which shows no permission dialog at all, so Bash `echo` and other
  allowlisted commands never block either). The cursor sits on the first option
  in every variant, and `agent send-keys <pane> Enter` picks it:
  - **Workspace trust prompt** (startup, `launch_pending`): first option is
    "No, exit". Enter quits Claude. Never send a bare Enter here; `Down Enter`
    trusts the folder.
  - **Write and Edit permission** ("Do you want to create b.txt?"): options
    "1. Yes", "2. Yes, and switch to accept edits …", "3. No". Enter allowed
    the write and the status went `blocked` → `done`.
  - **Bash permission** ("Do you want to proceed?"): "1. Yes", "2. Yes, and
    don't ask again for … in <cwd>", "3. Yes, and switch to auto mode",
    "4. No". Enter ran the command once, without changing any mode.
  - **`AskUserQuestion`**: the options are the question's own answers,
    "1. Tea", "2. Coffee", "3. Type something.", "4. Chat about this". Enter
    chose the first answer. Answering a question is never "Allow".
  - **Plan approval** (`ExitPlanMode`, "Ready to code?"): "1. Yes, and use
    auto mode", "2. Yes, manually approve edits", "3. Tell Claude what to
    change". Enter switches the session to auto mode, a lasting side effect.
    Never send a bare Enter here.
  So the trust prompt is the one dialog the plugin answers, with `Down Enter`
  and never a bare Enter. Tool permissions are Claude's own, decided by its
  permission mode, and a question and plan approval are the user's; the native
  view shows those three and leaves them to the terminal (the "Allow" button
  and the auto-accept setting of #99 were withdrawn on 2026-09-15 for that
  reason). The transcript shows a permission block as a dangling `tool_use`;
  plan approval as a dangling `ExitPlanMode` call; the trust prompt as no
  transcript at all. `agent_status` is `blocked` in all of them.
- **A pending question is not in the transcript.** Re-measured 2026-09-24
  against herdr 0.8.2 and Claude Code 2.1.281 (2.1.266 above read otherwise):
  the `AskUserQuestion` `tool_use` line is written only once the question is
  answered, together with its `tool_result`, whose `toolUseResult.answers`
  holds the choices. A Write or Bash permission and `ExitPlanMode` are still
  dangling `tool_use` lines written before their dialog. So a `blocked` agent
  with no dangling call, past startup, is showing a question, and the
  question's text and options are only on screen (`pane.read`). The dialog
  takes keys: a digit selects an answer (toggles one, on a multi-select), and
  on a dialog with more than one question `right` then `1` submits; a
  one-question single-select dialog submits on the digit. Details and the
  probe in the docs root, `findings/native-view-session-chrome.md` and
  `findings/native-view-control-channels.md`.
