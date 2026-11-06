# The native view

The native view shows a Claude Code session as Obsidian Markdown instead of a
terminal screen. It is the default view for every tab since 0.4.0, and the
plugin's answer to a simple observation: an agent doing knowledge work in a
vault writes prose, links and callouts, and a terminal is the wrong place to
read those. Coding work keeps the terminal; it is one click away on every tab.

## What you see

- **The agent's prose, rendered as a note.** Every assistant block goes
  through Obsidian's own Markdown renderer, so wikilinks resolve, callouts and
  embeds work, code blocks highlight, and your theme, fonts and readable line
  length apply. Relative links resolve from the agent's folder when it is
  inside the vault.
- **Your prompts** as plain text with wikilinks made clickable, so pasted
  snippets and `@` paths are not mangled.
- **Links open beside the view.** Clicking a wikilink opens the note next to
  the transcript, in the split beside it or in a leaf already showing that
  note, and never in place of the view. Ctrl-click (Cmd-click on macOS) opens
  a new tab, as in a note. Hold the same key while hovering for a page
  preview.
- **`obsidian://` links as note paths.** A link to a note in this vault, such
  as `obsidian://open?vault=…&file=…`, shows as the note's path from the vault
  root and opens inside the vault the same way, in prose (bare, in inline code
  or as a Markdown link, which keeps its label) and in your prompts. A link to
  another vault stays an ordinary external link.
- **Tool calls collapsed into one line per run**, such as "Read 4 files, ran 2
  commands", which expands to the individual calls. Two kinds stay visible in
  the text at the point they happened: vault edits, shown as "Updated
  [[note]]" with a live link, and web search and fetch results, shown as
  source links. The **Tool groups** setting folds those into the group too.
- **Thinking** as a collapsed "Thought" disclosure.
- **Subagents**: a delegated task's report reads like the agent's own prose,
  and its internals fold into the tool group of the call that launched it.
- **Steers**, prompts you sent while the agent was working, appear inline where
  the agent picked them up, so the transcript reads in order.
- **The full session history** on open, scrolled to the bottom, following new
  content as it arrives. Long sessions stay light: only turns near the
  viewport are laid out.

## The prompt box

A multi-line chat input sits under the transcript. The button reads **Send**
while the agent is idle and **Queue** while it is working; a queued prompt is
picked up mid-turn and shown inline once the agent takes it. Shift+Enter
inserts a line break. The box is disabled with a reason when the pane has no
agent, and while the agent is blocked on a question the card handles. On
Claude run by Obsidian a **Stop** button sits beside it while a turn runs:
it interrupts the turn, keeps what Claude had written so far, and leaves the
agent ready for the next prompt.

Typing `/` completes slash commands and skills from the user, project and
plugin scopes, with their descriptions; project scope wins, and discovery stops
at the repository or worktree root. They are the commands of the machine the
agent runs on: on an SSH herdr-core runtime, the remote's, from its home (or
`CLAUDE_CONFIG_DIR`), its plugins and the pane's remote folder. Typing `@` completes vault files and sends
the mention the way Claude expects: relative to the pane's working directory
when the file is inside it, absolute otherwise.

The very first prompt to a freshly started Claude can be sent from here. A
send that fails shows a notice.

## The waiting card

When the runtime reports the agent as **blocked**, the view shows a card naming
the block: the workspace trust prompt at startup, a sign-in, a question the
agent asked with its options, a plan awaiting approval, or a tool waiting for
permission. Every card has **Open in terminal**, which switches the tab to the
terminal so you can answer anything the view does not.

Which block it is comes from the runtime when the runtime says. herdr only says
"blocked", so on herdr the card reads it off the transcript instead: no
transcript yet is taken to be the trust prompt, and a call waiting for its
result is the tool asking for permission.

The trust prompt is the one block the view can answer for you: the card offers
**Trust this folder**, and the **Trust new folders automatically** setting
would press it without asking, but only when the runtime itself identified the
block as the trust prompt. No runtime does today, so the setting currently
does nothing and the button is the way. herdr reports no kind of block, and a
block before the session exists looks the same at the trust prompt as at a
sign-in or another startup dialog, so a guessed one is never answered unasked;
on herdr the card keeps its button and tells you to check the terminal first.
On herdr-core Claude shows the trust prompt before its `SessionStart` hook
runs, so the terminal has no session label yet and the tab shows the terminal,
where you answer it. Nothing else is answered on your behalf. Tool
permissions are Claude's own to ask; questions and plan approvals are yours.

