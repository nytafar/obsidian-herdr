# Development

```bash
npm install
npm run dev      # watch build to main.js
npm run build    # type-check + production build
npm test         # vitest, no herdr and no network
npx eslint src tests
```

## Installing into a vault

```bash
npm run install-dev -- /path/to/vault
```

This symlinks **only** `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/herdr/` and drops a `.hotreload` marker for the
[Hot-Reload](https://github.com/pjeby/hot-reload) plugin.

Never symlink the repository itself into the plugins folder. Obsidian enumerates
every file under it at startup, and the repo carries `node_modules` and `.git`,
tens of thousands of files, which hangs the vault on "Loading vault…".

## Tests and smoke recipes

`tests/README.md` lists what is unit tested and the manual recipes for the parts
that need a canvas or a live herdr: the renderers, the terminal view, shift+enter,
the remote profile. The Obsidian CLI (`obsidian plugin:reload id=herdr`,
`obsidian dev:errors`, `obsidian eval code=…`) is the quickest way to check a
build in a running vault.

## Releases

`.github/workflows/release.yml` builds on a `v*` tag and ships exactly `main.js`,
`manifest.json` and `styles.css`. The build asserts the embedded WebAssembly and
that no stray files are emitted.
