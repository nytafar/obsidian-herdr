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
