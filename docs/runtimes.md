# Runtimes: which herdr, on which machine

A **runtime** is something the plugin can connect to: a **kind** on a
**target**. The kind is **herdr**, the terminal multiplexer this plugin has
always supported, **herdr-core**, the headless `hc` runtime, or **Claude, run
by Obsidian**, the simple mode that needs no multiplexer at all. The target is
**this machine** or an **SSH host**; Claude run by Obsidian is this machine
only. Settings → Herdr → Runtimes lists them.

One runtime is **active** at a time. The agent list, the folder actions, the
notifications and the status bar counts are all for the active runtime;
switching tears the connection down and opens the next one.

## Adding, editing and removing

- **Add runtime** creates a herdr runtime over SSH and opens its form. Change
  **Kind** and **Target** first; the fields below them follow.
- The pencil on a row opens that runtime's form; **Done** closes it. Fields of the
  active runtime reconnect as you type (after a short pause); fields of another
  runtime are only saved.
- **Problems** under the form names anything still missing, such as an SSH
  host or a remote vault path.
- The plug on a row makes that runtime active; on the active one it reconnects.
- The bin removes a runtime after asking. Its pinned agents are forgotten, and
  terminal tabs opened on it say the runtime is no longer configured. The last
  runtime cannot be removed.

A runtime keeps its identity when you edit it: terminal tabs and pins stay
attached to it whatever you change, the host included.

## Switching

- **One runtime**: nothing to switch, no button.
- **Two**: the agent list's toolbar has a button (laptop for this machine,
  server for an SSH host) that switches to the other one.
- **Three or more**: the same button opens a menu of all of them, the active one
  checked.
- **Herdr: Switch runtime** in the command palette works for any count, and has
  no default hotkey.

With more than one runtime the status bar shows the active one's name beside
the counts; its tooltip always does. Renaming a runtime is display only: the
status bar and the settings status follow the new name at once, without a
reconnect.

Terminals are pinned to the runtime they were opened on: a local terminal keeps
running, keeps its title, and reconnects, toggles mode and rebuilds against its
own herdr after the list has switched to another runtime, and the other way
round. Its status line says where it runs. Pane ids repeat across servers, so a
remote `w4:p1` row opens its own terminal rather than revealing the local
`w4:p1`.

## herdr on this machine

The runtime a fresh install starts with, named **Local**.

- **Socket path**: the herdr server's socket. The plugin also asks
  `herdr status server --json` and prefers its answer.
