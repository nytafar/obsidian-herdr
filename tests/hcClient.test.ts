/**
 * The herdr-core runtime client, kind, actions and senders against a fake
 * `hc connect` (ADR-0005): reconnect after the core or the line goes,
 * `missed`, heartbeats, the stall watchdog, the generation warning, the
 * transport argv, the connection driven by the real coordinator, and the
 * action mapping.
 */
import { describe, expect, it } from 'vitest';
import { HcClient, remoteConnectCommand, sshConnectArgv, STALL_MS, type HcTimers } from '../src/hc/client';
import { HcActions, agentLaunchLine, hcKeyName, hcKeySender, hcPromptSender, hcTerminalName } from '../src/hc/actions';
import { HcScope } from '../src/hc/scope';
import { ConnectionCoordinator, endpointOf } from '../src/connection';
import { createHerdrCoreKind, hcStatusLines, loadSpaces } from '../src/runtime/herdrCoreKind';
import { HERDR_CORE_CAPABILITIES, HERDR_CORE_TERMINAL_UNAVAILABLE } from '../src/runtime/kind';
import { newRuntime, type RuntimeConfig } from '../src/runtimes';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import type { ActionHost } from '../src/actions';
import { encodeFrame, FrameKind } from '../src/hc/frames';
import { fakeSpawner, HELLO_RESULT, RpcError, settle, type FakeCore } from './fixtures/fakeHc';

/** Timers the test fires by hand. */
function manualTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	const timers: HcTimers = {
		set: (callback, ms) => {
			const id = next++;
			pending.set(id, { callback, ms });
			return id;
		},
		clear: (handle) => {
			pending.delete(handle as number);
		},
	};
	const fire = (ms?: number): number => {
		let fired = 0;
		for (const [id, entry] of [...pending]) {
			if (ms !== undefined && entry.ms !== ms) continue;
			pending.delete(id);
			entry.callback();
			fired++;
		}
		return fired;
	};
	return { timers, fire, pending };
}

function terminal(address: string, extra: Record<string, unknown> = {}) {
	return {
		address,
		argv: ['bash'],
		cwd: '/home/lasse/hvelv',
		state: 'live',
		labels: {},
		foreground: { name: 'claude', argv: ['claude'], cwd: '/home/lasse/hvelv', pid: 1 },
		status: { state: 'idle', app: 'claude-code' },
		reported: true,
		turn: 0,
		title: '',
		...extra,
	};
}

function coreWith(terminals: unknown[], seq = 10) {
	return (core: FakeCore): void => {
		core.handlers.set('events.subscribe', () => ({ seq, channel: 1, terminals }));
		core.handlers.set('doc.get', () => ({ value: { spaces: [] }, version: 1 }));
	};
}

