# Using Herdr for Obsidian

The day-to-day: the agent list, terminals, the native view, starting agents
and notifications. Where something works on one runtime only, it says so;
[runtimes.md](runtimes.md) has the full picture per runtime.

## The agent list

**Herdr: Show agents** opens it in the left sidebar; it stays wherever you
drag it. Only agents are listed: plain shells stay out.

Each row is one agent: a kind icon coloured by status (orange blocked, green
done, blue working, faint idle), the agent's name, its current task from the
terminal title, a prompt-cache countdown while one is running, and its folder.

The toolbar at the top of the list switches runtime, sets sort (herdr's own
priority order, or alphabetical) and grouping (herdr tab, working directory,
or none), opens quick settings, and ends with the **+**.

Clicking a row opens the agent. On herdr, the button that appears on hover
jumps to the pane in the herdr TUI, and a setting swaps the two.

## Terminals

A terminal tab attaches to the agent's pane in one of two modes, switchable
with the eye button:

- **Control** (default): you type, you scroll, and the pane follows the
  Obsidian tab's size while the tab is visible. herdr allows one controller
  per pane, so attaching takes over. A control tab left hidden for thirty
  seconds hands control back and takes it again when you return.
- **Observe**: read-only, never resizes, any number of watchers.

Shift+Enter inserts a line break in the agent's composer instead of
submitting. Scrolling moves the pane's own scrollback, so what you see is
what the TUI sees. Text selection works as usual; mouse clicks are not
forwarded to the agent yet.

By default a terminal opens beside the note when the note lies in the
agent's folder, otherwise as a tab; **Terminal placement** and **Terminal
tab** change that, including a mode that reuses one tab for whichever agent
you pick. Colours follow Obsidian or one of eight built-in palettes. Two
terminal engines are available; see [settings.md](settings.md) for when to
switch.

## The native view

For Claude Code, a tab can show the session as Markdown instead: the prose
reads like a note, each turn's tool calls collapse into one line, "Updated
[[note]]" links to what the agent changed, and the prompt box under the
transcript sends or queues your next prompt. When the agent stops to ask
something, a card names the block and offers to open the terminal. The
header button on the tab switches between terminal and native view, and
**Default view** in settings sets which one a new tab opens in. See
[native-view.md](native-view.md).

## Starting agents

- **The +** in the agent list's toolbar: a left click starts the runtime's
  default agent at the vault root; a right click lists the agent CLIs
  installed on the runtime's machine, plus your own entries. See
  [runtimes.md](runtimes.md#starting-agents-the--button-and-the-agent-catalog).
- **Folders**: hover a folder in the file explorer for the herdr button, or
  right-click it for **Start agent here**. Either starts the default agent
  in that folder, named from the pattern in settings.
- **The command palette** has the same actions for the active note's folder.

On herdr, a second agent in the same folder splits that folder's herdr tab
rather than opening another, up to a cap; turn **Share a herdr tab** off to
give every agent its own tab. On herdr-core, agents land in the vault's
Herdr UI space.

## Notifications

Only two transitions interrupt you: an agent becoming **blocked** (it wants
you) and becoming **done**. Each can raise an in-app notice and, while
Obsidian is unfocused, a system notification. A pane whose terminal you have
open never notifies.

What marks an agent seen depends on the runtime: on herdr, focusing its pane
in herdr; on herdr-core, looking at it in a terminal tab here, which every
herdr client shares.

## When something is off

**Settings → Herdr** opens with a status block: which binary was found, which
socket or connection answers, the server version, and which workspace or
space matched your vault. Every setup problem shows up there first;
[troubleshooting.md](troubleshooting.md) explains the messages.
