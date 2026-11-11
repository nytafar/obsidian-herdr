# Changelog

All notable changes to Gjetr (Herdr for Obsidian). Versions are the bare
`manifest.json` version, which is also the release tag.

## Unreleased

### Changed

- **Requires Obsidian 1.13.4 or later.** Older Obsidian keeps 0.7.1, the last
  release for it.
- **Settings are searchable**: Obsidian's settings search finds every Gjetr
  setting by name, "terminal engine" or "status bar counts" for example.
- **Settings in pages**: the tab opens on the connection status, then one
  page each for Runtimes, Agents, Views, Terminal, and Agent list and
  notifications. The entries show the active runtime, the default view and the
  terminal engine. Every setting keeps its stored value and what it does.
- **The agent list opens when you turn the plugin on**, so a new user finds
  it without the command palette. It opens only then, not on every start, so
  a list you closed stays closed.

## 0.7.1 — 2026-11-11

### Added

- **Tabs named after their folder on herdr-core**: an agent started from a
  folder gets a tab named after that folder in Herdr, as on herdr. A tab that
  already has a name keeps it.

### Fixed

- **Native view after the terminal**: a tab that had shown the terminal
  (ghostty-web) before switching to the native view could not be typed in or
  scrolled. The terminal engine no longer leaves its listeners behind.
- **Wheel in full-screen agents on herdr-core and Claude run by Obsidian**:
  the wheel scrolls the agent's own view (Claude Code's `"tui":
  "fullscreen"`, for one) instead of stepping through its prompt history.

## 0.7.0 — 2026-11-07

The native view catches up with Claude Code's own: answer it, steer it and
read it without switching to the terminal. Gjetr is now in Obsidian's
community plugins.

### Added

- **Answer from the view on herdr and herdr-core**: questions (with typed
  answers, option descriptions and the recommended one marked), permissions,
  plans and the folder trust prompt, from the waiting card. The card says when
  it is sending, shows errors inline, folds, and works from the keyboard.
- **Session bar** in the prompt box: model, effort and permission mode
  pickers, and the context used; a click on it shows Claude's context
  breakdown. Works on herdr, herdr-core and Claude run by Obsidian.
- **Prompt box**: one box with a toolbar strip. New settings **Prompt box
  style** (Divided, Joined, Floating) and **Context readout** (Detail, or a
  gauge with the tokens in its tooltip).
- **Queued prompts** held by the plugin, with Send now, Edit and Discard.
- **Images** in prompts: shown in the conversation, pasted or dropped into the
  prompt box.
- **To-do list** rendered and kept in view; **subagents** followed while they
  run; the **plan** on herdr and herdr-core read from Claude's plan file.
- **Copy** a reply as Markdown or plain text, and a prompt.
- **Timestamps and turn durations**, and work Claude resumes on its own after
  an answer.
- **Commands** to focus the prompt, jump between turns and find in the
  conversation; a jump-to-latest button.
- Long sessions load a page of turns at a time, with earlier ones on request.

### Changed

- Tool groups stay open while Claude writes, and their header says working,
  needs you or done, with failed calls counted. Only changed items redraw.
- Narrow sidebar and reduced-motion layouts; a failed read retries.
- A pane running another agent than Claude stays a terminal instead of
  opening an empty native view.
- README: install from the community plugins directory.

### Fixed

- Enter in the prompt box threw "isOpen is not a function" when deciding
  between picking a `/` or `@` suggestion and sending.
- Prompts with a pasted image or block no longer vanish; compaction shows as a
  divider; turns abandoned by a rewind or cancelled re-send go away; a `/clear`
  inside the same file no longer keeps stale tool calls; Claude's own notices
  show; background command notifications are told from subagents', and running
  work is marked lost when Claude exits.
- herdr panes find their transcript under `CLAUDE_CONFIG_DIR` and in symlinked
  folders.
- A queued prompt that runs as its own turn is no longer dropped; Claude run by
  Obsidian no longer stays working after its turn ends.
- Typing into a herdr-core terminal no longer resizes it to 200×120.

## 0.6.1 — 2026-11-06

For the community directory's review.

### Changed

- **Description**: "Run persistent agents in your vault locally or remotely
  using herdr or herdr-core."
