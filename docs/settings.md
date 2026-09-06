# Settings

All under **Settings → Herdr**. Sentence case names match the UI.

## Connection

| Setting | Meaning |
|---|---|
| Socket path | Unix socket of the running herdr server. Default `~/.config/herdr/herdr.sock`; the plugin also asks `herdr status server --json` and prefers its answer. |
| Herdr binary | Absolute path to `herdr`. Empty means auto-discovery in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, the extra PATH entries, then your login shell's PATH. Set it when Obsidian was launched from the Dock. |
| Extra PATH entries | Colon-separated directories prepended to `PATH` for every process the plugin spawns, so your agents find their tools. |
| Workspace ID | Pins the herdr workspace. Empty means resolve by label equal to the vault folder name, then by the workspace with the most panes inside the vault path. |

## Remote host

See [remote.md](remote.md). **Use a remote herdr**, **SSH host**, **Remote socket
path**, **Remote herdr binary** (absolute path), **Remote vault path** (required).

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

## Terminal

| Setting | Meaning |
|---|---|
| Attach mode | Control (type, scroll, the pane follows the tab's size) or observe (read-only, never resizes). Switchable per tab with the eye button. |
| Terminal placement | Where a new terminal opens when the active note is inside the agent's folder: split right (default), split left, or a plain tab. Unrelated notes always get a tab. |
| Terminal tab | Per agent (default): one tab per agent, reopening reveals it. Reuse: one tab, opening another agent switches it. Reuse saves roughly five megabytes per agent. |
| Theme | Follow Obsidian (default), or Ghostty dark, Ghostty light, Solarized dark, Solarized light, Gruvbox dark, Dracula, Nord, One dark. Applies to open terminals at once. |
| Terminal engine | ghostty-web (default) or xterm.js. ghostty-web parses faster and handles complex scripts better but keeps its memory until Obsidian restarts; xterm.js gives memory back when a tab closes and stops drawing when hidden. Switch if Obsidian feels heavy with several terminals open. Open terminals are rebuilt on change. |
| Font family, Font size | Override Obsidian's monospace font. Empty or 0 follows Obsidian. |
| Scrollback memory budget | Megabytes of memory each visible terminal may use for scrollback, roughly 600 lines per MB. Default 10, range 1 to 64. With ghostty-web this memory is kept until Obsidian restarts. Note that scrolling in a control terminal moves herdr's own scrollback, not this buffer. |

Hidden terminal tabs release their session and their renderer after thirty
seconds and rebuild when revealed, so only visible terminals pay for memory and
repaints. A control tab therefore hands control back to herdr while hidden.
