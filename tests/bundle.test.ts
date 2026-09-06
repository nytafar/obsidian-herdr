/**
 * The shipped bundle, built for real (issue #63).
 *
 * ghostty-web inlines `ghostty-vt.wasm` as a base64 data URL inside its own
 * dist file; `esbuild.config.mjs` rewrites that literal into a Brotli-encoded
 * one plus a decode shim. That transform runs at build time and never at test
 * time, so it needs a test that actually builds: this file bundles `src/main.ts`
 * into a temp directory with the production options and then reads the output.
 *
 * What it pins:
 *
 * 1. The Brotli marker is in the bundle, and the base64 wasm is not — the two
 *    halves the release workflow greps for.
 * 2. The literal in the bundle decompresses to bytes identical to
 *    `node_modules/ghostty-web/dist/ghostty-vt.wasm`, so the compression is not
 *    merely small but correct.
 * 3. Those bytes are a valid WebAssembly module that exports libghostty-vt's
 *    entry points. `tests/unicodeWidth.test.ts` instantiates the same wasm from
 *    the file; this one proves the copy inside `main.js` is that wasm.
 * 4. The transform fails loudly rather than silently emitting an unpatched
 *    bundle if ghostty-web stops inlining exactly one data URL.
 *
 * Nothing is written into the working tree: the outfile is under `os.tmpdir()`.
 */
import { brotliDecompressSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import esbuild from 'esbuild';
// @ts-expect-error -- the build config is plain ESM JavaScript and carries no types.
import * as buildConfig from '../esbuild.config.mjs';

/** The slice of `esbuild.config.mjs` this file uses, typed by hand. */
interface BuildConfig {
	readonly BROTLI_MARKER: string;
	readonly buildOptions: (options: { prod?: boolean; outfile?: string }) => esbuild.BuildOptions;
	readonly rewriteGhosttyWeb: (source: string) => string;
}

const { BROTLI_MARKER, buildOptions, rewriteGhosttyWeb } = buildConfig as unknown as BuildConfig;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GHOSTTY_WASM = path.join(ROOT, 'node_modules/ghostty-web/dist/ghostty-vt.wasm');

/** The base64 of the wasm magic number `\0asm\1\0\0\0`, i.e. an unencoded wasm. */
const WASM_BASE64_HEAD = 'AGFzbQEAAAA';

/**
 * The Brotli payload is the only very long string literal in the bundle, and
 * minification cannot rename a string. 10 000 characters is far above anything
 * else we bundle and far below the ~132 000 the payload occupies.
 */
const LONG_BASE64_LITERAL = /"([A-Za-z0-9+/]{10000,}={0,2})"/g;

/** The Brotli payload, extracted from the built bundle. Asserts it is unique. */
function brotliLiteral(bundle: string): string {
	const matches = [...bundle.matchAll(LONG_BASE64_LITERAL)];
	expect(matches).toHaveLength(1);
	const literal = matches[0]?.[1];
	if (literal === undefined) throw new Error('no brotli literal in the bundle');
	return literal;
}

describe('the production bundle', () => {
	let dir: string;
	let bundle: string;

	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'herdr-bundle-'));
		const outfile = path.join(dir, 'main.js');
		await esbuild.build({
			...buildOptions({ prod: true, outfile }),
			absWorkingDir: ROOT,
			logLevel: 'silent',
		});
		bundle = await readFile(outfile, 'utf8');
	}, 120_000);

	afterAll(async () => {
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	});

	it('carries the brotli marker exactly once', () => {
		expect(bundle.split(BROTLI_MARKER).length - 1).toBe(1);
	});

	it('no longer carries the wasm as base64', () => {
		expect(bundle).not.toContain(WASM_BASE64_HEAD);
		expect(bundle).not.toContain('data:application/wasm;base64');
	});

	it('decodes to exactly the ghostty-vt.wasm on disk', async () => {
		const decoded = brotliDecompressSync(Buffer.from(brotliLiteral(bundle), 'base64'));
		const onDisk = await readFile(GHOSTTY_WASM);
		expect(decoded.length).toBe(onDisk.length);
		expect(decoded.equals(onDisk)).toBe(true);
	});

	it('decodes to a wasm module the ghostty engine can instantiate', async () => {
		const decoded = brotliDecompressSync(Buffer.from(brotliLiteral(bundle), 'base64'));
		const module = await WebAssembly.compile(decoded);
		const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
		expect(exports).toContain('memory');
		// The handful GhosttyWebRenderer drives; if these move, so does init().
		for (const name of [
			'ghostty_terminal_new',
			'ghostty_terminal_write',
			'ghostty_terminal_resize',
			'ghostty_render_state_update',
		]) {
			expect(exports).toContain(name);
		}
	});

	it('is smaller than the base64 form it replaced', async () => {
		const onDisk = await readFile(GHOSTTY_WASM);
		const base64Cost = Math.ceil(onDisk.length / 3) * 4;
		expect(brotliLiteral(bundle).length).toBeLessThan(base64Cost / 3);
	});
});

describe('the ghostty-web transform', () => {
	it('refuses a module that does not inline exactly one wasm data URL', () => {
		expect(() => rewriteGhosttyWeb('const a = 1;')).toThrow(
			/expected exactly 1 embedded wasm data URL, found 0/,
		);
	});
});
