/**
 * Isolated scope invariants from the 2026-09-06 review.
 * Run from the repository root:
 *   node docs/reviews/2026-09-06/scope-repros.mjs
 *
 * Bundles source in memory. Does not load Obsidian, contact herdr, read vault
 * contents, or write the live main.js. A failed invariant sets exit status 1.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
	entryPoints: ['src/herdr/scope.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
});
const source = Buffer.from(bundle.outputFiles[0].text).toString('base64');
const { WorkspaceScope } = await import(`data:text/javascript;base64,${source}`);

const vaultPath = '/synthetic-vault/hvelv';
const workspace = (id, label) => ({ workspace_id: id, label });
const pane = (id, workspaceId, cwd = '/elsewhere') => ({
	pane_id: id,
	workspace_id: workspaceId,
	tab_id: `${workspaceId}:t`,
	agent: 'claude',
	agent_status: 'idle',
	cwd,
});
const state = (scope) => ({
	workspace: scope.workspaceId,
	panes: scope.list().map((entry) => [entry.paneId, entry.workspaceId]),
});

function check(name, actual, expected) {
	try {
		assert.deepEqual(actual, expected);
		console.log(`PASS: ${name}`);
	} catch {
		process.exitCode = 1;
		console.log(`FAIL: ${name}`);
		console.log(`  expected: ${JSON.stringify(expected)}`);
		console.log(`  actual:   ${JSON.stringify(actual)}`);
	}
}

const scope = new WorkspaceScope({ vaultPath });
scope.prime(
	[workspace('a', 'hvelv'), workspace('b', 'other')],
	[pane('pa', 'a'), pane('pb', 'b')],
);
scope.ingest({ event: 'workspace_renamed', data: { workspace_id: 'a', label: 'old' } });
check('renaming the matching workspace away removes its panes', state(scope), {
	workspace: null,
	panes: [],
});
scope.ingest({ event: 'workspace_renamed', data: { workspace_id: 'b', label: 'hvelv' } });
check('renaming another workspace into scope replaces the pane collection', state(scope), {
	workspace: 'b',
	panes: [['pb', 'b']],
});

const unresolved = new WorkspaceScope({ vaultPath });
unresolved.prime([workspace('a', 'other')], []);
unresolved.ingest({
	event: 'pane_created',
	data: { pane: pane('pa', 'a', vaultPath) },
});
check('a newly created in-vault pane enables cwd fallback resolution', state(unresolved), {
	workspace: 'a',
	panes: [['pa', 'a']],
});
