/**
 * The `claude` kind's terminal view and shell tabs (ADR-0007's D2,
 * ADR-0008), end to end over the kind's own seams: the headless process is
 * the fake `claude` over real pipes (`tests/fixtures/fake-claude.mjs`), the
 * TUI and the shell run on a fake `script` pty (`tests/fixtures/fakePty.ts`)
 * that behaves as Claude 2.1.318's TUI was measured to.
 *
 * Pinned here: the view-switch state machine, the TUI's argv (resume or
 * session id, the permission mode, the cwd), one live process per agent,
 * waiting for a running turn, status from OSC 7501, reattaching with a
 * replay, stop and unload, the shell's argv and lifetime, and Windows.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionHost } from '../src/actions';
import type { FrameMeta, TerminalSessionOptions } from '../src/bridge/terminalSession';
import {
	AGENT_FORGOTTEN,
	AGENT_STOPPING,
	ALLOW_ONCE_NO_TERMINAL,
	AGENT_RELEASED,
	AGENT_STOPPED,
	CLAUDE_QUIT,
	MOVED_TO_NATIVE,
	PLUGIN_UNLOADING,
	PROMPT_NOT_SENT_KEPT,
	PROMPT_NOT_SENT_STOPPED,
	WAIT_FOR_RUNTIME,
	type StoredClaudeSession,
} from '../src/claude/agents';
import type { ClaudeChild } from '../src/claude/process';
import { PROGRAM_STATUS_REPLY } from '../src/claude/programStatus';
import type { ClaudeClient, ClaudeScope } from '../src/claude/scope';
import { SHELL_ENDED, SHELL_GONE, SHELLS_UNLOADING, isShellId } from '../src/claude/shells';
import { FRAME_BYTES } from '../src/claude/terminalSession';
import { planViewSwitch, TUI_BUSY, WAIT_FOR_ANSWER, WAIT_FOR_STOP, WAIT_FOR_TURN } from '../src/claude/viewSwitch';
import { endpointOf, type Connection } from '../src/connection';
import type { DiscoveryResult } from '../src/herdr/binary';
import {
	CLAUDE_TERMINAL_UNAVAILABLE,
	CLAUDE_TERMINAL_UNVERIFIED,
	claudeStatusLines,
	createClaudeKind,
	SHELL_NO_NATIVE,
	type ClaudeKind,
	type ClaudeKindHost,
} from '../src/runtime/claudeKind';
import { DEFAULT_SETTINGS } from '../src/settings';
import { newRuntime, type ClaudePermissionMode } from '../src/runtimes';
import type { PaneSession } from '../src/views/paneTerminal';
import { FakePty } from './fixtures/fakePty';

const FAKE = resolve(__dirname, 'fixtures/fake-claude.mjs');

let dirs: string[] = [];
let kinds: ClaudeKind[] = [];

beforeEach(() => {
	dirs = [];
	kinds = [];
});

afterEach(async () => {
	await Promise.all(kinds.map((kind) => kind.dispose()));
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 5));
	}
}

interface Harness {
	kind: ClaudeKind;
	client: ClaudeClient;
	connection: Connection<ClaudeClient, ClaudeScope>;
	pty: FakePty;
	stored: Record<string, StoredClaudeSession[]>;
	notices: string[];
	runtimeId: string;
	dir: string;
	log: string;
}

function logged(log: string): Record<string, unknown>[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The stream processes the fake claude was started as. */
function streamStarts(h: Harness): string[][] {
	return logged(h.log)
		.filter((entry) => 'argv' in entry)
		.map((entry) => entry.argv as string[]);
}

function streamPrompts(h: Harness): string[] {
	return logged(h.log)
		.map((entry) => entry.stdin as { type?: string; message?: { content?: string } } | undefined)
		.filter((message) => message?.type === 'user')
		.map((message) => message?.message?.content ?? '');
}

interface HarnessOptions {
	host?: Partial<ClaudeKindHost>;
	/** Connect the runtime (configure the table) at once. */
	connect?: boolean;
	/** One stored row, {@link AGENT}, never started or started. */
	row?: 'fresh' | 'started';
	/** The runtime's permission mode, and the one the stored row pins, if any. */
	runtimeMode?: ClaudePermissionMode;
	rowMode?: ClaudePermissionMode;
	/** The TUI slot runs a stand-in that never reports its status (no OSC 7501). */
	silentTui?: boolean;
}

/** The stored row's id. */
const AGENT = 'cl-00000001';
const SESSION = '11111111-2222-4333-8444-555555555555';

