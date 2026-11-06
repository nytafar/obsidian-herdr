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

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ActionHost } from '../src/actions';
import { ClaudeActions } from '../src/claude/actions';
import { ClaudeAgents } from '../src/claude/agents';
import HerdrPlugin from '../src/main';
import type { GraduationRelease } from '../src/runtime/kind';
import { newRuntime } from '../src/runtimes';

interface World {
	plugin: HerdrPlugin;
	calls: string[];
	targetId: string;
}

function world(options: {
	release: GraduationRelease | null | Error | ((paneId: string) => Promise<GraduationRelease | null>);
	ready: boolean;
	started: boolean;
}): World {
	const calls: string[] = [];
	const target = newRuntime('herdr-core', 'local', []);
	const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
	const loose = plugin as unknown as Record<string, unknown>;
	loose.settings = { runtimes: [target] };
	Object.defineProperty(plugin, 'endpoint', { value: { id: 'claude-runtime' } });
	Object.defineProperty(plugin, 'actions', {
		value: {
			releaseForGraduation: (paneId: string) => {
				calls.push('release');
				if (typeof options.release === 'function') return options.release(paneId);
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

/** A stream claude that ignores stdin EOF, SIGTERM and SIGKILL: stuck in the kernel, say. */
class StuckChild extends EventEmitter {
	readonly pid = 4242;
	readonly signals: string[] = [];
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly stdin = {
		write: (): boolean => true,
		end: (): void => undefined,
		on: () => this.stdin,
	};

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.signals.push(signal);
		return true;
	}
}

describe('graduation of a process that will not die (the final D2 review)', () => {
	it('throws, gives the row back stopped, and starts nothing on the target', async () => {
		const runtimeId = 'claude-runtime';
		const children: StuckChild[] = [];
		const agents = new ClaudeAgents({
			load: () => [{ id: 'cl-1', sessionId: RELEASE.sessionId, cwd: '/vault', name: 'a', started: true }],
			save: () => undefined,
			env: () => ({}),
			exists: () => false,
			notice: () => undefined,
			newSessionId: () => RELEASE.sessionId,
			newAgentId: () => 'cl-2',
			spawn: () => {
				const child = new StuckChild();
				children.push(child);
				return child;
			},
			// Every stop wait runs out at once.
			timers: { setTimeout: (handler) => setTimeout(handler, 0), clearTimeout: (handle) => clearTimeout(handle as never) },
		});
		agents.configure(runtimeId, { binary: '/opt/fake/claude', permissionMode: 'manual' });
		agents.resume(runtimeId, 'cl-1');
		expect(children).toHaveLength(1);
		const actions = new ClaudeActions({ runtime: () => ({ id: runtimeId }) } as unknown as ActionHost, agents);

		let thrown: unknown = null;
		const w = world({
			release: (paneId) =>
				actions.releaseForGraduation(paneId).catch((error: unknown) => {
					thrown = error;
					throw error;
				}),
			ready: true,
			started: true,
		});
		await graduate(w);
		expect(String(thrown)).toContain('the agent did not stop');
		expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
		// The Notice says why; the target is never switched to or started on.
		expect(w.calls).toEqual(['release']);
		expect(agents.get(runtimeId, 'cl-1')?.mode).toBe('stream');

		// The row was given back, stopped: once the old process is really gone, a
		// person may resume it here, which a released row refuses.
		children[0]?.emit('exit', null, 'SIGKILL');
		expect(agents.get(runtimeId, 'cl-1')?.status).toBe('stopped');
		expect(() => agents.resume(runtimeId, 'cl-1')).not.toThrow();
		expect(children).toHaveLength(2);
	});
});
