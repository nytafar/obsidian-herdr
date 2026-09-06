# obsidian-herdr — working rules

Read `../PRD.md` first, then `../RESEARCH.md`. The PRD's section 7 is the verified
herdr integration contract; do not re-derive it, extend it with new verified facts.
`AGENTS.md` (from the Obsidian sample plugin) holds general plugin conventions.

## Hard rules

- Plugin id `herdr`, name `Herdr`, `isDesktopOnly: true`. Ship only `main.js`,
  `manifest.json`, `styles.css`. No helper files, no Python, no native addons.
- Terminal seam is `herdr terminal session control|observe` over child_process
  pipes with NDJSON. Not a PTY, not `herdr agent attach`, not the binary client
  socket. If the seam proves insufficient, write it up in the PRD before changing it.
- No code from Whip (KaminariOS/whip, AGPL). Read it for behaviour only.
- Obsidian guidelines are rules: `this.app` never global `app`; `registerEvent`,
  `registerDomEvent`, `registerInterval` for everything that must be torn down;
  no `innerHTML`/`outerHTML`/`insertAdjacentHTML`; no inline styles; no default
  hotkeys; sentence case in UI; never detach leaves in `onunload`; do not keep
  references to views, use `getLeavesOfType`; vault handlers inside
  `workspace.onLayoutReady`.
- JSON API: ignore unknown fields, treat unsupported methods as ordinary errors,
  warn on protocol mismatch, never refuse to connect over it.
- React to `agent_status` transitions, never to raw `pane.updated` events.
- Scope everything to one workspace client-side. herdr outside Obsidian must be
  unaffected by this plugin.

## herdr on this machine

- Installed 0.8.0, protocol 19, socket `~/.config/herdr/herdr.sock`. herdr
  master source at `~/code/herdr/herdr` (0.8.2+, protocol 22) is the design
  target. Do not run `herdr update` from an agent session: sessions run inside it.
- Remote test host: `lasse@xl`, herdr at `/home/lasse/.local/bin/herdr` (not on
  the non-interactive PATH), vault at `/home/lasse/hvelv`.
- Whip checkout for reading: `~/code/herdr/whip` (upstream fetched as FETCH_HEAD).

## Dev loop

- Dev vault `/Users/lasse/Vaults/hvelv` is Lasse's live vault. This repo is
  symlinked at `.obsidian/plugins/herdr`. Hot-Reload watches for `main.js` or
  `styles.css` changes when a `.hotreload` file exists in the plugin folder.
- `npm run dev` for watch builds, `npm run build` before committing.
- Do not touch the installed `ghostty-terminal` plugin in that vault.
- Sanity-check the terminal seam without Obsidian:
  `herdr terminal session observe <pane_id> --cols 80 --rows 24 </dev/null | head -1`

## Where things are

- `../PRD.md` — v1 decisions and, in section 7, the **verified herdr contract**.
  Authoritative. Extend it with new verified facts; do not re-derive it.
- `../notes/` — verified API facts gathered by an exploration pass: herdr's JSON
  API and event shapes, the terminal bridge contract, Obsidian API signatures
  with line numbers, ghostty-web, Electron/node access, and the memory
  diagnosis. Read these instead of re-exploring.
- `../RESEARCH.md` — historical. Its fork recommendation was overturned.
- **Issue #32** — the v0.2 roadmap: build order, what blocks what, and why.
  The single source for what to work on next.
- `AGENTS.md` — generic Obsidian plugin conventions from the sample template.

## How work gets done here

The loop that worked for v1, worth repeating. The `/implement-spec` skill
describes the general shape; what follows is what this repo specifically learned.

**Orchestrator holds the graph, subagents hold the code.** Read the roadmap
issue, work the frontier of unblocked issues, dispatch one `implementer`
subagent per unit of work with `isolation: "worktree"`, then merge its branch
yourself. Agents never push; the orchestrator merges, builds, tests and pushes.

**Use the `implementer` agent type.** It is defined in `.claude/agents/` here,
in the container, and in `~/.claude/agents/`. It is deliberately lean: Bash,
Read, Edit, Write only, no exploration surface. A general-purpose agent starts
tens of thousands of tokens heavier for no benefit. Custom agent types are
loaded at session start, so if you add one mid-session it will not resolve.

**Batch related issues into one branch.** Three list-view issues in one branch
beat three branches racing on the same render path. Split only where the files
genuinely do not overlap.

**Pass pointers, not content.** Give an agent the issue number to run
`gh issue view` on, the PRD path, and the specific note files. Do not paste
requirements into the prompt; they go stale and cost context twice.

**Expect conflicts in exactly two places.** `src/main.ts`, which every feature
touches, so tell agents to keep their footprint there small; conflicts are
almost always unions, resolved by keeping both sides. And `package-lock.json`,
which any `npm install` regenerates; resolve by regenerating once after merging.

**Review in two axes before merging a large branch.** One read-only agent
against the documented standards, one against the spec, in parallel, then hand
every finding to a single fix-up implementer. The spec axis caught that the
agent list would have displayed "claude" on every row; the standards axis caught
a literal NUL byte that made a whole file invisible to `git diff`.

**Verification before every commit:** `npm run build`, `npm test`, and
`npx eslint src tests` with zero errors. Use that path, not `npx eslint .`,
which walks agent worktrees under `.claude/` and reports their findings as
yours.