- **Herdr binary**: empty means auto-discovery in `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, the extra PATH entries, then your login
  shell's PATH. Set it when Obsidian was launched from the Dock. A leading
  `~` is expanded. Terminal tabs on this runtime find the binary the same way
  even while another runtime is active.
- **Workspace ID**: pins the herdr workspace. Empty means the workspace labelled
  like the vault folder, then the one with the most panes inside the vault.

## herdr over SSH

Run agents on another machine and see them here. The plugin forwards herdr's API
socket over SSH for the list and the actions, and runs herdr's terminal bridge on
the far side for terminals.

### The vault must exist on both machines

Everything the plugin does is relative to the vault: which workspace matches,
which folder an agent starts in, which note a terminal opens beside. The remote
host therefore needs a copy of this vault at **Remote vault path**, kept in sync
by whatever you already use, such as Obsidian Sync, Self-hosted LiveSync,
Syncthing or a git remote. The plugin does not sync anything itself. Tested with
a mirrored vault on 2026-09-06; it works.

### Fields

- **SSH host**: `user@host` or an alias from `~/.ssh/config`. Login must succeed
  without a prompt; the plugin runs `ssh` non-interactively.
- **Remote socket path**: the herdr server's socket on the remote host, usually
  `~/.config/herdr/herdr.sock`. A `~` is fine here (see below).
- **Remote herdr binary**: an **absolute** path such as
  `/home/you/.local/bin/herdr`. Non-interactive SSH has a minimal `PATH`, so a
  bare `herdr` will not be found.
- **Remote vault path**: where the mirror lives on the remote host. Required:
  without it the folder actions refuse rather than send a local path to the
  remote host.
- **Workspace ID**: as for a local runtime, on the remote server.

The status block in settings shows the tunnel state; a dropped link reconnects
with backoff. The native view is for local panes only on herdr; an SSH herdr
runtime's tabs show the terminal. (herdr-core reads transcripts over its
connection, so its SSH runtimes have the native view; see below.)

### Two caveats

**The tilde.** `ssh -L local:~/x` does not expand `~` on the remote side; the
forward binds and then every connection through it dies silently. The plugin asks
the remote host for `$HOME` and expands the path itself, so `~` in **Remote
socket path** is safe even though it would not be in a hand-typed command.

**Terminals do not use the forward.** herdr's terminal bridge talks to a
different socket inside the CLI process, so remote terminals run the CLI on the
far side: `ssh -T <host> <remote binary> terminal session control|observe …`.
That is why the remote binary path matters even when the tunnel is healthy.

### Checking by hand

```bash
ssh <host> <remote binary> status server --json
```

proves the server is up and prints its socket path. Nothing is created on the
remote host by the plugin unless you start an agent.

## herdr-core

A herdr-core runtime connects to `hc`, the headless herdr runtime, through
`hc connect`: on this machine directly, on another over `ssh -T`. There is no
socket to set and nothing to forward.

### Setting one up

1. In **Settings → Herdr → Runtimes**, add a runtime and set **Kind** to
   herdr-core (hc).
2. **This machine:** leave **Hc binary** empty to search Homebrew,
   `/usr/local/bin`, `~/.local/bin` and the login shell's PATH, or give the
   full path. `hc connect` starts the core if none runs.
3. **SSH host:** set the host (key login without a prompt; the plugin uses
   `BatchMode=yes`), the **Remote vault path**, and leave **Remote hc binary**
   empty unless hc lives somewhere unusual: the plugin then looks for `hc` or
   `herdr-core` on the non-interactive PATH and in `~/.local/bin`, as the core
   does when it adds a machine. hc must be installed on the host; nothing is
   needed locally but `ssh`.
4. **Space** is optional. Empty matches the herdr-app space named like the
   vault folder, else every terminal whose working directory is inside the
   vault. Set it to a space's name or id to pin the runtime to that space.
5. Make it active from the list, the agent list's switcher or **Switch
   runtime**.

The settings status shows the transport, the core's name, version and
generation, and which space or folder the list is scoped to. A core that
speaks another protocol generation is reported there and in a notice, and the
plugin connects anyway. A missing binary or an unreachable host is reported
the same way as for herdr.

### What works

- The agent list shows the space's (or the vault's) agent terminals with live
  status: a terminal counts as an agent when the program reports its status
  (`claude-code`, `codex`, …) or a known agent runs in it. Done and idle follow
  herdr-app's shared `herdr.seen` label, so an agent seen in herdr-app is not
  "done" here either.
- Pins are the shared `herdr.pinned` label: pinning in Obsidian pins in
  herdr-app and on the phone, and the other way round.
- **Start agent here** runs the default agent in the folder, in your own shell,
  labelled for herdr-app's space when one matched. **Terminate agent** kills
  and removes the terminal.
- The connection comes back on its own after the core restarts or the SSH
  line drops.

- **Terminal tabs** work as on herdr: control types and sets the terminal's
  size, observe only watches. hc has no single controller: whoever typed,
  resized or clicked into the tab last sets the size, and a tab whose size
  another viewer took draws at that size until you type, resize or focus it.
  A tab that opens hidden leaves the size alone until it is shown. A tab
  follows the program across a restart of a kept terminal and a lost
  connection on its own, keeps trying while the connection or the terminal
  is away, shows the program's last output, and says so when it exits.
- Looking at an agent's tab (window in front, tab on screen), in the terminal
  or the native view, marks it seen in herdr-app's shared `herdr.seen` label,
  so its "done" clears here, in herdr-app and on the phone.

herdr-core has no tabs, splits, rename or pane focus, so those are left out
rather than offered and refused.

- **The native view** works on herdr-core, on this machine and over SSH,
  for a Claude whose terminal carries the session hook's label (below). It
  follows `/clear` and `--resume` like on herdr, prompts go through
  `terminal.send` (queued while the agent works), keys through
  `terminal.keys`, and the waiting card names hc's blocked kinds (permission,
  question, sign-in). On an SSH runtime the transcript is read over the
  runtime's connection with hc's `file.read`, so nothing needs mounting.
- A terminal without the label stays a terminal: the view switch says
  `no Claude session label; run "Install or remove the Claude session hook"`
  (or `no Claude session in this terminal` when Claude is not running in it),
  and switches to the native view by itself once Claude labels it. A label
  whose pid is not the terminal's foreground process is not taken either,
  and the switch says the label belongs to another process: a wrapper that
  forks Claude instead of exec'ing it does that, and so does a label an
  earlier Claude left behind. Start Claude with `exec` in the wrapper. When
  Claude exits, or hands the terminal to an editor, the tab shows the
  terminal again.

### The Claude session hook

A Claude Code `SessionStart` hook labels the hc terminal Claude runs in with
its session (ADR-0006). It runs at every start, resume, `/clear`, compact and
fork. It is installed on the machine the runtime runs on, through the
runtime's own connection: for an SSH runtime, on the remote host.

1. Make the herdr-core runtime active.
2. Run **Install or remove the Claude session hook** from the command palette,
   or press **Review** on **Claude session hook** in the runtime's form,
   which also shows whether it is installed, outdated or absent.
3. The modal shows the exact script and the exact `SessionStart` entry, and
   where they go: `$CLAUDE_CONFIG_DIR` as the core's environment has it, else
   `~/.claude`. Nothing is written until you press **Install** (or
   **Update**).

Start Claude again after installing: Claude Code reads its hooks when a
session starts up, and a Claude already running may not pick a new one up.

It writes `hooks/obsidian-herdr-session.sh` and one entry in `settings.json`.
Every other setting in that file keeps its value: herdr's own hook and every
other hook stay as they are. The file is rewritten in standard JSON
formatting, as Claude itself writes it, so a hand-formatted file comes out
reformatted (its indentation and line endings are kept). If the rewrite would
change a value, the plugin refuses and says why: a number JavaScript cannot
hold exactly, or a key that appears twice. Then add or remove the entry by
hand. **Remove** takes out that entry and deletes the script. A
settings file that is not valid JSON is refused, not repaired. If the file
changes between the modal opening and the click, nothing is written.

The hook needs only `sh` and `awk`. It does nothing outside an hc terminal,
for subagents, and for a Claude started by another Claude.

Check by hand from inside an hc terminal running Claude:
`hc get "$HC_TERMINAL_ID" --json` shows `labels["obsidian-herdr.session"]`.


A herdr-core runtime shows only its own machine's terminals, never the
`machine/tN` ones the core federates from elsewhere. To see hc on another
machine, add an SSH runtime for it.

### Checking by hand

```bash
hc ls                      # this machine
ssh -T <host> hc connect   # should wait silently; Ctrl-D to leave
```

## Claude, run by Obsidian

The simple mode: the plugin starts Claude Code itself, as its own child
process, with no herdr or hc to install. It is for getting started; the
multiplexers are where agents outlive Obsidian, run on other machines, or get
a terminal (ADR-0007).

### Setting one up

**Add runtime**, then **Kind** → **Claude, run by Obsidian**. The target is
this machine and cannot be changed. Two fields:

- **Claude binary**: empty means the `claude` found in `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, the extra PATH entries, then your login
  shell's PATH. Set it when Obsidian cannot find Claude.
