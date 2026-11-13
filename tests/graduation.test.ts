/**
 * Graduation (ADR-0007, #185), through its own interface with fakes of what
 * it acts through: once a `claude` row is released its process is gone and
 * the row is held, so nothing here starts the session while the target
 * runtime resumes it. When the session does not move after all, the row is
 * given back (stopped, for the user to resume); when it moves, the row is
 * forgotten. Which runtimes can take a row is what their kinds say.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ActionHost } from '../src/actions';
import { ClaudeActions } from '../src/claude/actions';
import { ClaudeAgents } from '../src/claude/agents';
import { Graduation } from '../src/graduation';
import {
	CLAUDE_CAPABILITIES,
	HERDR_CAPABILITIES,
	HERDR_CORE_CAPABILITIES,
	type GraduationRelease,
	type RuntimeCapabilities,
	type StartAgentOptions,
} from '../src/runtime/kind';
import { newRuntime, type RuntimeConfig, type RuntimeKind } from '../src/runtimes';

/** What a target was asked to start, and where. */
interface Started {
	folder: string;
	start: StartAgentOptions | undefined;
}

interface World {
	graduation: Graduation;
	calls: string[];
	starts: Started[];
	targetId: string;
}

const CAPABILITIES: Record<RuntimeKind, Readonly<RuntimeCapabilities>> = {
	herdr: HERDR_CAPABILITIES,
	'herdr-core': HERDR_CORE_CAPABILITIES,
	claude: CLAUDE_CAPABILITIES,
};

function graduationOver(
	runtimes: RuntimeConfig[],
	options: {
		release?: (paneId: string) => Promise<GraduationRelease | null>;
		ready?: boolean;
		started?: boolean;
		unavailable?: Partial<Record<RuntimeKind, string>>;
	},
	calls: string[] = [],
	starts: Started[] = [],
): Graduation {
	return new Graduation({
		settings: () => ({ runtimes, activeRuntime: 'claude-runtime' }),
		kindOf: (kind) => ({ capabilities: CAPABILITIES[kind], unavailable: options.unavailable?.[kind] ?? null }),
		listEndpointId: () => 'claude-runtime',
		actions: () => ({
			releaseForGraduation: (paneId: string) => {
				calls.push('release');
				return options.release?.(paneId) ?? Promise.resolve(null);
			},
			startAgentHere: (folder: string, start?: StartAgentOptions) => {
				calls.push('start');
				starts.push({ folder, start });
				return Promise.resolve(options.started ? { paneId: 'p1' } : null);
			},
		}),
		switchRuntime: () => {
			calls.push('switch');
			return Promise.resolve();
		},
		scopeReady: () => Promise.resolve(options.ready ?? false),
		detachTerminalLeaves: () => calls.push('detach'),
		notice: () => undefined,
	});
}

/** A release handle that records what was done with the row. */
function handle(calls: string[], runtimeId = 'claude-runtime', paneId = 'cl-1'): GraduationRelease {
	return {
		cwd: '/vault',
		sessionId: '11111111-2222-4333-8444-555555555555',
		start: { kind: 'claude', args: ['--resume', '11111111-2222-4333-8444-555555555555'] },
		forget: () => {
			calls.push(`forget ${runtimeId} ${paneId}`);
			return Promise.resolve();
		},
		reclaim: () => calls.push(`reclaim ${runtimeId} ${paneId}`),
	};
}

function world(options: {
	release: 'released' | null | Error | ((paneId: string) => Promise<GraduationRelease | null>);
	ready: boolean;
	started: boolean;
}): World {
	const calls: string[] = [];
	const starts: Started[] = [];
	const target = newRuntime('herdr-core', 'local', []);
	const release = options.release;
	const graduation = graduationOver(
		[target],
		{
			ready: options.ready,
			started: options.started,
			release: (paneId) => {
				if (typeof release === 'function') return release(paneId);
				if (release instanceof Error) return Promise.reject(release);
				return Promise.resolve(release === 'released' ? handle(calls) : null);
			},
		},
		calls,
		starts,
	);
	return { graduation, calls, starts, targetId: target.id };
}

const RELEASE = { cwd: '/vault', sessionId: '11111111-2222-4333-8444-555555555555' };

function graduate(w: World): Promise<void> {
	return w.graduation.continueIn('cl-1', 'claude-runtime', w.targetId);
}

describe('graduation', () => {
	it('forgets the row once the agent runs on the target, and gives nothing back', async () => {
		const w = world({ release: 'released', ready: true, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'start', 'forget claude-runtime cl-1', 'detach']);
	});

	it('starts on the target what the release says resumes it, in its folder, and builds no command line itself', async () => {
		const w = world({ release: 'released', ready: true, started: true });
		await graduate(w);
		expect(w.starts).toEqual([{ folder: '/vault', start: handle([]).start }]);
	});

	it('gives the row back when the target does not connect', async () => {
		const w = world({ release: 'released', ready: false, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'reclaim claude-runtime cl-1']);
	});

	it('gives the row back when the target does not start the agent', async () => {
		const w = world({ release: 'released', ready: true, started: false });
		await graduate(w);
		expect(w.calls).toEqual(['release', 'switch', 'start', 'reclaim claude-runtime cl-1']);
	});

	it('starts nothing on the target when the process here could not be confirmed gone', async () => {
		const w = world({ release: new Error('the agent did not stop, so it was not moved'), ready: true, started: true });
		await graduate(w);
		expect(w.calls).toEqual(['release']);
	});

	it('does nothing for a row of another runtime than the list’s, or a target that is gone', async () => {
		const w = world({ release: 'released', ready: true, started: true });
		await w.graduation.continueIn('cl-1', 'elsewhere', w.targetId);
		await w.graduation.continueIn('cl-1', 'claude-runtime', 'rt-gone');
		expect(w.calls).toEqual([]);
	});
});

describe('graduation targets', () => {
	const herdr = { ...newRuntime('herdr', 'local', [], () => 0.1), id: 'rt-h', name: 'Here' };
	const core = { ...newRuntime('herdr-core', 'local', [], () => 0.2), id: 'rt-c1', name: 'Core one' };
	const core2 = { ...newRuntime('herdr-core', 'local', [], () => 0.3), id: 'rt-c2', name: 'Core two' };
	const ssh = { ...newRuntime('herdr', 'ssh', [], () => 0.4), id: 'rt-s', host: 'xl' };
	const claude = { ...newRuntime('claude', 'local', [], () => 0.5), id: 'claude-runtime' };

	it('are the local runtimes whose kind can take a row, labelled by kind, named when the kind has several', () => {
		expect(graduationOver([herdr, core, core2, ssh, claude], {}).targets()).toEqual([
			{ id: 'rt-h', label: 'herdr' },
			{ id: 'rt-c1', label: 'herdr-core (Core one)' },
			{ id: 'rt-c2', label: 'herdr-core (Core two)' },
		]);
	});

	it('leave out a kind this build cannot run', () => {
		expect(graduationOver([herdr, core], { unavailable: { 'herdr-core': 'not here' } }).targets()).toEqual([
			{ id: 'rt-h', label: 'herdr' },
		]);
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
