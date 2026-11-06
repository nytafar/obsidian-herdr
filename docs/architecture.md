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

**Agent kinds per release.** `agent.start`'s `kind` is checked against a
fixed list, the `--kind` possible values of `herdr agent start --help`. Read
from the release binaries on 2026-11-06: 0.8.2 accepts pi, claude, codex,
gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi,
kiro, droid, amp, grok, hermes, kilo, qodercli, qwen and maki; 0.9.0 adds
`muse`; 0.9.1 adds `letta`; 0.9.5 is the same as 0.9.1. The agent catalog
(`src/agents/catalog.ts`, issue #125) records the release a kind arrived in
and leaves it out of a herdr runtime's + menu on an older or unknown server
version. The version is the one the connection's first `ping` answered, and
the plugin publishes a connection before that ping returns, so the catalog's
probe waits for it (`src/agents/catalogs.ts`); herdr-core's client likewise
refuses every request until its `hello`. herdr calls the kind its "canonical executable": `agent.start` runs
that program in the pane and passes `args` after it, so herdr cannot start a
user's own wrapper; herdr-core's `terminal.run` can.

The catalog's probe (`src/agents/probe.ts`) does not count a version-manager
shim for a tool that is not active where agents start. Measured on this Linux
machine 2026-11-06: the file-only probe found 16 of 24 programs, most of them
in `~/.local/share/mise/shims/` (106 executable stubs, each a symlink to
`/usr/bin/mise`), and `mise which kimi` (likewise qwen, muse, devin, agy, omp,
kilo, cursor-agent, amp, opencode) answered `mise ERROR kimi is a mise bin
however it is not currently active` with exit 1. Activeness depends on the
working directory, so a shim (a path in `…/mise/shims/` or resolving to
`mise`, or in `~/.asdf/shims/`) is asked `mise which <name>` / `asdf which
<name>` from the runtime's vault root (local vault path, `remoteVaultPath` on
SSH and herdr-core `machine.exec`, where the script takes it as `$1`). Exit 0
counts; any other answer does not; a manager that is missing, cannot run or
times out leaves the file counted. With that, the same machine reports claude,
codex and pi from `~/hvelv`, locally and through the remote script.

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
(`src/runtimes.ts`): a kind (`herdr`, `herdr-core`, `claude`) on a target
(`local`, `ssh`; `claude` is `local` only), with a stable id. The id is what everything downstream keys on: the
connection's endpoint carries the runtime snapshot under it, terminal tabs
persist it as `endpointId`, and `pinnedPanes` is keyed by it. The local herdr
is `local` and a migrated remote keeps `ssh:<host>:<socket>`; a runtime added
later gets a generated `rt-…` id that never follows an edit. Loading never
erases a stored runtime (`migrateRuntimes`): an entry with an id and a kind or
target this build does not know is kept aside, never shown or connected, and
written back after the known ones by every save; a legacy `remote` block
beside the registry (an older build writes it again after a downgrade) is
imported as an extra, inactive runtime unless its `ssh:` id is already listed.

Everything that differs by kind sits behind `RuntimeKindAdapter`
(`src/runtime/kind.ts`): the connection driver the coordinator runs (discovery,
transport, client, scope, and how the scope is primed and fed), the terminal
tab's argv and bridge, the folder and row actions, the native view's prompt and
key senders and its session inputs (`native`, below), the tab-label source,
the settings status lines, and the capabilities the UI reads to leave out what
a kind cannot do. The herdr kind
(`src/runtime/herdrKind.ts`) is the two seams above; the herdr-core kind
(`src/runtime/herdrCoreKind.ts`) is the next section, and the `claude` kind
(`src/runtime/claudeKind.ts`) has a section of its own after the herdr-core
ones.

A terminal tab is spawned from its pinned runtime, not from whatever is
active, so each kind finds its own local binary: the runtime's override with
a leading `~` expanded (the bridge spawns without a shell), else what that
kind's own last discovery of that runtime found, else a discovery run when
the tab starts (`resolveCommand` on the herdr bridge, an argv thunk on the hc
session). The active connection's discovery is never borrowed: it may be the
other kind's binary, or none at all for an SSH runtime. Over SSH each kind
wraps its remote command in `sh -c`, so a fish or nu login shell parses it
the same way: a binary the runtime names is used as given, a leading `~/`
being the remote `$HOME`, and an empty one is searched for on the remote
host. herdr's search (`remoteHerdrCommand`, `src/herdr/ssh.ts`) is `command
-v herdr`, then `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, the
local search's directories in its order, because non-interactive SSH rarely
has the login PATH (`~/.local/bin` is not on it on `xl`); nothing found exits
127 with a message on stderr. The bridge's own arguments follow the script as
its positional parameters, so the NDJSON seam is unchanged. A stored SSH
herdr binary equal to the old default `~/.local/bin/herdr` loads as empty.

What the coordinator, the sessions and the views hold is the shared slice:
`ConnectionClient` (ping, request, the `connected`/`disconnected` edges,
dispose) and `ConnectionScope` (the rows, `get`, `list`, the four scope
events, `forget`, `refresh`, the taken names), both in `src/connection.ts`.
What only herdr has stays behind its driver: `session.snapshot` priming and the
coalesced `agent.list` refresh live in `src/herdr/connect.ts`, the `pane.list`
lookup is the herdr scope's own, and so is herdr's session watcher (next
paragraph). Pins follow `capabilities.sharedPins`: herdr's stay in the plugin's
`pinnedPanes`, herdr-core's are the runtime's own `herdr.pinned` label.

The native view's inputs are kind-neutral (ADR-0006). A kind with a native
view sets `capabilities.nativeView` and supplies `RuntimeKindAdapter.native`, a
`NativeSessionAdapter` with three calls:

- `transcriptAccess(endpoint)`: `local` (this machine's files), `rpc` (over the
  runtime's own connection) or null (out of reach). The view is offered on
  capability plus access, not on the target: null on an `ssh` target reads
  "local panes only", as herdr over SSH always has, and `rpc` on one would be
  offered.
- `watcher(connection)`: a `SessionWatcher` over one live connection
  (`src/native/sessionWatcher.ts`). Its snapshot of a pane is cwd, agent
  session, an optional transcript path, status and an optional block kind
  (`trust`, `permission`, `question`, `auth`); it pushes a pane's session on
  every report (the model deduplicates by value and re-reads the snapshot only
  when the session or its path moved), status transitions with their block
  kind, and scope membership.
- `transcripts(endpoint, connection)`: the `TranscriptSource` for that
  endpoint, given the published connection when it is that endpoint's. A
  `local` source needs no connection; the same object is returned for as long
  as it stays usable, because a model reopens its tail whenever its source
  changes.

herdr's watcher is `src/herdr/sessionWatcher.ts`: cwd and status from the
scope, `agent_session` from the raw `PaneInfo`, and rotation read off
`pane.updated` one microtask after the client's dispatch, so the scope has
ingested the update first. It reports no block kind, and the waiting card
guesses the block from the transcript. On a local herdr it works out the
transcript path of a Claude pane from the pane's Claude process (next
section), and of no other agent's pane: a path the runtime reports wins over
the format's, and this one is a Claude transcript's. Until that is known, over
SSH, and for any other agent, the model asks the agent's format for the path,
which for Claude is cwd and session under `~/.claude`. A session whose
`agent_session.agent` is not the pane's agent is not followed: the watcher
reports no session for the pane (Codex's shared daemon writes its thread id
onto the pane that started it, which may run Claude now; finding
`agent-codex` §2). herdr-core's watcher and
sources are in "herdr-core: the native view" below.

### The agent seam: formats and session bindings (issue #137, ADR-0010)

What a pane's session *means* is the agent's, not the runtime's. The
snapshot names the pane's agent (`PaneSnapshot.agent`: herdr's
`PaneInfo.agent`; `claude` for an hc terminal whose Claude hook label was
accepted, and on the `claude` kind; absent reads as the catalog's default
agent), and the session model reads the session with that agent's
`AgentFormat` (`src/agents/format.ts`). A format supplies the parser into
the neutral model (`src/native/conversation.ts`), the transcript path when
the runtime names none, images, the call a block is about, background
reports, the plan file, tool names, the `/` catalogue and session info.
Claude Code's is `src/agents/claude/`. Above the seam nothing imports it.

The native view is offered for a pane only when a format exists for its
agent **and** the runtime's session binding for that agent is `trusted`
(`AGENT_SESSIONS` in `src/runtime/kind.ts`: herdr `{claude: trusted, codex:
hint}`, herdr-core and the `claude` kind `{claude: trusted}`, anything
unlisted `absent`), on a runtime whose transcripts this machine can reach
(`transcriptAccess`, above). herdr's and herdr-core's watchers word a
refusal through `nativeAgentReason` (`src/native/agentSupport.ts`). The
catalog's `native` flag is `offersNativeView` for the runtime's kind and the
runtime's reach (`nativeAdapterFor`, which the plugin answers as
`nativeReachable` for the + menu and the settings), so all three agree:
Claude on herdr over SSH has no native view in any of them. A runtime that
knows session info sooner than the transcript puts it in
`PaneSnapshot.sessionInfo`; the model lays it over the format's reading per
field.

Two cases are kept apart wherever a format is picked: an agent the runtime
does not name is the catalog's default agent (Claude), and an agent without
a format gets nothing (no `/` list, no name on a waiting card, every call
`other`). The `/` catalogue the runtime reads (`NativeSessionAdapter
.commandCatalog`) is asked per agent: herdr's pane-Claude reader and
herdr-core's `machine.exec` reader are Claude's directory layout and answer
only for Claude; any other agent gets its own format's list (this machine's
on a local runtime, its built-ins on herdr-core over SSH). What a tool call is
shown as is looked up in the session's own format's tool table, not across
the registry.

### A pane's Claude process: config dir and real cwd (issue #132)

Claude files a session under its configuration folder (`CLAUDE_CONFIG_DIR`,
else `~/.claude`) and the real cwd: a session started in a symlinked folder is
filed under the link's target (measured 2026-11-06, the `claude` kind's table
below). What herdr 0.9.5 gives towards that, verified 2026-11-06 against the
running server and the herdr source (`herdrdev/herdr` master):