function harness(options: HarnessOptions = {}): Harness {
	const host = options.host ?? {};
	const connect = options.connect ?? true;
	const dir = mkdtempSync(join(tmpdir(), 'oh-claude-term-'));
	dirs.push(dir);
	const log = join(dir, 'fake.log');
	const stored: Record<string, StoredClaudeSession[]> = {};
	const notices: string[] = [];
	const pty = new FakePty({ tui: options.silentTui !== true });
	const kind = createClaudeKind({
		extraPath: () => '',
		spawnEnv: () => ({ ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HOME: dir, SHELL: '/usr/bin/zsh' }),
		vaultPath: () => dir,
		loadSessions: (runtimeId) => stored[runtimeId] ?? [],
		saveSessions: (runtimeId, sessions) => {
			stored[runtimeId] = sessions;
		},
		notice: (message) => notices.push(message),
		spawn: (argv, options): ClaudeChild =>
			nodeSpawn(process.execPath, [FAKE, ...argv.slice(1)], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }),
		home: dir,
		ptyPlatform: 'linux',
		ptySpawn: pty.spawn,
		ptyTools: pty.tools,
		...host,
	});
	kinds.push(kind);
	const runtime = newRuntime('claude', 'local', []);
	if (options.runtimeMode) runtime.permissionMode = options.runtimeMode;
	if (options.row) {
		stored[runtime.id] = [
			{
				id: AGENT,
				sessionId: SESSION,
				cwd: dir,
				name: 'a',
				...(options.row === 'started' ? { started: true } : {}),
				...(options.rowMode ? { permissionMode: options.rowMode } : {}),
			},
		];
	}
	const endpoint = endpointOf(runtime);
	const driver = kind.connection;
	if (!driver) throw new Error('no driver');
	const found: DiscoveryResult = {
		binary: { path: '/opt/fake/claude', source: 'setting' },
		status: null,
		identity: null,
		socketPath: '',
		error: null,
	};
	let client = null as unknown as ClaudeClient;
	let scope = null as unknown as ClaudeScope;
	if (connect) {
		client = driver.createClient('', endpoint, found);
		scope = driver.createScope(endpoint, client);
		client.on('connected', () => void driver.prime(client, scope, () => false));
		driver.start(client, scope);
	}
	const connection = { endpoint, client, scope } as unknown as Connection<ClaudeClient, ClaudeScope>;
	return { kind, client, connection, pty, stored, notices, runtimeId: runtime.id, dir, log };
}

function actionHost(h: Harness, opened: string[] = []): ActionHost {
	return {
		settings: () => ({ ...DEFAULT_SETTINGS, openTerminalAfterStart: false }),
		runtime: () => ({ ...h.connection.endpoint.runtime }),
		workspaceId: () => h.dir,
		request: (method, params) => h.client.request(method, params),
		connection: () => (method, params) => h.client.request(method, params),
		takenAgentNames: () => new Set(),
		agentPanes: () => [],
		vaultName: () => 'vault',
		notice: (message) => h.notices.push(message),
		openTerminal: async (paneId) => {
			opened.push(paneId);
		},
		detachTerminalLeaves: () => undefined,
		forgetPane: () => undefined,
		sleep: () => Promise.resolve(),
		now: () => Date.now(),
	};
}


/** An agent started from the folder menu: its headless process runs, idle. */
async function streamAgent(h: Harness): Promise<string> {
	const result = (await h.kind.createActions(actionHost(h)).startAgentHere(h.dir)) as { paneId: string };
	await waitFor(() => streamStarts(h).length === 1, 'the stream start');
	return result.paneId;
}

interface Tab {
	session: PaneSession;
	frames: { text: string; meta: FrameMeta }[];
	closed: string[];
	waiting: (string | null)[];
	grids: [number, number][];
	screen(): string;
}

function openTab(h: Harness, paneId: string, options: Partial<TerminalSessionOptions> = {}): Tab {
	const session = h.kind.createTerminalSession(
		{ command: h.kind.terminalCommand(h.connection.endpoint), target: paneId, mode: 'control', cols: 100, rows: 30, ...options },
		h.connection.endpoint,
	);
	const tab: Tab = {
		session,
		frames: [],
		closed: [],
		waiting: [],
		grids: [],
		screen: () => tab.frames.map((frame) => frame.text).join(''),
	};
	session.on('frame', (bytes, meta) => tab.frames.push({ text: new TextDecoder().decode(bytes), meta }));
	session.on('closed', (reason) => tab.closed.push(reason));
	session.on('waiting', (reason) => tab.waiting.push(reason));
	session.on('grid', (cols, rows) => tab.grids.push([cols, rows]));
	session.start();
	return tab;
}

/** The command line `script` was given for a pty spawn. */
function inner(argv: readonly string[]): string {
	expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
	expect(argv.slice(3, 6)).toEqual(['oh-pty', 'script', '-qfec']);
	return argv[6] ?? '';
}

/**
 * Until its first report a TUI reads as unknown; this waits for the probe's
 * answer and the `idle` it brings (and for every TUI spawned so far).
 */
async function reported(h: Harness, count = 1): Promise<void> {
	await waitFor(
		() =>
			h.pty.children.length >= count &&
			h.pty.children.every((child) => child.exited || child.input.includes(PROGRAM_STATUS_REPLY)),
		'the TUI to answer the probe',
	);
	await new Promise((done) => setTimeout(done, 15));
}

function agent(h: Harness, paneId: string) {
	return h.kind.agents.get(h.runtimeId, paneId);
}