- **Release assets carry build provenance attestations**, so a download can be
  checked against the workflow that built it from this repository.
- **README** says what the plugin uses on your machine: the programs it starts,
  the files it reads and writes outside the vault, the vault's file list, the
  clipboard, and that it sends nothing over the network except SSH to your
  hosts.

### Fixed

- Terminal underline and overline styles use `text-decoration-line` and
  `text-decoration-style`, which every supported Obsidian build has; the dim
  rule and the prompt box's height no longer need `!important` or a duplicate
  declaration.
- The connection and terminal modules time with Node's timers instead of
  `globalThis`, and the element check uses Obsidian's cross-window
  `instanceOf`.

## 0.6.0 — 2026-11-06

### Changed

- **The plugin is now Gjetr, id `gjetr`.** Commands
  read **Gjetr: Show agents** and so on, the settings tab is **Settings →
  Gjetr**, and the plugin folder is `.obsidian/plugins/gjetr/`. The GitHub
  repository stays `nytafar/obsidian-herdr`, so BRAT keeps working.
- Settings carry over: on the first load as `gjetr`, the plugin copies
  `.obsidian/plugins/herdr/data.json` when that folder is this plugin's (its
  manifest is ours, or, without one, the file has this plugin's own settings
  keys), saves it once and says so in a notice. Another plugin's data in that
  folder is never read in, and the old folder is never changed or removed.
  Hotkeys bound to the old `herdr:` command ids have to be set again.
- The old install is turned off: when this plugin's `herdr` copy is still
  enabled beside Gjetr (BRAT and a manual update leave it enabled), Gjetr
  disables it at load, before registering its views, and says so. Another
  plugin with the `herdr` id is never touched.

## 0.5.0 — 2026-11-06

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
- **Terminal view for Claude, run by Obsidian** (Linux only for now: off on
  macOS until its written path is verified there, which the settings status
  and the view switch say; not on Windows): the tab's view switch shows Claude's own
  terminal interface, on a real terminal from `script(1)`, in the runtime's
  permission mode. An agent runs one Claude at a time, so switching the view
  moves it between the headless process and the terminal with
  `claude --resume`, between turns only; while it works, the switch waits and
  the tab says why. A prompt sent from the native view to an agent in its
  terminal moves it back first and is delivered there, or the send fails
  with the reason (a Stop came first); it is never sent later. A tab opened
  while a switch runs waits for it. Stop, Forget, Continue in and unloading
  hold the agent while they end it, so nothing (a tab opening, a turn
  ending) starts it again behind them, and Continue in starts the session on
  the other runtime only once the process here is gone. A stopped agent's
  terminal tab that was hidden says the agent stopped when you show it again,
  and starts it only when you click Reconnect. Permissions asked in the terminal are answered there,
  and the agent list follows the status Claude reports to the terminal; a
  terminal that reports none (Claude before 2.1.295) shows as unknown, and
  moving it to the native view asks first, since a turn may be running.
  Closing the tab keeps Claude running, and opening it again in the same
  session shows the same screen, replayed without the terminal queries in
  it, so the reopened tab types no answers into the program. Resizing reaches Claude. A watchdog beside
  each terminal ends it within a second if Obsidian is killed.
