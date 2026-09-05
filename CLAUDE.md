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
