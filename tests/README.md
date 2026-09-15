# Tests

`npm test` runs vitest (`tests/**/*.test.ts`) in a plain node environment.

Only DOM-free logic is unit tested: the agent list's row model
(`src/views/rowModel.ts` — `buildRows`, `toRow`, `relativeCwd`,
`agentDisplayName`, `countStatuses`), the notification decision path
(`src/notify.ts`, with an injected clock) and the folder actions
(`src/actions.ts`, against a fake client — nothing here talks to a live herdr,
including the choice of which herdr tab a new agent is split into,
`chooseSplitTarget`).
`obsidian` has no runtime entry point outside the app, so `vitest.config.ts`
aliases it to `tests/fixtures/obsidian.ts`; `tsc` still checks against the real
`obsidian.d.ts`. Most of that fixture only has to be loadable, but `Setting` is
a working recorder (see "The `Setting` fixture" below). The terminal view is
unit tested the same way: only its exported
decisions (`parseTerminalState`, `attachFor`, `debounce`, `VisibilityTracker`,
`spawnEnv`, `isRecoverable`, `statusLine`) — the wiring needs a
canvas and a live herdr. `VisibilityTracker` is the whole hide/reveal state
machine with injected timers, so the decision to free a hidden terminal is tested
without a DOM; what a measurement *is* (a host with no box) is not. What a
settings change costs an open terminal is a table rather than a call path
(`TERMINAL_SETTING_EFFECTS`, `planSettingEffect`, `collapseEffects` in
`src/views/paneTerminal.ts`, issue #84), so it is asserted row by row in
`tests/paneTerminal.test.ts` alongside the effects themselves running on the
lifecycle: a theme remount that keeps the session, an engine change that does
not, and an observe-mode bridge that no rebuild takes over. The settings
side owns the scrollback budget (`clampScrollbackMb`, `scrollbackBytes`) and the
panes-per-tab cap (`clampPanesPerTab`). The
terminal renderers
(`src/views/renderer/ghosttyWeb.ts`, `xtermJs.ts`) need a canvas or a DOM, so
their tests stop at the pure helpers in `src/views/renderer/TerminalRenderer.ts`
(`resolveFont`, `computeFit`, `cellFromPoint`, `cssVar`, `parsePx`,
`normalizeEngineName`), at the byte-budget-to-line-count conversion
`scrollbackLines` from the xterm.js renderer, and at which class
`createRenderer` picks for an engine name — with both renderer modules mocked,
since instantiating either needs a browser (#27). Terminal placement
(`src/terminalPlacement.ts`, `decidePlacement`) is pure for the same reason: the
split-versus-tab choice is unit tested, the `createLeafBySplit` call is not.
The file explorer's folder hover button (`src/explorerButtons.ts`, #30) splits
the same way: the observer, the injected button and the row bookkeeping need a
real file explorer — undocumented DOM this repo does not fake — so
`tests/explorerButtons.test.ts` covers the decisions taken before any element is
touched (`menuItemsFor`, `attachablePane`, `folderAbsPath`, `vaultRelativeLabel`,
`asElement`) plus the two DOM constants the stylesheet also depends on.

The input layer (`src/views/input/`, #17) is pure by construction — no DOM, no
`obsidian`, no bridge — so `tests/input/` covers all of it: the mode tracker
against real escape sequences including ones split across frames, the kitty and
legacy key encodings, the SGR mouse report builders, and the router's
wheel payload. The router suite pins the shipped policy: shift+enter and
alt+enter are `ESC CR` (#18), plain enter and every other key are the renderer's,
and a wheel notch is always a `terminal.scroll` carrying the cell and herdr's
crossterm modifier bits rather than an SGR report the plugin built (#25).

## The `Setting` fixture and the settings tab (#85)

The settings tab is a status block plus seven sections, and each section is a
plain function over a container, the settings object and a bundle of callbacks
(`save`, `saveAndReconnect`, `redisplay`, `refreshAgentList`,
`refreshFolderHoverButton`, `applyTerminalSetting`). No builder sees the plugin,
so `tests/settingsSections.test.ts` renders a section on a bare container and
asserts three things: the rows it puts up, what a change writes into the
settings, and which callbacks run in which order — save before the refresh, and
the redisplay last where a control shows or hides other fields. Both conditional
groups are covered: the remote fields, which only exist while the profile is on
(the enable toggle itself is always there), and the panes-per-tab cap, which
only exists while agents share a herdr tab.

That works because `Setting` in `tests/fixtures/obsidian.ts` is a recorder
rather than a stub. It records `setName`, `setDesc`, `setHeading` and `setClass`,
and `addToggle`, `addText`, `addTextArea`, `addDropdown`, `addSlider`,
`addButton` and `addExtraButton` each build a component that records what it was
configured with — value, placeholder, dropdown options in order, slider limits,
button text — and keeps the handler passed to `onChange` (or `onClick`).
`component.change(value)` is what a test drives: it stores the new value, runs
the handler and returns its result, so an async handler can be awaited. Nothing
touches a DOM; the container is only an identity, which is what
`settingsContainer()` returns. Read a container back with `builtSettings`,
`settingNames` or `settingNamed(container, name)`, and `setting.control()` for
the single control of a row. `inputEl`, `selectEl` and `sliderEl` are
`FakeElement`s that record listeners, for code that attaches one.

## Smoking shift+enter, mouse and scroll (#18, #25, #33)

**Neither #18 nor #25 has been checked against a live pane.** The unit tests pin
the bytes and the payload; only a real attach can say whether the harness on the
other end reads them the way we expect. The check, in the dev vault, on a pane
that is yours:

1. `npm run build`, then open an attached Claude pane in control mode.
2. Shift+enter must add a line to the composer without submitting; plain enter
   must still submit. Alt+enter behaves like shift+enter. Repeat in a non-Claude
   harness (Codex, Gemini CLI, or plain `bash` where `ESC CR` should be inert).
3. Confirm what the pane actually received before trusting the UI: the bridge is
   the only writer, so `console.debug` at `TerminalView.onKeyEvent` shows the
   exact bytes. Do not use control mode on someone else's pane to test this.
4. Wheel: over the canvas, not just the padding, a notch must reach herdr. In a
   mouse-reporting TUI (`htop`, `less`, a fullscreen editor) the wheel must move
   that application's own view, and the cell it reports must follow the pointer —
   `console.debug` in `sendWheel` shows the `column`/`row` sent. In a plain shell
   pane the herdr viewport moves instead, which also moves the herdr TUI.
5. Selection must still work: drag across text in a plain pane and copy it.
   Clicks are deliberately left to ghostty-web (see below), so a mouse-reporting
   TUI will *not* respond to clicks yet.

Read `notes/herdr-terminal-bridge.md` first: herdr does not relay mode-setting
sequences in its frames, so the tracker is in its defaults for every live pane.
That is why the key encoder has to guess the protocol (it sends the legacy
`ESC CR`), why herdr and not the plugin encodes the wheel, and why clicks are not
routed at all — gating them without a mode signal would cost text selection in
every plain pane. Exposing `ServerMessage::MouseCapture` over the session
protocol is the herdr-side change that unblocks the click half of #25.

## Smoking the renderer inside Obsidian

1. `npm run build` (or `npm run dev` for a watch build). The dev vault
   `/Users/lasse/Vaults/hvelv` has this repo symlinked at
   `.obsidian/plugins/herdr`; Hot-Reload picks up `main.js`.
2. Open an agent's terminal from the agent list (the terminal button on a row).
   The shipped build has no dev-only smoke command; the real terminal view is the
   harness. To eyeball escape handling without an agent, run
   `printf '\033[1mbold\033[0m \033[38;2;255;128;0mtruecolour\033[0m ┌──┐ äöü 漢字 🐑\n'`
   inside that pane.
3. Expect: bold/underline/reverse/dim text, the 8 normal + 8 bright ANSI colours,
   a 256-colour background and a truecolour foreground, box-drawing characters,
   `äöü 漢字 🐑`, and a blinking cursor. Colours come from the active Obsidian
   theme (`--text-normal`, `--background-primary`, `--color-*`), so switching
   light/dark should change them (the view re-reads them on `css-change`).
4. Console check for the WASM path (PRD N5): the bundle must contain exactly one
   `data:application/wasm;base64` literal and no `ghostty-vt.wasm` file may be
   emitted next to `main.js`:
   `grep -c 'data:application/wasm;base64' main.js && ls main.js manifest.json styles.css`.
   If `Ghostty.load()` ever falls through to `./ghostty-vt.wasm`, the devtools
   network tab shows a failed request for it — that means the embedding broke.

## Comparing the two renderer engines (#27)

`node scripts/bench-renderers.mjs` measures what can be measured headlessly and
re-reads what cannot. It is not shipped (`scripts/` is outside the bundle) and
writes nothing into the working tree: the bundle variants go to a temp
directory. `--only bundle|throughput|repaint` and `--lines N` narrow a run; it
re-executes itself under `--expose-gc`, because "retained" here means what
survives three forced collections.

Numbers below are from 2026-09-06, node v22.23.1, an M-series Mac, a 120x40
grid, 200 000 lines of 180 characters (the payload notes/memory.md used) and the
plugin's default 10 MB scrollback setting — 10 MB of ghostty-web's byte budget,
which `scrollbackLines()` converts to 6 000 lines for xterm.js.

**Bundle contribution**, minified `main.js`, each engine stubbed out in turn so
the cost is a subtraction:

| Build | main.js | Engine cost |
|---|---|---|
| neither engine | 89.4 KB | — |
| ghostty-web only | 736.7 KB | +647.3 KB |
| xterm.js only | 390.1 KB | +300.7 KB |
| both (what ships) | 1033.4 KB | +944.0 KB |

**Write throughput and retained memory**, one child process per engine so the
heaps never mix. ghostty-vt is instantiated straight from the `.wasm` the way
the memory diagnosis did it; xterm.js is `@xterm/headless` 5.5.0, the same
parser and buffer as the browser build:

| | ghostty-web | xterm.js |
|---|---|---|
| 36.4 MB parsed in | 414 ms | 883 ms |
| throughput | 88.0 MB/s, 483 000 lines/s | 41.2 MB/s, 227 000 lines/s |
| scrollback held | 5 961 lines | 6 000 lines |
| memory for it | +14.29 MB of WASM | +11.85 MB of heap + external |
| after disposing it | **14.31 MB never returned** | **0.51 MB never returned** |

So ghostty-web parses about **2.1x faster**, and costs about the same memory
while it lives — but a `WebAssembly.Memory` cannot shrink, so its 14 MB stays
until Obsidian restarts, where xterm.js gives 96 % of its buffer back to the
process on `dispose()`. That is the ratchet notes/memory.md named, measured
against an engine that does not have it.

**Repaint cost per second cannot be measured headless**, so the script reads
both render loops instead and re-checks each claim against the installed source
on every run (a claim whose evidence has gone prints `[STALE]`):

- **xterm.js repaints only dirty rows, and only when something changed.**
  `RenderService.refreshRows(start, end)`
  (`node_modules/@xterm/xterm/src/browser/services/RenderService.ts:135`) widens
  a pending row range and hands it to `RenderDebouncer.refresh()`
  (`src/browser/RenderDebouncer.ts:40`), which requests an animation frame only
  when none is pending and then renders exactly that range. Idle means no frame
  is requested at all.
- **xterm.js also pauses itself when hidden.**
  `RenderService._registerIntersectionObserver()` (same file, :110) observes the
  screen element with an `IntersectionObserver`; not intersecting sets
  `_isPaused`, and `refreshRows()` then only records that a full refresh is
  owed. A background Obsidian tab costs nothing even before #15's disposal.
- **ghostty-web's loop is unconditional.** `Terminal.startRenderLoop()`
  (`node_modules/ghostty-web/dist/ghostty-web.js`) re-arms
  `requestAnimationFrame` every frame, checking only `isDisposed` and `isOpen`.
  60 wakeups a second per open terminal, hidden tab or not, until `dispose()`.
- **But each of those frames is not a full repaint.**
  `CanvasRenderer.render()` (same file) asks the WASM `isRowDirty(y)` per row and
  redraws only those. The cost of an idle ghostty-web terminal is the wakeup and
  its WASM round trips (`getCursor`, `getDimensions`, `getScrollbackLength` every
  frame), not 60 canvas redraws a second — which is a correction to how #14 and
  #24 phrased it.

## Smoking the xterm.js engine inside Obsidian (#27)

The renderer itself needs a DOM, so nothing below is unit tested. With a terminal
open, settings → Herdr → Terminal → **Terminal engine** → xterm.js:

1. The open terminal rebuilds in place: history reappears as plain text (no
   colours — the same trade a hide/reveal makes), and the status line still says
   "Controlling this pane."
2. Type. Keys reach the agent, and **shift+enter still inserts a line break**
   rather than submitting: that path runs through the renderer's key hook, whose
   polarity is inverted for xterm.js, so it is the thing most likely to break.
3. Resize the pane. The grid follows and herdr's pane follows with it (control
   mode), which proves `fit()` reads xterm's cell metrics.
4. Scroll with the wheel over the terminal. Every notch must reach herdr, not
   scroll xterm's own viewport — the capture-phase listener is what makes that
   true, and a notch that scrolls locally instead means it did not fire.
5. Switch the colour theme in settings. Both engines take the same palette, so
   the colours must not change when the engine does.
6. Switch back to ghostty-web and check the same six things.

## Checking the remote profile against `xl` (T10, PRD S5/S17)

The SSH tunnel unit tests inject the spawn, the socket probe and the unlink, so
`npm test` never runs `ssh`. The live check is manual and read-only:

1. `ssh lasse@xl /home/lasse/.local/bin/herdr status server --json` — proves the
   remote server is up and prints its socket (`/home/lasse/.config/herdr/herdr.sock`).
2. Drive `SshTunnel` from a scratch script (`tsx`), or by hand:
   `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L /tmp/herdr-<hash>.sock:/home/lasse/.config/herdr/herdr.sock lasse@xl`
   then `printf '{"id":"1","method":"ping","params":{}}\n' | nc -U /tmp/herdr-<hash>.sock`
   and the same with `workspace.list`. Both answer through the forward.
3. Nothing is created on the remote host: no panes, no tabs, no agents, and
   never `herdr update`.

Two facts worth keeping: `ssh -L local:~/x` binds the local socket but every
connection through it then dies silently, because the tilde is not expanded —
`SshTunnel` asks the remote `$HOME` instead. And the forwarded API socket gives
no terminals, since the bridge speaks to herdr's separate client socket; remote
terminals go through `ssh -T host <remote herdr> terminal session …`.
## Smoking the folder hover button inside Obsidian (#30)

The injection and its teardown are the untested half, and both are visible by
hand in the dev vault:

1. `npm run build`, reload the plugin. Hover a folder in the file explorer: a
   small bot icon appears at the right edge of the row and disappears when the
   pointer leaves. Files get no button.
2. Click it. The menu is **Start agent here** and **Copy path from vault root**,
   and the folder must **not** fold or unfold — that is the capture-phase
   `stopPropagation`. Fold and unfold with a normal click on the row to confirm
   the row itself still works.
3. Start an agent in that folder (or in one below it), then open the menu again:
   **Attach** is now the first entry and opens that agent's terminal view.
4. Scroll a long explorer, collapse and expand a few folders, then hover a row
   that scrolled out and back: the button is still there. That is the
   `MutationObserver` reclaiming recycled rows; without it the button survives
   only the first paint.
5. Settings → **File explorer → Folder hover button** off: every button
   disappears at once, no `data-herdr-folder-button` attribute is left in the
   explorer DOM (check in devtools), and hovering does nothing. On again brings
   them back without a reload.
6. Drag the file explorer into a popout window, or open a second explorer in the
   right sidebar: the buttons appear there too, because `layout-change` rescans.

## Smoking the agent list, actions and notifications inside Obsidian

The unit tests cover the decisions, not the wiring. Inside the dev vault:

1. Command palette → **Herdr: Show herdr agents** opens the list in the left
   sidebar (first time it is created with `getLeftLeaf(true)`; after that it is
   revealed wherever the user dragged it).
2. Rows group by herdr tab and show a status dot, the agent name, the stripped
   terminal title and the cwd relative to the vault. Clicking a row focuses that
   pane in herdr; the terminal button opens the terminal view (below). All of
   that comes from `buildRows`, so `tests/rowModel.test.ts` already covers the
   ordering, the grouping and the labels; what a click, a right-click or a key
   on a row then *does* is `tests/rowDispatch.test.ts`, which drives the
   dispatcher with a fake host and no view at all (issue #82). What is left to
   eyeball here is the DOM. `tests/agentListView.test.ts` only guards the module
   surface, since the view itself needs a document.
   Tab labels arrive from one `tab.list` per workspace resolution, never from
   the render path: with the devtools network-free view open, adding a pane
   should cause at most one extra `tab.list`, and repainting none at all.
3. The status bar shows `N blocked · M done` and clicking it reveals the list.
4. Right-click a folder or a note in the file explorer → the three Herdr items.
   The same three exist in the command palette for the active note's folder.
5. Notifications: let an agent finish or block while Obsidian is in the
   background; expect one Notice and one system notification, and nothing more
   for the next two seconds.

## Smoking the terminal view inside Obsidian (T9, PRD M13/M15/S16)

Nothing below is automated: the view needs a canvas, the ghostty WASM and a live
herdr pane. The unit tests stop at the exported decisions — but the session and
renderer lifecycle behind the view is no longer among the things only a hand
test covers: `tests/paneTerminal.test.ts` drives `PaneTerminal` (issue #83)
through fake factories and a fake scheduler, including the races this recipe
used to be the only check on — a suspend during a start, a reveal during the
release, a mount finishing after its renderer was given up, and a connection
arriving after a start had already given up on one. What is left to a hand test
is what the fakes stand in for: a real canvas, a real child process, and step 9
below, which is the only place the memory the suspension exists for is visible.

1. `npm run build`, then in the dev vault open the agent list and click the
   terminal button on a row (or run the "start agent here" action with
   "Open terminal after start" on).
2. Expect a main-area tab whose title is the agent name (the pane id when the
   agent has no name), the live pane rendered inside it, and a status strip at
   the bottom reading `Controlling this pane.`
3. Type: the keystrokes land in the herdr pane, not in Obsidian. Scroll the
   wheel: the pane's viewport scrolls. Drag the tab into a split and resize it:
   the herdr TUI pane follows Obsidian's size ~100 ms after you let go (PRD M15 —
   this is the documented cost of control mode).
4. Click the terminal button again from the list: the same tab is revealed, no
   second bridge process. `pgrep -fa 'terminal session'` shows exactly one per
   open terminal tab, and none after the tab is closed.
   With **Terminal placement** on its default (split right) and a note from the
   agent's folder open in the main area, the first open lands beside that note
   instead of in a tab; switching the setting to split left puts it on the other
   side, and to "Always a new tab" restores the pre-#28 behaviour. With an
   unrelated note open (or none), it is a tab either way.
5. Header actions: the eye toggles observe mode — the strip changes to
   `Observing (read-only).`, typing no longer reaches the pane and resizing no
   longer moves the herdr pane. Toggling back restarts the bridge in control
   mode. The refresh action reconnects.
6. Close reasons: attach the same pane from a second client with `--takeover`
   (`herdr terminal session control <pane> --takeover` in a scratch terminal) —
   the view's strip turns into
   `Session closed: terminal attach taken over. Reconnect to attach again.`
   Killing the pane's process instead yields `Session closed: terminal <id>
   exited.` with no reconnect hint. Bridge stderr appears as a faint second
   line: the newest one, with a `(+N more)` counter for the rest.
7. Theme: switch light/dark with a terminal open; colours and font follow
   (`css-change` -> `refreshTheme`).
8. Restart Obsidian with a terminal tab open: the tab comes back for the same
   pane and mode, because `getState`/`setState` persist `{paneId, mode}`.
9. Hidden-leaf suspension (#15, `HIDE_GRACE_MS` = 30 s): open a terminal, switch
   to another tab in the same tab group and wait half a minute. `pgrep -fa
   'terminal session'` then shows **no** bridge for that pane and, in control
   mode, herdr's own pane is usable again — the takeover was handed back. Come
   back to the tab: the scrollback is still there (as plain text, colours are
   gone by design) and a fresh full frame paints over the live state within a
   moment. Flipping tabs quickly must change nothing: 30 s of hiding is the
   trigger, not a tab switch. In devtools' Memory tab, "Collect garbage" then a
   heap snapshot after the suspension should show zero `Terminal`,
   `CanvasRenderer` and `HTMLCanvasElement` instances for that view, and the
   performance monitor's frame rate should drop — the ghostty repaint loop only
   stops when the renderer is disposed.
10. Scrollback budget: with "Scrollback memory budget" at 10 MB a terminal keeps
   roughly 6 000 lines (about 600 lines per megabyte, measured — the option is a
   byte budget, not a line count). Raising it to 64 MB and opening several
   terminals is the worst case the ceiling exists for.

## Smoking the render mode switch inside Obsidian (#92)

The pane surface seam is unit tested with a fake factory
(`tests/paneSurface.test.ts`); what needs Obsidian is the swap happening on a
real terminal.

1. With a terminal tab open, right-click its tab header (or use the palette's
   "Switch render mode"): the menu lists Ghostty web, xterm.js and Native view,
   with the current one checked.
2. Choose Native view: the terminal is given back — `pgrep -fa 'terminal
   session'` shows no bridge for that pane — and the tab shows the session's
   history (#93), or "No session yet." on a pane whose Claude has taken no
   prompt, with the strip reading `Native view of <pane>. No session yet.`
3. Choose Ghostty web again: the bridge respawns and the pane renders as before.
4. Restart Obsidian: a tab left in native mode comes back in native mode, and a
   tab that never chose follows **Default render mode** in the settings, so
   switching that setting to Native view moves every such tab at once.
5. With the remote profile on and a terminal opened on the remote endpoint, the
   menu shows "Native view (local panes only)", greyed out, and clicking it does
   nothing (ADR-0002).

Read-only bridge check without Obsidian (observe only — never control against a
pane someone is using):

```
herdr terminal session observe w4:p1 --cols 100 --rows 30 </dev/null | head -1
```

matches what the view spawns in observe mode; the first line is a
`terminal.frame` with `full: true` and the requested width/height.

## Smoking the native view's history inside Obsidian (#93)

The reducer, the transcript source, the session model and what the surface draws
are unit tested (`tests/transcriptReducer.test.ts`, `tests/transcriptSource.test.ts`,
`tests/sessionModel.test.ts`, `tests/nativeSurface.test.ts`, the first of them
against the live transcript of whatever session runs them). What needs Obsidian
is the Markdown: only the app can render a wikilink, a callout or an embed.

1. Open a pane whose Claude has answered at least once in native mode. The whole
   session so far is there: human prompts as plain pre-wrapped text, the
   assistant's prose as Markdown, tool calls and thinking as one grey line each.
2. A prompt that mentioned `[[a note]]` shows it as a link; clicking opens the
   note, and ctrl/cmd-clicking opens it in a new tab.
3. An answer containing a callout, an embed or a wikilink renders exactly as the
   same text would in a note, in the vault's own theme and fonts.
4. From the pane's own directory,
   `ls ~/.claude/projects/"$(pwd | tr -c 'a-zA-Z0-9' '-' | sed 's/-$//')"/`
   lists its transcripts; the one named by that pane's `agent_session.value` in
   `herdr agent list` is the file the view is showing.

## Smoking live updates and session following (#94)

The tail is tested against a real temp file and the following against fake
herdr events (`tests/transcriptSource.test.ts`, `tests/sessionModel.test.ts`).
What needs a real pane is the rotation, because nothing but Claude Code rotates
a session.

1. Prompt the agent from its terminal, with the native tab visible: new blocks
   appear as it writes, and "Working…" shows between them, going away when it
   finishes. Blocking it (a permission prompt) shows "Waiting for you."
2. Send `/clear` in that pane. Within a few seconds the view empties and starts
   showing the new session; `herdr agent list` confirms the pane's
   `agent_session.value` changed.
3. Exit Claude and start it again with `--resume <the old uuid>`: the original
   history comes back, because the id and the file are the ones it had.
4. Open a second native tab on the same pane (drag the tab out, or open the pane
   again): both keep up, and there is still one tail —
   `ls -l /proc/$(pgrep -f 'Obsidian' | head -1)/fd | grep -c '<session>.jsonl'`
   stays at one while both are open. Closing both releases it.
5. Leave a native tab in the background while the agent works, then switch back:
   it is up to date at once, with no reload.
6. Restart herdr (or stop and start the plugin's connection): the view keeps
   following, because the models rebind to the new scope.

## Smoking the prompt box (#97)

The button's label and enabled state per status, the text that goes out and the
failure path are unit tested (`tests/promptBox.test.ts`), and that the
`agent.prompt` request carries no `wait` field is pinned in
`tests/promptSender.test.ts`. What needs a real pane is that herdr's delivery is
what the facts say it is.

1. In a native tab on an idle pane, type three lines with a blank one between
   them and press ctrl/cmd-enter (or the **Send** button). The pane's Claude
   receives the whole text as one prompt, newlines intact, and the box empties.
2. While it works, the button reads **Queue** and stays enabled. Send a second
   prompt: it is accepted, Claude consumes it inside the running turn, and
   nothing is echoed into the view until the transcript says so.
3. Block the agent (a permission prompt): the button is disabled and the view
   says "Waiting for you.". Answer it in the terminal and the button comes back.
4. Open a native tab on a pane with no agent: the box says "No agent in this
   pane." and neither the box nor the button can be used.
5. Send `/help` from the box: Claude opens its help overlay rather than typing
   the text. `herdr agent send-keys <pane> esc` closes it again.
6. On a freshly started Claude that has never been prompted, the view says "No
   session yet." and the button reads **Send**. Sending the first prompt starts
   the session; within seconds the view shows the turn, because
   `agent_session` appeared and the tail started.
7. Stop herdr and press send: a notice says the prompt could not be sent and the
   text stays in the box.
