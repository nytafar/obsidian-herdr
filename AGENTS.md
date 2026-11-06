# obsidian-herdr — working rules

Read `docs/architecture.md` first: it is the verified herdr integration contract
(two seams, measured facts). Do not re-derive it, extend it with new verified
facts. Project docs beyond the repo live in the vault docs root named in
`docs/agents/domain.md`. `docs/agents/obsidian-plugin.md` (from the Obsidian sample
plugin) holds general plugin conventions.

## Hard rules

- Plugin id `herdr`, name `Herdr`, `isDesktopOnly: true`. Ship only `main.js`,
  `manifest.json`, `styles.css`. No helper files, no Python, no native addons.
- Each runtime kind has its own seams, over a socket or child_process pipes,
  never a native addon, and never a PTY except the one exception below.
  **herdr:** the terminal seam is `herdr terminal session
  control|observe` with NDJSON — not `herdr agent attach`, not the binary
  client socket. **herdr-core:** `hc connect` (or `ssh -T <host> … connect`)
  in framed mode, JSON-RPC on channel 0, events and attach on their own
  channels — ADR-0005, the recorded exception, resting on the finding
  `herdr-core-api`. **claude** ("Claude, run by Obsidian", ADR-0007): the
  plugin spawns `claude -p` in stream-json mode itself, over child_process
  pipes with no shell, every stdin line through the one strict writer
  (`src/claude/protocol.ts`). The one recorded exception to "not a PTY", for
  this kind only: its terminal view and shell tabs run on a pty from
  `script(1)` (`src/claude/pty.ts`), spawned over plain pipes inside the POSIX
  sh fd-3 watchdog that ends `script` when the plugin dies. An agent runs one
  process at a time, headless or its TUI. If a seam proves insufficient, write
  it up as a finding in the docs root before changing it.
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
  One exception: a view following a pane's agent session reads the
  `agent_session` field of `pane.updated` for its own pane only, deduplicated
  by value, because session rotation (`/clear`) has no event or status change.
- Scope everything to one workspace client-side. herdr outside Obsidian must be
  unaffected by this plugin.

## herdr on this machine

- Installed 0.9.5, protocol 22, at `~/.local/bin/herdr`, which is the one on
  PATH; socket `~/.config/herdr/herdr.sock`. An older 0.9.1 (also protocol 22)
  sits at `/usr/bin/herdr`; the plugin's binary search and the type generator
  both find `~/.local/bin` first. The generated types are read from 0.9.5 as
  of 2026-11-05: `npm run gen:types -- --binary ~/.local/bin/herdr`. 0.9.0
  through 0.9.5 all report protocol 22 with different schemas, so gate
  features on the server version, not the protocol (`docs/architecture.md`,
  "Versions and protocol"). To regenerate against a release without
  installing it, `gh release download vX.Y.Z -R herdrdev/herdr -p
  herdr-linux-x86_64 -O /tmp/herdr-X.Y.Z`, then
  `npm run gen:types -- --binary /tmp/herdr-X.Y.Z` and review the diff; the
  terminal session seam is checked by diffing `herdr terminal session
  observe --help` between the two binaries. Do not run `herdr update` from an
  agent session, and do not stop or restart the server: sessions run inside
  it.
- herdr-core: `hc` 0.1.18 (generation 1) at `~/.local/bin/hc`, a symlink to
  `herdr-core`; `asher` has 0.1.17 in `/root/.local/bin`, not on its
  non-interactive SSH PATH. Live checks may start terminals named `oh-test-*`
  here and remove only those; never `hc update` or `hc server stop|restart`,
  and nothing is started on `asher`.
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
- `docs/agents/obsidian-plugin.md` — generic Obsidian plugin conventions from the sample template.

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