- **Open shell here** for Claude, run by Obsidian (Linux only, as the
  terminal view): a plain shell in a
  folder, in a terminal tab of its own, from the folder menu or the command.
  It lives while a tab shows it. Ctrl-C interrupts what runs in it, the
  command it was opened with included (Get started's installer).
- **Get started** (ADR-0008): while no runtime connects, the agent list
  shows a guided start, also behind a `Get started` command. Start at once in
  Claude, run by Obsidian (the runtime is added, made active, and an agent
  starts in the vault), or install herdr-core with its official command:
  copy it, run it in a terminal tab, or ask Claude to run it. Ask Claude
  always starts in the asking permission mode, whatever the runtime's mode,
  so the command waits on a permission card, which offers only Allow once
  and Deny: no session or project rule for the installer is ever saved, and
  that agent has no terminal view, where Claude's own dialog could save one. **Check again** finds `hc`
  afterwards and adds herdr-core on this machine in one click, then offers
  the Claude session hook. A link covers herdr instead. The plugin never
  downloads or installs anything itself.
- **herdr 0.9.5**: the types are regenerated from it. The client records the
  server's version so features can be gated on it, and it recovers from the
  `events_lost` subscription error (0.9.2+) by resubscribing and taking a
  fresh snapshot.
- **Agent catalog** (#125): the + button and its menu list the agent CLIs
  installed on the active runtime's machine, checked once per connection
  (this machine's binary search, one `ssh` to an SSH herdr host, one
  `machine.exec` on herdr-core over SSH), plus hc's templates on herdr-core
  and your own entries from **Settings → Herdr → Agents**: a wrapper, another
  command or extra arguments. An entry that cannot start on the runtime is
  greyed with the reason; one of your own whose command was not found is
  marked so and still starts. On an SSH host the check uses the PATH of your
  own shell there, the one agents start in. On herdr, kinds the server's version does not
  accept are left out. Entries can be hidden from the menu, and **Check
  again** looks again after an install.
- **Agent CLIs on every machine** (#125): each agent CLI row in
  **Settings → Herdr → Agents** says which machines of your configured
  runtimes have it ("Found on this machine and lasse@mac. Not found on
  xl."), not only the active runtime's. Machines other than the active
  runtime's are checked when the section draws, once per opening of the
  settings and in parallel, and again on **Check again**; a machine that
  cannot be checked is named once. The active runtime's catalog still decides
  the menu and the default.

### Changed

- **The + button** sits at the far right of the agent list's toolbar. A left
  click starts the runtime's default agent at the vault root, a right click
  opens the agent catalog. The default is per runtime (**Default agent** in
  the runtime's form) and falls back to the first installed entry; if nothing
  is found, + says so instead of starting anything.
- **Default agent kind** is gone: it migrates to every herdr and herdr-core
  runtime's own default on first load, so the agent you chose keeps starting.

- The remote profile and the global socket, binary and workspace settings
  have moved into runtimes. They migrate on first load, and pins and saved
  terminal tabs keep their runtime. **Downgrading below this version loses
  the remote profile**, because the old keys are no longer written. A remote
  set up again in the older build comes back as an extra, inactive runtime
  on the next upgrade, and a runtime of a kind this build does not know (a
  newer build's) is kept in `data.json` rather than erased.
- A runtime keeps its id when you edit its host, so pins and saved tabs
  survive the edit.
- An SSH herdr runtime finds herdr on the remote host by itself when **Remote
  herdr binary** is empty, the new default: the remote PATH, then
  `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. A Mac remote with
  Homebrew's herdr works without typing its path. A binary left at the old
  default `~/.local/bin/herdr` becomes the search; a path you chose is kept.
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

- herdr-core: a vault now finds its herdr-app space when that space has no
  stored name and Herdr UI shows it under its first terminal's folder, as on
  the Mac, where every space had `name: ""`. Such a space matches when its
  first terminal's working directory is the vault or inside it (the plugin
  has no git top to compare, as Herdr UI does). If several match, the first
  in Herdr UI's order wins. Agents started from the plugin then get the space
  label again and show up in Herdr UI. Existing terminals are not relabelled.
- After a runtime switch, a native tab on the other runtime keeps what it
  showed and says its runtime is not connected, instead of showing the newly
  active runtime's pane with the same id. The table of contents follows the
  same runtime-and-pane pair.
- A transcript replaced or truncated under the native view is read again from
  the start instead of being appended to the old session's turns, and a file
  renamed over the transcript is followed at once rather than after the next
  2 s poll. A long transcript's first read is taken 1 MB at a time.
- The agent catalog no longer lists a CLI whose only trace is a mise or asdf
  shim for a tool that is not active in the vault. The check asks `mise
  which` (or `asdf which`) from the vault root, on this machine and on SSH
  and herdr-core hosts (from the remote vault path); if the manager cannot
  answer, the shim counts as before.
- pi started on herdr-core no longer drops out of the agent list once hc sees
  its foreground (`node`, titled `pi`): the process title is read too. Agents
  the plugin starts on herdr-core also carry an `obsidian-herdr.agent` label
  with their kind, so an unrecognised foreground never drops their row.

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
