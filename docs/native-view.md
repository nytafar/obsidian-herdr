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
  length apply. Clicking a wikilink opens the note.
- **Your prompts** as plain text with wikilinks made clickable, so pasted
  snippets and `@` paths are not mangled.
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
agent, and while the agent is blocked on a question the card handles.

Typing `/` completes slash commands and skills from the user, project and
plugin scopes, with their descriptions; project scope wins, and discovery stops
at the repository or worktree root. Typing `@` completes vault files and sends
the mention the way Claude expects: relative to the pane's working directory
when the file is inside it, absolute otherwise.

The very first prompt to a freshly started Claude can be sent from here. A
send that fails shows a notice.

## The waiting card

When herdr reports the agent as **blocked**, the view shows a card naming the
block: the workspace trust prompt at startup, a question the agent asked with
its options, a plan awaiting approval, or a tool waiting for permission. Every
card has **Open in terminal**, which switches the tab to the terminal so you
can answer anything the view does not.

The trust prompt is the one block the view can answer for you: the card offers
**Trust this folder**, and the **Trust new folders automatically** setting
presses it without asking. Nothing else is answered on your behalf. Tool
permissions are Claude's own to ask; questions and plan approvals are yours.

## Table of contents

**Herdr: Show table of contents** opens a sidebar listing the session's turns
with their headings nested underneath, where Obsidian's outline lives. It
follows whichever native view is active, and a click scrolls to that heading.

## Switching views

Each tab shows either the native view or a terminal, and remembers its choice.

- The **header button** on a tab toggles between the two. The tab menu offers
  the same, plus the terminal engine.
- **Herdr: Switch render mode** in the command palette does it for the active
  tab.
- **Settings → Herdr → Default view** sets what a tab shows until it chooses
  for itself. Native is the default; pick Terminal to make every new tab a
  terminal and switch to native per tab instead.

A tab switched to the terminal keeps the terminal engine it had when it comes
back, and a vault that had chosen an engine before 0.4.0 keeps its terminals.

## How it works, in one paragraph

The view never reads the terminal screen. It tails the session's transcript
file, which Claude Code writes under its projects folder, derived from the
pane's working directory and the agent session id that herdr reports. Prompts
go out through herdr as an agent prompt. The view follows the pane's agent
session: `/clear` empties it, `--resume` refills it. Two tabs on the same pane
and the table of contents share one session model, so a transcript is tailed
once. Unknown transcript line types are kept and render nothing, so a Claude
Code update does not break the view. Details and the verified facts are in
[architecture.md](architecture.md).

## Limits

- **Local panes only.** A remote herdr keeps the terminal view; the setting
  says so. The transcript source is designed so an SSH adapter can slot in.
- **Claude Code only** for now. Other agent kinds show a terminal. The
  normalized event model is what a second backend would map into.
- Questions and plan approvals are answered in the terminal; the card takes
  you there.
- Content blocks appear when complete, not streamed token by token.
- No diffs: an edit shows as a link to the changed note, not what changed.
