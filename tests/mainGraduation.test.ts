/**
 * Graduation's second half in the plugin (ADR-0007, the D2 review): once a
 * `claude` row is released its process is gone and the row is held, so
 * nothing here starts the session while the target runtime resumes it. When
 * the session does not move after all, the row is given back (stopped, for
 * the user to resume); when it moves, the row is forgotten.
 *
 * The plugin is built with `Object.create`, as in `mainPlacement.test.ts`:
 * `continueIn` needs the settings, the actions, the runtime switch and the
 * agent table, and nothing else.
 */

import { describe, expect, it } from 'vitest';
import HerdrPlugin from '../src/main';
import type { GraduationRelease } from '../src/runtime/kind';
import { newRuntime } from '../src/runtimes';

interface World {
	plugin: HerdrPlugin;
	calls: string[];
	targetId: string;
}

function world(options: { release: GraduationRelease | null | Error; ready: boolean; started: boolean }): World {
	const calls: string[] = [];
	const target = newRuntime('herdr-core', 'local', []);
	const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
	const loose = plugin as unknown as Record<string, unknown>;
	loose.settings = { runtimes: [target] };
	Object.defineProperty(plugin, 'endpoint', { value: { id: 'claude-runtime' } });
	Object.defineProperty(plugin, 'actions', {
		value: {
			releaseForGraduation: () => {
				calls.push('release');
				return options.release instanceof Error ? Promise.reject(options.release) : Promise.resolve(options.release);
			},
			startAgentHere: () => {
				calls.push('start');
				return Promise.resolve(options.started ? { paneId: 'p1' } : null);
			},
		},
	});
	loose.switchRuntime = () => {
		calls.push('switch');
		return Promise.resolve();
	};
	loose.scopeReady = () => Promise.resolve(options.ready);
	loose.detachTerminalLeaves = () => calls.push('detach');
	loose.claudeKind = {
		agents: {
			reclaim: (runtimeId: string, paneId: string) => calls.push(`reclaim ${runtimeId} ${paneId}`),
			forget: (runtimeId: string, paneId: string) => {
				calls.push(`forget ${runtimeId} ${paneId}`);
				return Promise.resolve();
			},
		},
	};
	return { plugin, calls, targetId: target.id };
}

const RELEASE: GraduationRelease = { cwd: '/vault', sessionId: '11111111-2222-4333-8444-555555555555' };

function graduate(w: World): Promise<void> {
	return w.plugin.continueIn('cl-1', 'claude-runtime', w.targetId);
}

describe('graduation in the plugin', () => {
	it('forgets the row once the agent runs on the target, and gives nothing back', async () => {
		const w = world({ release: RELEASE, ready: true, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'start', 'forget claude-runtime cl-1', 'detach']);
	});

	it('gives the row back when the target does not connect', async () => {
		const w = world({ release: RELEASE, ready: false, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'reclaim claude-runtime cl-1']);
	});

	it('gives the row back when the target does not start the agent', async () => {
		const w = world({ release: RELEASE, ready: true, started: false });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'start', 'reclaim claude-runtime cl-1']);
	});

	it('starts nothing on the target when the process here could not be confirmed gone', async () => {
		const w = world({ release: new Error('the agent did not stop, so it was not moved'), ready: true, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release']);
	});
});
