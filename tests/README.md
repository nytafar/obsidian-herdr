# Tests

`npm test` runs vitest (`tests/**/*.test.ts`) in a plain node environment.

Only DOM-free logic is unit tested: the pure helpers of the agent list
(`groupByTab`, `relativeCwd`, `countStatuses`), the notification decision path
(`src/notify.ts`, with an injected clock) and the folder actions
(`src/actions.ts`, against a fake client — nothing here talks to a live herdr).
`obsidian` has no runtime entry point outside the app, so `vitest.config.ts`
aliases it to `tests/fixtures/obsidian.ts`; `tsc` still checks against the real
`obsidian.d.ts`. The terminal renderer
(`src/views/renderer/ghosttyWeb.ts`) needs a canvas and the ghostty WASM, so its
tests stop at the pure helpers in `src/views/renderer/TerminalRenderer.ts`
(`resolveFont`, `computeFit`, `cssVar`, `parsePx`).

## Smoking the renderer inside Obsidian

1. `npm run build` (or `npm run dev` for a watch build). The dev vault
   `/Users/lasse/Vaults/hvelv` has this repo symlinked at
   `.obsidian/plugins/herdr`; Hot-Reload picks up `main.js`.
2. Command palette → **Herdr: Show renderer smoke test**. The command is
   dev-only, opens a modal, and talks to no herdr socket or pane.
3. Expect: bold/underline/reverse/dim text, the 8 normal + 8 bright ANSI colours,
   a 256-colour background and a truecolour foreground, box-drawing characters,
   `äöü 漢字 🐑`, and a blinking cursor after `$ `. Colours come from the active
   Obsidian theme (`--text-normal`, `--background-primary`, `--color-*`), so
   switching light/dark and reopening the modal should change them.
4. Typing goes to `onData` — nothing consumes it in the smoke test, so the screen
   stays still; the renderer is not echoing locally. That is correct.
5. Console check for the WASM path (PRD N5): the bundle must contain exactly one
   `data:application/wasm;base64` literal and no `ghostty-vt.wasm` file may be
   emitted next to `main.js`:
   `grep -c 'data:application/wasm;base64' main.js && ls main.js manifest.json styles.css`.
   If `Ghostty.load()` ever falls through to `./ghostty-vt.wasm`, the devtools
   network tab shows a failed request for it — that means the embedding broke.

## Smoking the agent list, actions and notifications inside Obsidian

The unit tests cover the decisions, not the wiring. Inside the dev vault:

1. Command palette → **Herdr: Show herdr agents** opens the list in the left
   sidebar (first time it is created with `getLeftLeaf(true)`; after that it is
   revealed wherever the user dragged it).
2. Rows group by herdr tab and show a status dot, the agent name, the stripped
   terminal title and the cwd relative to the vault. Clicking a row focuses that
   pane in herdr; the terminal button shows the T9 placeholder notice.
3. The status bar shows `N blocked · M done` and clicking it reveals the list.
4. Right-click a folder or a note in the file explorer → the three Herdr items.
   The same three exist in the command palette for the active note's folder.
5. Notifications: let an agent finish or block while Obsidian is in the
   background; expect one Notice and one system notification, and nothing more
   for the next two seconds.
