# Changelog

All notable changes to Herdr for Obsidian. Versions are the bare
`manifest.json` version, which is also the release tag.

## Unreleased

Runtimes. The plugin now works with herdr-core (`hc`), herdrdev's headless
runtime, next to the herdr TUI, and the local/remote pair has become a list of
runtimes you add and switch between. See [docs/runtimes.md](docs/runtimes.md).

### Added

- **Runtimes**: each one is a kind (herdr or herdr-core) on a target (this
  machine or an SSH host), with its own binary, socket, remote vault path and
  workspace. One runtime is active at a time. With two runtimes the agent
  list's toolbar button toggles between them; with three or more it opens a
  menu. A `Switch runtime` command works for any number of runtimes.
- **herdr-core**: agents and their status from `hc`, locally and over SSH,
  scoped to the herdr-app space named like the vault, or else to terminals
  under the vault. Terminal tabs attach through one `hc connect` per tab, in
  observe or control mode. Pins use herdr-app's shared `herdr.pinned` label,
  and looking at a terminal tab writes `herdr.seen`, so "done" clears on every
  herdr client. You can start and terminate agents from the plugin. Tabs,
  splits, rename and focus don't exist in hc and are hidden. The native view
  is offered for herdr panes only, because hc reports no agent session.
- **Claude session hook** for herdr-core: a command and a button in the
  runtime's settings install, update or remove a Claude Code `SessionStart`
  hook on the runtime's machine, local or over SSH. It labels each hc
  terminal with its Claude session (`obsidian-herdr.session`). The modal shows
  the exact script and settings entry first and changes nothing else in the
  Claude settings. The native view does not read the label yet.
- **herdr 0.9.5**: the types are regenerated from it. The client records the
  server's version so features can be gated on it, and it recovers from the
  `events_lost` subscription error (0.9.2+) by resubscribing and taking a
  fresh snapshot.

### Changed

- The remote profile and the global socket, binary and workspace settings
  have moved into runtimes. They migrate on first load, and pins and saved
  terminal tabs keep their runtime. **Downgrading below this version loses
  the remote profile**, because the old keys are no longer written. A remote
  set up again in the older build comes back as an extra, inactive runtime
  on the next upgrade, and a runtime of a kind this build does not know (a
  newer build's) is kept in `data.json` rather than erased.
- A runtime keeps its id when you edit its host, so pins and saved tabs
  survive the edit.
- `unknown_method` errors now count as unsupported methods. herdr 0.9.5
  answers removed methods that way.

## 0.4.0 — 2026-09-15

The native view. A Claude Code session rendered as Obsidian Markdown, made for
knowledge work in the vault and kept apart from coding work, which stays in the
terminal. The native view is now the default for every tab; the terminal is one
click away on the tab's header. See [docs/native-view.md](docs/native-view.md).

### Added

- **Native view** (#91, #92–#101): the agent's prose through Obsidian's own
  renderer, so wikilinks, callouts, embeds, theme, fonts and readable line
  length all apply. Full history on open, scrolled to the bottom and following
  new content. Long sessions lay out only what is near the viewport.
- **Tool groups**: a turn's tool calls fold into one line that expands to the
  calls. Vault edits stay in the text as "Updated [[note]]" links and web
  search and fetch results as source links; a setting collapses those too.
  Thinking is a collapsed disclosure. A subagent's report reads as prose, its
  internals fold into the launching call.
- **Prompt box**: a chat input under the transcript. Send when the agent is
  idle, Queue while it works, with the queued prompt shown inline where the
  agent picked it up. `/` completes commands and skills from user, project and
  plugin scopes; `@` completes vault files and sends the mention the way Claude
  expects. The first prompt to a fresh Claude works from here.
- **Waiting card**: when the agent is blocked, a card names the block, shows
  the question, options or plan when the transcript has them, and offers
  **Open in terminal**. The workspace trust prompt can be answered from the
  card; **Trust new folders automatically** does it unasked. Nothing else is
  answered for you (#99).
- **Table of contents**: **Herdr: Show table of contents** lists turns and
  their headings where Obsidian's outline lives, follows the active native
  view, and scrolls to the heading you click (#100, #119).
- **Session following** (ADR-0003): the view follows the pane's agent session,
  so `/clear` empties it and `--resume` refills it. Two tabs on one pane share
  a model.
- **View switching**: a header button and a tab menu entry toggle a tab
  between the native view and the terminal (#105); each tab remembers its
  choice, and the terminal keeps its engine across the round trip (#104).
  **Herdr: Switch render mode** does the same from the palette.
- **Settings**: **Default view** (native or terminal, native by default),
  **Tool groups**, **Trust new folders automatically**. A vault that had chosen
  a terminal engine before this release keeps its terminals.
- Agent status is now polled from herdr, so status changes it never announces
  still reach the list and the notifications.
- `eslint-plugin-obsidianmd` runs in lint, with the real warnings fixed.

### Changed

- The default view for a tab is the native view. Set **Default view** to
  Terminal for the previous behaviour.
- A new terminal splits beside the note even when a terminal is the most
  recent leaf (#106).
- A just-started agent's terminal gets the working directory the scope lacks.
- The agent list drops rows for panes herdr no longer lists, for closed tabs,
  and after terminate clears a gone pane.

### Notes

- The native view is local panes only and Claude Code only; other agent kinds
  and remote panes show a terminal. Questions and plan approvals are answered
  in the terminal.
- Next up: the settings refactor (#120).

## 0.3.0 — 2026-09-13

- Architecture deepening (#80): endpoint session per connection generation,
  agent list row dispatch, pane terminal lifecycle module, terminal
  settings-effect matrix, settings section builders (#81–#85).
- herdr 0.9.0 protocol parity (protocol 22): types regenerated, `qwen` and
  `muse` kinds added.
- Binary discovery prefers the binary matching the running server's protocol
  (#87).

## 0.2.0 — 2026-09-06

- First public release (#13): agent list, terminals as tabs on two engines,
  notifications, start agents from folders, remote herdr over SSH.
