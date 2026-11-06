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
  splits, rename and focus don't exist in hc and are hidden.
- **Claude session hook** for herdr-core: a command and a button in the
  runtime's settings install, update or remove a Claude Code `SessionStart`
  hook on the runtime's machine, local or over SSH. It labels each hc
  terminal with its Claude session (`obsidian-herdr.session`). The modal shows
  the exact script and settings entry first. Every other Claude setting keeps
  its value; the file is rewritten in standard JSON formatting, and a rewrite
  that would change a value is refused.
- **Native view on herdr-core**, on this machine and over SSH: a Claude in an
  hc terminal labelled by the session hook opens in the native view. The
  label counts only while its pid is the terminal's foreground process, so a
  Claude that exited or a child Claude never takes over the tab. It follows
  `/clear` and `--resume`, sends and queues prompts, `/` commands and keys
  through hc, and the waiting card names hc's blocked kinds. Over SSH the
  transcript and subagent reports are read with hc's `file.read` on the
  runtime's connection, paged, restarted when the file is replaced or
  truncated, and read when the agent's status changes and every 2 s while it
  works. A terminal without the label stays a terminal and its view switch
  names the install command; one whose label names another process (a
  wrapper that forks Claude) says that instead. Reading an agent in the
  native view marks it seen in `herdr.seen`, as a terminal tab does. A
  transcript hc's `file.read` refuses outright (over 64 MB, or a first line
  over 8 MB) is named in the view instead of leaving it empty. `@` mentions
  on an SSH runtime name the remote vault's file, and its `/` list offers the
  remote machine's commands and skills (user, plugin and the pane's project),
  read over the runtime's connection; while they cannot be read it offers
  only the built-ins.
- **Claude, run by Obsidian**: a third runtime kind and a simple mode that
  needs no multiplexer. The plugin starts Claude Code itself on this machine,
  in Claude's own stream-json mode, and its agents open in the native view.
  Status comes straight from Claude: working, done, or blocked with what it
  waits for. Done clears once you look at the agent in the native view,
  including a turn that ends while you are watching it. After a restart the agents come back as **stopped** rows;
  opening one or sending it a prompt resumes the conversation, in a symlinked
  folder and with `CLAUDE_CONFIG_DIR` set too. The waiting
  card answers Claude's dialogs itself: Allow, Deny, **Allow for this
  session**, and **Always allow in this project**, which names the exact
  `.claude/settings.local.json` Claude writes, at the root of the agent's git
  repository rather than in its folder, and says the rule then covers every
  agent in that repository; it is left out where that file cannot be told for
  sure; a question's options; a plan's
  approval, or its rejection with feedback. Nothing is answered for you and
  nothing times out; while an agent stops, its card says so and takes no
  answer, since stopping denies what waits. A **Stop** button interrupts the running turn. The row
  menu has **Stop agent**, **Forget agent** for a stopped row, and **Continue
  in herdr** or **Continue in herdr-core** once the session has had a turn,
  which hands the conversation to such a runtime with `claude --resume`, in
  the same permission mode. The permission mode is a runtime
  setting (default: ask, passed as Claude's documented `manual`). Agents end when Obsidian closes or the plugin
  unloads. See [docs/runtimes.md](docs/runtimes.md).
- **Terminal view for Claude, run by Obsidian** (Linux; macOS written but not
  yet verified; not on Windows): the tab's view switch shows Claude's own
  terminal interface, on a real terminal from `script(1)`, in the runtime's
  permission mode. An agent runs one Claude at a time, so switching the view
  moves it between the headless process and the terminal with
  `claude --resume`, between turns only; while it works, the switch waits and
  the tab says why. Permissions asked in the terminal are answered there,
  and the agent list follows the status Claude reports to the terminal.
  Closing the tab keeps Claude running, and opening it again in the same
  session shows the same screen. Resizing reaches Claude. A watchdog beside
  each terminal ends it within a second if Obsidian is killed.
- **Open shell here** for Claude, run by Obsidian: a plain shell in a
  folder, in a terminal tab of its own, from the folder menu or the command.
  It lives while a tab shows it.
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
- **Trust new folders automatically** only answers a trust prompt the runtime
  itself identified. herdr reports no kind of block, so on herdr the setting no
  longer presses anything: a block before the session exists looks the same at
  the trust prompt as at a sign-in, and `Down Enter` would land on the wrong
  dialog. herdr-core reports no trust kind either, and Claude asks there
  before its session hook labels the terminal, so today the setting does
  nothing on any runtime and says so. The waiting card's **Trust this
  folder** button still answers it.

### Fixed

- After a runtime switch, a native tab on the other runtime keeps what it
  showed and says its runtime is not connected, instead of showing the newly
  active runtime's pane with the same id. The table of contents follows the
  same runtime-and-pane pair.
- A transcript replaced or truncated under the native view is read again from
  the start instead of being appended to the old session's turns, and a file
  renamed over the transcript is followed at once rather than after the next
  2 s poll. A long transcript's first read is taken 1 MB at a time.

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
