/**
 * Installs the plugin into a vault for development by symlinking ONLY the three
 * release artifacts.
 *
 * Do not symlink the repository root into `.obsidian/plugins/`. Obsidian
 * enumerates plugin folders at startup, and the repo carries `node_modules` and
 * `.git` — around 37,000 files — which stalls the vault on "Loading vault...".
 * Verified on 2026-09-06: the same vault opened normally once only the
 * artifacts were exposed.
 *
 * Usage: node scripts/install-dev.mjs <vault path>
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = process.argv[2];

if (!vault) {
	console.error('usage: node scripts/install-dev.mjs <vault path>');
	process.exit(1);
}
const target = join(resolve(vault), '.obsidian', 'plugins', 'herdr');
if (existsSync(target) || lstatSafe(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of ARTIFACTS) symlinkSync(join(repo, file), join(target, file));
writeFileSync(join(target, '.hotreload'), '');
console.log(`linked ${ARTIFACTS.join(', ')} into ${target}`);

function lstatSafe(path) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}