- **Permission mode**: what new and resumed agents may do without asking:
  **Ask (default)**, **Accept edits**, **Plan**, **Auto** or **Don't ask**.
  It is passed to every process with `--permission-mode`, so your own Claude
  default never decides it. In the default mode every tool that needs a
  permission waits for you on the native view's waiting card.

Make it active with the plug, or with the switcher, like any other runtime.
The settings status names the binary, the permission mode and how many agents
run and how many are stopped.

### What works

- **Start agent here** from a folder's menu, the command, or the plus in the
  agent list starts one in that folder. Its process starts at once, so the
  first prompt does not wait for it, and its tab opens in the native view.
- **The agent list** shows every session the plugin started in this vault.
  Running ones show their live status from Claude's own stream: working,
  done, or blocked with what it waits for. After Obsidian restarts, or the
  plugin reloads, every row comes back **stopped**. Opening a stopped row, or
  sending it a prompt, resumes the conversation (`claude --resume`). This
  works in a symlinked folder and with `CLAUDE_CONFIG_DIR` set, since the row
  records that its session started rather than guessing where Claude put the
  file.
- **The native view** is the only view: prompts, queued prompts, `/` commands
  and **Stop** (which interrupts the running turn) go straight to the
  process, and the waiting card answers permissions, questions and plans
  itself ([native-view.md](native-view.md)). `/clear` is followed, and the
  row keeps the new session, so a later resume reopens the conversation after
  the clear.