describe('the view switch, as a state machine', () => {
	const base = { want: 'tui', mode: 'stream', status: 'idle', stopping: false, viewers: 1, queued: 0 } as const;

	it('switches an idle headless agent to its TUI, and waits while a turn runs or a request waits', () => {
		expect(planViewSwitch(base)).toEqual({ action: 'switch' });
		expect(planViewSwitch({ ...base, status: 'done' })).toEqual({ action: 'switch' });
		expect(planViewSwitch({ ...base, status: 'working' })).toEqual({ action: 'wait', reason: WAIT_FOR_TURN });
		expect(planViewSwitch({ ...base, status: 'blocked' })).toEqual({ action: 'wait', reason: WAIT_FOR_ANSWER });
		expect(planViewSwitch({ ...base, stopping: true })).toEqual({ action: 'wait', reason: WAIT_FOR_STOP });
	});

	it('starts a TUI for a stopped agent only when a tab waits for it', () => {
		expect(planViewSwitch({ ...base, mode: 'stopped', status: 'stopped' })).toEqual({ action: 'start-tui' });
		expect(planViewSwitch({ ...base, mode: 'stopped', status: 'stopped', viewers: 0 })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...base, viewers: 0 })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...base, mode: 'tui' })).toEqual({ action: 'stay' });
	});

	it('moves an idle TUI back to a headless process, never a busy one', () => {
		const native = { ...base, want: 'stream', mode: 'tui', viewers: 0 } as const;
		expect(planViewSwitch(native)).toEqual({ action: 'switch' });
		expect(planViewSwitch({ ...native, status: 'working' })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...native, status: 'blocked' })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...native, mode: 'stream' })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...native, mode: 'stopped', status: 'stopped' })).toEqual({ action: 'stay' });
		expect(planViewSwitch({ ...native, mode: 'stopped', status: 'stopped', queued: 1 })).toEqual({ action: 'start-stream' });
	});

	it('asks before it stops a TUI whose status is unknown', () => {
		const native = { ...base, want: 'stream', mode: 'tui', viewers: 0 } as const;
		expect(planViewSwitch({ ...native, status: 'unknown' })).toEqual({ action: 'confirm' });
		expect(planViewSwitch({ ...native, status: 'unknown', stopping: true })).toEqual({ action: 'stay' });
	});
});

