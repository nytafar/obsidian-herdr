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
`obsidian.d.ts`. The terminal view is unit tested the same way: only its exported
decisions (`parseTerminalState`, `attachFor`, `debounce`, `VisibilityTracker`,
`wheelToScroll`, `spawnEnv`, `isRecoverable`, `statusLine`) — the wiring needs a
canvas and a live herdr. `VisibilityTracker` is the whole hide/reveal state
machine with injected timers, so the decision to free a hidden terminal is tested
without a DOM; what a measurement *is* (a host with no box) is not. The settings
side owns the scrollback budget (`clampScrollbackMb`, `scrollbackBytes`) and the
panes-per-tab cap (`clampPanesPerTab`). The
terminal renderer
(`src/views/renderer/ghosttyWeb.ts`) needs a canvas and the ghostty WASM, so its
tests stop at the pure helpers in `src/views/renderer/TerminalRenderer.ts`
(`resolveFont`, `computeFit`, `cellFromPoint`, `cssVar`, `parsePx`). Terminal placement
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
   ordering, the grouping and the labels; what is left to eyeball here is the
   DOM. `tests/agentListView.test.ts` only guards the module surface, since the
   view itself needs a document.
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
herdr pane. The unit tests stop at the exported decisions.

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

Read-only bridge check without Obsidian (observe only — never control against a
pane someone is using):

```
herdr terminal session observe w4:p1 --cols 100 --rows 30 </dev/null | head -1
```

matches what the view spawns in observe mode; the first line is a
`terminal.frame` with `full: true` and the requested width/height.
