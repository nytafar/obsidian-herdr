# Herdr for Obsidian

Brings your [herdr](https://github.com/ogulcancelik/herdr) workspace into Obsidian.

- Live list of the agents in the herdr workspace that matches your vault
- Notifications when an agent is blocked or finished work you have not seen
- Open any agent's terminal as an Obsidian tab
- Create a herdr tab, split, or start an agent at the folder of the current note
- Works against a local herdr or one on a remote host over SSH

Desktop only. Requires a running herdr server (0.8.0 or newer).

## Status

Pre-alpha. Nothing works yet. The product requirements live in the parent
project's `PRD.md`; the feasibility study in `RESEARCH.md`.

## How it talks to herdr

- Workspace state and actions: herdr's JSON API over `~/.config/herdr/herdr.sock`.
- Pane terminals: `herdr terminal session control <pane> --cols N --rows M`,
  spawned as a child process with newline-delimited JSON on both pipes.
  It connects to the herdr server you already have running.

## Development

```bash
npm install
npm run dev        # watch build to main.js
npm run build      # type-check + production build
```

Symlink the repo into a vault's `.obsidian/plugins/herdr` and use the
Hot-Reload plugin to pick up rebuilds.

## License

MIT