describe('an agent in its terminal view', () => {
	it('starts the TUI of a row pinned to the asking mode in that mode, whatever the runtime is set to (ADR-0008)', async () => {
		const h = harness({ row: 'fresh', runtimeMode: 'auto', rowMode: 'manual' });
		openTab(h, AGENT);
		await reported(h);
		expect(inner(h.pty.last.argv)).toContain("'--permission-mode' 'manual'");
		expect(inner(h.pty.last.argv)).not.toContain("'auto'");
	});

	it('starts the TUI of a stopped agent in its cwd, with its session and permission mode, under the watchdog', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		const child = h.pty.last;
		expect(child.cwd).toBe(h.dir);
		expect(inner(child.argv)).toBe(
			"stty rows 30 cols 100 2>/dev/null; SHELL='/usr/bin/zsh'; export SHELL; exec '/opt/fake/claude' '--permission-mode' 'manual' '--session-id' '11111111-2222-4333-8444-555555555555'",
		);
		expect(child.env.SHELL).toBe('/bin/sh');
		expect(child.env.CLAUDECODE).toBeUndefined();
		// The probe is answered, so Claude reports its status.
		expect(child.input).toContain(PROGRAM_STATUS_REPLY);
		expect(agent(h, paneId)?.mode).toBe('tui');
		expect(tab.frames[0]?.meta).toMatchObject({ seq: 1, full: true });
		expect(tab.screen()).toContain('Claude Code (fake)');
		expect(streamStarts(h)).toEqual([]);
	});

	it('resumes a started session in the TUI', async () => {
		const h = harness({ row: 'started' });
		const paneId = AGENT;
		openTab(h, paneId);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		expect(inner(h.pty.last.argv)).toContain("'--resume' '11111111-2222-4333-8444-555555555555'");
	});

	it('types into the TUI, follows its status, and a look clears done', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		const statuses: string[] = [];
		h.kind.agents.on(() => statuses.push(agent(h, paneId)?.status ?? ''));
		tab.session.input('hello\r');
		await waitFor(() => agent(h, paneId)?.status === 'done', 'done');
		expect(statuses).toContain('working');
		expect(h.pty.last.input).toContain('hello\r');
		// A turn means the session has its transcript: resumed from now on.
		expect(h.stored[h.runtimeId]?.[0]?.started).toBe(true);
		tab.session.setLooking?.(true);
		expect(agent(h, paneId)?.status).toBe('idle');
	});

	it('switches an idle headless agent to its TUI with --resume once it had a turn, in about the stop time', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		await h.kind.promptSender(() => h.client).send(paneId, 'hi');
		await waitFor(() => agent(h, paneId)?.status === 'done', 'the stream turn');
		const before = Date.now();
		const tab = openTab(h, paneId);
		await waitFor(() => agent(h, paneId)?.mode === 'tui', 'the TUI');
		expect(Date.now() - before).toBeLessThan(3000);
		expect(tab.waiting[0]).toBe('starting Claude in the terminal');
		expect(tab.waiting.at(-1)).toBeNull();
		expect(inner(h.pty.last.argv)).toContain(`'--resume' '${agent(h, paneId)?.sessionId}'`);
		expect(h.pty.children).toHaveLength(1);
	});

	it('waits for a running turn to end before it switches', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		await h.kind.promptSender(() => h.client).send(paneId, 'SLOW');
		await waitFor(() => agent(h, paneId)?.status === 'working', 'working');
		const tab = openTab(h, paneId);
		await new Promise((done) => setTimeout(done, 100));
		expect(tab.waiting).toEqual([WAIT_FOR_TURN]);
		expect(h.pty.children).toHaveLength(0);
		expect(agent(h, paneId)?.mode).toBe('stream');
		await h.kind.promptSender(() => h.client).interrupt?.(paneId);
		await waitFor(() => agent(h, paneId)?.mode === 'tui', 'the switch after the turn');
	});

	it('lets a tab waiting for a turn go when the native view prompts again', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		await h.kind.promptSender(() => h.client).send(paneId, 'SLOW');
		await waitFor(() => agent(h, paneId)?.status === 'working', 'working');
		const tab = openTab(h, paneId);
		expect(tab.waiting).toEqual([WAIT_FOR_TURN]);
		await h.kind.promptSender(() => h.client).send(paneId, 'more');
		expect(tab.closed).toEqual([MOVED_TO_NATIVE]);
		await h.kind.promptSender(() => h.client).interrupt?.(paneId);
		await new Promise((done) => setTimeout(done, 100));
		expect(agent(h, paneId)?.mode).toBe('stream');
		expect(h.pty.children).toHaveLength(0);
	});

	it('goes back to a headless process when its tab switches to the native view', async () => {
		const h = harness({ row: 'started' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		await tab.session.dispose();
		h.kind.paneViewChosen?.(h.connection.endpoint, paneId, 'native');
		await waitFor(() => agent(h, paneId)?.mode === 'stream' && streamStarts(h).length === 1, 'the headless process');
		expect(h.pty.kills[0]).toEqual([h.pty.last.pid + 2, 'SIGTERM']);
		expect(h.pty.last.exited).toBe(true);
		expect(streamStarts(h).at(-1)).toContain('--resume');
	});

	it('tells a tab still open that the agent moved to the native view', async () => {
		const h = harness({ row: 'started' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		h.kind.agents.useNative(h.runtimeId, paneId);
		await waitFor(() => tab.closed.length > 0, 'the close');
		expect(tab.closed).toEqual([MOVED_TO_NATIVE]);
	});

	it('takes a native prompt to an idle TUI by switching first, and refuses one while it works', async () => {
		const h = harness({ row: 'started' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		tab.session.input('SLOW\r');
		await waitFor(() => agent(h, paneId)?.status === 'working', 'working');
		await expect(h.kind.promptSender(() => h.client).send(paneId, 'nope')).rejects.toThrow(TUI_BUSY);
		// Esc is Claude's own interrupt.
		await h.kind.promptSender(() => h.client).interrupt?.(paneId);
		expect(h.pty.last.input.at(-1)).toBe('\x1b');
		await waitFor(() => agent(h, paneId)?.status === 'idle', 'idle again');
		await h.kind.promptSender(() => h.client).send(paneId, 'from native');
		await waitFor(() => streamPrompts(h).includes('from native'), 'the prompt in the headless process');
		expect(agent(h, paneId)?.mode).toBe('stream');
		expect(tab.closed).toEqual([MOVED_TO_NATIVE]);
	});

	it('keeps the TUI when its tab closes, and repaints a reopened tab from the replay', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const first = openTab(h, paneId);
		await reported(h);
		first.session.input('remember me\r');
		await waitFor(() => agent(h, paneId)?.status === 'done', 'done');
		await first.session.dispose();
		expect(h.pty.kills).toEqual([]);
		const second = openTab(h, paneId);
		expect(h.pty.children).toHaveLength(1);
		expect(second.frames[0]?.meta.full).toBe(true);
		expect(second.screen()).toContain('> remember me');
		expect(second.screen()).toContain('Claude Code (fake)');
	});

	it('cuts a large replay into frames, the first one full', async () => {
		const h = harness({ row: 'fresh', host: { replayLimit: 4 * FRAME_BYTES } });
		const paneId = AGENT;
		openTab(h, paneId);
		await reported(h);
		h.pty.last.emit(`${'x'.repeat(100)}\r\n`.repeat(2000));
		const tab = openTab(h, paneId);
		expect(tab.frames.length).toBeGreaterThan(1);
		expect(tab.frames.map((frame) => frame.meta.full)).toEqual([true, ...tab.frames.slice(1).map(() => false)]);
		expect(tab.frames.every((frame) => frame.text.length <= FRAME_BYTES)).toBe(true);
	});

	it('resizes the pty through stty on the slave, and tells another tab the grid', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const a = openTab(h, paneId);
		const b = openTab(h, paneId);
		await reported(h);
		a.session.resize(132, 40);
		await waitFor(() => h.pty.resizes.length > 0, 'the stty');
		expect(h.pty.runs.at(-1)).toEqual(['stty', '-F', `/dev/pts/${h.pty.last.pid - 990}`, 'rows', '40', 'cols', '132']);
		expect(b.grids.at(-1)).toEqual([132, 40]);
		// An observer never types or resizes.
		const observer = openTab(h, paneId, { mode: 'observe' });
		expect(observer.session.input('x')).toBe(false);
		expect(observer.session.resize(10, 10)).toBe(false);
		expect(observer.grids.at(-1)).toEqual([132, 40]);
	});

	it('takes renderer replies from one tab only', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const a = openTab(h, paneId);
		const b = openTab(h, paneId);
		await reported(h);
		expect(a.session.reply?.('\x1b[?62c')).toBe(false);
		expect(b.session.reply?.('\x1b[?62c')).toBe(true);
	});

	it('stops the TUI on Stop, tells its tabs, and leaves the row stopped', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		await h.kind.createActions(actionHost(h)).closePane(paneId, h.connection.endpoint.id);
		expect(agent(h, paneId)?.status).toBe('stopped');
		expect(tab.closed).toEqual([AGENT_STOPPED]);
		expect(h.pty.last.exited).toBe(true);
		// Nothing starts again behind the stop.
		await new Promise((done) => setTimeout(done, 50));
		expect(h.pty.children).toHaveLength(1);
		expect(streamStarts(h)).toEqual([]);
	});

	it('reports Claude quitting by itself, and a tab that reconnects resumes it', async () => {
		const h = harness({ row: 'started' });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		await reported(h);
		h.pty.last.exit(0);
		expect(tab.closed).toEqual([CLAUDE_QUIT]);
		expect(agent(h, paneId)?.status).toBe('stopped');
		openTab(h, paneId);
		await waitFor(() => h.pty.children.length === 2, 'a second TUI');
	});

	it('starts the TUI once more the other way when Claude refuses the session id', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		openTab(h, paneId);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		h.pty.last.emit('Error: Session ID 11111111-2222-4333-8444-555555555555 is already in use.\r\n');
		h.pty.last.exit(1);
		await waitFor(() => h.pty.children.length === 2, 'the retry');
		expect(inner(h.pty.last.argv)).toContain("'--resume' '11111111-2222-4333-8444-555555555555'");
		expect(h.stored[h.runtimeId]?.[0]?.started).toBe(true);
	});

	it('waits for its runtime to connect before it starts anything', async () => {
		const h = harness({ row: 'started', connect: false });
		const paneId = AGENT;
		const tab = openTab(h, paneId);
		expect(tab.waiting).toEqual([WAIT_FOR_RUNTIME]);
		expect(h.pty.children).toHaveLength(0);
		h.kind.agents.configure(h.runtimeId, { binary: '/opt/fake/claude', permissionMode: 'manual' });
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		expect(tab.waiting.at(-1)).toBeNull();
	});

	it('stops every TUI and shell on unload', async () => {
		const h = harness({ row: 'fresh' });
		const paneId = AGENT;
		openTab(h, paneId);
		const shell = h.kind.shells?.open(h.dir) ?? '';
		await reported(h);
		openTab(h, shell);
		expect(h.pty.children).toHaveLength(2);
		// A shell is no agent: its probe is never answered.
		await new Promise((done) => setTimeout(done, 15));
		expect(h.pty.children[1]?.input).toEqual([]);
		await h.kind.dispose();
		expect(h.pty.children.every((child) => child.exited)).toBe(true);
	});
});

