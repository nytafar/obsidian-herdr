/**
 * Read-only transport audit reproductions for HEAD 1440d7d.
 * Run from the repository root: node docs/reviews/2026-09-06/transport-repros.mjs
 *
 * Bundles source in memory. All SSH processes, probes and socket removals are
 * mocked; this script does not contact or modify the live vault or herdr server.
 * Assertions pin the defects observed at review time, not desired behavior.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function bundle(relativePath) {
	const result = await build({
		absWorkingDir: repository,
		entryPoints: [relativePath],
		bundle: true,
		write: false,
		platform: 'node',
		format: 'cjs',
	});
	const module = { exports: {} };
	new Function('require', 'module', 'exports', result.outputFiles[0].text)(
		require, module, module.exports,
	);
	return module.exports;
}

class FakeChild extends EventEmitter {
	alive = true;
	signals = [];

	kill(signal = 'SIGTERM') {
		this.signals.push(signal);
		if (this.alive) {
			this.alive = false;
			this.emit('exit', null, signal);
		}
		return true;
	}
}

const { LineSplitter } = await bundle('src/bridge/terminalSession.ts');
for (const [name, chunks] of [
	['oversized complete line', ['x'.repeat(100) + '\n']],
	['buffered prefix plus oversized final chunk', ['x'.repeat(15), 'x'.repeat(100) + '\n']],
]) {
	const splitter = new LineSplitter(16);
	const lines = chunks.flatMap((chunk) => splitter.push(Buffer.from(chunk)));
	assert(lines[0].length > 16);
	console.log(`CONFIRMED framing: ${name}: budget=16, accepted=${lines[0].length}`);
}

// Overflow also fails to enter a discard-until-newline state: a suffix of the
// rejected line can be returned as a new record.
const resync = new LineSplitter(16);
assert.throws(() => resync.push(Buffer.from('x'.repeat(17))), /exceeded/);
assert.deepEqual(resync.push(Buffer.from('suffix\nok\n')), ['suffix', 'ok']);
console.log('CONFIRMED framing: suffix of an oversized line is emitted as a fresh record');

const { SshTunnel } = await bundle('src/herdr/ssh.ts');
let finishHome;
const home = new Promise((resolve) => { finishHome = resolve; });
const leakedChildren = [];
const stopping = new SshTunnel({
	host: 'audit.invalid',
	remoteSocketPath: '~/herdr.sock',
	deps: {
		run: () => home,
		removeFile: async () => {},
		probe: async () => true,
		spawn: () => {
			const child = new FakeChild();
			leakedChildren.push(child);
			return child;
		},
	},
});
const starting = stopping.start().catch((error) => error.message);
await stopping.stop();
finishHome('/home/audit');
assert.match(await starting, /stopped while connecting/);
assert.equal(leakedChildren.length, 1);
assert.equal(leakedChildren[0].alive, true);
assert.deepEqual(leakedChildren[0].signals, []);
assert.equal(stopping.status.state, 'starting');
console.log('CONFIRMED SSH cancellation: child spawned after stop resolved; alive=true; signals=[]');

// Two plugin instances with the same remote profile own the same pathname.
// Mimic unlink and bind with a Map; no real socket files are created.
const sockets = new Map();
const instances = [];
for (const owner of ['vault A', 'vault B']) {
	const child = new FakeChild();
	const tunnel = new SshTunnel({
		host: 'audit.invalid',
		remoteSocketPath: '/home/audit/herdr.sock',
		killGraceMs: 1,
		deps: {
			run: async () => '',
			removeFile: async (path) => { sockets.delete(path); },
			probe: async (path) => sockets.has(path),
			spawn: (_file, args) => {
				const specification = args[args.indexOf('-L') + 1];
				const path = specification.slice(0, specification.indexOf(':'));
				sockets.set(path, owner);
				return child;
			},
		},
	});
	await tunnel.start();
	instances.push({ tunnel, child });
}
const [first, second] = instances;
assert.equal(first.tunnel.localSocketPath, second.tunnel.localSocketPath);
assert.equal(sockets.get(second.tunnel.localSocketPath), 'vault B');
await first.tunnel.stop();
assert.equal(sockets.has(second.tunnel.localSocketPath), false);
assert.equal(second.child.alive, true);
assert.equal(second.tunnel.status.state, 'connected');
console.log('CONFIRMED SSH ownership: stopping vault A removes vault B socket while B reports connected');
await second.tunnel.stop();
