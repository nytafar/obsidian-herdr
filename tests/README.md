# Tests

`npm test` runs vitest (`tests/**/*.test.ts`) in a plain node environment.

Only DOM-free logic is unit tested: the pure helpers of the agent list
(`groupByTab`, `relativeCwd`, `countStatuses`), the notification decision path
(`src/notify.ts`, with an injected clock) and the folder actions
(`src/actions.ts`, against a fake client — nothing here talks to a live herdr).
`obsidian` has no runtime entry point outside the app, so `vitest.config.ts`
aliases it to `tests/fixtures/obsidian.ts`; `tsc` still checks against the real
`obsidian.d.ts`. The terminal view is unit tested the same way: only its exported
decisions (`parseTerminalState`, `attachFor`, `debounce`, `wheelToScroll`,
`spawnEnv`, `isRecoverable`, `statusLine`) — the wiring needs a canvas and a live
herdr. The terminal renderer
(`src/views/renderer/ghosttyWeb.ts`) needs a canvas and the ghostty WASM, so its
tests stop at the pure helpers in `src/views/renderer/TerminalRenderer.ts`
(`resolveFont`, `computeFit`, `cssVar`, `parsePx`).

The input layer (`src/views/input/`, #17) is pure by construction — no DOM, no
`obsidian`, no bridge — so `tests/input/` covers all of it: the mode tracker
against real escape sequences including ones split across frames, the kitty and
legacy key encodings, the SGR mouse report builders, and the router's
scroll-or-report fork. Two of those suites assert the ticket's own acceptance
criterion, that with the shipped options `routeKey` returns null for every key
and every wheel notch still becomes `terminal.scroll`; if #18 or #25 flips an
option, those expectations are what has to change with it.

## Smoking shift+enter, mouse and scroll (#18, #25, #33)

Nothing in the input layer is switched on, so there is nothing to smoke yet. When
one of those tickets turns an option on, the live check is:

1. `npm run build`, then in the dev vault open an attached Claude pane.
2. Shift+enter must add a line to the composer without submitting; plain enter
   must still submit. Try the same in a non-Claude harness.
3. Confirm what the pane actually received before trusting the UI: the bridge is
   the only writer, so `console.debug` at `TerminalView.onKeyEvent` shows the
   exact bytes. Do not use control mode on someone else's pane to test this.

Read `notes/herdr-terminal-bridge.md` first: herdr does not relay mode-setting
sequences in its frames, so the tracker is in its defaults for every live pane
and the encoder has to guess which protocol the pane negotiated.

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
## Smoking the agent list, actions and notifications inside Obsidian

The unit tests cover the decisions, not the wiring. Inside the dev vault:

1. Command palette → **Herdr: Show herdr agents** opens the list in the left
   sidebar (first time it is created with `getLeftLeaf(true)`; after that it is
   revealed wherever the user dragged it).
2. Rows group by herdr tab and show a status dot, the agent name, the stripped
   terminal title and the cwd relative to the vault. Clicking a row focuses that
   pane in herdr; the terminal button opens the terminal view (below).
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

Read-only bridge check without Obsidian (observe only — never control against a
pane someone is using):

```
herdr terminal session observe w4:p1 --cols 100 --rows 30 </dev/null | head -1
```

matches what the view spawns in observe mode; the first line is a
`terminal.frame` with `full: true` and the requested width/height.
