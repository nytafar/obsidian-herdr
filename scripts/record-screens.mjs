/**
 * `npm run record-screens`: re-records Claude's dialog screens on herdr and
 * herdr-core and diffs them against the last set (issue #168). The work is in
 * `scripts/record-screens/main.ts`, which reuses the plugin's own clients and
 * screen access; this bundles it with esbuild into a temporary folder, runs
 * it, and removes the folder. Not shipped: esbuild's only plugin entry point
 * is `src/main.ts`.
 *
 *     npm run record-screens -- --help
 */

import esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const dir = mkdtempSync(path.join(tmpdir(), 'record-screens-'));
let code = 1;
try {
	const outfile = path.join(dir, 'record-screens.mjs');
	await esbuild.build({
		entryPoints: [path.join(HERE, 'record-screens', 'main.ts')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		outfile,
		// Nothing here reaches Obsidian; the stub keeps a stray type import harmless.
		alias: { obsidian: path.join(ROOT, 'tests', 'fixtures', 'obsidian.ts') },
		logLevel: 'warning',
	});
	// A child of its own, so this process can remove the bundle whatever it does.
	const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
		stdio: 'inherit',
		env: { ...process.env, RECORD_SCREENS_ROOT: ROOT },
	});
	// The child closes its panes first on SIGINT or SIGTERM; this one passes
	// them on (Ctrl+C reaches both, which the child takes as one) and waits.
	process.on('SIGINT', () => child.kill('SIGINT'));
	process.on('SIGTERM', () => child.kill('SIGTERM'));
	code = await new Promise((resolve) => child.on('exit', (exit, signal) => resolve(exit ?? (signal ? 1 : 0))));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