describe('switches and stops that race a tab (the D2 review)', () => {
	const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

	it('delivers a native prompt in its switch when a tab attaches during the TUI stop, and the tab waits for it', async () => {
		const h = harness({ row: 'started' });
		const tab = openTab(h, AGENT);
		await reported(h);
		const sender = h.kind.promptSender(() => h.client);
		const sending = sender.send(AGENT, 'from native');
		const late = openTab(h, AGENT);
		// `send` settles only once the prompt is in the headless process.
		await sending;
		await waitFor(() => streamPrompts(h).includes('from native'), 'the prompt in the headless process');
		expect(tab.closed).toEqual([MOVED_TO_NATIVE]);
		// The tab that came during the switch never turned it into a stop: it
		// waits for the switch, then for the turn, then gets the TUI.
		expect(late.closed).toEqual([]);
		await waitFor(() => agent(h, AGENT)?.mode === 'tui', 'the TUI after the turn', 8000);
		expect(late.waiting.at(-1)).toBeNull();
		expect(h.pty.children).toHaveLength(2);
		await reported(h, 2);
		// Nothing queued resurfaces: the next native prompt goes alone.
		await sender.send(AGENT, 'later');
		await waitFor(() => streamPrompts(h).includes('later'), 'the later prompt');
		expect(streamPrompts(h)).toEqual(['from native', 'later']);
	});

	it('rejects a native prompt a Stop overtakes during its switch, and never sends it later', async () => {
		const h = harness({ row: 'started' });
		openTab(h, AGENT);
		await reported(h);
		const sender = h.kind.promptSender(() => h.client);
		const sending = sender.send(AGENT, 'never');
		const stopping = h.kind.agents.stop(h.runtimeId, AGENT);
		await expect(sending).rejects.toThrow(PROMPT_NOT_SENT_STOPPED);
		await stopping;
		await pause(50);
		expect(agent(h, AGENT)?.status).toBe('stopped');
		expect(streamStarts(h)).toEqual([]);
		await sender.send(AGENT, 'after');
		await waitFor(() => streamPrompts(h).includes('after'), 'the next prompt');
		expect(streamPrompts(h)).toEqual(['after']);
	});

	it('starts nothing for a tab that opens while Stop runs; a reconnect afterwards resumes', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		const stopping = h.kind.createActions(actionHost(h)).closePane(paneId, h.connection.endpoint.id);
		const tab = openTab(h, paneId);
		await stopping;
		await pause(100);
		expect(tab.closed).toEqual([AGENT_STOPPED]);
		expect(h.pty.children).toHaveLength(0);
		expect(streamStarts(h)).toHaveLength(1);
		expect(agent(h, paneId)?.status).toBe('stopped');
		openTab(h, paneId);
		await waitFor(() => agent(h, paneId)?.mode === 'tui', 'the TUI on reconnect');
	});

	it('keeps a stopped agent stopped when a hidden tab is shown again, until Reconnect', async () => {
		const h = harness({ row: 'started' });
		openTab(h, AGENT);
		await reported(h);
		await h.kind.agents.stop(h.runtimeId, AGENT);
		// Hidden past its grace period, the tab gave its session up and heard
		// nothing of the Stop; shown again, it says so and starts nothing.
		const shown = openTab(h, AGENT, { revealed: true });
		expect(shown.closed).toEqual([AGENT_STOPPED]);
		await pause(50);
		expect(h.pty.children).toHaveLength(1);
		expect(streamStarts(h)).toEqual([]);
		expect(agent(h, AGENT)?.status).toBe('stopped');
		// Reconnect is a person asking.
		openTab(h, AGENT);
		await waitFor(() => agent(h, AGENT)?.mode === 'tui', 'the TUI on reconnect');
		expect(h.pty.children).toHaveLength(2);
	});

	it('attaches a hidden tab shown again to a TUI that still runs', async () => {
		const h = harness({ row: 'started' });
		openTab(h, AGENT);
		await reported(h);
		const shown = openTab(h, AGENT, { revealed: true });
		expect(shown.closed).toEqual([]);
		expect(shown.frames[0]?.meta.full).toBe(true);
		expect(h.pty.children).toHaveLength(1);
	});

	it('leaves no process behind a Forget that a tab opening raced, before or after unload', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		const forgetting = h.kind.agents.forget(h.runtimeId, paneId);
		const tab = openTab(h, paneId);
		await forgetting;
		await pause(100);
		expect(agent(h, paneId)).toBeNull();
		expect(tab.closed).toEqual([AGENT_FORGOTTEN]);
		expect(h.pty.children).toHaveLength(0);
		await h.kind.dispose();
		expect(h.pty.children.every((child) => child.exited)).toBe(true);
	});

	it('keeps a released row from restarting until graduation gives it back, and confirms its process is gone', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		const sender = h.kind.promptSender(() => h.client);
		await sender.send(paneId, 'hello');
		await waitFor(() => agent(h, paneId)?.status === 'done', 'done');
		const actions = h.kind.createActions(actionHost(h));
		const releasing = actions.releaseForGraduation?.(paneId);
		const during = openTab(h, paneId);
		const released = await releasing;
		expect(released).toMatchObject({ sessionId: agent(h, paneId)?.sessionId });
		expect(agent(h, paneId)?.mode).toBe('stopped');
		expect(during.closed).toEqual([AGENT_RELEASED]);
		// While the target runtime starts, nothing here may start the session.
		const after = openTab(h, paneId);
		expect(after.closed).toEqual([AGENT_RELEASED]);
		await expect(sender.send(paneId, 'no')).rejects.toThrow(AGENT_RELEASED);
		await pause(100);
		expect(h.pty.children).toHaveLength(0);
		expect(streamStarts(h)).toHaveLength(1);
		// Graduation failed: the row is the user's to resume again.
		h.kind.agents.reclaim(h.runtimeId, paneId);
		openTab(h, paneId);
		await waitFor(() => agent(h, paneId)?.mode === 'tui', 'the TUI after the row came back');
	});

	it('waits on unload for the TUI of a runtime removed just before', async () => {
		const h = harness({ row: 'started' });
		openTab(h, AGENT);
		await reported(h);
		// The runtime goes from the settings, then the plugin unloads at once:
		// the row is gone, its TUI is still stopping, and unload waits for it.
		h.kind.agents.prune(new Set());
		expect(h.pty.last.exited).toBe(false);
		await h.kind.dispose();
		expect(h.pty.last.exited).toBe(true);
	});

	it('says the agent is stopping to a Resume that comes while Stop runs', async () => {
		const h = harness();
		const paneId = await streamAgent(h);
		const stopping = h.kind.agents.stop(h.runtimeId, paneId);
		expect(() => h.kind.agents.resume(h.runtimeId, paneId)).toThrow(AGENT_STOPPING);
		await stopping;
		expect(agent(h, paneId)?.status).toBe('stopped');
		expect(streamStarts(h)).toHaveLength(1);
	});

	it('starts nothing after unload, whatever a tab or a prompt asks', async () => {
		const h = harness({ row: 'started' });
		await h.kind.dispose();
		const tab = openTab(h, AGENT);
		expect(tab.closed).toEqual([PLUGIN_UNLOADING]);
		await expect(h.kind.promptSender(() => h.client).send(AGENT, 'x')).rejects.toThrow(PLUGIN_UNLOADING);
		await pause(50);
		expect(h.pty.children).toHaveLength(0);
		expect(streamStarts(h)).toEqual([]);
	});
});