describe('HcClient', () => {
	it('subscribes, then redials and resubscribes after the core goes away', async () => {
		const { spawn, cores } = fakeSpawner(coreWith([terminal('t1')]));
		const { timers, fire } = manualTimers();
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers });
		const seen: string[] = [];
		client.on('connected', () => seen.push('connected'));
		client.on('disconnected', (error) => seen.push(`disconnected ${error?.message ?? ''}`));
		client.on('snapshot', (seq) => seen.push(`snapshot ${seq}`));
		await client.ping();
		client.subscribe();
		await settle();
		expect(seen).toEqual(['snapshot 10', 'connected']);
		expect(client.state).toBe('connected');

		cores[0]?.stderrText('core restarted\n');
		cores[0]?.exit(1);
		await settle();
		expect(seen.at(-1)).toContain('disconnected');
		expect(client.state).toBe('reconnecting');
		expect(fire(1000)).toBe(1);
		await settle();
		await settle();
		expect(cores).toHaveLength(2);
		expect(seen.slice(-2)).toEqual(['snapshot 10', 'connected']);
		client.dispose();
	});

	it('backs off while the core stays down', async () => {
		let attempt = 0;
		const { spawn, cores } = fakeSpawner((core) => {
			attempt++;
			coreWith([])(core);
			if (attempt > 1) core.silent = true;
		});
		const { timers, fire, pending } = manualTimers();
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers });
		await client.ping();
		client.subscribe();
		await settle();
		cores[0]?.exit(1);
		await settle();
		fire();
		await settle();
		cores[1]?.exit(255);
		await settle();
		expect([...pending.values()].map((entry) => entry.ms)).toContain(2000);
		client.dispose();
		expect(pending.size).toBe(0);
	});

	it('treats a stream silent past the heartbeat window as dropped', async () => {
		const { spawn, cores } = fakeSpawner(coreWith([]));
		const { timers, fire } = manualTimers();
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers });
		const seen: string[] = [];
		client.on('disconnected', (error) => seen.push(error?.message ?? ''));
		await client.ping();
		client.subscribe();
		await settle();
		// A heartbeat pushes the deadline out; nothing breaks.
		cores[0]?.write(cores[0].eventFrames(1, [{ method: 'heartbeat', params: { seq: 11 } }]));
		expect(seen).toEqual([]);
		expect(fire(STALL_MS)).toBe(1);
		expect(seen).toEqual(['herdr-core stopped sending heartbeats']);
		expect(cores[0]?.stdinEnded).toBe(true);
		client.dispose();
	});

	it('hands `missed` on as a snapshot that replaces state', async () => {
		const { spawn, cores } = fakeSpawner(coreWith([terminal('t1')]));
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers: manualTimers().timers });
		const snapshots: number[] = [];
		client.on('snapshot', (seq) => snapshots.push(seq));
		await client.ping();
		client.subscribe();
		await settle();
		cores[0]?.write(cores[0].eventFrames(1, [{ method: 'missed', params: { seq: 900, terminals: [] } }]));
		expect(snapshots).toEqual([10, 900]);
		client.dispose();
	});

	it('reports a generation mismatch once and connects anyway', async () => {
		const { spawn } = fakeSpawner((core) => {
			coreWith([])(core);
			core.handlers.set('hello', (params) => {
				if (params.generation !== undefined) throw new RpcError('unsupported_generation', 'this core speaks generation 2');
				return { ...HELLO_RESULT, generation: 2, version: '0.2.0' };
			});
		});
		const mismatches: unknown[] = [];
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers: manualTimers().timers, onMismatch: (m) => mismatches.push(m) });
		await client.ping();
		client.subscribe();
		await settle();
		expect(client.state).toBe('connected');
		expect(mismatches).toEqual([{ server: 2, expected: 1, version: '0.2.0' }]);
		client.dispose();
	});

	it('restarts the stream when the core closes the event channel', async () => {
		const { spawn, cores } = fakeSpawner(coreWith([]));
		const { timers, fire } = manualTimers();
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers });
		await client.ping();
		client.subscribe();
		await settle();
		cores[0]?.write(encodeFrame(1, FrameKind.Close));
		expect(client.state).toBe('reconnecting');
		fire(1000);
		await settle();
		await settle();
		expect(client.state).toBe('connected');
		client.dispose();
	});
});

describe('transport argv', () => {
	it('runs hc connect over ssh with the core’s own fallbacks', () => {
		const argv = sshConnectArgv('asher', '');
		expect(argv.slice(0, 2)).toEqual(['ssh', '-T']);
		expect(argv).toContain('BatchMode=yes');
		expect(argv.at(-2)).toBe('asher');
		expect(argv.at(-1)).toContain('command -v hc || command -v herdr-core');
		expect(argv.at(-1)?.startsWith("sh -c '")).toBe(true);
		expect(remoteConnectCommand('~/.local/bin/hc')).toBe(`sh -c 'exec "$HOME"/.local/bin/hc connect'`);
		expect(() => sshConnectArgv('  ', '')).toThrow('no SSH host');
	});
});

const LOCAL_HC: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.25), name: 'hc here' };
const ASHER: RuntimeConfig = {
	...newRuntime('herdr-core', 'ssh', [], () => 0.5),
	host: 'asher',
	remoteVaultPath: '/root/vault',
};

function kindHost(spawn: ReturnType<typeof fakeSpawner>['spawn'], timers: HcTimers) {
	return {
		extraPath: () => '',
		spawnEnv: () => ({}),
		vaultPath: () => '/home/lasse/hvelv',
		vaultName: () => 'hvelv',
		onMismatch: () => undefined,
		currentScope: () => null,
		spawn,
		timers,
	};
}

