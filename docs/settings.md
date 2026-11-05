# Settings

All under **Settings → Herdr**. Sentence case names match the UI.

## Runtimes

The herdr, or herdr-core, instances the plugin can connect to, on this machine
or over SSH, and which one is active. Each runtime has its own binary, socket,
remote vault path and workspace. See [runtimes.md](runtimes.md) for adding,
editing, removing and switching, and for every field.

| Setting | Meaning |
|---|---|
| Runtime row | Name and what it is. The plug makes it active (or reconnects the active one), the pencil opens its form, the bin removes it after asking. The last runtime stays. |
| Add runtime | A new herdr runtime over SSH, its form open. |
| Name | What the switcher, the status bar and the list call it. Empty shows a name derived from kind and host. |
| Kind | Herdr, or herdr-core (hc), which this version lists but cannot connect yet. |
| Target | This machine or an SSH host. |
| Socket path / Remote socket path | herdr only. The server's socket on the target. Default `~/.config/herdr/herdr.sock`. |
| Herdr binary / Remote herdr binary | Locally an override for auto-discovery, empty to search; over SSH an absolute path on the remote host. |
| SSH host, Remote vault path | SSH targets only. The vault path is required for folder actions. |
| Workspace ID / Space | Pins the workspace (herdr) or space (herdr-core). Empty resolves by the vault folder's name, then by working directories inside the vault. |
| Problems | What the runtime still lacks, or "None.". |

The agent list's toolbar switches runtimes once there are two or more, and
**Herdr: Switch runtime** does from the palette. With more than one runtime the
status bar names the active one.

## Connection

| Setting | Meaning |
|---|---|
| Extra PATH entries | Colon-separated directories prepended to `PATH` for every process the plugin spawns, so your agents find their tools. |

## Notifications

| Setting | Meaning |
|---|---|
| Status bar counts | `N blocked · M done` for this vault's workspace; click reveals the list. |
| Blocked: notice / system notification | Raised when an agent stops and wants you. System notifications only while Obsidian is unfocused. Defaults: both on. |
| Done: notice / system notification | Raised when an agent finishes a turn. Defaults: notice on, system off. |

## Agents

| Setting | Meaning |
|---|---|
| Default agent kind | What **Start agent here** starts: claude, codex, gemini, opencode, pi, cursor, amp, copilot, kimi, droid or grok. |
| Agent name pattern | Name for started agents. `{folder}`, `{vault}` and `{n}` are replaced; `{n}` counts past names already taken anywhere in herdr. |
| Open terminal after starting an agent | Opens the new agent's terminal tab at once. |
| Share a herdr tab between agents in the same folder | On: a second agent in a folder splits that folder's herdr tab. Off: every agent gets its own tab, matching how herdr is navigated. |
| Panes per herdr tab | Shown while sharing is on. How many agents share a tab before the next opens a new one. 1 to 4, default 2. |

## File explorer

| Setting | Meaning |
|---|---|
| Folder hover button | The herdr button on folder rows (attach, start agent, copy path). It injects into Obsidian's explorer DOM, so it can be switched off if an update breaks it. The right-click menu is unaffected. |

## Agent list

| Setting | Meaning |
|---|---|
| Sort | Priority (herdr's own: blocked, done, working, idle, unknown, most recent change first among equals) or alphabetical. Also in the list's header menu. |
| Group by | Herdr tab, working directory, or nothing. Folder grouping keeps a folder's agents together whichever tab herdr put them in. |
| Clicking an agent row | Opens the terminal (default) or focuses the pane in herdr. The row's hover button does the other one; its tooltip says which. |
| Pinned panes | Not in the settings tab. Right-click a row and choose "Pin to top of group"; the pin is stored in `data.json` as `pinnedPanes`, a list of pane ids per runtime id, so a pin on one runtime never applies to another. Pinned rows lead their group whatever the sort, and unpin from the same menu. |

## Native view

| Setting | Meaning |
|---|---|
| Default view (under Terminal) | What a tab shows until it chooses for itself: the native view (default) or a terminal. Each tab keeps its own choice, switched from its header button, its tab menu or **Herdr: Switch render mode**. Native is offered for panes of a local herdr, and for herdr-core terminals on this machine or over SSH once the Claude session hook labels them; an SSH herdr runtime shows terminals. |
| Tool groups | Highlight vault changes and sources (default): the notes the agent changed and the sources it read stay in the text where they happened, the rest of a turn's tool calls fold into one line. Collapse everything: every call goes inside the group. |
| Trust new folders automatically | Answers Claude's workspace trust prompt from the native view, so an agent started in a new folder begins without a trip to the terminal. Only where the runtime identifies the prompt as the trust prompt: herdr reports no kind of block, so on herdr the waiting card's **Trust this folder** button answers it instead. Off by default. Nothing else is answered for you. |

See [native-view.md](native-view.md).

## Terminal

| Setting | Meaning |
|---|---|
| Attach mode | Control (type, scroll, the pane follows the tab's size) or observe (read-only, never resizes). Switchable per tab with the eye button. |
| Terminal placement | Where a new terminal opens when the active note is inside the agent's folder: split right (default), split left, or a plain tab. Unrelated notes always get a tab. |
| Terminal tab | Per agent (default): one tab per agent, reopening reveals it. Reuse: one tab, opening another agent switches it. Reuse saves roughly five megabytes per agent. |
| Terminal tab title | Agent name (default): the name the agent list shows. Herdr tab label: the label of the herdr tab the agent runs in, as in herdr's own tab bar. While "Share a herdr tab" is on and a tab holds two agents, the agent name is appended so the two terminals differ. A label herdr has not reported yet, or a herdr without `tab.list`, falls back to the agent name. Open terminals retitle at once. |
| Theme | Follow Obsidian (default), or Ghostty dark, Ghostty light, Solarized dark, Solarized light, Gruvbox dark, Dracula, Nord, One dark. Applies to open terminals at once. On ghostty-web the terminal is rebuilt to repaint it, so colours from before the switch are replayed as plain text; the session is untouched, so nothing is reattached or taken over. |
| Terminal engine | ghostty-web (default) or xterm.js. Applies to every tab showing a terminal, whatever the default view is. ghostty-web parses faster and handles complex scripts better but keeps its memory until Obsidian restarts; xterm.js gives memory back when a tab closes and stops drawing when hidden. Switch if Obsidian feels heavy with several terminals open. Open terminals are rebuilt on change. |
| Cursor style | Shape of the terminal cursor: block (default), underline or bar. Applies to open terminals at once, on both engines. |
| Blinking cursor | Whether the terminal cursor blinks. On by default. Applies to open terminals at once, on both engines. |
| Font family, Font size | Override Obsidian's monospace font. Empty or 0 follows Obsidian. |
| Scrollback memory budget | Megabytes of memory each visible terminal may use for scrollback, roughly 600 lines per MB. Default 10, range 1 to 64. With ghostty-web this memory is kept until Obsidian restarts. Note that scrolling in a control terminal moves herdr's own scrollback, not this buffer. |

Hidden terminal tabs release their session and their renderer after thirty
seconds and rebuild when revealed, so only visible terminals pay for memory and
repaints. A control tab therefore hands control back to herdr while hidden.
