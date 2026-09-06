/**
 * Renderer benchmark: ghostty-web against xterm.js (issue #27).
 *
 * Not shipped. `scripts/` is outside the plugin bundle — esbuild's only entry
 * point is `src/main.ts` and the release workflow attaches main.js,
 * manifest.json and styles.css — so this file costs a user nothing.
 *
 *     node scripts/bench-renderers.mjs                 # everything
 *     node scripts/bench-renderers.mjs --only bundle   # bundle sizes only
 *     node scripts/bench-renderers.mjs --lines 50000   # a quicker throughput run
 *     node scripts/bench-renderers.mjs --json          # machine-readable
 *
 * It re-executes itself under `--expose-gc` if it has to, because retained
 * memory means "what survives two forced collections", the same method
 * notes/memory.md used.
 *
 * Three sections:
 *
 * 1. **Bundle.** Four production builds into a temp directory — neither engine,
 *    ghostty-web only, xterm.js only, both — so each engine's contribution is a
 *    subtraction rather than a guess. Nothing is written into the working tree.
 * 2. **Throughput and retained memory.** 200 000 lines of 180 characters parsed
 *    by each VT, each in its own child process so the heaps do not mix.
 *    ghostty-vt is instantiated straight from the .wasm, the way
 *    notes/memory.md did it, because the package's loader wants a browser;
 *    xterm.js is `@xterm/headless`, which is the same parser and buffer as the
 *    browser build with the renderer removed.
 * 3. **Repaint.** This one cannot be measured without a browser, so it is a
 *    reading of both render loops, with the claims re-checked against the
 *    installed sources on every run so they cannot rot silently.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** The grid notes/memory.md measured on, so the numbers stay comparable. */
const COLS = 120;
const ROWS = 40;
/** Line length used by the memory diagnosis. */
const LINE_WIDTH = 180;
const DEFAULT_LINES = 200_000;
/** The plugin's default scrollback setting: 10 MB for ghostty-web… */
const SCROLLBACK_BYTES = 10_000_000;
/** …which `scrollbackLines()` in `src/views/renderer/xtermJs.ts` calls 6 000. */
const SCROLLBACK_LINES = 6_000;
/** Writes are chunked, because herdr's frames arrive in pieces too. */
const CHUNK_BYTES = 64 * 1024;

function parseArgs(argv) {
	const args = { only: 'all', lines: DEFAULT_LINES, json: false, engine: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--only') args.only = argv[++i] ?? 'all';
		else if (arg === '--lines') args.lines = Number(argv[++i]);
		else if (arg === '--engine') args.engine = argv[++i] ?? null;
		else if (arg === '--json') args.json = true;
		else if (arg === '--help' || arg === '-h') args.only = 'help';
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!Number.isFinite(args.lines) || args.lines <= 0) {
		throw new Error('--lines wants a positive number');
	}
	return args;
}

const mb = (bytes) => bytes / 1_000_000;
const fmtMb = (bytes) => `${mb(bytes).toFixed(2)} MB`;
const fmtKb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

/**
 * Two forced collections, then a reading. Needs `--expose-gc`.
 *
 * `heapUsed` alone is not enough for this comparison: xterm.js keeps every
 * buffer line in a `Uint32Array`, and V8 accounts a typed array's backing store
 * under `external`/`arrayBuffers` rather than in the heap. Measuring only the
 * heap would report a 6 000-line scrollback as under 3 MB when the cells alone
 * are three words per cell.
 */
function retained() {
	for (let i = 0; i < 3; i++) globalThis.gc?.();
	const usage = process.memoryUsage();
	return {
		heapUsed: usage.heapUsed,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
		rss: usage.rss,
		// What the process actually holds on to for the terminal.
		total: usage.heapUsed + usage.external,
	};
}

// ---------------------------------------------------------------------------
// 1. Bundle contribution
// ---------------------------------------------------------------------------

/**
 * The production build from `esbuild.config.mjs`, with a plugin that can stub
 * one or both renderer modules out. Kept in step by hand: if the real config
 * gains an option that changes size (minify, target, format), copy it here.
 */
