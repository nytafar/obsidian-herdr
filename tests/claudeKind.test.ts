/**
 * The `claude` kind end to end (ADR-0007), over real child-process pipes to
 * a fake `claude` (`tests/fixtures/fake-claude.mjs`) that speaks the
 * stream-json protocol with the spike's captured shapes.
 *
 * Driven through the kind's own seams — the connection driver, the session
 * watcher, the prompt sender, the responder and the actions — the way the
 * plugin drives it, so what is pinned here is what the native view and the
 * agent list see: spawn arguments, status from the stream, each waiting
 * card's `control_response`, the interrupt, `/clear` rotation, `is_error`,
 * stop, resume from stopped, persistence, and unload.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionHost } from '../src/actions';
import type { StoredClaudeSession } from '../src/claude/agents';
import type { ClaudeChild } from '../src/claude/process';
import type { ClaudeClient, ClaudeScope } from '../src/claude/scope';
import { endpointOf, type Connection } from '../src/connection';
import type { DiscoveryResult } from '../src/herdr/binary';
import type { WaitingAnswer } from '../src/native/pendingRequest';
import { encodeProjectDir } from '../src/native/transcriptSource';
import {
	claudeEnv,
	createClaudeKind,
	newClaudeAgentId,
	type ClaudeKind,
	type ClaudeKindHost,
} from '../src/runtime/claudeKind';
import { DEFAULT_SETTINGS } from '../src/settings';
import { newRuntime, type ClaudePermissionMode } from '../src/runtimes';
import { normalizeClaudeSessions } from '../src/claude/agents';

const FAKE = resolve(__dirname, 'fixtures/fake-claude.mjs');

interface Harness {
	kind: ClaudeKind;
	client: ClaudeClient;
	scope: ClaudeScope;
	connection: Connection<ClaudeClient, ClaudeScope>;
	stored: Record<string, StoredClaudeSession[]>;
	notices: string[];
	runtimeId: string;
	dir: string;
	log: string;
}

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

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'oh-claude-kind-'));
	dirs.push(dir);
	return dir;
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 10));
	}
}

/** Every line the fake logged: its argv per start, and every stdin message. */
function logged(log: string): Record<string, unknown>[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stdin(log: string): Record<string, unknown>[] {
	return logged(log)
		.filter((entry) => 'stdin' in entry)
		.map((entry) => entry.stdin as Record<string, unknown>);
}

function starts(log: string): string[][] {
	return logged(log)
		.filter((entry) => 'argv' in entry)
		.map((entry) => entry.argv as string[]);
}

interface HarnessOptions {
	stored?: Record<string, StoredClaudeSession[]>;
	runtimeId?: string;
	dir?: string;
	/** Host fields to put in place of the harness's own. */
	host?: Partial<ClaudeKindHost>;
	/** Variables added to the environment agents start with. */
	env?: NodeJS.ProcessEnv;
	/** The runtime's permission mode; `manual` (the default) otherwise. */
	permissionMode?: ClaudePermissionMode;
}

function harness(options: HarnessOptions = {}): Harness {
	const dir = options.dir ?? tempDir();
	const log = join(dir, 'fake.log');
	const stored: Record<string, StoredClaudeSession[]> = options.stored ?? {};
	const notices: string[] = [];
	const kind = createClaudeKind({
		extraPath: () => '',
		spawnEnv: () => ({ ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HOME: dir, ...options.env }),
		vaultPath: () => dir,
		loadSessions: (runtimeId) => stored[runtimeId] ?? [],
		saveSessions: (runtimeId, sessions) => {
			stored[runtimeId] = sessions;
		},
		notice: (message) => notices.push(message),
		// The real pipes, with node running the fake in place of the binary.
		spawn: (argv, spawnOptions): ClaudeChild =>
			nodeSpawn(process.execPath, [FAKE, ...argv.slice(1)], {
				cwd: spawnOptions.cwd,
				env: spawnOptions.env,
				stdio: ['pipe', 'pipe', 'pipe'],
			}),
		home: dir,
		...options.host,
	});
	kinds.push(kind);
	const runtime = newRuntime('claude', 'local', []);
	if (options.runtimeId) runtime.id = options.runtimeId;
	if (options.permissionMode) runtime.permissionMode = options.permissionMode;
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
	const client = driver.createClient('', endpoint, found);
	const scope = driver.createScope(endpoint, client);
	client.on('connected', () => void driver.prime(client, scope, () => false));
	driver.start(client, scope);
	const connection = { endpoint, client, scope } as unknown as Connection<ClaudeClient, ClaudeScope>;
	return { kind, client, scope, connection, stored, notices, runtimeId: runtime.id, dir, log };
}

function actionHost(h: Harness, opened: string[] = []): ActionHost {
	return {
		settings: () => ({ ...DEFAULT_SETTINGS, openTerminalAfterStart: true }),
		runtime: () => ({ ...h.connection.endpoint.runtime }),
		workspaceId: () => h.scope.workspaceId,
		request: (method, params) => h.client.request(method, params),
		connection: () => (method, params) => h.client.request(method, params),
		takenAgentNames: () => h.scope.agentNames(),
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

/** Starts an agent in the harness's directory (or `folder`) and waits for its process. */
async function started(h: Harness, folder = h.dir): Promise<string> {
	const actions = h.kind.createActions(actionHost(h));
	const result = (await actions.startAgentHere(folder)) as { paneId: string } | null;
	if (!result) throw new Error(`no agent: ${h.notices.join(' | ')}`);
	await waitFor(() => starts(h.log).length === 1, 'the first start');
	return result.paneId;
}

function status(h: Harness, paneId: string): string | undefined {
	return h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.agentStatus;
}

async function prompt(h: Harness, paneId: string, text: string): Promise<void> {
	await h.kind.promptSender(() => h.client).send(paneId, text);
}

async function answer(h: Harness, paneId: string, value: WaitingAnswer): Promise<void> {
	const request = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
	if (!request) throw new Error('no request');
	await h.kind.responder?.(() => h.client).respond(paneId, request.id, value);
}

/** The control_response the fake read last. */
function lastResponse(h: Harness): Record<string, unknown> | undefined {
	return stdin(h.log)
		.filter((message) => message.type === 'control_response')
		.at(-1);
}

describe('the claude kind over a fake claude', () => {
	it('starts a stored session with the plugin-generated id, in its cwd, with every stream flag', async () => {
		const h = harness();
		const paneId = await started(h);
		const [argv] = starts(h.log);
		const session = h.stored[h.runtimeId]?.[0];
		expect(session).toMatchObject({ id: paneId, cwd: h.dir });
		expect(argv).toEqual([
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--permission-prompt-tool',
			'stdio',
			'--permission-mode',
			'manual',
			'--session-id',
			session?.sessionId,
		]);
		expect(logged(h.log)[0]?.cwd).toBe(h.dir);
		expect(h.scope.get(paneId)).toMatchObject({ agentStatus: 'idle', stopped: false, cwd: h.dir });
	});

	it('never refuses its own agent the native view: it runs only Claude (#155)', async () => {
		const h = harness();
		const paneId = await started(h);
		const watcher = h.kind.native?.watcher(h.connection);
		expect(watcher?.snapshot(paneId)).not.toBeNull();
		expect(watcher?.unavailable?.(paneId) ?? null).toBeNull();
		expect(h.kind.paneNativeReason?.(paneId)).toBeNull();
	});

	it('maps a turn to working, then done, and a look to idle', async () => {
		const h = harness();
		const paneId = await started(h);
		const statuses: string[] = [];
		h.kind.native?.watcher(h.connection)?.onStatus((_pane, value) => statuses.push(value));
		await prompt(h, paneId, 'hello');
		expect(status(h, paneId)).toBe('working');
		await waitFor(() => status(h, paneId) === 'done', 'done');
		h.kind.native?.watcher(h.connection)?.looking?.(paneId, {}, true);
		expect(status(h, paneId)).toBe('idle');
		expect(statuses).toEqual(['working', 'done', 'idle']);
		expect(stdin(h.log)[0]).toEqual({ type: 'user', message: { role: 'user', content: 'hello' } });
	});

	it('sends a prompt’s images as image blocks after its text, and says images can go (#144)', async () => {
		const h = harness();
		const paneId = await started(h);
		const sender = h.kind.promptSender(() => h.client);
		const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' };

		expect(sender.imagesUnavailable?.(paneId)).toBeNull();
		await sender.send(paneId, 'What is this?', [image]);
		await waitFor(() => status(h, paneId) === 'done', 'done');

		expect(stdin(h.log)[0]).toEqual({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
				],
			},
		});
	});

	it('marks a turn that ends while a view looks as seen, and stops when the last view looks away', async () => {
		const h = harness();
		const paneId = await started(h);
		const watcher = h.kind.native?.watcher(h.connection);
		const first = {};
		const second = {};
		watcher?.looking?.(paneId, first, true);
		watcher?.looking?.(paneId, second, true);
		await prompt(h, paneId, 'hello');
		await waitFor(() => status(h, paneId) !== 'working', 'the end of the turn');
		expect(status(h, paneId)).toBe('idle');
		// One view looking away leaves the other one looking.
		watcher?.looking?.(paneId, first, false);
		await prompt(h, paneId, 'again');
		await waitFor(() => status(h, paneId) !== 'working', 'the end of the second turn');
		expect(status(h, paneId)).toBe('idle');
		// Nobody looking: done stays until someone does.
		watcher?.looking?.(paneId, second, false);
		await prompt(h, paneId, 'unseen');
		await waitFor(() => status(h, paneId) !== 'working', 'the end of the third turn');
		expect(status(h, paneId)).toBe('done');
	});

	it('blocks on a Write permission and allows it with the input unchanged', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'WRITE hello.txt');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		const pane = h.kind.native?.watcher(h.connection)?.snapshot(paneId);
		expect(pane?.blockKind).toBe('permission');
		expect(pane?.request).toMatchObject({ kind: 'permission', toolName: 'Write', session: { lines: ['accept file edits'] }, project: null });
		await answer(h, paneId, { type: 'allow' });
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect(lastResponse(h)).toEqual({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: 'req-1',
				response: { behavior: 'allow', updatedInput: { file_path: `${h.dir}/hello.txt`, content: 'hi\n' } },
			},
		});
	});

	it('denies a permission', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'WRITE');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		await answer(h, paneId, { type: 'deny' });
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect((lastResponse(h)?.response as { response: unknown }).response).toEqual({
			behavior: 'deny',
			message: 'The user denied permission to use Write.',
		});
	});

	it('offers and sends the project grant, never the userSettings one', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'BASH');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		const request = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
		expect(request?.project?.file).toBe(`${h.dir}/.claude/settings.local.json`);
		await answer(h, paneId, { type: 'allow-project' });
		await waitFor(() => status(h, paneId) === 'done', 'done');
		const sent = JSON.stringify(lastResponse(h));
		expect(sent).toContain('"destination":"localSettings"');
		expect(sent).not.toContain('userSettings');
		expect(sent).not.toContain('"destination":"session"');
	});

	it('names the git root’s settings file for an agent in a subfolder, as Claude writes it', async () => {
		const h = harness();
		// Below the harness's home, which as a git root would keep the file in the folder.
		const vault = join(h.dir, 'vault');
		mkdirSync(join(vault, '.git'), { recursive: true });
		const notes = join(vault, 'notes');
		mkdirSync(notes);
		const paneId = await started(h, notes);
		await prompt(h, paneId, 'BASH');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		const request = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
		const root = realpathSync(vault);
		expect(request?.project).toMatchObject({ file: `${root}/.claude/settings.local.json`, root, scope: 'repository' });
	});

	it('offers no project grant, and refuses one, where the file is not known', async () => {
		const h = harness({ host: { localSettings: () => null } });
		const paneId = await started(h);
		await prompt(h, paneId, 'BASH');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		const request = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
		expect(request?.project).toBeNull();
		await expect(answer(h, paneId, { type: 'allow-project' })).rejects.toThrow('that answer does not fit the request');
		expect(status(h, paneId)).toBe('blocked');
	});

	it('answers a question with updatedInput.answers, and reports it as a question block', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'ASK');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.blockKind).toBe('question');
		await answer(h, paneId, { type: 'answer', answers: { 'Which colour do you prefer?': 'Blue' } });
		await waitFor(() => status(h, paneId) === 'done', 'done');
		const response = (lastResponse(h)?.response as { response: { updatedInput: Record<string, unknown> } }).response;
		expect(response.updatedInput.answers).toEqual({ 'Which colour do you prefer?': 'Blue' });
		expect(response.updatedInput.questions).toHaveLength(1);
	});

	it('rejects a plan with feedback', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'PLAN');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request?.plan).toBe('1. Write hello.txt.\n2. Read it back.');
		await answer(h, paneId, { type: 'reject-plan', feedback: 'add a second line' });
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect((lastResponse(h)?.response as { response: unknown }).response).toEqual({
			behavior: 'deny',
			message: 'The user rejected the plan: add a second line',
		});
	});

	it('interrupts a running turn with the interrupt control request, quietly', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'SLOW');
		await new Promise((done) => setTimeout(done, 60));
		expect(status(h, paneId)).toBe('working');
		await h.kind.promptSender(() => h.client).interrupt?.(paneId);
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect(stdin(h.log).at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
		// An interrupt's own aborted result is not an error worth a notice.
		expect(h.notices.filter((notice) => !notice.startsWith('Herdr: started'))).toEqual([]);
	});

	it('refuses an answer while the agent is stopping, and shows the request as stopping', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'WRITE');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		const before = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
		expect(before?.stopping).toBeFalsy();
		const stopping = h.kind.createActions(actionHost(h)).closePane(paneId, h.runtimeId);
		const during = h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request;
		expect(during).toMatchObject({ id: before?.id, stopping: true });
		await expect(
			h.kind.responder?.(() => h.client).respond(paneId, before?.id ?? '', { type: 'allow' }),
		).rejects.toThrow('the agent is stopping');
		await stopping;
		// Only the stop's own denial reached Claude.
		const responses = stdin(h.log).filter((message) => message.type === 'control_response');
		expect(responses).toHaveLength(1);
		expect(JSON.stringify(responses[0])).toContain('"behavior":"deny"');
	});

	it('closes a waiting card when Claude withdraws the request', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'WRITE');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		await h.kind.promptSender(() => h.client).interrupt?.(paneId);
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.request).toBeUndefined();
	});

	it('follows /clear to the next init and stores the new session', async () => {
		const h = harness();
		const paneId = await started(h);
		const before = h.stored[h.runtimeId]?.[0]?.sessionId;
		const sessions: string[] = [];
		h.kind.native?.watcher(h.connection)?.onSession((_pane, session) => sessions.push(session));
		await prompt(h, paneId, '/clear');
		await waitFor(() => sessions.length === 1, 'the rotation');
		const after = h.stored[h.runtimeId]?.[0]?.sessionId;
		expect(after).not.toBe(before);
		expect(sessions).toEqual([after]);
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.agentSession).toBe(after);
	});

	it('shows is_error results with their terminal reason', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'FAIL');
		await waitFor(() => h.notices.some((notice) => notice.includes('Not logged in')), 'the notice');
		expect(h.notices.at(-1)).toBe(`Herdr: ${h.scope.get(paneId)?.name}: Not logged in · Please run /login (api_error)`);
	});

	it('answers a control request nobody declared with an error, so Claude never hangs', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'HOOK');
		await waitFor(() => lastResponse(h) !== undefined, 'the reply');
		expect(lastResponse(h)).toEqual({
			type: 'control_response',
			response: { subtype: 'error', request_id: 'hook-1', error: 'Unsupported control request subtype: hook_callback' },
		});
	});

	it('stops an agent, keeps its row stopped, and resumes it with --resume on the next prompt', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'hello');
		await waitFor(() => status(h, paneId) === 'done', 'done');
		const actions = h.kind.createActions(actionHost(h));
		expect(await actions.closePane(paneId, h.runtimeId)).toBe(false);
		expect(h.scope.get(paneId)).toMatchObject({ stopped: true, agentStatus: 'idle' });
		await prompt(h, paneId, 'again');
		await waitFor(() => status(h, paneId) === 'done', 'done again');
		const sessionId = h.stored[h.runtimeId]?.[0]?.sessionId ?? '';
		expect(starts(h.log)[1]?.slice(-2)).toEqual(['--resume', sessionId]);
	});

	it('starts a session that never had a turn with --session-id again, not --resume', async () => {
		const h = harness();
		const paneId = await started(h);
		const actions = h.kind.createActions(actionHost(h));
		await actions.closePane(paneId, h.runtimeId);
		await actions.resumeAgent?.(paneId);
		await waitFor(() => starts(h.log).length === 2, 'the second start');
		expect(starts(h.log)[1]).toContain('--session-id');
	});

	it('brings stored rows back stopped after a restart, and forgets one for good', async () => {
		const first = harness();
		const paneId = await started(first);
		await prompt(first, paneId, 'hello');
		await waitFor(() => status(first, paneId) === 'done', 'done');
		await first.kind.dispose();
		const second = harness({ stored: first.stored, runtimeId: first.runtimeId, dir: first.dir });
		expect(second.scope.list()).toHaveLength(1);
		expect(second.scope.get(paneId)).toMatchObject({ stopped: true, name: first.scope.get(paneId)?.name });
		// Opening it resumes the conversation.
		const actions = second.kind.createActions(actionHost(second));
		await actions.resumeAgent?.(paneId);
		await waitFor(() => starts(second.log).length === 2, 'the resume');
		expect(starts(second.log)[1]).toContain('--resume');
		expect(await actions.forgetAgent?.(paneId, second.runtimeId)).toBe(true);
		expect(second.scope.list()).toEqual([]);
		expect(second.stored[second.runtimeId]).toEqual([]);
	});

	it('resumes an agent started in a symlinked folder, whose transcript Claude keeps under the real path', async () => {
		const h = harness();
		const real = join(h.dir, 'real');
		mkdirSync(real);
		const link = join(h.dir, 'link');
		symlinkSync(real, link);
		const paneId = await started(h, link);
		await prompt(h, paneId, 'hello');
		await waitFor(() => status(h, paneId) === 'done', 'done');
		const sessionId = h.stored[h.runtimeId]?.[0]?.sessionId ?? '';
		const transcript = join(realpathSync(h.dir), '.claude', 'projects', encodeProjectDir(realpathSync(real)), `${sessionId}.jsonl`);
		expect(existsSync(transcript)).toBe(true);
		// The native view follows the file Claude writes, not one derived from the link.
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.transcriptPath).toBe(transcript);
		await h.kind.createActions(actionHost(h)).closePane(paneId, h.runtimeId);
		await prompt(h, paneId, 'again');
		await waitFor(() => status(h, paneId) === 'done', 'done again');
		expect(starts(h.log)[1]?.slice(-2)).toEqual(['--resume', sessionId]);
		expect(h.notices.filter((notice) => notice.includes('stopped'))).toEqual([]);
	});

	it('finds the transcript under CLAUDE_CONFIG_DIR, and resumes from it', async () => {
		const config = join(tempDir(), 'claude-config');
		const h = harness({ env: { CLAUDE_CONFIG_DIR: config } });
		const paneId = await started(h);
		await prompt(h, paneId, 'hello');
		await waitFor(() => status(h, paneId) === 'done', 'done');
		const sessionId = h.stored[h.runtimeId]?.[0]?.sessionId ?? '';
		const transcript = join(config, 'projects', encodeProjectDir(realpathSync(h.dir)), `${sessionId}.jsonl`);
		expect(existsSync(transcript)).toBe(true);
		expect(h.kind.native?.watcher(h.connection)?.snapshot(paneId)?.transcriptPath).toBe(transcript);
		await h.kind.createActions(actionHost(h)).closePane(paneId, h.runtimeId);
		await prompt(h, paneId, 'again');
		await waitFor(() => status(h, paneId) === 'done', 'done again');
		expect(starts(h.log)[1]?.slice(-2)).toEqual(['--resume', sessionId]);
	});

	it('records that a session started, and resumes it after a restart without looking for its file', async () => {
		const first = harness();
		const paneId = await started(first);
		expect(first.stored[first.runtimeId]?.[0]?.started).toBeUndefined();
		await prompt(first, paneId, 'hello');
		await waitFor(() => status(first, paneId) === 'done', 'done');
		expect(first.stored[first.runtimeId]?.[0]?.started).toBe(true);
		await first.kind.dispose();
		const second = harness({ stored: first.stored, runtimeId: first.runtimeId, dir: first.dir, host: { exists: () => false } });
		await second.kind.createActions(actionHost(second)).resumeAgent?.(paneId);
		await waitFor(() => starts(second.log).length === 2, 'the resume');
		expect(starts(second.log)[1]).toContain('--resume');
	});

	it('falls back to --resume when Claude says the session id is already in use, and sends the prompt there', async () => {
		const first = harness();
		const paneId = await started(first);
		await prompt(first, paneId, 'hello');
		await waitFor(() => status(first, paneId) === 'done', 'done');
		await first.kind.dispose();
		// A row stored before `started` existed, whose transcript the plugin cannot find.
		const stored = { [first.runtimeId]: (first.stored[first.runtimeId] ?? []).map(({ started: _started, ...row }) => row) };
		const second = harness({ stored, runtimeId: first.runtimeId, dir: first.dir, host: { exists: () => false } });
		await prompt(second, paneId, 'again');
		await waitFor(() => status(second, paneId) === 'done', 'done after the fallback');
		const [, refused, resumed] = starts(second.log);
		expect(refused).toContain('--session-id');
		expect(resumed).toContain('--resume');
		expect(stdin(second.log).filter((line) => line.type === 'user').at(-1)).toMatchObject({ message: { content: 'again' } });
		expect(second.stored[second.runtimeId]?.[0]?.started).toBe(true);
		expect(second.notices.filter((notice) => notice.includes('in use'))).toEqual([]);
	});

	it('starts the id afresh when a session recorded as started has no conversation to resume', async () => {
		const h = harness();
		const sessionId = '3b3ad50c-0000-4000-8000-0000000000aa';
		const stored = { [h.runtimeId]: [{ id: 'cl-gone0001', sessionId, cwd: h.dir, name: 'gone', started: true }] };
		const again = harness({ stored, runtimeId: h.runtimeId, dir: h.dir });
		await prompt(again, 'cl-gone0001', 'hello');
		await waitFor(() => status(again, 'cl-gone0001') === 'done', 'done after the fallback');
		const [refused, fresh] = starts(again.log);
		expect(refused).toContain('--resume');
		expect(fresh?.slice(-2)).toEqual(['--session-id', sessionId]);
		expect(again.notices).toEqual([]);
	});

	it('hands a started session to another runtime with its permission mode, and keeps a fresh one', async () => {
		const h = harness();
		const paneId = await started(h);
		const actions = h.kind.createActions(actionHost(h));
		// Never prompted: no transcript, so nothing another runtime could resume.
		expect(await actions.releaseForGraduation?.(paneId)).toBeNull();
		expect(status(h, paneId)).toBe('idle');
		expect(h.scope.get(paneId)?.started).toBe(false);
		await prompt(h, paneId, 'hello');
		await waitFor(() => status(h, paneId) === 'done', 'done');
		expect(h.scope.get(paneId)?.started).toBe(true);
		const sessionId = h.stored[h.runtimeId]?.[0]?.sessionId;
		expect(await actions.releaseForGraduation?.(paneId)).toEqual({
			cwd: h.dir,
			sessionId,
			permissionMode: h.connection.endpoint.runtime.permissionMode,
		});
		expect(h.scope.get(paneId)?.stopped).toBe(true);
	});

	it('starts a row pinned to the asking mode in that mode, even on a runtime set to auto, and keeps it (ADR-0008)', async () => {
		const h = harness({ permissionMode: 'auto' });
		const modeOf = (argv: string[] | undefined): string | undefined => argv?.[(argv?.indexOf('--permission-mode') ?? -2) + 1];
		// An ordinary agent takes the runtime's mode.
		await started(h);
		expect(modeOf(starts(h.log)[0])).toBe('auto');
		const pinned = h.kind.agents.start(h.runtimeId, h.dir, 'Install herdr-core', { permissionMode: 'manual' });
		await waitFor(() => starts(h.log).length === 2, 'the pinned start');
		expect(modeOf(starts(h.log)[1])).toBe('manual');
		expect(h.stored[h.runtimeId]?.find((row) => row.id === pinned.id)?.permissionMode).toBe('manual');
		// The pin survives a stop and a resume, and goes with a graduation.
		await prompt(h, pinned.id, 'hello');
		await waitFor(() => status(h, pinned.id) === 'done', 'done');
		const actions = h.kind.createActions(actionHost(h));
		await actions.closePane(pinned.id, h.runtimeId);
		await actions.resumeAgent?.(pinned.id);
		await waitFor(() => starts(h.log).length === 3, 'the resume');
		expect(starts(h.log)[2]).toContain('--resume');
		expect(modeOf(starts(h.log)[2])).toBe('manual');
		expect(h.kind.agents.permissionMode(h.runtimeId, pinned.id)).toBe('manual');
		expect(h.kind.agents.permissionMode(h.runtimeId)).toBe('auto');
		expect((await actions.releaseForGraduation?.(pinned.id))?.permissionMode).toBe('manual');
	});

	it('offers an installer row only Allow once and Deny, never a session or project grant, after a resume too (ADR-0008)', async () => {
		const h = harness();
		const pinned = h.kind.agents.start(h.runtimeId, h.dir, 'Install herdr-core', {
			permissionMode: 'manual',
			allowOnceOnly: true,
		});
		expect(h.stored[h.runtimeId]?.find((row) => row.id === pinned.id)?.allowOnceOnly).toBe(true);
		const card = async () => {
			await prompt(h, pinned.id, 'BASH');
			await waitFor(() => status(h, pinned.id) === 'blocked', 'blocked');
			const request = h.kind.native?.watcher(h.connection)?.snapshot(pinned.id)?.request;
			expect(request).toMatchObject({ kind: 'permission', toolName: 'Bash', session: null, project: null });
			await expect(answer(h, pinned.id, { type: 'allow-project' })).rejects.toThrow('that answer does not fit the request');
			await expect(answer(h, pinned.id, { type: 'allow-session' })).rejects.toThrow('that answer does not fit the request');
			expect(status(h, pinned.id)).toBe('blocked');
			await answer(h, pinned.id, { type: 'allow' });
			await waitFor(() => status(h, pinned.id) === 'done', 'done');
			const sent = JSON.stringify(lastResponse(h));
			expect(sent).toContain('"behavior":"allow"');
			expect(sent).not.toContain('updatedPermissions');
		};
		await card();
		const actions = h.kind.createActions(actionHost(h));
		await actions.closePane(pinned.id, h.runtimeId);
		await actions.resumeAgent?.(pinned.id);
		await waitFor(() => starts(h.log).length === 2, 'the resume');
		await card();
	});

	it('reads the allow-once pin back from data.json, and only as true', () => {
		const row = { id: 'cl-1', sessionId: '11111111-2222-4333-8444-555555555555', cwd: '/v', name: 'a' };
		expect(
			normalizeClaudeSessions({ rt: [{ ...row, allowOnceOnly: true }, { ...row, id: 'cl-2', allowOnceOnly: 'yes' }] }),
		).toEqual({ rt: [{ ...row, allowOnceOnly: true }, { ...row, id: 'cl-2' }] });
	});

	it('reads a pinned permission mode back from data.json, and drops one it does not know', () => {
		const row = { id: 'cl-1', sessionId: '11111111-2222-4333-8444-555555555555', cwd: '/v', name: 'a' };
		expect(
			normalizeClaudeSessions({
				rt: [
					{ ...row, permissionMode: 'manual' },
					{ ...row, id: 'cl-2', permissionMode: 'bypassPermissions' },
				],
			}),
		).toEqual({ rt: [{ ...row, permissionMode: 'manual' }, { ...row, id: 'cl-2' }] });
	});

	it('stops every process on unload, denying what is pending first', async () => {
		const h = harness();
		const paneId = await started(h);
		await prompt(h, paneId, 'WRITE');
		await waitFor(() => status(h, paneId) === 'blocked', 'blocked');
		await h.kind.dispose();
		expect(status(h, paneId)).toBe('idle');
		expect(h.scope.get(paneId)?.stopped).toBe(true);
		expect((lastResponse(h)?.response as { response: unknown }).response).toEqual({
			behavior: 'deny',
			message: 'The agent was stopped before this was answered.',
		});
	});

	it('keeps the processes when a connection is retired, as on a runtime switch', async () => {
		const h = harness();
		const paneId = await started(h);
		h.client.dispose();
		await expect(h.client.request('agent.prompt', { target: paneId, text: 'x' })).rejects.toThrow();
		expect(h.kind.agents.get(h.runtimeId, paneId)?.status).toBe('idle');
	});

	it('has the terminal view and shell tabs where a pty can be made (ADR-0007’s D2)', () => {
		const h = harness({ host: { ptyPlatform: 'linux' } });
		expect(h.kind.terminalUnavailable).toBeNull();
		expect(h.kind.terminalCommand(h.connection.endpoint)).toEqual(['script']);
		expect(h.kind.capabilities).toMatchObject({
			tabs: false,
			splits: false,
			focus: false,
			rename: false,
			resumable: true,
			shells: true,
			nativeView: true,
		});
	});
});