- **The row menu** has **Stop agent** for a running row: the turn is
  interrupted, the process ends, and the row stays as a stopped session.
  **Forget agent** removes a stopped row; Claude keeps its transcript in
  `~/.claude/projects` (or under `$CLAUDE_CONFIG_DIR`). **Continue in herdr** or **Continue in herdr-core**
  appears when such a runtime is configured on this machine: it stops the
  process, starts `claude --resume <session>` in the same folder on that
  runtime, switches the list there, and removes the row here.
- Pins work as on herdr, stored in the plugin's settings.

### Limits

- **No terminal view** in this version. The tab's view switch shows the
  terminal disabled, with the reason; the terminal through `script(1)` comes
  later.
- **Agents end with Obsidian.** Closing Obsidian, unloading or reloading the
  plugin, or removing the runtime stops every agent in order: what is waiting
  for an answer is denied, a running turn is interrupted, then the process
  gets end of input, then SIGTERM, then SIGKILL. Switching to another runtime
  does not stop them: their rows come back live when you switch back, and an
  agent left waiting on a permission waits for you.
- **This machine only.** Over SSH, use herdr or herdr-core.
- **No tabs, splits, focus or rename.** The row name is the folder's, made
  unique like herdr's agent names.
- **"Always allow in this project"** writes to the `.claude/settings.local.json`
  of the agent's git repository, not of its folder: in a vault that is a git
  repository, that is the vault's root, and the rule applies to every agent
  in the vault. Outside git it is the folder's own file. The card names the
  exact file and says how far the rule reaches before you press it, and the
  button is left out where the file cannot be told for sure.
- Sign-in, API key and model errors show as a notice with Claude's own words
  and its reason, such as `api_error`; the agent stays usable after them.

### Checking by hand

```bash
which claude && claude --version
```

## Upgrading from the local/remote settings

Versions up to 0.4.0 had a local herdr and one remote profile. On first load the
plugin turns them into runtimes and saves once:

- the local herdr becomes **Local**, with your socket path, binary and
  workspace ID;
- a remote profile with an SSH host becomes a runtime named after the host, with
  its socket, binary and vault path, whether it was switched on or not;
- the workspace ID goes to both, since it applied to whichever was connected;
- whichever of the two was in use stays active.

Pinned agents and open terminal tabs stay attached to the same herdr.