### Cards that answer, on Claude run by Obsidian

On Claude run by Obsidian the agent's dialogs come to the plugin as requests
Claude itself waits on, so the card is the dialog and answers it directly.
There is no terminal there, and no **Open in terminal**. Nothing is pressed
for you and nothing times out: an unanswered card waits, and its row shows
the agent as blocked. Stopping the agent denies whatever it was waiting on;
until it has stopped, the card says so and takes no answer.

- **A tool permission** names the tool and what it acts on, with Claude's
  reason when it gives one (a path outside the folder). **Allow** and
  **Deny** answer this one call. When Claude suggests them, two more:
  - **Allow for this session**, with what it grants on the line beside it
    (accept file edits, access to a folder), until the agent stops.
  - **Always allow in this project**, with the rule, the exact file Claude
    writes it to, and how far it reaches. Claude keeps these rules per
    repository, not per folder: for an agent anywhere inside a git
    repository the file is `<repository root>/.claude/settings.local.json`,
    and the rule then applies to every agent in that repository and its
    worktrees. If your vault is a git repository, that is the vault's root,
    whatever folder the agent started in. A linked worktree writes to its
    main checkout. Outside git, and where the repository root is your home
    folder or not yours, the file is `<folder>/.claude/settings.local.json`
    and the rule applies to agents started in that folder. Where the file
    cannot be told for sure (a `.git` that is a link, a worktree of a bare
    repository), the button is not offered.
  A grant for your user-wide settings is never offered, and the tool's input
  is never changed: what Claude asked to run is what runs.
- **A question** shows its options as buttons. One question with one answer
  is answered by its button; several questions, or one that takes more than
  one answer, are sent with **Send answers** once each has one. **Dismiss**
  declines to answer.
- **A plan** is shown as Markdown with **Approve plan**, or **Reject** with
  what should change typed above it; Claude revises the plan and asks again.
- When Claude withdraws a request, as an interrupt does, its card goes.

## Table of contents

**Gjetr: Show table of contents** opens a sidebar listing the session's turns
with their headings nested underneath, where Obsidian's outline lives. It
follows whichever native view is active, and a click scrolls to that heading.

## Switching views

Each tab shows either the native view or a terminal, and remembers its choice.

- The **header button** on a tab toggles between the two. The tab menu offers
  the same, plus the terminal engine.
- **Gjetr: Switch render mode** in the command palette does it for the active
  tab.
- **Settings → Gjetr → Default view** sets what a tab shows until it chooses
  for itself. Native is the default; pick Terminal to make every new tab a
  terminal and switch to native per tab instead.

A tab switched to the terminal keeps the terminal engine it had when it comes
back, and a vault that had chosen an engine before 0.4.0 keeps its terminals.

## How it works

The view never reads the terminal screen. It tails the session's transcript
file, which Claude Code writes under its projects folder: the path the runtime
reports, or one derived from the pane's working directory and the agent
session id, which is what herdr gives. Prompts go out through the runtime, on
herdr as an agent prompt. The view follows the pane's agent session: `/clear`
empties it, `--resume` refills it, and a transcript replaced or truncated
under it is read again from the start. Two tabs on the same pane and the table
of contents share one session model, so a transcript is tailed once; the same
pane id on another runtime is another pane with a model of its own. Unknown
transcript line types are kept and render nothing, so a Claude Code update does
not break the view. Details and the verified facts are in
[architecture.md](architecture.md).

What the view reads comes through the runtime's kind: a session watcher for
the pane's session, cwd and status, and a transcript source for the files.
herdr supplies local ones. herdr-core reads the session from the label the
Claude session hook writes on the terminal, and its transcripts from this
machine's files or, over SSH, through the runtime's connection (ADR-0006).

## On herdr-core

A Claude in a herdr-core terminal opens in the native view once the Claude
session hook is installed on the runtime's machine (**Install or remove the
Claude session hook**, see [runtimes.md](runtimes.md)), on this machine and
over SSH alike. Everything above works the same: `/clear` and `--resume` are
followed, prompts are sent or queued, `/` commands and keys go through hc,
and the waiting card names the block hc reports (a permission, a question, a
sign-in). A block hc gives no kind for, such as a startup dialog, is only
described; nothing on herdr-core is ever answered for you.