describe('an agent pinned to Allow once (Get started\'s installer)', () => {
	it('has no terminal view, where Claude\'s own dialog could save a lasting rule', async () => {
		const h = harness();
		const pinned = h.kind.agents.start(h.runtimeId, h.dir, 'Install herdr-core', { permissionMode: 'manual', allowOnceOnly: true });
		await waitFor(() => streamStarts(h).length === 1, 'the stream start');
		const reason = h.kind.paneTerminalReason?.(h.connection.endpoint, pinned.id) ?? null;
		expect(reason).toBe(ALLOW_ONCE_NO_TERMINAL);
		expect(h.kind.paneTerminalReason?.(h.connection.endpoint, 'cl-other')).toBeNull();
		const tab = openTab(h, pinned.id);
		expect(tab.closed).toEqual([ALLOW_ONCE_NO_TERMINAL]);
		await new Promise((done) => setTimeout(done, 50));
		expect(h.pty.children).toHaveLength(0);
		expect(agent(h, pinned.id)?.mode).toBe('stream');
	});
});

describe('a TUI that never reports its status', () => {
	const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

	/** A harness whose confirmation answers `answer`, counting the questions. */
	function asking(answer: boolean | null) {
		const questions: string[] = [];
		const h = harness({
			row: 'started',
			silentTui: true,
			host:
				answer === null
					? {}
					: {
							confirm: (question) => {
								questions.push(question.body);
								return Promise.resolve(answer);
							},
						},
		});
		return { h, questions };
	}

	async function typedTui(h: Harness): Promise<Tab> {
		const tab = openTab(h, AGENT);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		// Typed into, it may be mid-turn for all the plugin knows.
		expect(tab.session.input('do something\r')).toBe(true);
		return tab;
	}

	it('shows as unknown in the list, never idle', async () => {
		const { h } = asking(true);
		openTab(h, AGENT);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		await pause(20);
		expect(agent(h, AGENT)?.status).toBe('unknown');
		expect(h.connection.scope.get(AGENT)?.agentStatus).toBe('unknown');
	});

	it('asks before a native prompt stops it, and sends nothing when told no', async () => {
		const { h, questions } = asking(false);
		await typedTui(h);
		await expect(h.kind.promptSender(() => h.client).send(AGENT, 'no')).rejects.toThrow(PROMPT_NOT_SENT_KEPT);
		expect(questions).toHaveLength(1);
		expect(questions[0]).toContain('2.1.295');
		await pause(50);
		expect(h.pty.last.exited).toBe(false);
		expect(h.pty.kills).toEqual([]);
		expect(streamStarts(h)).toEqual([]);
		expect(agent(h, AGENT)?.mode).toBe('tui');
		// Nothing is asked again behind the user's back.
		expect(questions).toHaveLength(1);
	});

	it('stops it and delivers the native prompt once the user confirms', async () => {
		const { h, questions } = asking(true);
		const tab = await typedTui(h);
		await h.kind.promptSender(() => h.client).send(AGENT, 'yes');
		expect(questions).toHaveLength(1);
		await waitFor(() => streamPrompts(h).includes('yes'), 'the prompt in the headless process');
		expect(h.pty.last.exited).toBe(true);
		expect(tab.closed).toEqual([MOVED_TO_NATIVE]);
	});

	it('asks before the native view takes it, and keeps it when told no', async () => {
		const { h, questions } = asking(false);
		await typedTui(h);
		h.kind.paneViewChosen?.(h.connection.endpoint, AGENT, 'native');
		await pause(50);
		expect(questions).toHaveLength(1);
		expect(h.pty.last.exited).toBe(false);
		expect(agent(h, AGENT)?.mode).toBe('tui');
	});

	it('does not keep the prompt when a tab takes the agent back while the user is asked', async () => {
		let answer: (yes: boolean) => void = () => undefined;
		const h = harness({
			row: 'started',
			silentTui: true,
			host: { confirm: () => new Promise<boolean>((done) => (answer = done)) },
		});
		await typedTui(h);
		const sending = h.kind.promptSender(() => h.client).send(AGENT, 'late');
		await pause(20);
		openTab(h, AGENT);
		answer(true);
		await expect(sending).rejects.toThrow(PROMPT_NOT_SENT_KEPT);
		await pause(50);
		expect(h.pty.last.exited).toBe(false);
		expect(streamStarts(h)).toEqual([]);
	});

	it('rejects the waiting prompt when Stop comes while the user is asked, and never sends it after Resume', async () => {
		let answer: (yes: boolean) => void = () => undefined;
		const h = harness({
			row: 'started',
			silentTui: true,
			host: { confirm: () => new Promise<boolean>((done) => (answer = done)) },
		});
		await typedTui(h);
		const sending = h.kind.promptSender(() => h.client).send(AGENT, 'stale');
		let settled = 'pending';
		sending.then(
			() => (settled = 'resolved'),
			(error: Error) => (settled = error.message),
		);
		await pause(20);
		await h.kind.agents.stop(h.runtimeId, AGENT);
		answer(true);
		await pause(50);
		expect(settled).toBe(PROMPT_NOT_SENT_STOPPED);
		h.kind.agents.resume(h.runtimeId, AGENT);
		await waitFor(() => streamStarts(h).length === 1, 'the resumed process');
		await pause(100);
		expect(streamPrompts(h)).toEqual([]);
	});

	it('refuses a native prompt where nobody can be asked', async () => {
		const { h } = asking(null);
		await typedTui(h);
		await expect(h.kind.promptSender(() => h.client).send(AGENT, 'no')).rejects.toThrow(PROMPT_NOT_SENT_KEPT);
		await pause(50);
		expect(h.pty.last.exited).toBe(false);
	});

	it('moves without asking while nothing was ever typed into it, since no turn can be running', async () => {
		const { h, questions } = asking(false);
		openTab(h, AGENT);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		await h.kind.promptSender(() => h.client).send(AGENT, 'fresh');
		await waitFor(() => streamPrompts(h).includes('fresh'), 'the prompt');
		expect(questions).toEqual([]);
	});
});

