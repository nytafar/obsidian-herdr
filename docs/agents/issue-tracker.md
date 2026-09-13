# Issue tracker

Tickets are GitHub issues in `nytafar/obsidian-herdr`. Issue #32 is the roadmap.

Labels in use: `bug`, `enhancement`, `refactor` (enabling change, little
user-visible effect), `spike` (investigation, output is a report),
`question` (open discussion), `documentation`, and priorities `P0` (blocks
other work or user-stated top priority), `P1` (wanted soon), `P2` (nice to
have). There is no `ready-for-agent` label; a ticket whose blockers are closed
is agent-grabbable.

Ticket shape: a parent issue for a batch, one issue per vertical slice with
`## What to build`, `## Acceptance criteria` and `## Blocked by` sections, in
dependency order so blockers have real numbers. Orchestrators merge and push;
agents commit on branches or worktrees and never push.