async function buildVariant(esbuild, outfile, stubbed) {
	const stub = {
		name: 'stub-renderers',
		setup(build) {
			for (const [moduleName, className] of Object.entries(stubbed)) {
				// The import specifier, not the file: `create.ts` says
				// `./ghosttyWeb`, extensionless.
				const filter = new RegExp(`(^|/)${moduleName}$`);
				build.onResolve({ filter }, (args) => ({
					path: args.path,
					namespace: 'herdr-stub',
					pluginData: { className },
				}));
			}
			build.onLoad({ filter: /.*/, namespace: 'herdr-stub' }, (args) => ({
				contents: `export class ${args.pluginData.className} {}`,
				loader: 'js',
			}));
		},
	};
	await esbuild.build({
		entryPoints: [path.join(ROOT, 'src/main.ts')],
		absWorkingDir: ROOT,
		bundle: true,
		external: [
			'obsidian',
			'electron',
			'@codemirror/autocomplete',
			'@codemirror/collab',
			'@codemirror/commands',
			'@codemirror/language',
			'@codemirror/lint',
			'@codemirror/search',
			'@codemirror/state',
			'@codemirror/view',
			'@lezer/common',
			'@lezer/highlight',
			'@lezer/lr',
			...builtinModules,
			...builtinModules.map((name) => `node:${name}`),
		],
		loader: { '.wasm': 'dataurl' },
		format: 'cjs',
		target: 'es2021',
		logLevel: 'silent',
		treeShaking: true,
		minify: true,
		sourcemap: false,
		outfile,
		plugins: Object.keys(stubbed).length > 0 ? [stub] : [],
	});
	return statSync(outfile).size;
}

