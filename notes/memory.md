# Memory diagnosis (issue #14)

> Home of this file is the shared `../notes/` directory next to the repo
> (`/Users/lasse/code/nytafar/obsidian-herdr/notes/memory.md`). It is committed
> on `spike/memory` only because a worktree-isolated agent cannot write outside
> its worktree; move it when merging.

Spike, branch `spike/memory` off `v1`. Reported symptom: with the plugin
enabled, Obsidian's memory grows steadily.

**Short version.** Nothing in the plugin's node-side code grows. Six minutes of
the real `HerdrClient` + `WorkspaceScope` against the live socket, and six
minutes of a real `TerminalSession` observing a live pane, both plateau at
**+0.02 MB/min of retained heap** — that is noise, not a leak. One million
synthetic `pane_updated` events through `WorkspaceScope.ingest` retain
**0.06 MB**. 881 event-stream reconnects leave the listener and subscription
tables at exactly their starting sizes.

What is big, and what the fix list is about, is per-terminal-view cost that is
allocated once and **never returned**: ghostty-web shares one WebAssembly memory
across every terminal, a WASM memory can only grow, and each open terminal costs
about **5.4 MB** of it plus a device-pixel-scaled canvas (tens of MB on a Retina
display, arithmetic below, unmeasured). Opening and closing terminals therefore
ratchets Obsidian's memory to the high-water mark of concurrently open
terminals and holds it there for the life of the window. Each open terminal also
runs an unconditional 60 fps `requestAnimationFrame` repaint loop, even when its
tab is not the visible one.

The one thing that is *not* the problem is the missing scrollback cap. Measured:
ghostty-web's `scrollback` option is a **byte budget**, not a line count, and the
default already caps a terminal at ~445 lines / 5.4 MB.

## How this was measured

Everything below is read-only against the live herdr (0.8.0, protocol 19,
`~/.config/herdr/herdr.sock`): `ping`, `pane.list`, `tab.list`,
`session.snapshot`, `events.subscribe`, and `herdr terminal session observe`.
No control mode, no focus, no create, no `herdr update`.

Four throwaway harnesses were bundled with esbuild from the real `src/` modules
and run under `node --expose-gc`, forcing two GCs before every sample so the
numbers are retained memory, not garbage. They are not committed; each is ~50
lines and is described where its numbers appear, so they are cheap to rebuild.

Session under test: 100 panes session-wide, 17 workspaces, the vault's workspace
(`w4`) holding 7–8 agent panes.

## Suspect 1 — no scrollback cap

**Hypothesis.** `RendererOptions.scrollback` is never set
(`src/views/renderer/ghosttyWeb.ts`), so the library default applies per
terminal; with ~98 KB full repaints, retained VT state inside the WASM heap
could be large.

**Test.** `ghostty-vt.wasm` instantiated directly in node (the package's own
loader wants a browser `fetch`), driving the same `GhosttyTerminal` the widget
uses. One terminal per process, 120×40, 200 000 lines of 180 characters written,
sweeping `scrollbackLimit`. Memory read from `WebAssembly.Memory.buffer.byteLength`.

| `scrollbackLimit` | WASM memory after 200k lines | scrollback lines retained |
|---|---|---|
| (no config object) | 6.63 MB (+5.44) | 445 |
| 1 000 | 6.63 MB (+5.44) | 445 |
| **10 000 (what the plugin gets today)** | **6.63 MB (+5.44)** | **445** |
| 100 000 | 6.63 MB (+5.44) | 445 |
| 1 000 000 | 6.63 MB (+5.44) | 445 |
| 10 000 000 | 14.69 MB (+13.50) | 5 961 |
| **0** | **1023.25 MB and still climbing** | **399 961** |

So the value is a byte budget for libghostty-vt's page list, rounded up to whole
pages, and `0` means unlimited. The plugin always passes a theme, which makes
ghostty-web build a WASM config with `scrollback ?? 10000`, so every terminal
today runs with the 10 KB budget: bounded at ~5.4 MB, and with a scrollback of
only ~445 lines.

Frame volume, measured against the live working pane `w4:p12`: the first frame
after attach is **158 KB decoded** (211 KB of base64), and steady-state frames
average **945 bytes**; 1 764 frames over 5.5 minutes, of which 7 were full
repaints, **1.59 MB** of ANSI in total. The premise of "periodic 98 KB full
repaints" does not hold, and it would not matter if it did: the byte budget caps
what the VT keeps regardless of how much is written.

