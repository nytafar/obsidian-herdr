# obsidian-herdr — working rules

Read `docs/architecture.md` first: it is the verified herdr integration contract
(two seams, measured facts). Do not re-derive it, extend it with new verified
facts. Project docs beyond the repo live in the vault docs root named in
`docs/agents/domain.md`. `AGENTS.md` (from the Obsidian sample plugin) holds
general plugin conventions.

## Hard rules

- Plugin id `herdr`, name `Herdr`, `isDesktopOnly: true`. Ship only `main.js`,
  `manifest.json`, `styles.css`. No helper files, no Python, no native addons.
- Terminal seam is `herdr terminal session control|observe` over child_process
  pipes with NDJSON. Not a PTY, not `herdr agent attach`, not the binary client
  socket. If the seam proves insufficient, write it up as a finding in the docs
  root before changing it.
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

- Installed 0.8.2, protocol 20, at `/usr/bin/herdr`, socket
  `~/.config/herdr/herdr.sock`. A stale 0.8.0 (protocol 19) also sits at
  `~/.local/bin/herdr`, and both the plugin's binary search and the type
  generator's fixed directories rank it first; the generator now prefers the
  PATH binary, the plugin needs the settings override or the stale copy
  removed. The generated types track the newest herdr release, not the
  installed one: 0.9.0 (protocol 22) as of 2026-09-13. To regenerate without
  installing, `gh release download vX.Y.Z -R herdrdev/herdr -p
  herdr-linux-x86_64 -O /tmp/herdr-X.Y.Z`, then
  `npm run gen:types -- --binary /tmp/herdr-X.Y.Z` and review the diff; the
  terminal session seam is checked by diffing `herdr terminal session
  observe --help` between the two binaries. Do not run `herdr update` from an
  agent session: sessions run inside it.
- Remote test host: `lasse@xl`, herdr at `/home/lasse/.local/bin/herdr` (not on
  the non-interactive PATH), vault at `/home/lasse/hvelv`.
- Whip checkout for reading: `~/code/herdr/whip` (upstream fetched as FETCH_HEAD).

## Dev loop

- Dev vault `/Users/lasse/Vaults/hvelv` is Lasse's live vault. Install with
  `npm run install-dev -- ~/Vaults/hvelv`, which symlinks **only** `main.js`,
  `manifest.json` and `styles.css`.
- **Never symlink the repository root into `.obsidian/plugins/`.** Obsidian
  enumerates plugin folders at startup, and the repo carries `node_modules` and
  `.git`, about 37,000 files. Doing so hangs the vault on "Loading vault..."
  indefinitely while other vaults open normally. Cost us a debugging round on
  2026-09-06. Hot-Reload watches for `main.js` or
  `styles.css` changes when a `.hotreload` file exists in the plugin folder.
- `npm run dev` for watch builds, `npm run build` before committing.
- Do not touch the installed `ghostty-terminal` plugin in that vault.
- Sanity-check the terminal seam without Obsidian:
  `herdr terminal session observe <pane_id> --cols 80 --rows 24 </dev/null | head -1`

## Where things are

- `docs/architecture.md` — the **verified herdr contract**: the JSON API seam,
  the terminal session seam and the facts measured against real herdr builds.
  Authoritative. Extend it with new verified facts; do not re-derive it.
- `~/hvelv/repos/obsidian-herdr/` — the vault docs root (see
  `docs/agents/domain.md`): `adr/` for hard decisions, `findings/` for
  discussions and verified facts per topic. The v1 PRD, its research file and
  the exploration notes predate this layout and are not on every machine; when
  found, they belong here, not beside the repo.
- **Issue #32** — the v0.2 roadmap: build order, what blocks what, and why.
  The single source for what to work on next. `docs/agents/issue-tracker.md`
  has the label vocabulary.
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
`gh issue view` on, the doc path, and the specific finding files. Do not paste
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