describe('shell tabs', () => {
	it('opens a shell in the folder from the action, and runs the initial command first', async () => {
		const h = harness();
		const opened: string[] = [];
		const actions = h.kind.createActions(actionHost(h, opened));
		const paneId = (await actions.openShellHere?.(h.dir, "echo 'hi'")) ?? '';
		expect(isShellId(paneId)).toBe(true);
		expect(opened).toEqual([paneId]);
		// Nothing runs until a tab attaches.
		expect(h.pty.children).toHaveLength(0);
		const tab = openTab(h, paneId);
		expect(h.pty.last.cwd).toBe(h.dir);
		expect(inner(h.pty.last.argv)).toBe(
			"stty rows 30 cols 100 2>/dev/null; SHELL='/usr/bin/zsh'; export SHELL; trap : INT QUIT; /bin/sh -c 'printf '\\''\\033[1m$ %s\\033[0m\\n'\\'' '\\''echo '\\''\\'\\'''\\''hi'\\''\\'\\'''\\'''\\''; echo '\\''hi'\\'''; trap - INT QUIT; exec '/usr/bin/zsh'",
		);
		h.pty.last.emit('$ echo hi\r\nhi\r\n');
		expect(tab.screen()).toContain('hi');
		expect(h.kind.paneNativeReason?.(paneId)).toBe(SHELL_NO_NATIVE);
		expect(h.kind.paneTitle?.(paneId)).toMatch(/^Shell: oh-claude-term-/);
		// No row in the agent list.
		expect(h.kind.agents.list(h.runtimeId)).toEqual([]);
	});

	it('outlives its tab until the last one is closed for good, then hangs up', async () => {
		const h = harness();
		const paneId = h.kind.shells?.open(h.dir) ?? '';
		const tab = openTab(h, paneId);
		await tab.session.dispose();
		openTab(h, paneId);
		expect(h.pty.children).toHaveLength(1);
		h.kind.terminalReleased?.(h.connection.endpoint, paneId);
		await waitFor(() => h.pty.last.exited, 'the shell to end');
		expect(h.pty.kills[0]).toEqual([h.pty.last.pid + 2, 'SIGHUP']);
		expect(() => openTab(h, paneId).session).not.toThrow();
		expect(h.kind.shells?.has(paneId)).toBe(false);
	});

	it('types nothing into the shell when a reopened tab replays its old queries; one tab answers live ones', async () => {
		const h = harness();
		const paneId = h.kind.shells?.open(h.dir) ?? '';
		/** A tab with a real renderer that answers queries the way the plugin's do (`PaneTerminal.onReply`). */
		const rendered = () => {
			const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
			const tab = openTab(h, paneId);
			const writes: Promise<void>[] = [];
			const drawn = () => Promise.all(writes);
			let seen = 0;
			const pump = () => {
				for (; seen < tab.frames.length; seen++) {
					const frame = tab.frames[seen]?.text ?? '';
					writes.push(new Promise<void>((done) => term.write(frame, done)));
				}
			};
			pump();
			tab.session.on('frame', () => pump());
			term.onData((data) => void tab.session.reply?.(data));
			return { term, tab, drawn };
		};
		const first = rendered();
		const child = h.pty.last;
		// A program asks DA1, DA2 and the cursor position, as vim or a prompt does.
		child.emit('$ \x1b[c\x1b[>c\x1b[6n');
		await first.drawn();
		const answered = child.input.length;
		expect(answered).toBeGreaterThan(0);
		await first.tab.session.dispose();
		first.term.dispose();
		const second = rendered();
		await second.drawn();
		await new Promise((done) => setTimeout(done, 20));
		// The replay asked the new renderer nothing, so nothing was typed.
		expect(child.input.length).toBe(answered);
		// A second tab on the same shell: still nothing from its replay.
		const third = rendered();
		await third.drawn();
		expect(child.input.length).toBe(answered);
		// A live query is answered once, by the tab that attached last.
		child.emit('\x1b[c');
		await Promise.all([second.drawn(), third.drawn()]);
		expect(child.input.length).toBe(answered + 1);
		second.term.dispose();
		third.term.dispose();
	});

	it('starts no shell once the plugin is unloading', async () => {
		const h = harness();
		await h.kind.dispose();
		const paneId = h.kind.shells?.open(h.dir) ?? '';
		const tab = openTab(h, paneId);
		expect(tab.closed).toEqual([SHELLS_UNLOADING]);
		expect(h.pty.children).toHaveLength(0);
	});

	it('says a restored tab’s shell is gone, and starts a new one after `exit` without the command', async () => {
		const h = harness();
		const gone = openTab(h, 'sh-zzzzzzzz');
		expect(gone.closed).toEqual([SHELL_GONE]);
		const paneId = h.kind.shells?.open(h.dir, 'echo once') ?? '';
		const tab = openTab(h, paneId);
		h.pty.last.exit(0);
		expect(tab.closed).toEqual([SHELL_ENDED]);
		openTab(h, paneId);
		expect(h.pty.children).toHaveLength(2);
		expect(inner(h.pty.last.argv)).not.toContain('echo once');
	});
});