**Verdict: killed as a memory suspect.** It is a *usability* bug (445 lines of
scrollback), and a latent footgun: any future setting that hands this option a
`0` turns one terminal into a gigabyte. A guard against non-positive values
landed on this branch.

## Suspect 2 — WASM heap per view

**Hypothesis.** Each `TerminalView` builds its own `GhosttyWebRenderer`; does
`dispose()` free the WASM instance and does a closed tab's memory return?

**Test.** Read `node_modules/ghostty-web/dist/ghostty-web.js`, plus the same
headless WASM harness: create 10 terminals, write 20 000 lines into each, free
them all, watch the shared memory.

Findings:

- There is **one** WASM instance per window, not one per view. `Terminal`'s
  constructor does `this.ghostty = options.ghostty ?? getGlobalGhostty()`, and
  `init()` memoises a single module-level `Ghostty`. Every `TerminalView` shares
  the same `WebAssembly.Memory`.
- `Terminal.dispose()` → `cleanupComponents()` → `wasmTerm.free()` does free the
  terminal *inside* the WASM allocator, so a later terminal reuses the space.
  Our `GhosttyWebRenderer.dispose()` calls it correctly and also removes the
  canvas and the textarea from the DOM.
- A `WebAssembly.Memory` can only grow. Measured: 10 concurrent terminals took
  the shared memory from 6.63 MB to **51.69 MB (+45.06 MB, ~4.5 MB each)**, and
  after freeing all ten it stayed at **51.69 MB**.

**Verdict: confirmed, with a correction.** There is no per-view WASM *leak*, and
`dispose()` is correct, but memory is returned to ghostty's allocator, never to
the OS. Open five terminals over a day and Obsidian's footprint keeps the peak
(~5.4 MB × peak concurrent terminals) until the window is reloaded. That is
exactly the "grows and never comes back" shape a user sees. It is a ratchet
bounded by the peak, not an unbounded leak.

## Suspect 3 — frame retention in the bridge

**Hypothesis.** `src/bridge/terminalSession.ts` decodes base64 to a
`Uint8Array` per frame; something retains past frames, or `LineSplitter.pending`
grows without bound.

**Test.** A real `TerminalSession` in **observe** mode against the live pane
`w4:p12` (a working agent) for 5.5 minutes, sampling `process.memoryUsage()` and
`v8.getHeapStatistics()` every 30 s after two forced GCs.

```
t=  0s heapUsed=3.84MB rss=43.27MB external=1.70MB arrayBuffers=0.01MB frames=0
t= 60s heapUsed=3.97MB rss=45.36MB external=1.71MB arrayBuffers=0.02MB frames=181
t=180s heapUsed=3.98MB rss=45.94MB external=1.71MB arrayBuffers=0.02MB frames=434
t=330s heapUsed=4.05MB rss=48.99MB external=1.71MB arrayBuffers=0.02MB frames=1764
growth over 5.5 min: heapUsed 0.10MB (0.02MB/min), rss 5.72MB (1.04MB/min)
```

`heapUsed`, `external` and `arrayBuffers` are flat; `rss` wanders by a couple of
MB in both directions (allocator arenas) and does not trend. Code reading agrees:
frames are emitted synchronously and dropped, `pending` is only used before the
renderer mounts and is cleared by `dispose()`, and both `LineSplitter`s throw and
reset past their byte budget.

One cosmetic note, not a leak: `decodeBase64` returns a `Uint8Array` **view** on
a `Buffer`, and node allocates buffers under 4 KB out of a shared 8 KB pool.
Frames average 945 B, so any frame that *were* retained would pin 8 KB rather
than 1 KB. Nothing retains them today.

**Verdict: killed.**

## Suspect 4 — event volume

**Hypothesis.** `pane.updated` arrives ~10×/s per pane across ~20 panes;
per-event allocation in `src/herdr/scope.ts`, or a listener set / Map that grows.

**Test A**, live: `HerdrClient` + `WorkspaceScope` with the real subscription
list, primed from `session.snapshot`, for 6 minutes.

