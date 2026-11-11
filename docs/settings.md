# Settings

All under **Settings → Gjetr**, which needs Obsidian 1.13.4 or later. Sentence
case names match the UI.

Obsidian's settings search finds a setting by its name, its description or
the other words it is known by, but only while it is shown: a field hidden
because of another choice (a runtime's kind or target, a toggle that is off)
is found through the page or the row that holds it. "Permission mode" finds
the runtime pages, through their Kind, and "panes per herdr tab" finds
**Share a herdr tab between agents in the same folder**.

The tab opens on one line naming the active runtime, then one entry per
page: Runtimes, Agents, Views, Terminal, and Agent list and notifications. An
entry shows the page's main value where it has one: the default view, the
terminal engine.

Every fact is shown in one place, next to where you act on it, and state
lives with what it describes. The root says which runtime is active and
whether it is connected; that runtime's page says how, at its top; the
runtime list marks the active runtime and the ones with problems.

## Active runtime

| Setting | Meaning |
|---|---|
| Active runtime | "Active runtime: Local · connected", or "connecting" or "not connected", as a warning while it is not connected or has an error, a protocol mismatch or a kind this build cannot run. Click it to open that runtime's page, where the Status group says why, or Problems where its setup is the cause. It follows the connection as it changes. |

## Runtimes

The herdr, or herdr-core, instances the plugin can connect to, on this machine
or over SSH, or Claude run by Obsidian on this machine, and which one is
active. Each runtime has its own binary, socket, remote vault path and
workspace. See [runtimes.md](runtimes.md) for adding, editing, removing and
switching, and for every field. The page's entry carries a warning mark
while any runtime has a problem, as that runtime's row does.

The **Runtimes** list has one row per runtime, in the switcher's order: its
name, what it is and where, **Active** on the active one, and a warning mark
when it has a problem. A row opens the runtime's own page. The + in the
list's header (**Add runtime**) adds a herdr runtime over SSH and opens its
page. With a row focused, Delete removes the runtime after asking and
Alt+Up or Alt+Down moves it; the same three are rows of the runtime's page.
A runtime added or made active elsewhere (**Get started**, the agent list's
switcher, **Gjetr: Switch runtime**) shows in the list at once.

A runtime's page shows the fields its kind and target use: changing **Kind**
or **Target** shows and hides them. Settings search finds the fields shown
now by their names, and finds every runtime page by "socket path", "SSH
host", "binary", "workspace", "permission mode" or "default agent", whatever
its kind.

### Status

The active runtime's page opens on its Status group; other runtimes' pages
have none, and say "Not active" by **Use this runtime**.

| Setting | Meaning |
|---|---|
| Connection | The live connection: which binary was found, which socket or connection answers (and the SSH tunnel), the server version and protocol, mismatches, which workspace or space matched the vault, and the last error. What the runtime's setup lacks is under **Problems** instead. [troubleshooting.md](troubleshooting.md) explains the messages. It follows the connection as it changes. |

### Fields

| Setting | Meaning |
|---|---|
| Name | What the switcher, the status bar and the list call it. Empty uses a name derived from kind and host, which the empty field shows greyed. |
| Kind | Herdr, herdr-core (hc), or Claude, run by Obsidian, which starts Claude Code itself with no multiplexer. |
| Target | This machine or an SSH host. Not shown for Claude run by Obsidian, which is this machine only. |
| Claude binary | Claude run by Obsidian only. An override for auto-discovery of `claude`, empty to search. |
| Permission mode | Claude run by Obsidian only. What its agents may do without asking; the default asks for every tool that needs a permission, on the native view's waiting card. |
| Terminal view | Claude run by Obsidian only. Not available yet: its agents open in the native view. |
| Socket path / Remote socket path | herdr only. The server's socket on the target. Default `~/.config/herdr/herdr.sock`. |
| Herdr binary / Remote herdr binary | An override for discovery, empty to search: locally Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH; over SSH the remote PATH, then Homebrew, /usr/local/bin and ~/.local/bin on the remote host. |
| Hc binary / Remote hc binary | herdr-core only. The same for `hc`: locally the usual places and a login-shell PATH; over SSH `hc` or `herdr-core` on the remote PATH, then ~/.local/bin. |
| SSH host, Remote vault path | SSH targets only. The vault path is required for folder actions. |
| Workspace ID / Space | Pins the workspace (herdr) or space (herdr-core). Empty resolves by the vault folder's name, then by working directories inside the vault. |
| Claude session hook | herdr-core only. Whether the hook that lets the native view follow Claude in its terminals is installed on the runtime's machine, and **Review** to install, update or remove it. The active runtime only. See [runtimes.md](runtimes.md#the-claude-session-hook). |
| Default agent | herdr and herdr-core only. What the + button and **Start agent here** start on this runtime. **First installed** (the default) is the first agent CLI of its catalog found on its machine; a choice it cannot start falls back to it. |
| Problems | What the runtime's setup lacks, such as an SSH host or the remote vault path folder actions need, or a kind this build cannot run; else "None.". Updated as you type. |
| Use this runtime / Reconnect | Makes the runtime active, as the switcher does; on the active one, connects again. |
| Order | Its place in the list and the switcher, with buttons to move it up or down. |
| Remove runtime | **Remove** takes it out after asking, and goes back to the list; on an Obsidian without a way to leave a page, the page says it was removed instead. Its pinned agents are forgotten. The last runtime stays. |
| Add runtime | The + in the list's header. Adds a herdr runtime over SSH and opens its page. |

Fields of the active runtime reconnect as you type, after a short pause;
fields of another runtime are only saved. Renaming never reconnects.

The agent list's toolbar switches runtimes once there are two or more, and
**Gjetr: Switch runtime** does from the palette. With more than one runtime the
status bar names the active one.

### Connection

| Setting | Meaning |
|---|---|
| Extra PATH entries | Colon-separated directories prepended to `PATH` for every process the plugin spawns, so your agents find their tools. |

## Agents

### Agent CLIs

| Setting | Meaning |
|---|---|
| Agent CLIs | The active runtime's agent catalog, in two lists below this row: the agent CLIs found on its machine, then your own entries. Every row says what it runs and which machines of your runtimes have it, "Found on this machine and lasse@mac. Not found on xl.", with "Checking …" until a machine answers, and the rows change in place as each one does; a machine that cannot be checked is named once, on this row. Machines, not runtimes: every local runtime is this machine, and runtimes on one SSH host are that host. The active runtime's machine reads its connection's check; any other is checked directly (this machine's binary search, or one `ssh` to the host from its remote vault path, the active runtime's where two runtimes on one host differ, else the first one set), once each time the settings open, when the Agents page is first shown. **Check again** looks again on every machine, after you install one; otherwise each connection checks once. See [runtimes.md](runtimes.md#starting-agents-the--button-and-the-agent-catalog). |

### Built-in agent CLIs

| Setting | Meaning |
|---|---|
| Built-in agent CLI row | One per agent CLI the active runtime offers: herdr's agent kinds found on its machine, and on herdr-core hc's templates. A built-in only another machine has is listed too, greyed: it is not in the active runtime's menu. The eye hides it from the + menu, or shows it again. |

### Your agent CLIs

| Setting | Meaning |
|---|---|
| Add agent CLI | The + in the list's heading adds an entry at the end of the list and opens its page to fill it in. |
| Your agent CLI row | One per entry, opening its page. It shows on every runtime, marked as needing attention (with the reason in its line) where it cannot start, and "not found" (still startable) where its command was not found. The Agents entry carries a warning mark while one needs attention. With the row focused, Delete or Backspace removes it, after asking. |
| Name | On an entry's page. What the menu calls it. Empty shows the command. |
| Agent | On an entry's page. Which agent it is: what herdr starts and detects, and the row's mark. |
| Command | On an entry's page. Empty runs the agent's own program; a name or a path, `~/` is the home of the machine it runs on. |
| Arguments | On an entry's page. Plain words, separated by spaces. |
| Hide from the menu | On an entry's page. Keeps it out of the + menu on every runtime, as the eye does for a built-in. |
| Where it starts | On an entry's page. The runtime kinds that can start it, and why the others cannot. |
| Remove agent CLI | On an entry's page. **Remove** takes it out, after asking, with every runtime's default that named it, and goes back to the list; on an Obsidian without a way to leave a page, the page says it was removed instead. |

Typing on an entry's page checks nothing; going back to the Agents page checks a command the machines were not asked about yet.

### Starting agents

| Setting | Meaning |
|---|---|
| Agent name pattern | Name for started agents. `{folder}`, `{vault}` and `{n}` are replaced; `{n}` counts past names already taken anywhere in herdr. |
| Open terminal after starting an agent | Opens the new agent's terminal tab at once. |
| Share a herdr tab between agents in the same folder | On: a second agent in a folder splits that folder's herdr tab. Off: every agent gets its own tab, matching how herdr is navigated. |
| Panes per herdr tab | Shown while sharing is on, and found by search through the row above. How many agents share a tab before the next opens a new one. 1 to 4, default 2. |

## Views

The page's entry shows the default view.

| Setting | Meaning |
|---|---|
| Default view | What a tab shows until it chooses for itself: the native view (default) or a terminal. Each tab keeps its own choice, switched from its header button, its tab menu or **Gjetr: Switch render mode**. Native is offered for panes of a local herdr, and for herdr-core terminals on this machine or over SSH once the Claude session hook labels them; an SSH herdr runtime shows terminals. Open tabs that never chose follow it. |

### Native view

| Setting | Meaning |
|---|---|
| Tool groups | Highlight vault changes and sources (default): the notes the agent changed and the sources it read stay in the text where they happened, the rest of a turn's tool calls fold into one line. Collapse everything: every call goes inside the group. |
| Prompt box style | Divided (default): the strip with the pickers and buttons has its own background. Joined: one surface with the text. Floating: the box is raised over the conversation, with icon buttons. Applies to open native views at once. |
| Context readout | Detail (default): the tokens, the window and the share. Gauge: a small ring with the share, the tokens in its tooltip. Either opens Claude's context breakdown when clicked. |
| Trust new folders automatically | Answers Claude's workspace trust prompt for an agent open in a tab, on herdr and herdr-core, once the prompt is read on the screen and names the agent's own folder. Nothing else is answered for you: tool permissions, questions and plan approval stay yours, on the waiting card or in the terminal. Off by default. |

See [native-view.md](native-view.md).

## Terminal

The page's entry shows the terminal engine.

### Opening

| Setting | Meaning |
|---|---|
| Attach mode | Control (type, scroll, the pane follows the tab's size) or observe (read-only, never resizes). Switchable per tab with the eye button. |
| Terminal placement | Where a new terminal opens when the active note is inside the agent's folder: split right (default), split left, or a plain tab. Unrelated notes always get a tab. |
| Terminal tab | Per agent (default): one tab per agent, reopening reveals it. Reuse: one tab, opening another agent switches it. Reuse saves roughly five megabytes per agent. |
| Terminal tab title | Agent name (default): the name the agent list shows. Herdr tab label: the label of the herdr tab the agent runs in, as in herdr's own tab bar. While "Share a herdr tab" is on and a tab holds two agents, the agent name is appended so the two terminals differ. A label herdr has not reported yet, or a herdr without `tab.list`, falls back to the agent name. Open terminals retitle at once. |

### Look

| Setting | Meaning |
|---|---|
| Theme | Follow Obsidian (default), or Ghostty dark, Ghostty light, Solarized dark, Solarized light, Gruvbox dark, Dracula, Nord, One dark. Applies to open terminals at once. On ghostty-web the terminal is rebuilt to repaint it, so colours from before the switch are replayed as plain text; the session is untouched, so nothing is reattached or taken over. |
| Terminal engine | ghostty-web (default) or xterm.js. Applies to every tab showing a terminal, whatever the default view is. ghostty-web parses faster and handles complex scripts better but keeps its memory until Obsidian restarts; xterm.js gives memory back when a tab closes and stops drawing when hidden. Switch if Obsidian feels heavy with several terminals open. Open terminals are rebuilt on change. |
| Cursor style | Shape of the terminal cursor: block (default), underline or bar. Applies to open terminals at once, on both engines. |
| Blinking cursor | Whether the terminal cursor blinks. On by default. Applies to open terminals at once, on both engines. |
| Font family, Font size | Override Obsidian's monospace font. Empty or 0 follows Obsidian. |
| Scrollback memory budget | Megabytes of memory each visible terminal may use for scrollback, roughly 600 lines per MB. Default 10, range 1 to 64. With ghostty-web this memory is kept until Obsidian restarts. Note that scrolling in a control terminal moves herdr's own scrollback, not this buffer. |

Hidden terminal tabs release their session and their renderer after thirty
seconds and rebuild when revealed, so only visible terminals pay for memory and
repaints. A control tab therefore hands control back to herdr while hidden.

## Agent list and notifications

### Agent list

| Setting | Meaning |
|---|---|
| Sort | Priority (herdr's own: blocked, done, working, idle, unknown, most recent change first among equals) or alphabetical. Also in the list's header menu. |
| Group by | Herdr tab, working directory, or nothing. Folder grouping keeps a folder's agents together whichever tab herdr put them in. |
| Clicking an agent row | Opens the terminal (default) or focuses the pane in herdr. The row's hover button does the other one; its tooltip says which. |
| Pinned panes | Not in the settings tab. Right-click a row and choose "Pin to top of group"; the pin is stored in `data.json` as `pinnedPanes`, a list of pane ids per runtime id, so a pin on one runtime never applies to another. Pinned rows lead their group whatever the sort, and unpin from the same menu. |

### File explorer

| Setting | Meaning |
|---|---|
| Folder hover button | The herdr button on folder rows (attach, start agent, copy path). It injects into Obsidian's explorer DOM, so it can be switched off if an update breaks it. The right-click menu is unaffected. |

### Notifications

| Setting | Meaning |
|---|---|
| Status bar counts | `N blocked · M done` for this vault's workspace; click reveals the list. |
| Blocked: notice, Blocked: system notification | Raised when an agent stops and wants you. System notifications only while Obsidian is unfocused. Defaults: both on. |
| Done: notice, Done: system notification | Raised when an agent finishes a turn. Defaults: notice on, system off. |
