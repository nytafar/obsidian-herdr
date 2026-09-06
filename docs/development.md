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

## The embedded ghostty WebAssembly

We ship one file, so `ghostty-vt.wasm` has to live inside `main.js`. ghostty-web
0.4.0 already arranges that: it inlines the 423 045 byte module as a single
`data:application/wasm;base64,…` literal in its own dist bundle, and
`Ghostty.load()` with no argument always takes that path. Base64 costs 564 060
bytes of the bundle.

`esbuild.config.mjs` shrinks that at build time. An `onLoad` transform, scoped to
ghostty-web's dist file, rewrites the one data URL literal into a call returning
a `blob:` URL built from Brotli-decompressed bytes, and prepends a small decode
shim that calls `zlib.brotliDecompressSync`. Everything around the literal —
ghostty-web's `new URL(…, self.location)` and the `loadFromPath(href)` after it —
works unchanged, because a blob URL is fetchable in the renderer, so nothing in
`src/` knows about any of this. Brotli q11 then base64 costs 131 824 bytes:
`main.js` went from 1 076 177 to 644 292. Decompression happens once, on the
first `Ghostty.load()`, not per frame.

Compression is deterministic (q11, size hint) and memoised, so watch rebuilds do
not pay for it. If ghostty-web ever stops inlining exactly one data URL the
build **fails**, rather than quietly emitting an unpatched bundle — the version
is pinned, but a bump could move the literal. `tests/bundle.test.ts` builds into
a temp directory and checks the round trip against
`node_modules/ghostty-web/dist/ghostty-vt.wasm`; the release workflow greps
`main.js` for the shim's `herdr:wasm-brotli` marker and for the absence of plain
base64 wasm. The same test also pins `main.js`'s total size: `MAIN_JS_BASELINE_BYTES`
records the 644 292 bytes we shipped right after #63, and `MAIN_JS_CEILING_BYTES`
is about 15% above that; the test fails if the built bundle exceeds the ceiling
so a size regression shows up in diff review rather than only as a red test
(issue #64). A deliberate size change updates both constants in the same commit.

## Tests and smoke recipes

`tests/README.md` lists what is unit tested and the manual recipes for the parts
that need a canvas or a live herdr: the renderers, the terminal view, shift+enter,
the remote profile. The Obsidian CLI (`obsidian plugin:reload id=herdr`,
`obsidian dev:errors`, `obsidian eval code=…`) is the quickest way to check a
build in a running vault.

## Releases

`.github/workflows/release.yml` builds on a bare version tag (e.g. `0.1.0`, no
`v` prefix — Obsidian's own contract, see AGENTS.md and the official sample
plugin) matching `manifest.json`'s version, and ships exactly `main.js`,
`manifest.json` and `styles.css`. The build asserts the embedded, Brotli-compressed
WebAssembly is present and that no stray files are emitted.