```
t=  0s heapUsed=3.84MB rss=43.39MB external=1.63MB events=0
t= 60s heapUsed=4.12MB rss=49.63MB external=1.63MB events=577  scopeChanged=0  panes=7
t=180s heapUsed=4.16MB rss=50.64MB external=1.63MB events=1612 scopeChanged=13 panes=8
t=360s heapUsed=4.22MB rss=48.52MB external=1.63MB events=2736 scopeChanged=13 panes=8
growth over 5.5 min: heapUsed 0.10MB (0.02MB/min), rss 2.77MB (0.50MB/min)
```

**Test B**, wire volume: subscribing with the plugin's own subscription list and
counting bytes for 60 s gave **590 lines, 386.8 KiB, 6.45 KiB/s = 0.38 MiB/min**,
mean line 671 B. The real rate is ~9.8 events/s for the whole 100-pane session,
not per pane.

**Test C**, synthetic: one million `pane_updated` events fed through
`WorkspaceScope.ingest` with 20 in-scope panes: **179 ms (5.6 M events/s)** and
**0.06 MB** of retained heap afterwards.

Also worth recording as evidence that PRD N4 works: **2 736 events produced 13
`changed` events** over six minutes. The scope swallows 99.5 % of the stream, so
the list view and the status bar repaint essentially never at idle.

**Verdict: killed.** Event volume is ~0.4 MiB/min of transient garbage and
retains nothing. If Obsidian's memory grows steadily, this is not where.

## Suspect 5 — `refreshAgentNames` timers

**Hypothesis.** Overlapping or accumulating timers on scope change.

**Test.** Code reading; the path is four lines. `refreshAgentNames` returns
immediately when `this.agentNameTimer` is non-zero, the callback clears the field
before doing anything, and `onunload` clears a pending one. `window.setTimeout`
never returns 0, so the sentinel is sound. There is exactly one timer at a time,
holding one closure over the plugin. Nothing schedules it on an interval — only
scope `added` / `workspaceResolved` edges, of which there was 1 in six minutes.

**Verdict: killed.**

## Suspect 6 — the event-stream reconnect path

**Hypothesis.** Re-priming leaves old subscriptions or listeners attached.

**Test.** A fake NDJSON server on a temp socket that acks `events.subscribe`,
pushes 50 `pane_updated` and then destroys the connection, with the client's
backoff set to 1 ms. Real `HerdrClient` + `WorkspaceScope`, 20 seconds:

```
start   streams=0   heapUsed=4.02MB subscriptions=15 handlerTypes=2 handlers=2
running streams=440 heapUsed=4.63MB subscriptions=15 handlerTypes=2 handlers=2
end     streams=881 heapUsed=4.72MB subscriptions=15 handlerTypes=2 handlers=2
```

881 reconnects and ~44 000 events: +0.7 MB of heap (V8 not bothering to shrink),
and the subscription array and handler table are exactly the sizes they started
at. `closeStream` calls `removeAllListeners()` before `destroy()`, and
`subscribe()` deduplicates by `JSON.stringify`.

**Verdict: killed.**

## Suspect 7 (new) — the 60 fps repaint loop per open terminal

Not in the ticket; found while reading ghostty-web for suspect 2.

`Terminal.startRenderLoop()` is an unconditional `requestAnimationFrame` loop:
every frame it re-renders the canvas and reads the cursor, with no dirty check
and no visibility check, until `dispose()`. Obsidian tabs that are not in front
are still in a visible window, so the loop is not throttled by the browser. Two
open terminal tabs mean two full canvas repaints per display frame forever.

This is CPU, GPU and battery rather than JS heap, but it is the other half of
what "Obsidian feels heavy with the plugin on" means, and canvas backing stores
are a real, non-heap allocation: a 1400×900 CSS-pixel host at
`devicePixelRatio` 2 is a 2800×1800×4 B = **20 MB** canvas per open terminal.
That number is arithmetic from ghostty-web's `canvas.width = w * devicePixelRatio`,
not a measurement — see the devtools recipe below to confirm it.

**Verdict: needs-UI-confirmation** for the size, confirmed for the loop.

## Suspect 8 (new) — `render()` ⇄ `refreshTabLabels()` in the list view