A terminal without the hook's label stays a terminal, and the view switch says
why and names the install command. A label that names another process than
the terminal's foreground one, as a wrapper that forks Claude instead of
exec'ing it leaves, is not taken either, and the switch says so instead. The tab moves to the native view by itself
once Claude labels the terminal, and back to the terminal when Claude exits or
hands the terminal to another program, such as an editor.

On an SSH runtime, `@` mentions name the file in the remote vault, and the
transcript is read with hc's `file.read` when the agent's status changes and
every 2 s while it works, so new content can take a moment longer than
locally. The `/` list is read from the remote machine in one call over the
runtime's connection and kept for a few seconds. A remote that
does not answer within 3 seconds, or cannot be read, offers only Claude's
built-in commands until it does; it never offers this machine's commands.

## On Claude run by Obsidian

Agents of this runtime are Claude processes the plugin runs itself
([runtimes.md](runtimes.md)). The transcript is still the content, read from
this machine's files as on herdr. The session, the status and the block come
from Claude's own stream instead of a multiplexer: working from a prompt to
the end of its turn, done when the turn ended (until you look at it), blocked
while a card waits. A stopped agent's tab shows its conversation and keeps its
prompt box: sending resumes it.

**Switching to the terminal and back moves the agent.** An agent runs one
Claude at a time: the headless one this view talks to, or Claude's own
terminal interface in the terminal view. Switching the tab's view stops the
one and starts the other on the same conversation (`--resume`), about a
second for the switch, then a few more while Claude draws its screen.

- **Only between turns.** While the agent works, or a card waits for your
  answer, a switch to the terminal waits for the turn to end and the tab says
  so; answer the card in the native view (switch back to it) and the switch
  follows. A switch to native waits the same way for a turn running in the
  terminal. Nothing is interrupted and nothing is asked.
- **In the terminal view** everything is answered in the terminal, since
  Claude asks there and not over its stream. The list shows the status Claude
  reports to the terminal; a native view of the same agent shows a blocked
  card with **Open in terminal**.
- **A prompt from a native view** while the agent runs in its terminal moves
  it back to the headless process first, if the terminal is idle, and is sent
  there; while the terminal is busy it is refused with a notice. **Stop** in
  the prompt box sends Esc to the terminal, Claude's own interrupt key.
- **Closing the terminal tab** does not move the agent: Claude keeps running
  there, and the tab opened again shows the same screen. Another tab still on
  the terminal when the agent moves says so, and **Reconnect** brings it back.
- On Windows there is no terminal view (no `script(1)`), and the view switch
  shows the terminal disabled, with the reason.

Hook output and banners in Claude's stream are never shown, since content
comes from the transcript.

## Switching runtimes

A native tab belongs to the runtime it was opened on. When you switch the
active runtime, a tab on the other one keeps what it shows, its status line
says the runtime is not connected, and its prompt box is disabled; it never
shows a pane of the newly active runtime that happens to have the same id. It
picks up again when its runtime is active once more.

## Limits

- **Local panes only, on herdr.** A remote herdr keeps the terminal view; the
  setting says so. herdr-core reads its transcripts over its connection, so
  its SSH runtimes have the view.
- **herdr-core over SSH:** a transcript over 64 MB cannot be read (hc's
  `file.read` limit), and a single transcript line over 8 MB is skipped. When
  the file is over 64 MB, or its first line is over 8 MB, nothing can be read
  and the view says so where it would say "No turns in this session yet."; the
  terminal view still follows the agent. The remote needs `sh`, `awk` and `tr`
  for its `/` list, as the session hook does.
- **A prompt to a herdr-core terminal less than 10 seconds old** may be
  refused while its screen is still settling; send it again.
- **Claude Code only** for now. Other agent kinds show a terminal. The
  normalized event model is what a second backend would map into.
- Questions and plan approvals are answered in the terminal on herdr and
  herdr-core; the card takes you there. Only Claude run by Obsidian answers
  them on the card.
- **Claude run by Obsidian has no terminal view** yet, and its live text is
  not drawn as it streams: turns appear block by block, as everywhere else.
- Content blocks appear when complete, not streamed token by token.
- No diffs: an edit shows as a link to the changed note, not what changed.