describe('claudeEnv and ids', () => {
	it('drops what a parent Claude or herdr pane set, keeps user configuration, and puts the binary first on PATH', () => {
		const env = claudeEnv(
			{ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', HERDR_PANE_ID: 'w1:p1', CLAUDE_CODE_USE_BEDROCK: '1' },
			'/home/u/.local/bin/claude',
		);
		expect(env).toEqual({ PATH: '/home/u/.local/bin:/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1' });
	});

	it('uses the platform’s own paths and PATH separator, as on Windows', () => {
		const env = claudeEnv(
			{ Path: 'C:\\Windows\\system32;C:\\tools', CLAUDECODE: '1' },
			'C:\\Users\\u\\.local\\bin\\claude.exe',
			win32,
		);
		// The one variable Windows has, whatever its case, with the binary's folder first.
		expect(env).toEqual({ Path: 'C:\\Users\\u\\.local\\bin;C:\\Windows\\system32;C:\\tools' });
		expect(claudeEnv({ PATH: 'C:\\tools' }, 'claude', win32)).toEqual({ PATH: 'C:\\tools' });
		// Already there: left as it is.
		expect(claudeEnv({ PATH: 'C:\\tools' }, 'C:\\tools\\claude.exe', win32)).toEqual({ PATH: 'C:\\tools' });
		// A POSIX PATH that happens to be spelled otherwise is another variable.
		expect(claudeEnv({ Path: '/x', PATH: '/usr/bin' }, '/opt/claude/claude', posix)).toEqual({
			Path: '/x',
			PATH: '/opt/claude:/usr/bin',
		});
	});

	it('makes row ids that never collide with taken ones', () => {
		let n = 0;
		const random = () => [0, 0, 0.5][n++] ?? 0.5;
		expect(newClaudeAgentId(new Set(['cl-00000000']), random)).not.toBe('cl-00000000');
	});
});