`AgentListView.render()` calls `refreshTabLabels()` when any group's tab id is
missing from `this.tabLabels`, and `refreshTabLabels()` calls `render()` when it
got any labels. On this machine the two converge immediately — live `tab.list`
for `w4` returns every tab id that `pane.list` reports. But a pane whose tab is
never in `tab.list` would spin: one `tab.list` round trip plus one full DOM
rebuild per iteration, forever, for as long as the sidebar is open.

**Verdict: needs-UI-confirmation** (unreachable on today's herdr; one line to
make impossible).

## What Lasse should confirm in Obsidian devtools, in three steps

The renderer, the canvas and the WASM high-water mark cannot be measured from
node. Ctrl-Shift-I in Obsidian, then:

1. **Memory tab → "Take heap snapshot"** with the plugin loaded and no herdr
   views open. Note "Total". Then open the agent list, wait a minute, snapshot
   again. The delta should be under a megabyte; anything more means the list
   view is the problem after all, which the numbers above do not predict.
2. **Open one terminal tab, let it run ten minutes, close the tab, press
   "Collect garbage" (the bin icon), then snapshot again.** In the snapshot's
   class list, sort by retained size and look for `GhosttyWebRenderer`,
   `Terminal`, `CanvasRenderer` and `HTMLCanvasElement`. **Zero instances of each
   is the pass condition** — a surviving instance is a real leak on top of the
   ratchet in suspect 2, and the retainer chain in the lower pane names who holds
   it.
3. **⌘⇧P → "Show performance monitor"**, then open and close terminal tabs while
   watching *JS heap size* and *DOM Nodes*. Nodes climbing and not returning
   after a close is a detached-DOM leak. JS heap returning to baseline while the
   process RSS (Activity Monitor) stays high is the WASM/canvas ratchet, which is
   expected and only fixable by not keeping terminals mounted.

## Prioritised fix list (for issue #15)

1. **Reuse one renderer across terminal views, or dispose eagerly on hide.**
   `src/views/terminalView.ts`. Each open terminal permanently costs ~5.4 MB of
   shared WASM plus a dpr-scaled canvas, and the WASM is never returned to the
   OS. Cheapest real win: we already dispose in `onClose`; add disposal (and
   `session.release()`) when the leaf has been hidden for a grace period, and
   re-mount on show. Biggest measured lever, most design work.
2. **Stop the repaint loop for terminals whose leaf is not visible.**
   `src/views/terminalView.ts` + `src/views/renderer/*`. ghostty-web offers no
   pause, so this means disposing the renderer on hide (same change as 1) or
   upstreaming a `pause()`. 60 fps × every open terminal is being spent on
   canvases nobody is looking at.
3. **Decide the scrollback budget on purpose.** `src/views/renderer/ghosttyWeb.ts`.
   Today's implicit 10 KB gives ~445 lines. `10_000_000` gives ~5 961 lines for
   +8 MB per terminal (measured). Pick one and write it down; whatever is chosen,
   never pass `0`. The non-positive guard landed on this branch; the value choice
   did not, because it trades memory for scrollback and that is a product call.
4. **Break the `render()` ⇄ `refreshTabLabels()` cycle.**
   `src/views/agentListView.ts`. Fetch labels on `workspaceResolved` / `added`
   only, or remember "already asked for this tab id", instead of re-asking from
   inside `render()`.
5. **Do not hand out pooled `Buffer` views from the bridge.**
   `src/bridge/terminalSession.ts`, `decodeBase64`. One `Uint8Array` copy per
   frame (945 B average) removes a footgun where any future consumer that keeps a
   frame pins 8 KB of node's shared buffer pool. Cosmetic today; costs nothing.

Explicitly *not* on the list, because they were measured and are innocent:
`WorkspaceScope.ingest`, the event stream and its reconnect path, the NDJSON
splitters, `refreshAgentNames`, and the terminal bridge's frame path.

## Unmeasured

- Everything DOM-bound: canvas bytes, detached nodes, Obsidian's own overhead
  per view. The recipe above is the way to close that gap.
- Long-horizon behaviour. The longest run here is six minutes; a leak with a
  period longer than that (per `workspace_closed`, say, or per Obsidian window
  reload) would not have shown up.
- Control mode. Everything measured here was observe mode, by rule. Control adds
  `terminal.resize` and input, neither of which allocates per frame.
- The remote (SSH) profile.
