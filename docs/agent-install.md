# Installing Gjetr with a coding agent

This file is written for a coding agent (Claude Code, Codex, …) running on
the user's machine. It installs the Gjetr plugin (herdr for Obsidian)
into the user's Obsidian vault, plus BRAT, which keeps Gjetr updated, by writing the plugin files
directly. Nothing is clicked in Obsidian unless the step below says so.

Paste this into the agent:

```text
Install the Obsidian plugin Gjetr for me: read
https://raw.githubusercontent.com/nytafar/obsidian-herdr/main/docs/agent-install.md
and follow it.
```

## For the agent

Desktop only, macOS or Linux. Work through the steps in order, and report
at the end in the shape given under "Report".

### 1. Find the vault

Obsidian's own vault list is `obsidian.json`:

- macOS: `~/Library/Application Support/obsidian/obsidian.json`
- Linux: `~/.config/obsidian/obsidian.json`, or
  `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json` (Flatpak),
  or `~/snap/obsidian/current/.config/obsidian/obsidian.json` (Snap)

Its `vaults` object maps ids to `{path, ts, open?}`. Use the one vault
there is. If there are several, ask the user which one, and offer the one
with `"open": true` or the latest `ts` first. Never pick on your own. Call
its folder `<vault>`.

### 2. Download the files

From the latest GitHub release of each project, put `main.js`,
`manifest.json` and `styles.css` into the plugin's folder:

| Plugin | Repository | Folder |
|---|---|---|
| Gjetr | `nytafar/obsidian-herdr` | `<vault>/.obsidian/plugins/gjetr/` |
| BRAT | `TfTHacker/obsidian42-brat` | `<vault>/.obsidian/plugins/obsidian42-brat/` |

URL shape: `https://github.com/<repository>/releases/latest/download/<file>`
(`curl -fL`, or `gh release download -R <repository>`).

- Check that each `manifest.json` has the id from the folder name (`gjetr`,
  `obsidian42-brat`).
- The plugin's id was `herdr` until 0.5. A `<vault>/.obsidian/plugins/herdr/`
  folder is this plugin's old install only if its `manifest.json` has
  author `Lasse` and author URL `https://github.com/nytafar`; other
  plugins use the id `herdr` too. Either way, leave that folder alone:
  Gjetr copies its own old settings from it on first load. If it is ours,
  tell the user they can remove it, and its `"herdr"` entry in
  `community-plugins.json`, once Gjetr has loaded.
- If a folder already exists, replace only those three files. Keep its
  `data.json` (the plugin's settings) and anything else in it.
- Never symlink a source checkout into `.obsidian/plugins/`. Obsidian hangs
  on "Loading vault…" over a folder with `node_modules` in it.

### 3. Turn them on

Merge, never replace: read each JSON file, add what is missing, keep every
entry already there, write it back.

- `<vault>/.obsidian/community-plugins.json` is a JSON array of enabled
  plugin ids. Add `"gjetr"` and `"obsidian42-brat"`. Create it as `[]`
  first if it does not exist.
- `<vault>/.obsidian/plugins/obsidian42-brat/data.json` is BRAT's settings.
  Create it as `{}` if missing, then make sure that:
  - `pluginList` (array) contains `"nytafar/obsidian-herdr"`;
  - `pluginSubListFrozenVersion` (array) has an entry
    `{"repo": "nytafar/obsidian-herdr", "version": "latest"}`;
  - `updateAtStartup` is `true`, unless the user already set it.

  BRAT fills in its other settings with defaults when it loads.

### 4. Load them

Obsidian reads the plugin list when a vault opens.

- **Obsidian is not running** (`pgrep -x obsidian` / `pgrep -f Obsidian`):
  nothing to do. The plugins load on the next start.
- **Obsidian is running**: it has to reopen the vault. Ask the user before
  you restart it. With a yes, quit it (macOS: `osascript -e 'quit app
  "Obsidian"'`; Linux: end the Obsidian process normally, never with
  `kill -9`), wait until it is gone, then start it again (macOS: `open -a
  Obsidian`; Linux: `obsidian`, `flatpak run md.obsidian.Obsidian` or the
  desktop launcher, whichever it was started as). Obsidian saves notes as
  they are typed, so nothing is lost. Without a yes, tell them to restart
  it themselves.

### 5. The one step files cannot do

Obsidian keeps "community plugins on" (Restricted mode off) in its own
browser storage, not in the vault. A vault where community plugins have
never been turned on starts in Restricted mode and loads no plugin,
whatever `community-plugins.json` says.

If `community-plugins.json` was missing or empty before step 3, assume
Restricted mode is on. Tell the user to switch it off once in **Settings →
Community plugins → Turn on community plugins**. Obsidian then loads both
plugins straight away. Do not try to edit Obsidian's storage.

### 6. Check for a runtime

Gjetr shows agents from a runtime. It never installs one, and neither do
you: report what is there and let the user decide.

Look on the PATH and in `/opt/homebrew/bin`, `/usr/local/bin` and
`~/.local/bin` for:

- `hc` or `herdr-core` (herdr-core);
- `herdr` (the herdr TUI);
- `claude` (Claude Code, which Gjetr can run by itself).

Note each one's version (`--version`). If none is found, the plugin's
**Get started** card offers the ways in once Obsidian is open.

### Report

Tell the user, in a few lines:

- the vault you installed into, and the Gjetr and BRAT versions (from
  their `manifest.json`);
- the files you created or changed;
- whether Obsidian was restarted, and whether they still have to turn on
  community plugins (step 5);
- which runtimes you found, with versions;
- next: open the vault, run **Gjetr: Show agents** from the command
  palette, and follow **Get started** if no runtime connects.
  **Settings → Gjetr** shows what the plugin found.