- **No transcript path.** The Claude hook (integration v10, installed here)
  sends `agent_session_path` (the hook's `transcript_path`) with every
  `pane.report_agent_session`, and herdr drops it: `session_ref_from_report`
  (`src/agent_resume.rs`) keeps a path only for `pi` and `omp`, and every
  other agent's `agent_session` is `{"kind":"id","value":<uuid>}`. All 36
  `agent_session` values in `pane list` on this machine were `kind: "id"`.
  `AgentSessionInfo.kind` can be `"path"`, but not for Claude.
- **The pane's `cwd` is the shell's report.** `Pane::cwd` (`src/pane.rs`)
  returns the cwd the shell last reported in its prompt (an OSC sequence) when
  there is one, and only otherwise the shell process's cwd read from the OS.
  A shell reports its logical `$PWD`, so a pane started in a link can report
  the link. `foreground_cwd` (`Pane::foreground_cwd`) is the foreground
  group leader's cwd read from the OS. Read from the source, not measured in
  a symlinked pane: no pane here sits in a link, and none was made.
- **The pid and a resolved cwd, from `pane.process_info`** (present in 0.9.1
  and 0.9.5): `{shell_pid, foreground_process_group_id, tty?,
  foreground_processes: [{pid, name, argv, argv0?, cmdline, cwd}]}`. For a
  Claude pane the list holds `claude` (name `claude`, pid equal to the
  foreground group id) and its MCP servers. The process `cwd` is read from the
  OS (`/proc/<pid>/cwd` on Linux), which is the resolved path.
- **No environment.** Neither `pane.get`, `pane.list` nor `pane.process_info`
  carries one. On Linux `/proc/<pid>/environ` of the same user's Claude is
  readable (59 variables for pane `w1:p1A`'s Claude, `HERDR_PANE_ID` among
  them). No Claude on this machine had `CLAUDE_CONFIG_DIR` set when measured.

So for a local herdr (`src/herdr/paneClaude.ts`): `pane.process_info`, the
process called `claude` (by name or program file name; else the foreground
group's leader), its `cwd` as the real cwd, and its `CLAUDE_CONFIG_DIR` from
`/proc/<pid>/environ` (Linux) or `ps -wwE -o command= -p <pid>` (macOS, parsed
for the last `CLAUDE_CONFIG_DIR=` assignment, up to the next `NAME=`); a
relative value is taken from Claude's cwd. No process: the pane's `cwd`
through `realpath` here. No environment read: `~/.claude`. An
answer is kept per pane and agent session, 30 s when the environment was read
and 2 s when anything fell back, and refreshed on that pane's updates only
while a session model follows it. The watcher pushes the path as soon as it is
known, and every later `pane.updated` carries it, so the model's dedupe holds.
The `/` list's user scope and plugins come from the same configuration folder.

**herdr over SSH is unchanged:** its panes have no transcript adapter and stay
terminals (ADR-0002), and nothing here reads a remote process. Its prompt box
is not offered either, so the `/` list question does not arise.

Session models are keyed by runtime id and pane id (`SessionModelRegistry`).
Each model asks for its own runtime's watcher and source on every connection
change and never for the published runtime's on its behalf, so one pane id on
two runtimes is two models. While another runtime is active a model holds no
watcher: it keeps its turns, reports `connected: false` and status `unknown`
(which disables the prompt box), and its tab's status line says the runtime is
not connected. A `local` tail keeps following meanwhile; one whose source went
with the connection is closed and read again whole when the runtime is back.
The native surface and the table of contents compare the runtime as well as
the pane.

The local tail (`LocalTranscriptSource`) reads from a byte offset in pieces of
1 MB, and treats anything but growth as another file: a new inode, a size below
its offset, or a first kilobyte that differs from what it read. Any of them
restarts it at the beginning, and its next batch carries `restart`, on which
the model drops the turns it held. A `rename` event rebuilds the `fs.watch`:
measured 2026-11-05 on Linux (`tests/transcriptSource.test.ts`), a watch on a
file that is renamed over hears nothing of the replacement afterwards, and
only the 2 s poll would have found it.

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
  space named like the vault, an unnamed space whose first terminal runs in
  the vault, then terminals whose cwd (`foreground.cwd`, else `cwd`) is under
  the vault root. Members of a space carry `herdr.space=<id>`. Measured on the
  Mac's hc 0.1.18, 2026-11-06: all three spaces had `name: ""` and `folder:
  "/Users/lasse"`, and Herdr UI still showed one as "hvelv", because
  herdr-app names an unnamed space after its first terminal (`space_name` in
  herdr-app `src/model.rs`): the first `content.terminal` block of its tabs'
  `root` trees, walked tab by tab, node before children (`Node::walk`,
  floating blocks not walked), then that terminal's git top, else the
  space's `folder`, shown by last path segment. The plugin has no git top,
  so it takes the first terminal's cwd (`foreground.cwd`, else `cwd`), or
  the space's `folder` when there is no first terminal or the core does not
  list it, and matches when that is the vault root or inside it. That is an
  approximation: a first terminal in a vault subfolder matches here, while
  Herdr UI names it after the repository top, which is the vault for a vault
  under git. The match moves with that cwd, as Herdr UI's name does. When
  several unnamed spaces qualify, the first in document order wins, which is
  Herdr UI's sidebar order. The plugin writes no labels to existing
  terminals: it labels only agents it starts.
  The scope stays unresolved until the document has been read once. Terminals
  addressed `machine/tN` (federated) are left out on both targets, and so are
  finished ones. Rows group by `herdr.tab`, labelled with the space's tab
  names, or the tab's 1-based position when unnamed, as herdr-app writes
  `where` ("sysadmin / 1").
- **Agents and status.** A terminal is an agent when it reported `status.app`
  (`claude-code` is shown as `claude`) or its foreground program is a known
  agent, looking through `node`/`bun`/`python`/`env`. Measured on asher: `t7`
  and `t8` never reported (`status: null`), have `env …` in `argv` and
  `claude` in the foreground, and show as claude with status unknown. The
  foreground's `argv[0]` is the process title and is read too: measured on the
  Mac's hc 2026-11-06, pi reports `foreground: {name: "node", argv: ["pi",
  ""]}` (node retitles itself), which the interpreter scan of `argv[1…]`
  missed, so the row vanished. herdr's own detection (`src/detect/mod.rs`,
  `normalized_process_name`) reads argv0 first, so herdr panes have no such
  gap, and the plugin does not classify herdr panes itself. Last resort: the
  label `obsidian-herdr.agent=<kind>`, which the plugin's own `terminal.run`
  sets (not for an hc template, which names no kind); the terminal ends with
  the agent (the launch line leaves the shell when the agent exits), so the
  label never outlives what it describes. Status
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
  native view follows the Claude session hook's label (ADR-0006; "herdr-core:
  the native view" below).
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
  - **Focus.** ghostty-web never emits focus reports (`ESC[I`/`ESC[O`): its
    bundle only has `hasFocusEvents()`, nothing writes the sequences. xterm.js
    does, for a program with mode 1004, and they arrive as replies. So the
    view tells the session itself (`focusin`/`focusout` on the host; a
    `focusout` with no related target is the window losing the foreground),
    the session sends FOCUS `1`/`0`, and the reply path drops xterm.js's own
    reports so the program does not hear them twice. In the core
    (`viewers.rs` `viewer_focus`) FOCUS `1` is activity and takes the size;
    `0` is not; either goes to the program as `CSI I`/`CSI O` only when it
    enabled 1004. Measured: a program with 1004 set read `ESC[I` then `ESC[O`
    from one tab's FOCUS 1 and 0, and FOCUS 1 took the size from a second
    controller (70x20 to 90x25) while FOCUS 0 left it there. A tab focused
    while `hc connect` is still dialling (the view focuses the renderer on
    every start) owes the program that focus: it is sent as FOCUS 1 right
    after the first attach that takes the size, which already made the tab
    the leader, so it costs no size; on a placeholder grid it is sent with the
    first real RESIZE instead. A focus lost again before then is not owed.
    Nothing is sent on a `resumed` attach (a redial, a restart, a repaint),
    so those never take the size.
  - **Size ownership.** A control attach at 80x24 resized the terminal from
    its headless 200x120 to 80x24 at once; RESIZE 100x30 made it 100x30. A
    second controller at 90x25 took the size (last active viewer wins); the
    first tab then gets `grid 90x25` from the `size` event and draws at it,
    and its next RESIZE (101x31) took the size back and ended the foreign
    grid. Cell size goes as FACTS `{cell: [w, h]}` and with the attach as
    `display`. A `resumed` attach is not the size leader (no `active_at`
    until it types, resizes or gains focus, `viewers.rs`), and a `size` event
    missed while the tab was disconnected never comes again, so a controller
    also follows the attach record's `cols`/`rows` (read after the attach
    took effect) and the subscribe snapshot's record. Measured: a tab at
    100x30 whose `hc connect` was killed while another controller took 60x15
    reattached resumed and drew at 60x15 at once. A control tab whose host
    has no box yet (fit 0x0) starts with the 80x24 placeholder but marks it
    `provisionalSize`: it attaches `resumed`, follows the shared grid, sends
    no RESIZE and no FOCUS `1`, and takes the size with its first measured
    fit, even one equal to the placeholder. herdr's bridge ignores the flag.
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
    `finished` (events channel) can come before output still queued on the
    attach stream for credit, and a CLOSE of ours would drop that output
    (`wire.rs`), while the core's own CLOSE follows it; so on `finished` the
    session lets the stream drain to the core's CLOSE, for at most 3 s, then
    ends. Measured: `seq 1 120000; echo LAST-LINE-MARKER; exit 4` into a tab
    crediting 150 ms late got 262,517 bytes and no marker when ending on
    `finished`, and all 849,282 bytes with the marker when draining.
    Killing the tab's `hc connect` child showed "herdr-core connection lost …;
    trying again", redialled after 1 s (backoff to 30 s), attached with
    `resumed: true` and took typing again. A redial that fails before or
    during the attach (ssh down, the child gone) is reported and retried on
    the same backoff, as is a passing error on the very first attach
    (`unavailable` while a kept terminal waits for its new shell,
    `unreachable`, `busy`) or a timeout; any other failure before the first
    attach (no `hc`, ENOENT reported by the spawn, an unreachable host)
    shows its reason and ends the tab. `hello` has a 20 s deadline and
    `terminal.attach` 15 s; either passing aborts the connection, which then
    fails like a dead process. Plain lines before the `hello` reply that are
    not JSON (a login banner) are skipped, and a reply sharing a line with a
    banner's unterminated tail is found at the first `{` it parses from. A theme rebuild under a live
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
  A native view of an hc terminal counts the same way, under the same rules:
  its window focused and visible and its host with a box. It has no attach
  connection, so the write goes over the plugin's own `hc connect`: the
  session watcher (`src/hc/sessionWatcher.ts`) keeps one tracker per terminal
  some native view is in front of, fed from the scope's ingested events, and
  the view says when it looks and when it looks away
  (`SessionWatcher.looking`). Two views of one terminal look once; herdr's
  watcher has no such method, so a herdr tab is untouched.

## herdr-core: the Claude session hook

ADR-0006 puts a herdr-core terminal's Claude session on a label written by a
Claude Code `SessionStart` hook. This section is the label and the installer;
the native view that reads it is the next section. Code is in
`src/sessionHook/`: `hookScript.ts` (the script and its one entry),
`claudeSettings.ts` (merge, unmerge, status), `installer.ts` (paths, plan,
apply over hc), `label.ts` (the parser), `modal.ts` (the consent step).

- **The label.** Key `obsidian-herdr.session`, value one JSON object
  `{"v":1,"session":"<id>","pid":<Claude's pid>,"transcript":"<absolute path>"}`.
  `parseSessionLabel(value)` / `sessionLabelOf(labels)` return
  `{sessionId, pid, transcriptPath}` or null. They ignore unknown fields,
  read any integer `v` ≥ 1, and require a positive integer pid and an
  absolute transcript path. Parsing does not mean trusting: the caller still
  compares `pid` with the terminal's `foreground.pid`.
- **Measured inside the hook** (Claude Code 2.1.318, hc 0.1.18, a throwaway
  `oh-test-*` terminal running bash, then `CLAUDE_CONFIG_DIR=<tmp> claude`):
  - `HC_TERMINAL_ID` (`t1d`) and `HC_TERMINAL_SOCKET` reach the hook.
  - `CLAUDE_PID` was 2385349: Claude's pid, equal to `$PPID` there and to
    hc's `foreground.pid` for the terminal.
  - `CLAUDE_CODE_SESSION_ID` equals the input's `session_id`.
  - `CLAUDE_CODE_CHILD_SESSION=1` is set in **every** hook's environment, a
    top-level Claude's included: Claude sets it for its children, and the
    hook is one. Claude's own initial environment (`/proc/<pid>/environ`)
    does not have it. hc terminals do not inherit it from the caller of
    `hc run` (the core's environment is the base), but they would if the core
    itself had been started from inside a Claude.
  - Claude's tool shells run in a session of their own with no terminal
    (`TPGID -1`, `TT ?`). The top-level Claude leads the terminal's
    foreground process group (`PGID == TPGID`).
  - The hook input for a start is flat: `session_id`, `transcript_path`,
    `cwd`, `hook_event_name: "SessionStart"`, `source`, `model`.
- **The child rule, as measured.** Because of the above, the hook cannot use
  `CLAUDE_CODE_CHILD_SESSION`, which would skip every session. It skips a
  Claude that is not in the terminal's foreground process group instead
  (`/proc/<pid>/stat` fields pgrp and tpgid, else `ps -o pgid= -o tpgid=`),
  which is what a Claude started from another one's tool shell is. Measured:
  `HC_TERMINAL_ID=t1d claude -p` from a tty-less shell started a session (its
  transcript appeared) and left t1d's label alone. The same `claude -p` in the
  foreground of a second `oh-test-*` terminal labelled that terminal. When the
  group cannot be read, the hook writes the label, and the plugin's pid check
  still decides. Subagents (`agent_id` non-empty, as herdr checks it) are
  skipped too.
- **Live, end to end.** The installer, run over `hc connect` into a throwaway
  `CLAUDE_CONFIG_DIR` seeded with this machine's real `hooks` section
  (herdr's entry, repowise's, the PreToolUse and PostToolUse ones), added
  exactly one `SessionStart` group, and a second install wrote nothing.
  `claude` in the terminal then gave `hc get`:
  `obsidian-herdr.session={"v":1,"session":"3dd92716-…","pid":2467640,"transcript":"…/3dd92716-….jsonl"}`,
  with pid equal to `foreground.pid`. `hc send … /clear` rotated it to
  `f540889b-…` with the same pid. Remove left the settings byte-identical to
  the pre-install copy, which was already in standard formatting, and
  deleted the script.
- **The script** is POSIX `sh` plus `awk`: no python3 or jq. It reads the
  input with a small JSON reader, not regexes over the raw text: top-level
  string fields only, `\"` `\\` `\/` decoded, nested values skipped whole,
  and a value with a control character or a `\u` escape refused. Claude's
  JSON writes non-ASCII raw, so only control characters would be escaped. It
  was checked with gawk (also `--posix` and `--traditional`) and with
  busybox ash and awk (alpine:3). busybox `ps` has no `tpgid`, but Linux
  reads `/proc` first. It writes through `hc label` (found as `hc`, then
  `herdr-core`, then `~/.local/bin/herdr-core`) and prints nothing: a
  `SessionStart` hook's stdout becomes model context.
- **The entry** is one group, `{"matcher":"^(startup|resume|clear|compact|fork)$","hooks":[{"type":"command","command":"sh <absolute script path>","timeout":10}]}`.
  Run by `sh`, so no exec bit is needed (`file.write` creates 0644). The
  path is absolute, so a cswap session dir works: there `settings.json` is a
  symlink to `~/.claude/settings.json`, but `hooks/` is not shared. cswap
  `execvpe`s Claude, so the pid check holds under it.
- **Install and remove.**
  - Both go over the active herdr-core runtime's own connection, local and
    SSH alike: `machine.exec sh -c 'printf … "$HOME" "${CLAUDE_CONFIG_DIR:-}"'`
    for the paths (the core's environment, the one its terminals inherit),
    and `file.read`/`file.write` for the files. `file.write` swaps atomically,
    keeps the mode and follows a symlinked settings file (measured: a write
    through a symlink kept the link and the target's 0600). Deleting the
    script is `machine.exec rm -f --`, and only while it carries the
    `OBSIDIAN_HERDR_HOOK_VERSION` marker.
  - Ours is any command hook whose command names `obsidian-herdr-session.sh`.
    Install replaces our group where it stands, or appends one, and never
    joins another group. It is idempotent. It creates a missing or blank
    file, and refuses text it cannot parse, a non-object root, a non-object
    `hooks` or a non-list `SessionStart`. Remove takes out only our hooks,
    other hooks in a group shared with ours included, plus a group,
    `SessionStart` list or `hooks` object that this leaves empty.
  - Both rewrite the whole file with `JSON.parse` and `JSON.stringify`, as
    Claude does: the file's indentation, final newline and line endings
    (CRLF) stay, but inline arrays and objects come out expanded and
    integer-like keys move first in their object. Only a file already in
    that formatting comes back byte for byte after install and remove. A
    rewrite that would change a value is refused with the reason, checked
    over the original text (`rewriteIssue`): a number the double cannot
    hold as written (`12345678901234567890` would become
    `12345678901234567000`, `1e400` would become `null`), or a key that
    appears twice in one object. Spellings of the same number (`1.0`,
    `1e2`, `-0`) are not a change.
  - The modal shows the plan built from what it read. Applying reads both
    files again and refuses if either changed. Install writes the script
    before the entry, remove takes out the entry before the script.
  - Status: absent, installed (our exact entry and script), outdated (an
    older marker, a missing or edited script, a different entry), or
    unreadable settings.

## herdr-core: the native view

The hc kind's `NativeSessionAdapter` (ADR-0006), in `src/runtime/herdrCoreKind.ts`:
transcript access is `local` on this machine and `rpc` over SSH, with one
watcher and one transcript source per connection (keyed by its scope), so a
session model never reopens a tail for a source that did not change.

- **The watcher** (`src/hc/sessionWatcher.ts`) reads the scope after it has
  ingested each event: `HcScope.onIngested(address, type)` fires once the
  store holds the event and the rows are reconciled, with a null address
  after a snapshot (subscribe, `missed`, a redial).
  - The session is the `obsidian-herdr.session` label, **accepted only while
    its pid equals `foreground.pid`** (the foreground process group's
    leader). A label that lands before the 2/s foreground poll has seen
    Claude is taken when `foreground` arrives; when Claude exits, is
    suspended or hands the terminal to an editor (Ctrl-G), the pid no longer
    matches and the session clears; `lost` and `finished` clear it too. The
    label's transcript path is the model's path, so nothing is derived from
    the cwd. `onSession` and `onStatus` fire only when the value moved.
  - Status is the row's (herdr.seen over `turn`), except that `error` reads
    as `done`/`idle`: Claude is back at its prompt and there is no dialog to
    name. Block kinds are hc's `permission`, `question`, `auth`; anything
    else, `trust` included, is no kind, so the waiting card never answers an
    hc block by itself.
  - `unavailable(paneId)` is the per-pane gate the contract gained: null for
    an accepted session and for a terminal the core has not reported (not
    connected yet), `no Claude session label; run "Install or remove the
    Claude session hook"` for a terminal whose program is Claude
    (`status.app` or the foreground), `no Claude session in this terminal`
    otherwise. `onAvailability` fires when that answer moved, and the tab
    mounts the surface it can show now; the stored view is kept, as on a
    remote endpoint.
- **The RPC transcript source** (`src/hc/transcriptSource.ts`) reads with
  `file.read {path, offset, limit}` over the runtime's own connection.
  `file.read`'s rules, from hc's `files.rs` and measured live:
  - The core reads the whole file (refusing one over **64 MB** with
    `invalid_params`) and answers lines `offset..`, at most `limit` and at
    most **8 MB as JSON** of them, whole lines only, with `lines` the file's
    count. A trailing line with no newline counts and is sent as it stands.
  - An offset past the end is `invalid_params` ("offset 9: the file has 3
    lines"), not an empty answer, except offset 1 on an empty file; so is a
    single line over the 8 MB.
  - The tail delivers only complete lines and counts them. Each read starts
    at the last delivered line (the anchor), which keeps the offset valid and
    checks the file still says it; line 1 (the head) is compared whenever
    something new came. A shorter count, a different anchor or a different
    head restarts it with `restart: true`. An `invalid_params` is diagnosed
    with a one-line read of line 1: shorter or another head restarts, an
    offset past the count is "nothing new", and a line that exists but
    cannot be sent is skipped and counted. When that one-line read of line 1
    is itself `invalid_params` (the file over 64 MB, or line 1 over 8 MB),
    nothing can be read or told apart: the tail says so through
    `TailOptions.onProblem`, the session model keeps it as `readProblem`, and
    the native view shows it in the empty line, above any turns already read.
    The next successful read clears it.
  - Pages follow `last` to `lines`, 4000 lines at most per read.
  - **Cost, not redesigned:** the core reads the whole file for every
    `file.read`, whatever `offset` and `limit` say. Each poll and each kick is
    at least one whole-file read on the remote host (two when something new
    came and the head is compared, more for a multi-page catch-up), so a
    transcript of tens of megabytes is read in full every 2 s while its agent
    works. Fine for the sizes sessions reach; a cheaper seam (a byte offset,
    a stat) would need hc to offer one.
  - Reads are kicked by `status` and `turn` of the terminal whose label
    names the file (debounced 50 ms, and again 1 s later for what Claude
    writes after reporting) and by every snapshot; a poll runs every 2 s
    while that agent is `working` or never reported, every 15 s otherwise.
  - `read(path)` (a subagent's `outputFile`, `subagents/agent-<id>.jsonl`)
    pages the whole file.
- **Senders** are the kind's `terminal.send` / `terminal.keys` over the tab's
  own runtime's client (`plugin.nativeClient`), as before.
- **On SSH**, `@` mentions use the runtime's remote vault path (the agent opens
  the file on its machine), and relative links map a remote cwd inside the
  remote vault onto this vault.
- **The `/` catalog** is the machine the agent runs on (`native.commandCatalog`,
  `src/hc/commandCatalog.ts`): this machine's files on a local runtime, read
  synchronously as on herdr; over SSH, one `machine.exec {argv: ["sh", "-c",
  <script>, "sh", <cwd>], timeout: 30}` on the runtime's connection. hc has no
  list method, so the script walks the three scopes itself (the cwd up to the
  `.git`, `$CLAUDE_CONFIG_DIR` or `$HOME/.claude`, and every `installPath` in
  its `plugins/installed_plugins.json`) and prints a snapshot: NUL-terminated
  fields, which no path contains, and each Markdown file cut to its
  frontmatter by `awk`. The plugin serves the snapshot as a `CatalogFs` and
  runs the same walk over it as over local files. The script needs `sh`,
  `awk` and `tr`; `realpath` or `readlink -f` only for a symlinked file. The
  catalog is cached per connection and cwd for 5 s, one read in flight per
  cwd; a read that has not answered in 3 s offers what the cwd had before or
  the built-ins, and a failed or cut-short one offers the built-ins for the
  TTL. Without the runtime's connection, the built-ins: never this machine's
  commands.

Measured 2026-11-06 against `hc` 0.1.18 and Claude Code 2.1.318, with the
plugin's own modules driven from a script outside the repo, a throwaway
`CLAUDE_CONFIG_DIR` (credentials copied in, `settings.json` `{"model":
"haiku"}`) and Claude started with the plugin's own launch line in
`oh-test-*` terminals:

- Without the hook, a Claude terminal had no session and the gate gave the
  install command. After installing into the throwaway dir, a new Claude was
  picked up within a second: `pid` equal to `foreground.pid` under the
  launch line's `bash -ic`, transcript under the throwaway config dir.
- A prompt arrived and its turn rendered from the transcript; a prompt sent
  while working was queued (two `queue-operation` lines) and rendered inline.
- `/clear` rotated the label and the model followed with a reset. The new
  session's file starts with Claude's own `/clear` local-command lines, which
  the view shows as a turn, as it does on herdr (since #134 the `/clear` echo
  is read as a reset and opens no turn, in a new file or the same one). `/exit` cleared the session
  and the gate said no Claude; `claude --resume <first id>` in the same
  terminal brought the first session back with its turns.
- Blocks on the wire: a Bash permission prompt reported `{"state":"blocked",
  "kind":"permission"}`; Claude's "Make auto mode your default?" startup
  dialog reported `blocked` with `msg: "dialog open"` and **no kind**, so it
  shows as a block the card only describes. `terminal.keys` `Down Enter` and
  `Escape` answered them.
- hc refuses `terminal.send` to a terminal younger than 10 s whose screen has
  not settled within 5 s (`unavailable`, "still starting: its output has not
  settled"); the prompt box shows that error.
- The RPC source over the local core (connection given explicitly) delivered
  a live transcript line for line in pages of 3, `read` returned it
  byte-identical, a model over it rendered the same turns, and it followed a
  live turn through the status and turn kicks. On a scratch file: a partial
  last line held and then delivered, an idle read past the end delivering
  nothing, truncation and a rename-replace both restarting.

Measured 2026-11-06, the `/` catalog's `machine.exec` over a real `HcClient`
with the remote path forced (read-only, from a script outside the repo):

- Over the local core (bash as `sh`, gawk), the catalog equalled the local walk
  of the same home entry for entry, paths included, from five cwds (a
  worktree, the vault with 19 project entries, `~`, `/`, a repository with
  project skills); 42 of the user skills are symlinked directories. One
  round trip took 77–102 ms.
- Through federation, `on: "asher"` (hc 0.1.17, dash as `sh`, gawk), the
  script exited 0 with nothing on stderr: 87 entries beyond the built-ins
  (37 user, 50 plugin; from `/root` the same 37 are project, since
  `/root/.claude` is both), 68–91 KB of snapshot, in 183–305 ms.
- `tests/hcCommandCatalog.test.ts` runs the script with `sh` over a temp tree
  with spaces, quotes and a newline in names, a dangling link, a link cycle,
  CRLF, NUL and unclosed frontmatter, and a plugin path with `"` in it, and
  checks it against the local walk.
- asher (0.1.17, read only, through the local core's federation with `on`):
  an 11 MB, 951-line transcript paged to the same 951 lines; with a large
  limit hc's 8 MB cap ended the first page at line 609 and the second
  continued at 610.

## Claude run by Obsidian: the `claude` kind

ADR-0007's simple mode: Claude Code processes the plugin starts itself,
over plain child-process pipes, with no multiplexer and no native code. D1
is the headless process and the native view; D2 adds the terminal view and
shell tabs on a pty from `script(1)`, ADR-0007's recorded exception to "not a
PTY", for this kind only (below). Every protocol fact below is from the finding `direct-claude-spike`
(Claude Code 2.1.318, measured 2026-11-06) and was checked again live against
the same build on 2026-11-06 (start, prompt, a Write allowed and denied, an
`AskUserQuestion`, interrupt, stop idle, stop while blocked and mid-turn,
resume, `/clear`, unload).

**The process** (`src/claude/process.ts`, `protocol.ts`). One child per
running agent, spawned without a shell in the agent's cwd:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --permission-mode <runtime's mode> (--session-id <uuid> | --resume <uuid>)
```

The asking mode is passed as `manual`, the choice `claude --help` lists
(`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`); `default`
is not listed. Measured on 2.1.318 (2026-11-06): `manual` is an alias, the
`init` reports `permissionMode:"default"` for it, and Write and Bash block on
`can_use_tool` with the same suggestions as under `default`. Every installed
build back to 2.1.270 lists it. A runtime stored with `default` reads as
`manual`.

A row can pin what its runtime would decide, stored with it: Get started's
"Ask Claude" row (ADR-0008) pins `permissionMode: 'manual'`, passed to every
headless and TUI spawn and to a graduation, and `allowOnceOnly`, which takes
the session and project grants off its cards and refuses those answers, so
no Bash rule for the installer's `curl` and `sh` is ever written to the
vault's `settings.local.json`. Such a row has no terminal view
(`paneTerminalReason`): Claude's own dialog there offers "don't ask again".

The session id is generated by the plugin, so it is known before the first
prompt (`system:init` only comes once a prompt arrives). `--resume` is used
once the session has **started**: the row records `started` at its first
`init` or successful `result`, after which Claude has written the transcript
(also true of the new id after a bare `/clear`, measured 2026-11-06). A
session that never had a turn is started again with `--session-id`, since
there is nothing to resume. A row stored before `started` existed looks for
the transcript where Claude files it: `$CLAUDE_CONFIG_DIR` (else
`~/.claude`) `/projects/<encoded real cwd>/<id>.jsonl`, the cwd's real path
because Claude's cwd, its `init`'s `cwd` and its project folder are all the
symlink-resolved path. If the guess is wrong, Claude refuses at startup,
before it reads stdin (measured on 2.1.318): `--session-id` of a session with
a transcript exits 1 with `Error: Session ID … is already in use.`, and
`--resume` of one without says `No conversation found with session ID: …` on
stderr and in an error `result`, then exits 1. Either refusal starts the
process once more the other way, with the prompts the refused one never read,
and records the answer. The native view reads the transcript at that same
path, with the cwd `init` reports once it has come. The
environment is the plugin's, with the binary's folder first on PATH and the
variables a parent Claude or herdr pane sets for its children removed
(`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `HERDR_PANE_ID` and the like); user
configuration (`CLAUDE_CODE_USE_BEDROCK`, …) is kept. Every stdin line goes
through `encodeLine`: one `JSON.stringify`d object and a newline, nothing
else, because one malformed line kills the process. stdout is split into
lines with no size limit and parsed; unknown types are dropped and nothing is
logged, so the `initialize` response (never requested anyway), which would
carry the account email, cannot be either. stderr is kept as a 2 KB tail for
the one line an unexpected exit is reported with.

**Stop order**, for Stop agent, graduation, removing the runtime and unload:
every pending `can_use_tool` is denied, an `interrupt` control request goes
out while a turn runs and the stop waits up to 1.5 s for its `result`, stdin
is closed and the stop waits 2 s for the exit, then SIGTERM and 5 s, then
SIGKILL. Measured live: an idle stop takes about 0.8 s, a stop while blocked
or mid-turn about 0.9–1 s, and the partial text and the interrupt marker are
in the transcript. A runtime switch retires only the connection; the
processes belong to the kind's table, not to it.

**The agent table** (`src/claude/agents.ts`), one per plugin lifetime,
per runtime: the stored row (`claudeSessions[runtimeId]` in `data.json`: a
stable `cl-…` row id that tabs and pins key on, the session id, cwd, name and
whether the session has `started`)
and, while it runs, its process. Status is the stream's:

| Row | When |
|---|---|
| working | a prompt was written and Claude has not answered it: every prompt goes with its own `uuid`, and is answered by a `result` naming it in `user_message_uuids` (one `result` names a prompt and the queued one absorbed into its turn, "Queued prompts" below) or by its `command_lifecycle` ending (`completed`, `cancelled`, `discarded`, `refused`; a cancelled queued prompt gets no `result`); a `result` that names nothing answers the oldest (#158) |
| blocked | a `can_use_tool` request waits; kind `question` for `AskUserQuestion`, `permission` for the rest; never `trust` |
| done | the last turn's `result` came, until a native view of it is looked at or it is prompted; a turn that ends while a view is being looked at (its window focused and visible, the view drawn) is seen at once, counted per viewer as herdr-core's `herdr.seen` is |
| idle | the process runs and nothing is pending |
| stopped | no process: `idle` with `PaneState.stopped`, which the row shows as **Stopped** |

`/clear` rotates the session in the same process (`conversation_reset`'s
`new_conversation_id` is not the session); the next `system:init`'s
`session_id` is stored at once and pushed to the watcher. `result` errors are
keyed on `is_error` with `terminal_reason`, never on `subtype`, and shown as a
notice; an interrupt's own `aborted_*` result is not. A control request of a
subtype nothing declared is answered with the CLI's own error shape, and
`control_cancel_request` withdraws a pending one (its card closes). Once a
stop has begun, its denials are already on their way, so the pending request
is shown with `PendingRequest.stopping` (the card says the agent is stopping
and disables its buttons) and an answer is refused with "the agent is
stopping"; before, `alive` still held and the answer was written after the
denial (measured live).

**The connection** has no transport. Discovery finds `claude` like the other
binaries (override, the usual directories, extra PATH, the login shell's
PATH); the client answers `ping` at once and its one `connected` edge primes
the scope (`src/claude/scope.ts`) from the stored rows. The client's
`request` takes three methods for the native view: `agent.prompt`,
`agent.interrupt` and `agent.respond`. Its tab labels are empty; there are no
tabs.

**The native view.** The transcript stays the content (ADR-0003), from this
machine's files, path derived from cwd and session. Measured 2026-11-06: a
prompt sent over stream-json is written as a `queue-operation` enqueue, a
dequeue, then its `user` line with `promptSource: "sdk"` and `entrypoint:
"sdk-cli"`, where a prompt typed in a terminal has no enqueue. The parser
takes such a line for a prompt (`sentByHuman`, with the TUI's `typed` and
`queued` lines, #157); an enqueued line that names no human source, or any
task notification, is still injected content. A prompt written while a turn
runs and taken in mid-turn is a `queued_command` attachment with no
`origin`, `commandMode: "prompt"` and `entrypoint: "sdk-cli"` (measured
2026-11-06, 2.1.318), which the parser shows as a steer. The watcher
(`src/claude/sessionWatcher.ts`) reports session, status, block kind and,
new in the contract, `PaneSnapshot.request`: the pending request as a
kind-neutral `PendingRequest` (`src/native/pendingRequest.ts`). The session
model carries it, the waiting card is built from it (`requestCard`), and the
surface answers it through the kind's optional `responder` with a
`WaitingAnswer`, which the kind turns into the `control_response`:

| Answer | `response` |
|---|---|
| Allow, Approve plan | `{behavior:"allow", updatedInput:<input as sent>}` |
| Allow for this session | the same plus `updatedPermissions`: the suggestions with `destination:"session"` |
| Always allow in this project | the same plus the `destination:"localSettings"` suggestions, which Claude writes to `<root>/.claude/settings.local.json` (below) |
| Deny, Dismiss, Reject | `{behavior:"deny", message}`, a reject carrying the feedback |
| A question's answers | `{behavior:"allow", updatedInput:{...input, answers:{<question>:<label>}}}` |

`updatedInput` is never altered beyond the answers (the model is not told of
a change), `userSettings` and `projectSettings` suggestions are never sent,
and no request times out. The prompt sender has an optional `interrupt`, and
the prompt box shows **Stop** for a sender that has one. On Windows the kind's
`terminalUnavailable` is set ("not available on Windows, which has no
script(1)"), and `PaneWhere.terminalReason` makes a tab there show the native
view whatever its stored view or the default says; elsewhere both are null.

**Where a project rule is written** (`src/claude/projectRoot.ts`). Claude Code
canonicalises `localSettings` to the repository, so the file is
`<root>/.claude/settings.local.json`, and the card names that file and its
reach. Read from the 2.1.318 bundle and measured with real Claude on haiku
under `/tmp/oh-d1f-*` on 2026-11-06:

| Agent's cwd | File written (measured) |
|---|---|
| a subfolder of a git repository | the git root's (`/tmp/x/sub` wrote `/tmp/x/.claude/…`) |
| a linked worktree | the main checkout's: a rule granted in the main repository needed no prompt in the worktree, and a new one landed in the main repository's file |
| a repository nested in another | the innermost repository's |
| outside git | the cwd's own |
| a symlink to a folder | the real folder's (Claude's cwd, the init's `cwd` and the transcript folder are all the real path) |
| a subfolder of a git repository whose root is the home directory | the cwd's own |

From the bundle, not measured: the root is used only on a platform with uids,
and only when the root, its `.git` and its `.claude` (when present) belong to
the current user; otherwise the cwd's file. A `.git` file with no `commondir`
(a submodule) keeps its own folder. `projectSettings` (`settings.json`) stays
in the cwd. The plugin resolves this once per process start and returns no
file, and so offers no button, for a `.git` that is a link or a worktree of a
bare repository, which Claude reads with checks not mirrored here.

**Row actions.** `capabilities.resumable` turns close into **Stop agent**
(the row stays), adds **Forget agent** for a stopped row, and graduation:
**Continue in herdr / herdr-core** for every local runtime of those kinds,
offered only for a row whose session has `started` (`PaneState.started`),
since `claude --resume` of a session with no transcript says "No conversation
found". Graduation stops the process, switches to the target, waits for its
scope to resolve, and calls that runtime's own `startAgentHere(cwd, {kind:
'claude', args: ['--permission-mode', <runtime's mode>, '--resume',
<session>]})` (`graduationArgs`), so the pane keeps the mode the row ran in
rather than the user's own default: `agent.start`'s `args` on herdr, the
launch line on herdr-core (plain words only, since it is a single-quoted
shell line; every mode is one).
The row is forgotten once the agent runs there, so one conversation is never
resumed in two places. Until then the row is held (`ClaudeAgents.release`):
nothing in this plugin starts its session, and the target starts only once
the process here has exited; when the move fails the row is given back
(`reclaim`), stopped. SSH runtimes are not offered: the transcript is this
machine's.

**The terminal view** (D2; `src/claude/pty.ts`, `sharedPty.ts`,
`terminalSession.ts`, `viewSwitch.ts`). Measured on this machine (Linux,
util-linux `script` 2.42.4, Claude Code 2.1.318, haiku) on 2026-11-06, with
the plugin's own code driving real processes and `@xterm/headless` as the
renderer:

- **Spawn.** `/bin/sh -c WATCHDOG oh-pty script -qfec <line> /dev/null`, four
  pipes, its own process group. The watchdog runs `script` in the
  foreground without fd 3, and a subshell `cat`s fd 3, which the plugin
  never writes, and sends the group SIGTERM at EOF; the shell traps TERM
  with a no-op so it exits only after `script`, with its status. `script`
  itself ignores stdin EOF. `script` must not be an asynchronous list: in a
  non-interactive shell one starts with SIGINT and SIGQUIT ignored, and the
  D2 review measured `SigIgn: 0x6` on the program, where Ctrl-C did
  nothing. Measured after the change (bash as `/bin/sh`): `SigIgn` 0 on
  `script`, on a shell tab's initial command and on what its shell runs,
  and Ctrl-C ended a `sleep` in each. busybox ash as `/bin/sh` (python:3.13-alpine,
  2026-11-06, `--network none`): the shell ignores SIGQUIT in itself, as
  bash does, so a shell's own `/proc/<pid>/status` reads `SigIgn: 0x4`
  (what the final review saw, reading `$$` of an `sh -c`); what it runs
  starts with SIGQUIT at its default (`SigIgn` without bit 3 on the
  watchdog's foreground program). Through a pty below the watchdog (Python's
  `pty.fork` standing in for `script`, which the image lacks), Ctrl-\ ended
  an `exec`'d `sleep` with signal 3 and a `sleep` under a further `sh -c`
  ("Quit (core dumped)"), under ash and under dash alike, and the watchdog
  still reaped on EOF. A `trap - QUIT` changed none of it, so the watchdog
  has none. The line is `stty rows R cols C; SHELL=<user's>; export
  SHELL; exec claude --permission-mode <mode> (--resume|--session-id) <id>`,
  every word single-quoted; `script` gets `SHELL=/bin/sh` so that line is
  parsed by a known shell, and the TUI gets `TERM=xterm-256color`,
  `COLORTERM=truecolor`, no `TERM_PROGRAM`. The permission mode is always
  passed: without it the TUI comes up in the user's own default.
- **The TUI** draws in the alternate screen (`CSI ? 1049 h`), sends the OSC
  7501 probe `ESC ] 7501 ; ? ST` within a second, and asks `CSI ? u` (kitty
  keyboard) and `CSI c` (DA1). It also works with nobody answering those.
  Once the plugin answers the probe (as herdr-core does), Claude reports
  `state=idle` at start, `working` and `done` around a turn, and `clear`
  three times on exit; that is the row's status in TUI mode
  (`programStatus.ts`), and a `working` marks the session started. Before
  its first report, and for good on a Claude older than 2.1.295, the row is
  `unknown`, never idle: a switch to the headless process (a tab switched
  to native, a native prompt) then asks the user before it stops the TUI,
  unless no key was ever typed into it, since only typing starts a turn
  there. A blocked
  TUI is answered in the terminal: there is no `can_use_tool` in TUI mode,
  and the card offers "Open in terminal". An unprompted TUI writes no
  transcript, so a later `--session-id` of the same id still works. Its
  startup refusals are the stream's words on the pty, coloured, exit 1:
  `Error: Session ID … is already in use.` and `No conversation found with
  session ID: …`; the same fallback applies.
- **Resize** from outside: the slave is `/proc/<script's child>/fd/0`
  (`/dev/pts/97`), and `stty -F <slave> rows 40 cols 132` gave SIGWINCH: the
  TUI redrew the whole screen (a `CSI 2 J`) at 132 columns, and `stty -F …
  size` read `40 132`. A same-size `stty` sends no SIGWINCH, so a forced
  repaint passes through one row less first. Resizes wait for the first
  output byte, so the line's own `stty` cannot undo them.
- **Stop**: SIGTERM to the TUI ended it in 0.79 s (exit 143, a `state=clear`),
  measured again as 0.76 s for Stop and 0.79 s for unload with a TUI and a
  shell running; then fd 3 closed (`script` prints "Session terminated,
  killing shell...", gives its child 2 s, kills it: 2.0 s); then SIGKILL to
  the group. A shell gets SIGHUP first, since an interactive shell ignores
  SIGTERM. After Stop, unload, or the shell's last tab closing, `ps` showed
  no watchdog, `script`, `claude` or shell left.
- **Plugin killed**: with a TUI and a shell running, SIGKILL of the plugin's
  process left nothing 1 s later: the TUI, `script`, both watchdogs and
  `cat`s, the shell's `bash` and Claude's MCP server child were all gone.
  `setpriv --pdeathsig` is not used: Linux only.
- **One process per agent** (`viewSwitch.ts`). A terminal that attaches asks
  for the TUI, a tab switched to native or a native prompt for the headless
  process; the switch happens only between turns, and waits otherwise (the
  tab says why). Measured: headless to TUI 0.86 s to the TUI's spawn and
  3.2–3.4 s to its first full paint with `--resume` (Claude's own startup);
  TUI to headless 0.80 s. A native turn, then a TUI turn, then a native
  question about both answered "HERON PELICAN": the conversation carried
  across both switches. A switch keeps the target it started with: a native
  prompt that set it off is written to the headless process it starts, and
  `agent.prompt` settles only then (or rejects when a stop overtook it); a
  tab that attaches meanwhile waits, then follows whatever runs.
- **Stops hold the row** (the D2 review). Stop, Forget, graduation, a
  removed runtime and unload mark the row before the process is told to
  end, and nothing that comes during the stop (a tab attaching, a turn
  ending, the runtime connecting) starts it: before this, a tab opened
  during Forget left an untracked TUI running past unload, and one opened
  during graduation ran a second Claude on the session. Unload also stops
  every process and shell the kind started, in a row or not. Only an
  explicit act lifts a Stop's hold: a prompt, Resume, opening a tab, or a
  Reconnect click. A tab hidden past its grace period has given its session
  up, so Stop's close never reached it; shown again, its start carries
  `revealed` (`TerminalSessionOptions`), and the agent table answers it with
  "the agent stopped; reconnect to resume it here" instead of starting the
  TUI. A reveal onto a TUI that still runs attaches as before.
- **Reattach.** The TUI belongs to the agent, not to the tab. A tab's session
  only attaches and detaches; a reopened tab got the same TUI pid and
  repainted from a replay of the raw output (`replay.ts`): at most 1 MiB, cut
  at a line end, with the DEC modes and kitty keyboard flags in effect where
  the kept bytes start put back first, and a SIGWINCH when anything was
  dropped. Claude's output for a few turns was under 5 KB. Several tabs can
  show one TUI; the last controller to resize or type owns the grid, the
  others get `grid`, and one tab answers the program's queries. A replay
  leaves out every query a renderer answers by itself (device attributes,
  cursor and status reports, mode requests, colour queries, the 7501
  probe): measured before that, a reopened shell tab's xterm answered the
  old DA1, DA2 and cursor queries, and `1;2c0;276;0c1R` landed on the
  shell's command line. Live queries are answered as before, by one tab.
- **Not seen in TUI mode:** a `/clear` typed there (no stream, no `init`):
  the row keeps the session from before it.
- **macOS**: written, not verified, so **off** (`ptyPlatformOf('darwin')`
  is null and the kind says `CLAUDE_TERMINAL_UNVERIFIED`) until it is: BSD
  `script -q /dev/null /bin/sh -c <line>`, the slave from
  `ps -A -o pid=,ppid=,tty=,comm=` (`ttys004` → `/dev/ttys004`), `stty -f`.
  A host can pass `ptyPlatform: 'darwin'` to `createClaudeKind` to run it
  for that verification. **Windows**: no terminal view, no shells.

**Shell tabs** (`src/claude/shells.ts`, ADR-0008). A pane id `sh-…` that no
scope lists: a plain `$SHELL` (else `/bin/sh`) on the same pty, started when
its first tab attaches. An initial command runs first through `/bin/sh -c`,
printed in bold before it runs, while the line's shell traps SIGINT and
SIGQUIT, so Ctrl-C ends the command and not the tab; then the shell starts. It survives a hidden
or closed tab, and ends a second after its last tab is gone, also when its
runtime was removed while the tab was open
(`HerdrPlugin.terminalTabReleased`, deferred so a tab moved to another
window keeps it). Measured: `echo hi` ran and printed `hi`, and a typed
`echo typed-$((40+2))` printed `typed-42`. Shells are not stored.

## The settings tab

The tab itself is an assembler. Its section builders — runtimes, connection,
notifications, agents, file explorer, agent list, terminal, native view — are plain functions
over a container, the settings object and a bundle of callbacks, listed in
`SETTINGS_SECTIONS` in `src/settings.ts`; none of them ever sees the plugin. The
callbacks bundle is the whole of what a control may do besides write into the
settings: save, save and reconnect, redisplay, refresh the agent list or the
folder hover buttons, hand one changed setting to the open terminals, or switch,
open and remove runtimes, or check and review the active herdr-core runtime's
Claude session hook. Which runtime's form is open is the tab's state, handed
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
  already in flight. Only `blocked` rejects, with `agent_blocked`. (On
  2.1.318 a queued prompt that finds no further tool boundary runs as a turn
  of its own instead: "Queued prompts" below.)
- **`agent_session` appears after the first prompt, not at startup.** A freshly
  started Claude sits `idle` with no `agent_session` field until the first
  turn begins; the transcript file is created at that moment. (herdr 0.9.5
  reports it at `agent start` already; "Model, effort, permission mode and
  context" below.)
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
  (Since measured, 2026-11-06, 2.1.286 and 2.1.318: `compact_boundary` has
  `parentUuid: null` and names the record it continues in
  `logicalParentUuid`; the summary after it is a string `user` line with
  `isCompactSummary: true`. `informational` carries the runtime's notices —
  "Unknown command: …", "Usage limit reached · …", "Compacted while idle …".)
- **Not every string-content `user` line is a human prompt.** A background
  subagent's completion arrives as a `queue-operation` enqueue followed by a
  `user` line whose string content is a `<task-notification>` block, with
  `isMeta` unset. The human steer above, by contrast, never became a `user`
  line at all. A human prompt is therefore recognised by the
  `queued_command` attachment with `origin.kind: "human"`, or by being a
  string `user` line that is not preceded by a queue enqueue of the same
  content, not by `isMeta` alone. (Since 2.1.263 a human's line says so
  itself, `origin.kind: "human"` and a `promptSource`, and that wins over a
  pending enqueue: see "Queued prompts", #157.) The launch `tool_result` of an async
  `Agent` call holds only a "launched" notice; the report lives in the
  notification's `<output-file>` under `/tmp/claude-<uid>/…/tasks/` and in
  `<session>/subagents/agent-<id>.jsonl`. A synchronous `Agent` call puts the
  report straight into its `tool_result`. Measured 2026-09-15: all 137 async
  agent output files still on this machine are symlinks to that same
  `subagents/agent-<id>.jsonl`, so the output file is a JSONL transcript and
  its report is the last assistant text, not plain text. A background shell
  task's output file, by contrast, is a plain file holding its stdout.
- **A notification comes in any of three records, and sometimes only one**
  (measured 2026-11-06 over every transcript on this machine, 2.1.263 to
  2.1.318): its queue enqueue always; then a `user` line, or a
  `queued_command` attachment with `commandMode: "task-notification"` when it
  is taken in mid-turn (526 of 1,171), or nothing more at all (238, enqueue
  and `remove` only). Its `<summary>` says whose it is: `Agent "…" finished`
  for a subagent (also on a `SendMessage` call that resumed one), `Background
  command "…" completed (exit code 0)` / `failed with exit code N` / `was
  stopped …` for a shell command, `Monitor …` for a monitor. A background
  command's launch result opens `Command running in background with ID:`.
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
  dangling `tool_use` lines written before their dialog (`ExitPlanMode` no
  longer is on 2.1.286, next item). So a `blocked` agent
  with no dangling call, past startup, is showing a question, and the
  question's text and options are only on screen (`pane.read`). The dialog
  takes keys: a digit selects an answer (toggles one, on a multi-select), and
  on a dialog with more than one question `right` then `1` submits; a
  one-question single-select dialog submits on the digit. Details and the
  probe in the docs root, `findings/native-view-session-chrome.md` and
  `findings/native-view-control-channels.md`. On 2.1.318 the question is
  dangling again ("Answering Claude's dialogs from the screen" below), and the digits-in-one-call reading
  does not hold on herdr.
- **Plan approval and the plan file (issue #148).** Read 2026-11-06 from
  this machine's transcripts. On Claude Code 2.1.286 `ExitPlanMode` is no
  longer dangling: in session `363fde6f` the call (timestamped at the
  dialog) is written after the `queue-operation` lines of the wait, together
  with its `tool_result`, so the transcript at the block ends on the landed
  `Write` of the plan file. The 2.1.266 probe (`/tmp/herdr-perm-FJK7`) still
  wrote it dangling. So a blocked agent with no dangling call may be at a
  question or at plan approval. What the transcript does give:
  - **The slug.** Once Claude names one, every message and attachment line
    carries a top-level `"slug"` (lowercase words and hyphens, e.g.
    `wondrous-roaming-charm`; one began with words from the prompt,
    `use-the-askuserquestion-tool-cozy-liskov`). 30 local transcripts have
    one, most of them sessions that never planned, so a slug is not plan
    mode. Each held a single slug; a slug change is handled by taking the
    last.
  - **The plan file** is `<config dir>/plans/<slug>.md`, written with
    `Write` before the dialog. The plan-mode reminder names it ("create your
    plan at /home/lasse/.claude/plans/wondrous-roaming-charm.md"), and the
    `plan_mode` and `plan_mode_exit` attachments carry it as `planFilePath`
    with `planExists`. Only the two plans of this machine's `~/.claude/plans`
    exist, both matching their session's slug. Claude's `plansDirectory`
    setting, unset here, would move it; that is not followed.
  - **Plan mode.** The `plan_mode` attachment on entering (after an
    `EnterPlanMode` call, or after a prompt sent in plan mode, whose user
    line carries `"permissionMode":"plan"`), `plan_mode_exit` on leaving
    after approval, and the `permission-mode` lines Claude writes at each
    flush with the mode then. A rejected plan leaves the mode at `plan`.

  The session model (`src/agents/claude/planFile.ts`) follows the last slug and the
  last word on the mode from the lines it reads, and while the pane is
  `blocked` in plan mode, on no runtime request and no kind other than
  `permission`, reads the plan file three levels above the transcript
  (`CLAUDE_CONFIG_DIR` included, #132) through the transcript's own source:
  a slug of any other shape is never read. The card shows it as Markdown
  when no call dangles. herdr names no block kind, so a question asked in
  plan mode after a plan was written shows that plan; the card says to
  answer in the terminal either way. herdr over SSH has no transcript source
  and reads nothing; herdr-core over SSH reads the file with `file.read` on
  its own machine, as it reads the transcript.

## Images in prompts

Measured 2026-11-06 (#144) against herdr 0.9.5, hc 0.1.18 and Claude Code
2.1.318, in `oh-test-*` panes in a `/tmp` folder with 64x64 one-colour PNGs
and one-word prompts, checked against Claude's answers and the transcript.

- **A terminal Claude attaches an image when a bracketed paste is exactly
  paths to image files.** `ESC[200~/tmp/x/blue.png ESC[201~` became
  `[Image #1]` in the input within a second. Two paths separated by a space
  in one paste became two images; a path with a space in it attached when
  the space was escaped with a backslash (`/tmp/x/sp\ ace/x.png`), the way a
  terminal writes a dropped file. A paste of a path followed by words stayed
  text.
- **A path in an ordinary prompt is not an attachment.** `herdr agent prompt`
  with "… this image: /tmp/x/red.png" was typed as text; Claude read the file
  with its `Read` tool and the image arrived as a `tool_result`, not in the
  prompt.
- **The text after the paste lands in the same input, and its Enter sends
  both as one prompt.** herdr: `pane.send_text` with the paste, then
  `agent.prompt` with the text, back to back with no wait (the second call
  took about 400 ms). `agent.prompt` with empty text is refused
  (`empty_agent_prompt`, "agent prompt must not be empty"); a picture alone is
  sent with `agent.send_keys ["Enter"]`. While Claude worked, the same pair
  was queued: the enqueue's `content` is the text block as written
  (`[Image #5]Queued: …`), and the steer arrives as a `queued_command`
  attachment whose `prompt` is an array of blocks, the image among them.
- **Claude reads the file when the paste lands.** A file removed right after
  `agent.prompt` returned was in the transcript all the same. The plugin
  writes herdr's images to `<tmpdir>/gjetr-images/` (mode 0600) and
  removes them a minute after the send. Only a local herdr shows the native
  view, so that folder is the agent's machine.
- **herdr-core has no raw-input method, and `terminal.send` cannot carry the
  paste**: it presses the submit key itself and strips an embedded
  `ESC[201~` (finding `herdr-core-api`). What worked: `terminal.put
  {terminal, name, data}` writes the image beside the terminal on its own
  machine and answers `{path, bytes}`
  (`~/.local/state/herdr-core/default/files/<terminal>/<name>`, removed with
  the terminal by `terminal.rm`); one `terminal.attach {cols, rows, history:
  0, resumed: true}` at the terminal's own grid, an AUTOMATIC_INPUT frame
  with the bracketed paste of the paths, CLOSE; then `terminal.send {text}`.
  Back to back with no waits the images still attached, though Claude placed
  their `[Image #N]` after the text (it resolves a paste asynchronously).
  `terminal.send` with empty text pastes nothing and presses Enter, which sent
  the picture alone. A core whose `hello` lacks `automatic_input` (0.1.17)
  gets the paste as DATA, which counts as a person typing, so hc holds the
  following `terminal.send` for its 3 s quiet period; not measured there, and
  whether 0.1.17 has `terminal.put` is not known (the plugin asks `hello`'s
  `methods` and says why not when it is missing).
- **`claude -p` in stream-json takes image content blocks** in the user
  message, `[{type: "text", text}, {type: "image", source: {type: "base64",
  media_type, data}}]`; the answer named the colour.
- **What the transcript holds.** The prompt is a `user` line of blocks: the
  text (with the `[Image #N]` stand-ins where the TUI showed them; none for
  stream-json), then one `image` block each, base64 with `media_type`. The
  next line is an `isMeta` `user` line of `[Image: source: <path>]` text
  blocks, one per image (stream-json: a path under
  `/tmp/claude-<uid>/<project>/<session>/images/`). The reducer drops the
  stand-ins from the prompt it shows, and an image entry records only the
  line's uuid and the image's index there; the view reads the bytes from the
  file when the thumbnail comes into view (`transcriptImage`).

## Queued prompts

Measured 2026-11-06 (#150) against herdr 0.9.5, hc 0.1.18 and Claude Code
2.1.318 on haiku: a TUI Claude in an `oh-test-*` herdr tab and hc terminal
(cwd under `/tmp`), and `claude -p` in stream-json, each running a long
foreground Bash call while prompts were sent behind it. Details and the
probes are in the docs root, `findings/queued-prompts.md`.

- **herdr and herdr-core have no queue.** A prompt sent while Claude works
  (`agent.prompt`, `terminal.send`) is typed into the TUI at once, and from
  then on it is Claude's. Neither has a method to list, cancel or reorder
  input. herdr's `agent.prompt` has no idle guard; hc's `terminal.send` takes
  `if: "idle"`, which refuses a working terminal with `status_mismatch` and
  types nothing.
- **The TUI shows what it has queued.** Each queued prompt is a `❯ <text>`
  row above the spinner, followed by `ctrl+enter to send now`; the empty
  input reads `Press up to edit queued messages`.
- **Up takes every queued prompt back into the input**, joined by newlines,
  and the transcript writes one `queue-operation` `popAll` per prompt with
  its content. There is no way to take back one. Enter queues the input again
  as a single prompt.
- **Clearing the input is no discard while Claude works.** Esc, and Ctrl+C,
  interrupt the turn even with text in the input; `Esc Esc` in one
  `send-keys` call clears the input only at idle (and on an empty input opens
  the rewind menu); two separate `esc` calls are not a double Esc. `ctrl+u`
  deletes to the start of the current line only.
- **Esc does not take a queued prompt back.** It interrupts the turn, and the
  queued prompt runs next as a turn of its own.
- **Ctrl+Enter sends the queue in now**, through `agent.send_keys
  ["ctrl+enter"]` and `terminal.keys ["ctrl+enter"]` alike. It does not
  interrupt: a running foreground Bash call was moved to the background (its
  `tool_result`: "Command was moved to the background … so that a message
  that arrived while it was running can reach you; it was not interrupted")
  and the prompt taken in at once.
- **Where a queued prompt goes.** Taken in at the next tool boundary: a
  `remove` with `reason: "absorbed_mid_turn"` and a `queued_command`
  attachment, the steer. When the turn ends with no further tool call (a
  tool-less answer, an interrupt) it runs as a turn of its own: `enqueue`,
  `dequeue` (no content), then a string `user` line with `promptSource:
  "queued"` and `origin.kind: "human"`, and no attachment. Over all
  transcripts on this machine (2.1.263–2.1.318): 331 such lines; `remove`
  reasons `absorbed_mid_turn` (996), `delivered_to_agent` (26),
  `agent_stopped` (1); `popAll` 9. A prompt typed at an idle TUI has
  `promptSource: "typed"`, a stream-json one `"sdk"`. Until #157 the
  parser dropped the `"queued"` line, because its enqueue was pending, and
  kept the enqueues of a `popAll`, so the same words typed later were
  dropped too. Now a line that says a human sent it (`origin.kind: "human"`,
  or `promptSource` `typed`, `queued`, `sdk`) is a prompt and spends its
  enqueue whatever is pending; `remove` and `popAll` spend the entry they
  name; and dequeues, which name none, spend the pending entries once they
  are as many as the entries (a `dequeue` is not always the oldest entry: 47
  of 1,434 on this machine took another). Over every transcript here this
  shows 329 more prompts and loses none (three turns that had
  no prompt now show theirs), and a line-by-line read agrees with
  a whole-file one. Fixtures: `queued-own-turn`, `queue-pull-back`,
  `queue-cancel` under `tests/fixtures/transcripts/`.
- **Stream-json addresses queued messages by uuid.** `system:init` lists
  `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`,
  `interrupt_send_now_v1`, `interrupt_requeue_taken_v1` and
  `msg_lifecycle_v1`. A user line carrying `uuid` gets `command_lifecycle`
  lines with `command_uuid` and `state` `queued`, `started`, `completed` or
  `cancelled`; a `result` names what it answers in `user_message_uuids`.
  The CLI's schema (2.1.318) adds the terminal states `discarded` and
  `refused`, gives exactly one terminal state per message, and sends the
  stopped turn's `cancelled` lines after its `result`. The `claude` kind
  sends every prompt with a uuid and follows these (#158).
  - A message absorbed into the running turn shares its `result`: prompts A
    and B gave one `result` with `user_message_uuids: [A, B]`, so results
    are not one per message.
  - `control_request {subtype: "cancel_async_message", message_uuid}`
    answered `{cancelled: true}` and a `cancelled` lifecycle, and the message
    never ran; asked again, `{cancelled: false}`. The transcript records the
    cancel as a bare `dequeue`.
  - `control_request {subtype: "interrupt", send_now: true, message_uuid}`
    answered `{still_queued: [B], send_now: "stopped"}`: the running turn was
    aborted (`aborted_tools`, the Bash call killed) and B started as its own
    turn.
  - A plain `interrupt` answered `{still_queued: [B]}`, and B ran next.
  - Edit has no operation: cancel, then write the new text, which joins the
    back. User lines also take `priority: 'now' | 'next' | 'later'` (SDK
    0.3.318 types; not measured).

So Edit and Discard of a prompt already handed over exist only on the
`claude` kind. On herdr and herdr-core a queue the user can act on has to be
held by the plugin, sent when the agent leaves `working`, with Send now as
the one act that hands a prompt over during a turn.

## Answering Claude's dialogs from the screen

Measured 2026-11-06 for issue #151 against Claude Code 2.1.318, herdr 0.9.5
and hc 0.1.18, in `oh-test-*` panes running `claude --permission-mode default`
in `/tmp` folders. The measurements, key by key, are the finding
`answering-on-screen` in the docs root; the proposed design is ADR-0009. The
screens are recorded in `tests/fixtures/screens/claude-2.1.318/` with an
index. Nothing in the plugin answers these dialogs yet except the trust
prompt; these are the facts a build may rely on.

- **What is in the transcript while a dialog is up.** `AskUserQuestion`:
  a dangling `tool_use` with the full `input.questions` (checked while the
  dialog was up; 2.1.281 wrote it only when answered). Bash and Write
  permissions: dangling, as before. `ExitPlanMode`: not written until
  answered, then call and result together (as on 2.1.286). Trust: no
  transcript. So on 2.1.318 a blocked pane with no dangling call past
  startup is plan approval or an unknown dialog, never a question.
- **What hc reports.** Claude's OSC 7501 status carries the request in
  `msg`: question `kind: question`, `msg: "answer: <question> (A · B · C)"`;
  Bash `kind: permission`, `msg: "approve Bash: <command>"`; plan approval
  `kind: permission`, `msg: "approve plan"`. At the trust prompt the status is
  `null`: Claude reports nothing before trust, so hc never says `trust`.
- **Reading the screen.** herdr `pane.read {source: visible, format: text}`
  and hc `terminal.read {lines: 0}` both show the dialog with its cursor
  (`❯`) and ticks (`[✔]`, `☒` in the tab bar) as text; colour is not needed.
  herdr's `revision` in the read result did not change while a text row was
  typed into, so it is not a screen version; hc's read has none. A
  dialog's identity is its content.
- **Telling the dialogs apart.** Question: hint `Enter to select · ↑/↓ to
  navigate` (`Tab/Arrow keys to navigate` with several questions), rows
  `N. label` with the description on the next line, then `Type something.`
  and, under a rule, `Chat about this`; multi-select adds a tab bar
  `←  ☐ header  ✔ Submit  →`, `[ ]` boxes and an unnumbered `Submit` row.
  Review: `Review your answers`, ` ● question` / `   → answer`, `1. Submit
  answers`. Permission: `Do you want to proceed?` (Bash) or `Do you want to
  create <file>?` (Write), hint `Esc to cancel · Tab to amend`. Plan:
  `Ready to code?`, `Would you like to proceed?`, the hint ending in
  `~/.claude/plans/<slug>.md`. Trust: `Accessing workspace:`, the folder,
  `No, exit` / `Yes, I trust this folder`, hint `Enter to confirm`.
- **Option 2 of a permission is not one thing.** Bash `python3 …`: "Yes, and
  don’t ask again for: python3 *", which wrote `Bash(python3 *)` to the
  folder's `.claude/settings.local.json`. Bash `touch one.txt`: "Yes, and
  always allow access to <folder> from this project", which wrote no settings
  file. Write: "Yes, and switch to accept edits … for this session
  (shift+tab)". Option 3 on Bash switches to auto mode.
- **Keys.** Single-choice question: a digit, or `down`s and `enter`, answers
  at once. Multi-select: `enter` toggles the row under the cursor and leaves
  the cursor; `right`, or `down` `enter` on `Submit`, opens the review, where
  `enter` submits. Several questions: a digit per tab, then the review. Own
  answer: move to `Type something.`, type, `enter` (single) or `down` `enter`
  (multi; typing ticks the row). Permission: digit, or move and `enter`; deny
  with `esc`; deny with feedback is `No`, `tab` (the row becomes "No, and tell
  Claude what to do differently"), text, `enter`. Plan: `2` approves with
  manual edits, `1` with auto mode; row 3, text, `enter` rejects with
  feedback and Claude replans; row 3, text, `shift+tab` approves **and
  switches the session to auto mode**. Trust: `down` `enter`. `esc` on a
  question or permission writes a rejected `tool_result`.
- **Text goes only onto a text row.** Text sent with the cursor on an option,
  or on the Bash `No` row before `tab`, was ignored; a single digit there
  would answer. herdr `pane.send_text` types exactly. hc `terminal.keys`
  lowercases letters (`A` → `a`; capitals need `shift+a`, space is `space`),
  and `terminal.send --force` pastes and presses Enter after about 5 s, which
  on a multi-select text row unticked it. One AUTOMATIC_INPUT frame on a
  `terminal.attach {cols, rows, history: 0, resumed: true}` at the terminal's
  own grid typed `Mango, Ripe 2` exactly and left the size at 200x120.
  `ctrl+u` empties a text row.
- **herdr merges printable keys in one `agent.send_keys`.** `["1", "3"]` on a
  multi-select toggled nothing, the same digits in two calls toggled both,
  `["4", "Down"]` did both. hc's `terminal.keys` spaces keys 30 ms apart and
  `["1", "3"]` toggled both.
- **Confirmation.** Every answer cleared its dialog from the screen within
  about a second. The next dialog can look the same: after a deny with
  feedback a new Bash permission with the same options came up within
  seconds, differing only in the command. The transcript is the authority: a
  question's `toolUseResult.answers` (multi-select joined with `, `, a typed
  answer containing a comma quoted), a permission's `tool_result`
  (`is_error: true` with the user's words for a denial), the `ExitPlanMode`
  call and result. hc's `terminal.keys` replies at once with the status from
  before the key (`{status: "blocked", turn}`); `msg` names the next request
  1-3 s later, and `turn` advances on every status change.
- **Screen access, as built (#164).** `ScreenAccess` (`src/native/screenAccess.ts`):
  `read`, `press` one key, `type` text; the herdr and herdr-core kinds supply
  it through `RuntimeKindAdapter.screen`, the `claude` kind has none. Keys
  are one spelling for both runtimes: `up down left right tab shift+tab enter
  esc ctrl+u` and the digits 1-9, never a letter. Measured 2026-11-06 (herdr
  0.9.5, hc 0.1.18, `oh-test-screen*` in `/tmp`): herdr takes these
  lowercase names (`pane.send_keys` into `cat -v` gave `^[[B ^[[A ^[[D ^[[C`,
  `^[[Z` for `shift+tab`, `^[` for `esc`; `agent.send_keys ctrl+u` emptied
  Claude's composer); `agent.send_keys` on a pane with no agent detected
  answers `agent_not_found`; `pane.read` answers `{type: "pane_read", read:
  {text, revision, …}}`. hc's `terminal.keys` gave the same bytes for the
  same names. Typing `Mango, Ripe 2 — ✔` through the built code arrived
  exactly on both (herdr `pane.send_text` into Claude's composer; hc the
  resumed attach into `cat -v`), the hc terminal stayed 200x120 and the herdr
  pane's viewport 62 rows. `HcClient.input` refuses, attaching nothing, when
  `terminal.get` gives no `cols`/`rows`: on a core without AUTOMATIC_INPUT
  the bytes go as DATA, which makes the attach the size leader at whatever
  grid it named. Text with a line break or any C0, DEL or C1 character is
  refused before anything is sent. Remote (herdr over SSH, hc on another
  machine) is the same calls over the runtime's own client; not run live.
- **Narrow screens (#163).** Measured 2026-11-06 at 60 and 90 columns
  (herdr 0.9.5 pane held at size by a `terminal session control` client, hc
  0.1.18 terminals started with `terminal.run {size}`; fixtures `*-60-*`,
  `*-90-*`). Every part of every dialog wraps, by words, or mid-word in a
  path (`…/a-ra` / `ther-long-name`, the plan file `~/.claude/pl` /
  `ans/<slug>.md`). Continuation lines sit at the column the row's text
  starts at: question options and typed answers at 5 (single) or 9
  (multi-select, behind the box), **so a wrapped label and the description
  under it share one indent** and only the request can say where one ends;
  permission rows at 6, the amended `No, …` row at 10; plan row 3 at 8,
  where its `shift+tab to approve with this feedback` line also sits. A
  wrapped question, and a wrapped Bash command, get a `│ ` gutter; so does a
  wrapped question on the review, though one at 60 columns wrapped without
  it. The plan hint breaks after `·`, leaving the path on a line of its own.
  `tab` on a permission's `No` shows the placeholder `No, and tell Claude
  what to do differently` and the hint loses `· Tab to amend`; typed words
  replace the placeholder after `No, `. **A torn repaint stays on screen:**
  with a two-line typed answer on the multi-select's own-answer row, moving
  down to `Submit` left `❯    Submitrden` (herdr at 90, hc at 60), the
  answer's last line dropped and its end written after `Submit`; the same
  step at the other two sizes drew cleanly. Reached through `right` instead,
  the review is what states the answer. Write and Edit show the file
  relative to the session's folder (`b.txt` for a `file_path` inside it).
- **The parser, as built (#163).** `parseClaudeScreen`
  (`src/agents/claude/screenDialog.ts`, behind `AgentFormat.screenDialog`)
  reads a screen into `question`, `review`, `permission`, `plan`, `trust`
  or `unknown` (`src/agents/screenDialog.ts`). A dialog is the region under
  a `─` rule down to the last line; rules are tried from the bottom up and
  only a region that is wholly one dialog counts, every line accounted for,
  one cursor, rows numbered from 1. Text is kept per screen line and
  compared with `wrappedEquals`, which allows a run of spaces and one line
  break, or nothing, at each wrap point and nothing else.
- **The answer driver, as built (#165).** `ScreenAnswerer`
  (`src/native/screenAnswer.ts`) takes a runtime's `ScreenAccess` and an
  agent format's reader. Every read is matched against the request
  (`matchScreen`) and, before keys, hc's status `msg` (`statusAgrees`);
  moves go one key per call, then reads every 100 ms until the screen shows
  the intended state (3 s, never repeated); a commit key goes alone after a
  read that showed it; the final key is followed by reads for 1.5 s and the
  transcript's result (`receiptAgrees`). No digit is pressed. Run live
  2026-11-06 through the built code on herdr 0.9.5 and hc 0.1.18
  (`oh-test-ans*` in `/tmp`, Claude Code 2.1.318, haiku), each answered
  and judged against the transcript in 0.3-1.7 s: a single choice (`down`
  `enter`), a multi-select with two ticks and the typed `Mango, Ripe 2`
  through the review, Bash allow once (`enter`), Bash deny with feedback
  (`down`×3 `tab`, the words, `enter`), plan reject with feedback (`down`
  `down`, the words, `enter`; Claude replanned under the same slug), plan
  approve with manual edits (herdr and hc); a Bash request matched against
  another command was refused with nothing sent, on both.
- **The arrows on a question's own-answer row move within the words.** With
  the cursor on the multi-select's text row (typed or not), `right` did not
  change tab on either runtime; `up` to an option row and then `right`
  opened the review, the typed words kept. So the driver leaves the text row
  upwards before `left`/`right`, and never goes down onto `Submit`.
- **The dangling `AskUserQuestion` is not reliably there.** In four of five
  questions asked live (both runtimes), the transcript had no `assistant`
  line with the call while the dialog was up, for over a minute; the call
  and its result were written together on the answer, as on 2.1.281. A Bash
  call was written about half a second after its dialog showed. A card that
  builds a question's request from the transcript has none to offer most of
  the time; hc's `msg` names the question and labels, not headers,
  descriptions or `multiSelect`.
- **What the transcript says after an answer**, as the driver judges it:
  `The user answered: "<question>"="<answer>". …` or `Your questions have
  been answered: …` (both seen on 2.1.318), with `toolUseResult.answers`; a
  typed answer with a comma is quoted inside unescaped,
  `"Which fruits do you like?"="Apple, Cherry, "Mango, Ripe 2""`. A denial
  or rejected plan starts `The user doesn't want to proceed with this tool
  use.` and carries `the user said:\n<words>`; an approved plan starts
  `User has approved your plan`.
- **After a plan is approved, a titled rule sits under the next dialog.** The
  Write permission that followed showed, below its hint line, a rule ending
  in the plan's name (`──── create-d-txt-file ─`), on herdr and on hc. The
  parser reads such a screen as `unknown`, so the driver refuses there; the
  parser does not know this line yet.

## Model, effort, permission mode and context

Measured 2026-11-06 for issues #110 and #111 against Claude Code 2.1.318,
herdr 0.9.5 and hc 0.1.18, in `oh-test-*` panes and `claude -p` stream-json
processes under `/tmp`. The finding `native-view-session-settings` in the
docs root has the measurements; `native-view-header` the context and
placement. Claude's agent format reads the `model` attachment, each main-chain
reply's `message.model`, `effort` and usage, and the prompt's
`permissionMode` into `SessionInfo` (#137, `src/agents/claude/transcript.ts`);
nothing shows or sets them yet, and the stdout lines and `/context` are not
read.

- **What the transcript says.** Every `assistant` line: `message.model`
  and top-level `effort` (and `perTurnEffort`). A `model` attachment
  (`identity.modelId`, `marketingName`) before the first reply and before
  the first reply after a switch. `/model` and `/effort` run from the prompt
  leave three `user` lines: the local-command caveat,
  `<command-name>/model</command-name>` with `<command-args>`, and
  `<local-command-stdout>` "Set model to \`Haiku 5.5\` and saved as your
  default for new sessions" (or "… for this session only", optionally
  "… with \`medium\` effort"), "Set effort level to low (saved as your
  default for new sessions): …" (or "(this session only)"). An invalid
  argument is written as `system` `local_command` instead ("Model 'bogus'
  not found"; "Invalid argument: bogus. Valid options are: low, medium,
  high, xhigh, max, auto"). New record types in 2.1.318: `api-request`
  (`params.model`, `params.output_config.effort`, `betas`),
  `api-request-shape`, `api-request-blob`, `session-owner`, and
  `prompt_snapshot` and `session_context` attachments; the last holds the
  account email, so nothing may log attachments whole.
- **The window size is not in a herdr or hc transcript.** With
  `opus[1m]` set, the attachment said `claude-opus-5-5` / "Opus 5.5", the
  `api-request` had no 1M beta, and `/context` said `1m`; Haiku 5.5 and
  Sonnet 5.5 were `1m` too on this account. The `[1m]` suffix is no signal.
  `/context` writes "**Tokens:** 22.6k / 1m (2%)" in an `isMeta` `user`
  line after a `local_command` with `commandRun.command: "context"`.
- **Context in use** is `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens` of the newest main-chain reply: 22,550 against
  `/context`'s 22.6k, 26,922 against 26.9k.
- **`/model <alias>` and `/effort <level>` save the default.** The first
  writes `model` in `~/.claude/settings.json`, the second
  `modelSettings.<model id>.effortLevel` (per model). Aliases accepted:
  `opus`, `opus[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, `fable`, `best`,
  `default`, `opusplan`, a full id such as `claude-opus-4-8`.
- **Session only goes through the pickers.** `/model` with no argument
  lists `N.  <Display name> [✔]` rows, cursor `❯` on the current one, and
  says "Enter to set as default · s to use this session only · Esc to
  cancel"; ←/→ there sets the effort. `/effort` with no argument is a
  `low medium high xhigh max` slider, "←/→ to adjust · Enter to confirm · s
  for this session only · Esc to cancel". Arrow, then `s`: settings
  untouched (herdr and hc). A digit in the model picker selects and saves
  as the default.
- **Switching model in a conversation with replies asks first**, with an
  argument too: "Switch model? … ❯ 1. Yes, switch to Haiku 5.5 / 2. No, go
  back". `2` or `esc` prints "Kept model as …" and writes nothing. Not shown
  before the first reply or for the same model under another name. herdr
  stays `done` or `working` (`agent explain`: `osc_title_idle`) and hc's
  status has no `msg`: only the screen shows it.
- **Mid-turn**, `/effort high` ran at once and applied from the next reply,
  and **wrote nothing to the transcript**; `/model` put up the confirm while
  the turn streamed on. Neither is queued or typed as text.
- **The `claude` kind's control requests** (stream-json, all answered at
  once, also mid-turn, applying from the next turn): `set_model {model}` →
  `{model: "claude-sonnet-5-5"}` plus a replayed "Set model to \`sonnet
  (claude-sonnet-5-5)\`" stdout line, settings untouched;
  `apply_flag_settings {settings: {effortLevel}}` → bare success, session
  only, no record; `set_permission_mode {mode}` → `{mode}`, an unknown mode
  `error_code: "invalid_mode"` listing `acceptEdits, auto,
  bypassPermissions, default, dontAsk, plan`; `get_context_usage` →
  `categories`, `totalTokens`, `maxTokens`, `percentage`,
  `autocompactSource`. Every `result` has `modelUsage[<model>].contextWindow`
  (1000000 here); `system:init` has `model` and `permissionMode`.
  `get_settings` answers with the account email: never call it.
- **Permission mode** on 2.1.318: `shift+tab` cycled manual, accept edits,
  plan, auto, manual (footer through `pane.read`); the next `user` line had
  the new `permissionMode`, the `permission-mode` line lagged, as on 2.1.281.
- **herdr 0.9.5 reports `agent_session` at `agent start`**, before any
  prompt (source `herdr:claude`), unlike 0.8.2 below; the transcript file
  appears with the first prompt or slash command.

## A second agent: Codex

Measured on 2026-11-06 for issue #136, against herdr 0.9.5 and Codex 0.163.0
(the standalone TUI at `~/.local/bin/codex`), 0.166.0 (the shared app-server
daemon) and 0.167.0 (the mise install), in a scratch herdr tab on
`/tmp/oh-codex-live` with one-word prompts. The discussion, a cross-check
against another reader of Codex's files and what the agent-neutral model
needs are in the docs root, `findings/agent-codex.md`. Scrubbed recordings
are in `tests/fixtures/codex/`,
and `tests/codexFixtures.test.ts` pins the facts below that rest on them.

- **Which agent a pane runs.** herdr names it in `PaneInfo.agent`
  (`"codex"`), and the session it reports names it again in
  `agent_session.agent`, with `source: "herdr:codex"`. herdr-core has no
  field for it: the plugin's `agentKindOf` (`src/hc/model.ts`) reads
  `status.app`, then the foreground program (a Codex TUI runs as a native
  process named `codex`), then the `obsidian-herdr.agent` label. The `claude`
  kind runs only Claude. Until #155 no code path read the pane's agent before
  it offered the native view, so a Codex pane on herdr was offered a view that
  derived a Claude transcript path from Codex's thread id. Now herdr's and
  herdr-core's session watchers refuse a pane whose agent has no format or
  no trusted session binding (`src/native/agentSupport.ts`, the agent seam
  above), through the pane-reason path, and the pane stays a terminal that
  names its agent. herdr's Codex binding is a `hint` (next item).
- **The session is a thread id, and the transcript is a rollout file.**
  `~/.codex/sessions/YYYY/MM/DD/rollout-<local start time>-<thread id>.jsonl`
  (`$CODEX_HOME` moves `~/.codex`). It is created at the first prompt, not at
  start, and the thread id ends its name, so a known id finds its file by
  name. Codex's store `state_5.sqlite` holds the same path in
  `threads.rollout_path`, with `source` (`cli`, `vscode`, `exec`); a reader
  with `immutable=1` saw none of the day's threads, which were still in the
  WAL.
- **herdr reports a Codex session only when the TUI runs without the shared
  daemon.** herdr's Codex integration is a `SessionStart` hook
  (`~/.codex/hooks.json`, `herdr-agent-state.sh`) that sends
  `pane.report_agent_session` with the thread id (`kind: "id"`, never the
  path) to the pane named by `HERDR_PANE_ID` in its own environment. By
  default the Codex TUI is a client of one app-server daemon per user
  (`codex app-server`, here started on 2026-11-04 from herdr pane `wS:p3`),
  and the hook runs in the daemon, with the daemon's environment. Measured:
  a TUI in `w14:p8` ran a turn, `w14:p8` got no `agent_session`, and `wS:p3`,
  a pane in another workspace with no agent, got the new thread's id. The daemon,
  not the TUI, held the rollout open (`/proc/<pid>/fd`). Started with
  `--no-daemon`, the same pane got `agent_session` at its first prompt, and
  `/new` rotated it to the next thread's id at that thread's first prompt,
  as `/clear` does for Claude. Quitting a daemon TUI prints "Disconnected
  from this task. Any running work continues." and `codex resume <id>`.
- **The record format.** Every line is `{timestamp, ordinal, type,
  payload}`, `ordinal` counting 0, 1, 2, … in the file. Types: `session_meta`
  (first line: `id`, `cwd`, `originator: "codex-tui"`, `cli_version` of the
  process that writes, which is the daemon's version under the daemon,
  `source`), `turn_context` (per turn: `model`, `effort`, `summary`,
  `approval_policy`, `sandbox_policy`, `collaboration_mode`), `world_state`,
  `token_usage_record`, `compacted`, `response_item` (what the model saw and
  said) and `event_msg` (lifecycle). A turn opens with `event_msg/task_started`
  and closes with `task_complete` (`last_agent_message`, `duration_ms`) or
  `turn_aborted` (`reason: "interrupted"`).
- **Every prompt and every reply is written twice,** within a few
  milliseconds: as a `response_item` `message` and as an
  `event_msg/item_completed` item (`UserMessage` with a `client_id`,
  `AgentMessage` with `phase` `commentary` or `final_answer`). The
  `response_item` user messages also carry the AGENTS.md text and the
  environment context; only the ones whose
  `internal_chat_message_metadata_passthrough.content_item_kinds` is
  `["user.text"]`, or the `UserMessage` items, are prompts. No
  `event_msg/user_message` or `agent_message` was written by 0.163.0–0.167.0.
- **Tool calls are scripts, and no record flags a failure.** The model calls
  one code-mode tool, `exec` (`response_item/custom_tool_call`, its `input` a
  JavaScript cell calling `tools.exec_command(…)` and others), or `wait` on a
  yielded cell (`function_call`); outputs pair by `call_id`. The call's own
  `status` is `completed` even when it was refused. The outcome is text: a
  completed script's output opens `Script completed`, and a command inside it
  that failed shows only as `"exit_code":1` in the JSON block after; a
  yielded one says `Script running with cell ID <n>`; a call the user
  declined is answered by the plain string `aborted by user after <s>s` and
  the turn ends `turn_aborted`. A `CommandExecution` item (`status`
  `completed`/`failed`, `exit_code`, `command`) is written only for a command
  that outlives its script (a yielded cell) and for review runs, not for one a
  script ran to the end. Reasoning items carry no text here: reasoning
  summaries are off (`turn_context.summary: "none"`).
- **Approvals.** With `-a on-request`, a command the sandbox refused was
  retried with `sandbox_permissions: "require_escalated"` and a
  `justification` in the cell's input; that `custom_tool_call` is written
  before the dialog and stays unanswered while herdr shows the agent
  `blocked`, as a Claude permission leaves a dangling `tool_use`. The dialog
  is on screen only: "1. Yes, proceed (y)", "2. Yes, and don't ask again for
  commands that start with `…` (p)", "3. No, and tell Codex what to do
  differently (esc)", Enter confirms the highlighted first. `esc` declined.
  Under this machine's default policy (`granular`, `sandbox_approval: false`)
  Codex asks nothing and the model reports the refusal itself.
- **Steering.** A prompt herdr delivers while a turn runs joins that turn: a
  second `UserMessage` under the running turn's id, with no new
  `task_started`, and the reply answers both. herdr types the prompt into the
  composer and presses Enter, so a draft left there is sent in front of it
  (a `/` left by a key press turned `/new` into the text `//new`).
- **Slash commands** sent with `agent prompt` run: `/compact`, `/new`.
  `/compact` is a turn of its own with no prompt: `task_started`, a
  `compacted` record whose `message` is empty and whose summary is opaque, a
  `ContextCompaction` item, and `task_complete` with
  `last_agent_message: null`. The TUI's `/` list is compiled in (`/model`,
  `/fast`, `/presets`, `/permissions`, `/review`, …); no file lists it.
- **Model, effort and usage** are in the rollout: `turn_context.model` and
  `effort` per turn, `event_msg/token_count` with `total_token_usage`,
  `last_token_usage` and `model_context_window`.
- **Spawned directly**, Codex has two machine interfaces besides the TUI.
  `codex exec --json` prints a stream of its own (`thread.started`,
  `turn.started`, `item.completed` with snake-case item types,
  `turn.completed` with usage) and writes a rollout too (`source: "exec"`).
  `codex app-server` speaks JSON-RPC over stdio (`codex app-server
  generate-json-schema` prints it): `thread/start|resume`, `turn/start`,
  `turn/steer`, `turn/interrupt`, `thread/compact/start`, `model/list`;
  approvals and questions arrive as server requests
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`); its `ThreadItem` statuses include
  `declined`, and `TurnStatus` is `completed|interrupted|failed|inProgress`.
  The app-server was read from its schema, not run.