async function benchBundle() {
	const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
	const dir = mkdtempSync(path.join(tmpdir(), 'herdr-bench-'));
	try {
		const variants = {
			neither: {
				ghosttyWeb: 'GhosttyWebRenderer',
				xtermJs: 'XtermJsRenderer',
			},
			ghostty: { xtermJs: 'XtermJsRenderer' },
			xterm: { ghosttyWeb: 'GhosttyWebRenderer' },
			both: {},
		};
		const sizes = {};
		for (const [name, stubbed] of Object.entries(variants)) {
			sizes[name] = await buildVariant(
				esbuild,
				path.join(dir, `main-${name}.js`),
				stubbed,
			);
		}
		return {
			...sizes,
			ghosttyCost: sizes.ghostty - sizes.neither,
			xtermCost: sizes.xterm - sizes.neither,
			bothCost: sizes.both - sizes.neither,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 2. Throughput and retained memory
// ---------------------------------------------------------------------------

/** `lines` lines of `LINE_WIDTH` printable characters, CRLF terminated. */
function payload(lines) {
	const body = 'x'.repeat(LINE_WIDTH);
	const chunks = [];
	let current = [];
	let currentBytes = 0;
	for (let i = 0; i < lines; i++) {
		// A line number in front, so the parser sees varied content rather than
		// one repeated cell it might optimise.
		const line = `${String(i).padStart(7, '0')} ${body.slice(8)}\r\n`;
		current.push(line);
		currentBytes += line.length;
		if (currentBytes >= CHUNK_BYTES) {
			chunks.push(Buffer.from(current.join(''), 'utf8'));
			current = [];
			currentBytes = 0;
		}
	}
	if (current.length > 0) chunks.push(Buffer.from(current.join(''), 'utf8'));
	return chunks;
}

/**
 * libghostty-vt straight from the .wasm. ghostty-web's own loader fetches a
 * data URL through the browser, so the harness constructs the same
 * `GhosttyTerminal` the widget uses over an instance we made ourselves — the
 * method notes/memory.md used, repeated here so the numbers line up with it.
 */
async function benchGhostty(lines) {
	const chunks = payload(lines);
	const bytes = chunks.reduce((sum, c) => sum + c.length, 0);
	const wasm = await readFile(
		path.join(ROOT, 'node_modules/ghostty-web/dist/ghostty-vt.wasm'),
	);
	const { GhosttyTerminal } = await import('ghostty-web');
	const { instance } = await WebAssembly.instantiate(wasm, {
		env: { log: () => {} },
	});
	const memory = instance.exports.memory;
	const wasmBefore = memory.buffer.byteLength;
	const heapBefore = retained();

	let terminal = new GhosttyTerminal(instance.exports, memory, COLS, ROWS, {
		scrollbackLimit: SCROLLBACK_BYTES,
	});
	const started = process.hrtime.bigint();
	for (const chunk of chunks) terminal.write(chunk);
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

	const scrollback = terminal.getScrollbackLength();
	const wasmAfter = memory.buffer.byteLength;
	const heapAfter = retained();
	terminal.free();
	// Dropped as well as freed, or the reading below would only prove that a
	// live local variable keeps an object alive.
	terminal = null;
	await settle();
	const wasmFreed = memory.buffer.byteLength;
	const heapFreed = retained();

	return {
		engine: 'ghostty-web',
		lines,
		bytes,
		elapsedMs,
		scrollbackLines: scrollback,
		// The WASM memory is the number that matters: it can grow and never
		// shrink, so this is what Obsidian keeps until it restarts.
		wasmBefore,
		wasmAfter,
		wasmRetainedAfterFree: wasmFreed,
		heapBefore,
		heapAfter,
		heapAfterFree: heapFreed,
	};
}

/**
 * `@xterm/headless` 5.5.0: the browser build's parser, buffer and scrollback
 * with the renderer taken out, so it measures the same work the DOM renderer's
 * write path does.
 */
async function benchXterm(lines) {
	const chunks = payload(lines);
	const bytes = chunks.reduce((sum, c) => sum + c.length, 0);
	const headless = await import('@xterm/headless');
	const { Terminal } = headless.default ?? headless;
	const heapBefore = retained();

	let terminal = new Terminal({
		cols: COLS,
		rows: ROWS,
		scrollback: SCROLLBACK_LINES,
		// `buffer.active` is proposed API in 5.5; the plugin's renderer reads it
		// for `snapshotLines()`, so the benchmark has to be allowed to as well.
		allowProposedApi: true,
	});
	const started = process.hrtime.bigint();
	for (const chunk of chunks) {
		// xterm parses asynchronously in slices; awaiting each chunk is both
		// honest about the cost and closer to how herdr's frames arrive.
		await new Promise((resolve) => terminal.write(chunk, resolve));
	}
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

	const scrollback = terminal.buffer.active.length - ROWS;
	const heapAfter = retained();
	terminal.dispose();
	// Same reason as the ghostty harness: dispose *and* drop.
	terminal = null;
	await settle();
	const heapFreed = retained();

	return {
		engine: 'xterm.js',
		lines,
		bytes,
		elapsedMs,
		scrollbackLines: scrollback,
		heapBefore,
		heapAfter,
		heapAfterFree: heapFreed,
	};
}

/**
 * One turn of the event loop before a reading. xterm.js parses in slices behind
 * `setTimeout`, so a terminal disposed on the same tick is still reachable from
 * a scheduled callback and its buffer looks retained when it is not.
 */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Runs one engine in a fresh process, so neither heap sees the other's work. */
function runEngineChild(engine, lines) {
	const out = execFileSync(
		process.execPath,
		[
			'--expose-gc',
			fileURLToPath(import.meta.url),
			'--engine',
			engine,
			'--lines',
			String(lines),
			'--json',
		],
		{ cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
	);
	return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// 3. Repaint behaviour — read, not measured
// ---------------------------------------------------------------------------

/**
 * Both libraries' render scheduling, with every claim tied to a string that
 * must still be present in the installed source. A claim whose evidence has
 * gone is reported as STALE rather than quietly repeated.
 */
const REPAINT_CLAIMS = [
	{
		file: 'node_modules/ghostty-web/dist/ghostty-web.js',
		symbol: 'Terminal.startRenderLoop()',
		evidence: 'this.animationFrameId = requestAnimationFrame(A)',
		claim:
			'ghostty-web schedules the next animation frame unconditionally: the loop body checks only isDisposed and isOpen, never whether anything changed. An idle terminal therefore wakes 60 times a second and, each time, calls renderer.render() plus getCursor() across the WASM boundary. There is no visibility check either; an Obsidian tab in the background is still in a visible window, so the frames keep coming until dispose().',
	},
	{
		file: 'node_modules/ghostty-web/dist/ghostty-web.js',
		symbol: 'CanvasRenderer.render()',
		evidence: 'A.isRowDirty(',
		claim:
			'What that frame does is not a full repaint, though: CanvasRenderer.render() asks the WASM which rows are dirty and redraws those. So the cost of an idle ghostty-web terminal is the wakeup and the WASM round trips, not 60 full canvas redraws a second.',
	},
	{
		file: 'node_modules/@xterm/xterm/src/browser/RenderDebouncer.ts',
		symbol: 'RenderDebouncer.refresh()',
		evidence: 'if (this._animationFrame) {',
		claim:
			'xterm.js repaints only dirty rows, and only when something asked it to. RenderService.refreshRows(start, end) widens a pending row range and hands it to RenderDebouncer.refresh(), which requests an animation frame only when none is already pending and then renders exactly that range. Nothing pending means no frame is requested at all: an idle xterm.js terminal schedules nothing.',
	},
	{
		file: 'node_modules/@xterm/xterm/src/browser/services/RenderService.ts',
		symbol: 'RenderService._registerIntersectionObserver()',
		evidence: 'new w.IntersectionObserver(',
		claim:
			'And xterm.js pauses itself when hidden: an IntersectionObserver on the screen element sets _isPaused, and refreshRows() then only records that a full refresh is owed. A terminal in a background Obsidian tab costs nothing even before the plugin disposes it (#15).',
	},
];

function checkRepaintClaims() {
	return REPAINT_CLAIMS.map((claim) => {
		let present = false;
		try {
			present = readFileSync(path.join(ROOT, claim.file), 'utf8').includes(
				claim.evidence,
			);
		} catch {
			present = false;
		}
		return { ...claim, present };
	});
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportBundle(sizes) {
	console.log('## Bundle contribution (minified main.js, bytes)\n');
	console.log(`  neither engine   ${fmtKb(sizes.neither).padStart(9)}`);
	console.log(
		`  ghostty-web only ${fmtKb(sizes.ghostty).padStart(9)}   +${fmtKb(sizes.ghosttyCost)}`,
	);
	console.log(
		`  xterm.js only    ${fmtKb(sizes.xterm).padStart(9)}   +${fmtKb(sizes.xtermCost)}`,
	);
	console.log(
		`  both (shipped)   ${fmtKb(sizes.both).padStart(9)}   +${fmtKb(sizes.bothCost)}`,
	);
	console.log('');
}

function reportThroughput(results) {
	console.log('## Write throughput and retained memory\n');
	console.log(
		'  The payload (36 MB of Buffers at the default line count) is held for the\n' +
			'  whole run, so absolute `external` is large in both columns; the deltas\n' +
			'  are what the terminal itself costs.\n',
	);
	for (const r of results) {
		const seconds = r.elapsedMs / 1000;
		console.log(`  ${r.engine}`);
		console.log(
			`    ${r.lines.toLocaleString('en-US')} lines / ${fmtMb(r.bytes)} in ${r.elapsedMs.toFixed(0)} ms` +
				` = ${(mb(r.bytes) / seconds).toFixed(1)} MB/s, ${Math.round(r.lines / seconds).toLocaleString('en-US')} lines/s`,
		);
		console.log(
			`    scrollback retained: ${r.scrollbackLines.toLocaleString('en-US')} lines`,
		);
		if (r.engine === 'ghostty-web') {
			console.log(
				`    wasm memory: ${fmtMb(r.wasmBefore)} → ${fmtMb(r.wasmAfter)}` +
					` (+${fmtMb(r.wasmAfter - r.wasmBefore)}), still ${fmtMb(r.wasmRetainedAfterFree)} after free()`,
			);
		}
		console.log(
			`    js heap + external: ${fmtMb(r.heapBefore.total)} → ${fmtMb(r.heapAfter.total)}` +
				` (+${fmtMb(r.heapAfter.total - r.heapBefore.total)}),` +
				` ${fmtMb(r.heapAfterFree.total)} after dispose + gc`,
		);
		console.log(
			`      of which heapUsed ${fmtMb(r.heapAfter.heapUsed)}, external ${fmtMb(r.heapAfter.external)}; rss ${fmtMb(r.heapAfter.rss)}`,
		);
		console.log(
			`      never returned: ${fmtMb(r.heapAfterFree.total - r.heapBefore.total)}`,
		);
		console.log('');
	}
}

function reportRepaint(claims) {
	console.log('## Repaint scheduling (read, not measured)\n');
	for (const claim of claims) {
		console.log(`  ${claim.present ? '[verified]' : '[STALE]'} ${claim.symbol}`);
		console.log(`    ${claim.file}`);
		console.log(`    ${claim.claim}`);
		console.log('');
	}
	if (claims.some((c) => !c.present)) {
		console.log(
			'  A STALE line means the quoted code is no longer in the installed\n' +
				'  package: re-read it before trusting the claim above it.\n',
		);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.only === 'help') {
		console.log(
			'node scripts/bench-renderers.mjs [--only bundle|throughput|repaint] [--lines N] [--json]',
		);
		return;
	}

	// Child mode: one engine, one JSON line, its own heap.
	if (args.engine) {
		const result =
			args.engine === 'ghostty-web'
				? await benchGhostty(args.lines)
				: await benchXterm(args.lines);
		process.stdout.write(JSON.stringify(result));
		return;
	}

	if (typeof globalThis.gc !== 'function') {
		// Retained memory means "survives two collections", so the run needs
		// --expose-gc; re-exec rather than report numbers that include garbage.
		const out = execFileSync(
			process.execPath,
			['--expose-gc', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
			{ cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
		);
		process.stdout.write(out);
		return;
	}

	const wanted = (section) => args.only === 'all' || args.only === section;
	const report = {};

	if (wanted('bundle')) report.bundle = await benchBundle();
	if (wanted('throughput')) {
		report.throughput = [
			runEngineChild('ghostty-web', args.lines),
			runEngineChild('xterm.js', args.lines),
		];
	}
	if (wanted('repaint')) report.repaint = checkRepaintClaims();

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(
		`# Renderer benchmark, ${COLS}x${ROWS} grid, node ${process.version}\n`,
	);
	if (report.bundle) reportBundle(report.bundle);
	if (report.throughput) reportThroughput(report.throughput);
	if (report.repaint) reportRepaint(report.repaint);
}

await main();