describe('the herdr-core kind', () => {
	it('connects through the coordinator and lists the vault’s agents', async () => {
		const { spawn, cores } = fakeSpawner((core) => {
			coreWith([terminal('t1'), terminal('t2', { foreground: { name: 'bash', argv: [], cwd: '/', pid: 1 }, status: null }), terminal('asher/t3')])(core);
			core.handlers.set('doc.get', () => ({ value: { spaces: [{ id: 'sp1', name: 'hvelv', tabs: [] }] }, version: 2 }));
		});
		const kind = createHerdrCoreKind(kindHost(spawn, manualTimers().timers));
		const driver = kind.connection;
		if (!driver) throw new Error('driver');
		const errors: (string | null)[] = [];
		const coordinator = new ConnectionCoordinator({
			endpoint: () => endpointOf(ASHER),
			driver: () => driver,
			notice: () => undefined,
			setError: (message) => errors.push(message),
			onReplaced: () => undefined,
			onPrimed: () => undefined,
		});
		await coordinator.connect();
		await settle();
		await settle();
		const scope = coordinator.current?.scope;
		expect(cores[0]?.argv[0]).toBe('ssh');
		// t1 has no herdr.space label, so the space matched but holds nothing.
		expect(scope?.method).toBe('label');
		expect(scope?.list()).toEqual([]);
		cores[0]?.write(cores[0].eventFrames(1, [
			{ method: 'event', params: { seq: 11, type: 'labels', terminal: 't1', data: { labels: { 'herdr.space': 'sp1' } } } },
		]));
		expect(scope?.list().map((row) => row.paneId)).toEqual(['t1']);
		expect(errors.filter((e) => e !== null)).toEqual([]);
		const lines = hcStatusLines(coordinator.current as never).map((line) => line.text);
		expect(lines[0]).toBe('Transport: ssh -T asher hc connect');
		expect(lines[1]).toBe('Core: oma, version 0.1.18, generation 1');
		coordinator.dispose();
	});

	it('needs the hc binary locally, a host over ssh, and says why a terminal tab is not there', () => {
		const { spawn } = fakeSpawner();
		const kind = createHerdrCoreKind(kindHost(spawn, manualTimers().timers));
		const driver = kind.connection;
		if (!driver) throw new Error('driver');
		const missing = { binary: null, status: null, identity: null, socketPath: '', error: 'hc was not found in …' };
		expect(driver.discoveryIssue(endpointOf(LOCAL_HC), missing)).toBe('hc was not found in …');
		expect(driver.discoveryIssue(endpointOf(ASHER), missing)).toBeNull();
		expect(driver.discoveryIssue(endpointOf({ ...ASHER, host: '' }), missing)).toBe('the runtime has no SSH host');
		expect(() => kind.terminalCommand(endpointOf(LOCAL_HC))).toThrow(HERDR_CORE_TERMINAL_UNAVAILABLE);
		expect(kind.capabilities).toEqual(HERDR_CORE_CAPABILITIES);
		expect(kind.unavailable).toBeNull();
	});

	it('treats a missing herdr-app document as no spaces, not an error', async () => {
		const scope = new HcScope({ space: '', vaultPath: '/v', vaultName: 'v' });
		// A lost connection is an error the prime reports.
		await expect(
			loadSpaces({ request: () => Promise.reject(new Error('not connected to herdr-core')) }, scope, () => false),
		).rejects.toThrow('not connected');
		expect(scope.spacesLoaded).toBe(false);
		const { spawn } = fakeSpawner((core) => {
			core.handlers.set('doc.get', () => {
				throw new RpcError('unknown_method', 'no doc.get');
			});
		});
		const client = new HcClient({ argv: ['hc'], spawn, timers: manualTimers().timers });
		await client.ping();
		await loadSpaces(client, scope, () => false);
		expect(scope.spacesLoaded).toBe(true);
		expect(scope.method).toBe('cwd');
		client.dispose();
	});
});

interface Recorded {
	method: string;
	params: Record<string, unknown>;
}