describe('on macOS, until it is verified there', () => {
	it('offers no terminal view and no shell, and says it is not verified yet', () => {
		const h = harness({ host: { ptyPlatform: undefined, platform: 'darwin' } });
		expect(h.kind.terminalUnavailable).toBe(CLAUDE_TERMINAL_UNVERIFIED);
		expect(CLAUDE_TERMINAL_UNVERIFIED).toMatch(/macOS.*not .*verified/);
		expect(h.kind.capabilities.shells).toBe(false);
		expect(h.kind.shells).toBeNull();
		expect(() => h.kind.terminalCommand(h.connection.endpoint)).toThrow(CLAUDE_TERMINAL_UNVERIFIED);
		const lines = claudeStatusLines(
			{ client: { setup: { binary: 'claude', permissionMode: 'manual' } }, scope: { size: 0, running: 0 } },
			CLAUDE_TERMINAL_UNVERIFIED,
		);
		expect(lines.at(-1)?.text).toContain(CLAUDE_TERMINAL_UNVERIFIED);
	});

	it('still runs the macOS script path where a host asks for it explicitly', async () => {
		const h = harness({ row: 'fresh', host: { ptyPlatform: 'darwin', platform: 'darwin' } });
		expect(h.kind.terminalUnavailable).toBeNull();
		openTab(h, AGENT);
		await waitFor(() => h.pty.children.length === 1, 'the TUI');
		expect(h.pty.last.argv.slice(3, 7)).toEqual(['oh-pty', 'script', '-q', '/dev/null']);
	});
});

describe('on Windows', () => {
	it('offers no terminal view and no shell, and says why', () => {
		const h = harness({ host: { ptyPlatform: null } });
		expect(h.kind.terminalUnavailable).toBe(CLAUDE_TERMINAL_UNAVAILABLE);
		expect(CLAUDE_TERMINAL_UNAVAILABLE).toContain('Windows');
		expect(h.kind.capabilities.shells).toBe(false);
		expect(h.kind.shells).toBeNull();
		expect(() => h.kind.terminalCommand(h.connection.endpoint)).toThrow();
	});
});
