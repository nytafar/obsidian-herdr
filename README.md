# Herdr for Obsidian

See, reach and start your [herdr](https://github.com/ogulcancelik/herdr) agents from
inside Obsidian. The plugin finds the herdr workspace that matches your vault and
brings it into the app:

- **Agent list** in the sidebar: every agent pane of that workspace, grouped by
  herdr tab, with a status dot, the agent name, its terminal title and its cwd
  relative to the vault. It updates live.
- **Notifications** when an agent becomes blocked (it wants you) or is done, with
  a status bar count of both.
- **Terminal tabs**: open any agent's live terminal as an Obsidian tab, type in
  it, scroll it, or watch it read-only.
- **Folder actions**: new herdr tab, split, or start an agent at the folder of a
  note — from the file explorer context menu or the command palette.
- **Remote herdr** over SSH: the same list, actions and terminals against herdr
  on another machine.

Nothing here changes how herdr behaves for anyone using it outside Obsidian. All
the workspace filtering happens on the plugin side.

## Requirements

- Obsidian **desktop** 1.7.2 or newer. The plugin is `isDesktopOnly`; there is no
  mobile build.
- macOS or Linux. Windows hosts are not supported.
- **herdr 0.8.0 or newer, already running.** The plugin never starts, stops or
  updates a herdr server; it attaches to the one you have.
- For the remote profile: `ssh` on this machine and key-based login to the remote
  host that does not prompt.

## Install

Until the plugin is in the community list, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. BRAT → *Add beta plugin* → `nytafar/obsidian-herdr` → choose the latest
   release.
3. Enable **Herdr** in Community plugins.

Manual install works too: download `main.js`, `manifest.json` and `styles.css`
from a [release](https://github.com/nytafar/obsidian-herdr/releases) into
`<vault>/.obsidian/plugins/herdr/` and reload Obsidian.

## Setup

Open **Settings → Herdr**. The top of the tab is a live status block: which
binary was found and how, which socket is in use, the server's version and
protocol, and which workspace matched your vault. Read it first — every setup
problem below shows up there.

### Socket

**Socket path** is the Unix socket of the running herdr server, by default
`~/.config/herdr/herdr.sock`. Leave it alone unless you start herdr with a custom
socket. The plugin also asks `herdr status server --json` where the socket is and
uses that answer when it can.

### Binary path and the Dock caveat

The plugin needs the `herdr` executable for two things: probing the server and
spawning terminal bridges. It looks in this order:

1. the **Herdr binary** setting, if set;
2. `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`;
3. any directory in **Extra PATH entries**;
4. a `PATH` obtained by asking your login shell.

**The Dock caveat**: an Obsidian launched from the macOS Dock (or from a desktop
launcher on Linux) does not inherit your login shell's `PATH`. If the status
block says the binary was not found, or terminals fail to start with
`spawn herdr ENOENT`, put the absolute path into **Herdr binary** — `which herdr`
in a terminal prints it. **Extra PATH entries** is the same fix for the tools
your *agents* need: those directories are prepended to `PATH` for every process
the plugin spawns.

### Workspace resolution

Everything the plugin shows is filtered to exactly one herdr workspace, resolved
in this order:

1. the **Workspace ID** setting, if set (ids are opaque and differ between
   servers, so only pin one when the rules below pick wrong);
2. the workspace whose **label equals the vault folder name** (case-insensitive
   as a second pass);
3. the workspace with the most panes whose **cwd is inside the vault path** (the
   remote vault path when a remote profile is on).

If none matches, the list says "No herdr workspace matches this vault yet" and
the settings status says the same. Creating a herdr workspace labelled like your
vault folder is the simplest fix. Only panes that have an agent are ever listed;
plain shell panes stay invisible.

## Remote herdr over SSH

Turn on **Use a remote herdr** and fill in:

- **SSH host** — `user@host` or an alias from `~/.ssh/config`. Login must succeed
  without a passphrase prompt; the plugin runs `ssh` non-interactively.
- **Remote socket path** — the herdr server's socket on the remote host,
  usually `~/.config/herdr/herdr.sock`.
- **Remote herdr binary** — an **absolute** path such as
  `/home/you/.local/bin/herdr`. Non-interactive SSH has a minimal `PATH`, and
  `~/.local/bin` is typically not on it, so a bare `herdr` will not be found.
- **Remote vault path** — where this same vault lives on the remote host. Folder
  actions translate note paths against it, and it is also what the cwd rule of
  workspace resolution matches against.

Two things worth knowing about how this works:

- The JSON API is reached through a forwarded socket:
  `ssh -N -L /tmp/herdr-<hash>.sock:<remote socket> host`. The local end is short
  on purpose — macOS caps socket paths near 104 bytes and a long one is rejected
  outright. A stale local socket file is removed before every attempt, and a
  dropped link reconnects with backoff; the settings status shows the state.
- **The tilde caveat**: `ssh -L local:~/x` does *not* expand `~` on the remote
  side. The forward binds happily and then every connection through it dies
  silently. The plugin therefore asks the remote host for `$HOME` and expands the
  path itself — so a `~` in **Remote socket path** is safe here, even though it
  is not safe if you type that `ssh` command yourself.
- **Terminals do not use the forward.** herdr's terminal bridge talks to a
  *different* socket inside the CLI process, so remote terminals run the CLI on
  the far side: `ssh -T <host> <remote binary> terminal session control|observe …`.
  That is why the remote binary path matters even when the tunnel is healthy.
  `-T` is deliberate: the bridge is newline-delimited JSON over pipes, not a PTY.

## Terminals: control mode and its cost

Opening an agent's terminal attaches to that herdr pane. Two modes, switchable
per view with the eye button in the tab header and set as a default under
**Terminal → Attach mode**:

- **Control** (default) — you can type and scroll, and the pane is yours. herdr
  allows one controller per terminal, so attaching takes control over
  (`--takeover`). **While the view is attached, the herdr TUI pane follows the
  Obsidian view's size**: resizing or splitting the Obsidian tab resizes the pane
  in the herdr TUI a moment later. That is the documented cost of control mode,
  not a bug. Closing the view releases the terminal and hands ownership back.
- **Observe** — read-only. Typing does not reach the pane and the pane is never
  resized, so the herdr TUI is left completely alone. Any number of observers can
  watch the same pane at once. Use it when someone (or you, in the TUI) is
  working in that pane and the size must not move.

Other terminal behaviour:

- One tab per pane. Opening the same agent again reveals the existing tab instead
  of spawning a second bridge. Closing the tab ends the bridge process.
- The status strip at the bottom reads `Controlling this pane.` or
  `Observing (read-only).`, and turns into the reason when the session ends —
  for example `Session closed: terminal attach taken over. Reconnect to attach
  again.` when another client takes control. The refresh button reconnects.
- Colours and font follow the Obsidian theme's CSS variables. **Font family** and
  **Font size** override them; leave them empty / at 0 to follow Obsidian.
- Open terminal tabs are restored on restart, for the same pane and mode.

## Notifications

The plugin reacts to agent *status transitions*, never to raw pane updates, and
only two transitions are considered worth interrupting you: into **blocked** (an
agent stopped and wants you) and into **done** (an agent finished a turn).
`working`, `idle` and `unknown` are noise and are ignored.

Escalation, all of it per transition in settings:

- **Status bar** — `N blocked · M done` for this vault's workspace. Clicking it
  reveals the agent list.
- **Notice** — an in-app notice, `Herdr: <agent> needs you` / `is done`.
- **System notification** — only while the Obsidian window is *unfocused*.
  Clicking it brings the agent list up. macOS and Linux both need Obsidian to be
  allowed to send notifications; the first attempt asks. Defaults: on for
  blocked, off for done.

Two rules that keep this quiet: a pane that just notified is muted for 2 seconds
(agents flap blocked → working → blocked), and a pane whose terminal is open in
Obsidian never notifies, because you are already looking at it.

Focusing a pane is what marks it seen — in herdr, not in the plugin. Clicking a
row does exactly that.

## Commands and menus

Command palette:

| Command | What it does |
|---|---|
| **Herdr: Show herdr agents** | Opens/reveals the agent list. First time it is created as a split in the left sidebar; after that it stays wherever you dragged it. |
| **Herdr: New tab here** | `tab.create` in the scoped workspace at the active note's folder, labelled with the folder name. |
| **Herdr: Split here** | Splits the focused herdr pane with that folder as cwd. |
| **Herdr: Start agent here** | Creates the tab, waits for its pane to reach a shell prompt, then starts an agent of the configured kind and name pattern in it. Reports the result as a notice, and opens the terminal when *Open terminal after starting an agent* is on. |

The last three are hidden when no note is open, since there is no folder to act
on.

Right-clicking a folder **or** a note in the file explorer adds the same three
actions — **Herdr: new tab here**, **Herdr: split here**, **Herdr: start agent
here** — acting on the folder (for a note, its parent). With several items
selected, the first one's folder is used.

In the agent list, clicking a row focuses that pane in herdr; the terminal button
on the row opens it as a tab.

Agent kind (`claude`, `codex`, `gemini`, `opencode`, `pi`, `cursor`, `amp`,
`copilot`, `kimi`, `droid`, `grok`) and the name pattern are settings. The
pattern understands `{folder}`, `{vault}` and `{n}`, where `{n}` is a counter
that avoids colliding with agent names already taken.

## Troubleshooting

**"Herdr binary not found" / terminals never start.** Obsidian was probably
launched from the Dock and has no login `PATH`. Set **Herdr binary** to the
absolute path from `which herdr`. See the Dock caveat above.

**"Server: not reachable".** herdr is not running, or it listens on a different
socket. Check `herdr status server --json` in a terminal and copy its socket path
into **Socket path**.

**"No herdr workspace matches this vault yet".** Neither the label nor the cwd
rule matched. Label a herdr workspace like the vault folder, open a pane whose
cwd is inside the vault, or pin **Workspace ID**.

**"Protocol mismatch".** The running herdr speaks a different protocol number
than the plugin was generated against. This is a warning only — the plugin never
refuses to connect, ignores fields it does not know, and disables just the single
action whose method is missing.

**The agent list is empty but herdr shows panes.** Only panes with an agent are
listed; shell panes are deliberately invisible.

**The herdr TUI pane keeps resizing.** That is control mode. Switch the view to
observe with the eye button, or set **Attach mode** to observe.

**Remote: the tunnel connects but nothing answers.** Almost always the tilde
problem or a wrong remote socket path. Verify with
`ssh <host> <remote binary> status server --json` and copy the socket it prints.

**Remote: terminals fail while the list works.** The forwarded socket does not
carry terminals. Check **Remote herdr binary** is an absolute path that exists on
the remote host.

**A leftover `herdr terminal session` process.** Closing the tab should end it;
`pgrep -fa 'terminal session'` should show one process per open terminal tab and
none afterwards.

## Development

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # type-check + production build
npm test        # vitest, no herdr and no network
npm run lint    # eslint, including the Obsidian plugin rules
```

Symlink the repo into a vault at `.obsidian/plugins/herdr` and use the
[Hot-Reload](https://github.com/pjeby/hot-reload) plugin to pick up rebuilds.
`tests/README.md` documents what is unit tested and the manual smoke recipes for
the parts that need a canvas or a live herdr (renderer, terminal view, remote
profile). Releases are built by `.github/workflows/release.yml` on a `v*` tag and
ship exactly `main.js`, `manifest.json` and `styles.css`.

## How it talks to herdr

- **Workspace state and actions**: herdr's JSON API over the Unix socket. That
  server answers one request per connection, so every call opens its own
  connection; only `events.subscribe` holds a long-lived one, and it reconnects
  with backoff when the server restarts. Reads used: `ping`, `workspace.list`,
  `pane.list`, `events.subscribe`. Writes only on your action: `pane.focus`,
  `tab.create`, `pane.split`, `agent.start`.
- **Pane terminals**: `herdr terminal session control|observe <pane> --cols N
  --rows M`, spawned as a child process speaking newline-delimited JSON on both
  pipes. Not a PTY, and not the API socket.

## License

MIT. See `LICENSE`.