function actionHost(answer: (method: string, params: Record<string, unknown>) => unknown, settings: Partial<HerdrSettings> = {}) {
	const calls: Recorded[] = [];
	const notices: string[] = [];
	const opened: string[] = [];
	const forgotten: string[] = [];
	const request = <T,>(method: string, params: unknown): Promise<T> => {
		calls.push({ method, params: params as Record<string, unknown> });
		try {
			return Promise.resolve(answer(method, params as Record<string, unknown>) as T);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	};
	let now = 0;
	const host: ActionHost = {
		settings: () => ({ ...DEFAULT_SETTINGS, openTerminalAfterStart: true, ...settings }),
		runtime: () => LOCAL_HC,
		workspaceId: () => 'sp1',
		request,
		connection: () => request,
		takenAgentNames: () => new Set(['notes']),
		agentPanes: () => [],
		vaultName: () => 'hvelv',
		notice: (message) => notices.push(message),
		openTerminal: (paneId) => {
			opened.push(paneId);
			return Promise.resolve();
		},
		detachTerminalLeaves: () => undefined,
		forgetPane: (paneId) => forgotten.push(paneId),
		sleep: () => {
			now += 100;
			return Promise.resolve();
		},
		now: () => now,
	};
	return { host, calls, notices, opened, forgotten };
}

describe('herdr-core actions', () => {
	it('starts the default agent with terminal.run, labelled for herdr-app', async () => {
		const { host, calls, notices, opened } = actionHost(() => ({ address: 't12', name: 'notes-2' }));
		const actions = new HcActions(host, () => ({ space: { id: 'sp1', name: 'hvelv' } }));
		const started = await actions.startAgentHere('/home/lasse/hvelv/notes');
		expect(calls).toEqual([
			{
				method: 'terminal.run',
				params: {
					line: agentLaunchLine('claude'),
					cwd: '/home/lasse/hvelv/notes',
					name: 'notes-2',
					labels: { 'herdr.seen': '0', 'herdr.space': 'sp1' },
				},
			},
		]);
		expect(started).toEqual({ paneId: 't12', name: 'notes-2', kind: 'claude' });
		expect(notices[0]).toContain('started claude agent "notes-2"');
		expect(opened).toEqual(['t12']);
	});

	it('leaves out herdr.space in cwd mode and retries a taken name once', async () => {
		const { HcError } = await import('../src/hc/connection');
		let first = true;
		const { host, calls } = actionHost((method) => {
			if (method === 'terminal.run' && first) {
				first = false;
				throw new HcError('terminal.run', { code: -32000, message: 'name taken', data: { kind: 'name_taken' } });
			}
			return { address: 't13' };
		});
		const actions = new HcActions(host, () => ({ space: null }));
		await actions.startAgentHere('/home/lasse/hvelv/inbox');
		expect(calls.map((call) => call.params.name)).toEqual(['inbox', 'inbox-2']);
		expect(calls[0]?.params.labels).toEqual({ 'herdr.seen': '0' });
	});

	it('closes with terminal.kill then terminal.rm, and drops the row', async () => {
		const { host, calls, forgotten } = actionHost(() => ({}));
		const actions = new HcActions(host, () => null);
		expect(await actions.closePane('t5', 'rt-x')).toBe(true);
		expect(calls.map((call) => call.method)).toEqual(['terminal.kill', 'terminal.rm']);
		expect(forgotten).toEqual(['t5']);
	});

	it('takes a terminal the core no longer has as closed', async () => {
		const { HcError } = await import('../src/hc/connection');
		const { host, calls, notices } = actionHost(() => {
			throw new HcError('terminal.kill', { code: -32000, message: 'no terminal t5', data: { kind: 'not_found' } });
		});
		expect(await new HcActions(host, () => null).closePane('t5', 'rt-x')).toBe(true);
		expect(calls).toHaveLength(1);
		expect(notices[0]).toContain('already gone');
	});

	it('pins through the shared herdr.pinned label', async () => {
		const { host, calls } = actionHost(() => ({}));
		const actions = new HcActions(host, () => null);
		await actions.setPinned('t2', true);
		await actions.setPinned('t2', false);
		expect(calls.map((call) => call.params)).toEqual([
			{ terminal: 't2', labels: { 'herdr.pinned': '1' } },
			{ terminal: 't2', labels: { 'herdr.pinned': '' } },
		]);
	});

	it('says what herdr-core cannot do instead of sending', async () => {
		const { host, calls, notices } = actionHost(() => ({}));
		const actions = new HcActions(host, () => null);
		await actions.newTabHere();
		await actions.renameAgent();
		expect(await actions.focusPane()).toBe(false);
		expect(calls).toEqual([]);
		expect(notices).toHaveLength(3);
	});

	it('sends prompts with terminal.send and keys with terminal.keys in hc’s names', async () => {
		const calls: Recorded[] = [];
		const client = {
			request: <T,>(method: string, params: unknown) => {
				calls.push({ method, params: params as Record<string, unknown> });
				return Promise.resolve({} as T);
			},
		};
		await hcPromptSender(() => client).send('t2', 'line one\nline two');
		await hcKeySender(() => client).sendKeys('t2', ['Down', 'Enter', 'C-c', 'Escape', 'y']);
		expect(calls).toEqual([
			{ method: 'terminal.send', params: { terminal: 't2', text: 'line one\nline two' } },
			{ method: 'terminal.keys', params: { terminal: 't2', keys: ['down', 'enter', 'ctrl+c', 'esc', 'y'] } },
		]);
		await expect(hcPromptSender(() => null).send('t2', 'x')).rejects.toThrow('Not connected');
		expect(hcKeyName('M-x')).toBe('alt+x');
	});

	it('keeps names hc accepts and launches through the user’s shell', () => {
		expect(hcTerminalName('t12')).toBe('a-t12');
		expect(hcTerminalName('notes')).toBe('notes');
		expect(agentLaunchLine('cursor')).toContain("-ic 'cursor-agent; exec");
		expect(() => agentLaunchLine('rm -rf /')).toThrow();
	});
});
