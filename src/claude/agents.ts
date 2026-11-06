/**
 * The `claude` kind's agents (ADR-0007): the sessions the plugin started in
 * this vault, per runtime, and the process each one runs in while it runs.
 *
 * One table for the plugin's lifetime, owned by the kind, not by a
 * connection: a runtime switch leaves the processes running (their rows come
 * back live when the runtime is active again), and only unloading the plugin
 * — or stopping, forgetting or graduating one — ends a process.
 *
 * **What is stored** is the row: a stable agent id (the pane id views and
 * pins key on), the session id, the cwd and the name, through the host into
 * the plugin's data. After a restart every row comes back **stopped**.
 * Prompting or opening a stopped row spawns its process again with
 * `--resume <session>` once the session has **started** (its first `init`
 * or successful `result` came, so Claude has written its transcript), and
 * with `--session-id` before that. A row stored before `started` existed
 * looks for the transcript where Claude keeps it: under `CLAUDE_CONFIG_DIR`
 * (else `~/.claude`), filed by the cwd's real path. Whichever way the guess
 * goes wrong, Claude says so at startup ("Session ID … is already in use",
 * or "No conversation found"), and the process is started once more the
 * other way, with the prompts it never read.
 *
 * **Status** comes from the stream, not from a screen:
 *
 * - `working` from a prompt written until its `result` (one per message,
 *   queued ones included);
 * - `blocked` while a `can_use_tool` request waits, with `question` for
 *   `AskUserQuestion` and `permission` for everything else; never `trust`;
 * - `done` once the last turn ended, until a person looks at the agent or
 *   prompts it, then `idle`;
 * - `stopped` without a process.
 *
 * **Session id.** Plugin-generated and passed with `--session-id`, so it is
 * known before the first prompt. `/clear` rotates it inside the same process;
 * the new id comes from the next `system:init` and is stored at once, so a
 * later `--resume` reopens the conversation after the clear.
 *
 * **Errors** are read from `is_error` with `terminal_reason`, never from
 * `subtype` (auth and model errors are `success`); an interrupt's own
 * `aborted_*` result is not an error worth a notice.
 *
 * No Obsidian: everything outside the table comes through {@link ClaudeAgentsHost}.
 */

import type { BlockKind } from '../native/sessionWatcher';
import type { PendingRequest, WaitingAnswer } from '../native/pendingRequest';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { claudeTranscriptFile } from '../native/transcriptSource';
import type { ClaudePermissionMode } from '../runtimes';
import {
	claudeArgv,
	controlError,
	controlResponse,
	pendingRequestOf,
	permissionResponse,
	SESSION_ID_RE,
	userMessage,
	type StreamEvent,
	type ToolPermissionRequest,
} from './protocol';
import { ClaudeProcess, type ClaudeSpawn, type ClaudeTimers } from './process';
import type { LocalSettingsTarget } from './projectRoot';

/** One stored row, as `data.json` keeps it under `claudeSessions[runtimeId]`. */
export interface StoredClaudeSession {
	/** The row's stable id: what tabs and pins key on. Never the session id, which rotates. */
	id: string;
	/** The Claude session to resume. */
	sessionId: string;
	/** Where the agent runs, absolute. */
	cwd: string;
	/** The name the row shows. */
	name: string;
	/**
	 * The session has had a turn, so Claude has written its transcript and it
	 * is continued with `--resume`. Absent until then, and on rows stored
	 * before this was recorded.
	 */
	started?: boolean;
}

/**
 * Claude Code's configuration folder for an environment, which holds the
 * transcripts: `CLAUDE_CONFIG_DIR`, else `.claude` in the home directory
 * (Claude 2.1.318 reads it the same way). A relative one is taken from the
 * agent's cwd, which is where Claude would resolve it.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string, cwd: string): string {
	const configured = env.CLAUDE_CONFIG_DIR;
	if (!configured) return resolve(home, '.claude');
	return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/** Whatever `data.json` holds, turned into stored rows; anything else is dropped. */
export function normalizeClaudeSessions(value: unknown): Record<string, StoredClaudeSession[]> {
	const result: Record<string, StoredClaudeSession[]> = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
	for (const [runtimeId, list] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		const seen = new Set<string>();
		const sessions: StoredClaudeSession[] = [];
		for (const entry of list as unknown[]) {
			if (!entry || typeof entry !== 'object') continue;
			const row = entry as Record<string, unknown>;
			const id = typeof row.id === 'string' ? row.id : '';
			const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
			const cwd = typeof row.cwd === 'string' ? row.cwd : '';
			if (!id || seen.has(id) || !SESSION_ID_RE.test(sessionId) || !cwd.startsWith('/')) continue;
			seen.add(id);
			sessions.push({
				id,
				sessionId,
				cwd,
				name: typeof row.name === 'string' ? row.name : '',
				...(row.started === true ? { started: true } : {}),
			});
		}
		if (sessions.length > 0) result[runtimeId] = sessions;
	}
	return result;
}

/** An agent's status, as the scope and the watcher read it. */
export type ClaudeAgentStatus = 'stopped' | 'idle' | 'working' | 'blocked' | 'done';

/** One agent as the rest of the plugin sees it. Immutable snapshot. */
export interface ClaudeAgentView {
	id: string;
	name: string;
	cwd: string;
	sessionId: string;
	status: ClaudeAgentStatus;
	/** While `blocked`: the kind of the oldest pending request. */
	blockKind: BlockKind | null;
	/** The oldest pending request, as the waiting card shows it; null when none. */
	request: PendingRequest | null;
	/** Bumped on every status change, for the list's "most recent first". */
	statusSeq: number;
	/** The session has had a turn, so there is a conversation to resume. */
	started: boolean;
	/** Where Claude writes the current session's transcript, on this machine. */
	transcriptPath: string;
}

/** What changed about an agent, for the scope and the watcher. */
export type ClaudeAgentChange = 'added' | 'removed' | 'status' | 'session';

/** How a runtime's agents are started: its binary and its permission mode. */
export interface ClaudeRuntimeSetup {
	binary: string;
	permissionMode: ClaudePermissionMode;
}

export interface ClaudeAgentsHost {
	/** The stored rows of a runtime. */
	load(runtimeId: string): StoredClaudeSession[];
	/** Persists a runtime's rows. */
	save(runtimeId: string, sessions: StoredClaudeSession[]): void;
	/** The environment a process starts with, given its binary. */
	env(binary: string): NodeJS.ProcessEnv;
	/** Whether a file exists on this machine: a transcript, before a resume. */
	exists(path: string): boolean;
	/**
	 * The real path of a folder, as Claude sees its cwd (symlinks resolved);
	 * the path itself when it cannot be resolved. Absent, paths are taken as given.
	 */
	realpath?(path: string): string;
	notice(message: string): void;
	/** A fresh session UUID. */
	newSessionId(): string;
	/** A fresh row id not in `taken`. */
	newAgentId(taken: ReadonlySet<string>): string;
	spawn: ClaudeSpawn;
	timers: ClaudeTimers;
	/** Arguments after the fixed ones; a probe's `--model haiku`. */
	extraArgs?(): readonly string[];
	/** Home of this machine, for the transcript path; defaults to `os.homedir()`. */
	home?: string;
	/**
	 * Where Claude writes a project rule for an agent in `cwd`
	 * (`./projectRoot.ts`), or null when that is not known; asked once per
	 * process start. Absent, no project grant is offered.
	 */
	localSettings?(cwd: string): LocalSettingsTarget | null;
}

interface AgentRecord {
	stored: StoredClaudeSession;
	process: ClaudeProcess | null;
	/** Where the running process writes a project rule; null when not known. */
	settings: LocalSettingsTarget | null;
	/** Where the transcripts are and the cwd Claude files them under; null until asked. */
	where: { configDir: string; realCwd: string } | null;
	/** The cwd the last `init` reported: Claude's own word for its real cwd. */
	reportedCwd: string;
	/** How the current process was started. */
	spawnedWith: 'resume' | 'session-id';
	/** The current process has sent an `init`, so it took its prompts. */
	initSeen: boolean;
	/** Prompts written to the current process before its first `init`. */
	unclaimed: string[];
	/** The current process is already the other way of starting; never a third. */
	retried: boolean;
	/** Prompts written whose `result` has not come yet. */
	turns: number;
	/** The last turn ended and nobody has looked or prompted since. */
	finished: boolean;
	/** Pending `can_use_tool` requests, oldest first (Map keeps insertion order). */
	pending: Map<string, ToolPermissionRequest>;
	status: ClaudeAgentStatus;
	statusSeq: number;
}

type Listener = (runtimeId: string, agentId: string, change: ClaudeAgentChange) => void;

/** What a record starts with besides its row and its process. */
function freshRecord(): Pick<
	AgentRecord,
	'settings' | 'where' | 'reportedCwd' | 'spawnedWith' | 'initSeen' | 'unclaimed' | 'retried'
> {
	return {
		settings: null,
		where: null,
		reportedCwd: '',
		spawnedWith: 'session-id',
		initSeen: false,
		unclaimed: [],
		retried: false,
	};
}

/**
 * The other way to start a process whose startup Claude refused, read off
 * its stderr (measured on 2.1.318, 2026-11-06); null for any other exit.
 */
export function startupFallback(
	spawnedWith: 'resume' | 'session-id',
	error: string,
): 'resume' | 'session-id' | null {
	if (spawnedWith === 'session-id' && /session id .* is already in use/i.test(error)) return 'resume';
	if (spawnedWith === 'resume' && /no conversation found/i.test(error)) return 'session-id';
	return null;
}

/** Said when something is asked of an agent the table does not have. */
export const NO_SUCH_AGENT = 'that agent is no longer in the list';

export class ClaudeAgents {
	private readonly runtimes = new Map<string, Map<string, AgentRecord>>();
	private readonly setups = new Map<string, ClaudeRuntimeSetup>();
	private readonly listeners = new Set<Listener>();
	/** One card model per request, so an unchanged request reads as the same object. */
	private readonly requestViews = new WeakMap<ToolPermissionRequest, PendingRequest>();
	private statusSeq = 0;

	constructor(private readonly host: ClaudeAgentsHost) {}

	/** How new processes of this runtime start; set by every connection to it. */
	configure(runtimeId: string, setup: ClaudeRuntimeSetup): void {
		this.setups.set(runtimeId, { ...setup });
	}

	/** Every agent of a runtime, stored ones first loaded as stopped. */
	list(runtimeId: string): ClaudeAgentView[] {
		return [...this.table(runtimeId).values()].map((record) => this.view(runtimeId, record));
	}

	get(runtimeId: string, agentId: string): ClaudeAgentView | null {
		const record = this.table(runtimeId).get(agentId);
		return record ? this.view(runtimeId, record) : null;
	}

	/** The permission mode a runtime's agents start in; null before it is configured. */
	permissionMode(runtimeId: string): ClaudePermissionMode | null {
		return this.setups.get(runtimeId)?.permissionMode ?? null;
	}

	/** Names in use on a runtime, for a new agent's name. */
	names(runtimeId: string): Set<string> {
		return new Set([...this.table(runtimeId).values()].map((record) => record.stored.name));
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A new agent in `cwd`, stored and started at once (it idles until prompted). */
	start(runtimeId: string, cwd: string, name: string): ClaudeAgentView {
		const table = this.table(runtimeId);
		const id = this.host.newAgentId(new Set(table.keys()));
		const record: AgentRecord = {
			stored: { id, sessionId: this.host.newSessionId(), cwd, name },
			process: null,
			...freshRecord(),
			turns: 0,
			finished: false,
			pending: new Map(),
			status: 'stopped',
			statusSeq: 0,
		};
		table.set(id, record);
		this.persist(runtimeId);
		this.emit(runtimeId, id, 'added');
		this.spawn(runtimeId, record);
		return this.view(runtimeId, record);
	}

	/** Spawns a stopped agent's process again (`--resume`), with no prompt. */
	resume(runtimeId: string, agentId: string): void {
		const record = this.record(runtimeId, agentId);
		if (!record.process) this.spawn(runtimeId, record);
	}

	/** Sends a prompt, resuming a stopped agent first. Throws a readable error. */
	prompt(runtimeId: string, agentId: string, text: string): void {
		const record = this.record(runtimeId, agentId);
		if (record.process?.isStopping) throw new Error('the agent is stopping');
		if (!record.process) this.spawn(runtimeId, record);
		const process = record.process;
		if (!process?.alive) throw new Error('the agent could not be started');
		process.send(userMessage(text));
		if (!record.initSeen) record.unclaimed.push(text);
		record.turns++;
		record.finished = false;
		this.update(runtimeId, record);
	}

	/** The `interrupt` control request, while a turn runs. */
	interrupt(runtimeId: string, agentId: string): void {
		const record = this.record(runtimeId, agentId);
		if (!record.process?.alive) throw new Error('the agent is not running');
		record.process.interrupt();
	}

	/** Answers a pending permission request. Throws a readable error. */
	respond(runtimeId: string, agentId: string, requestId: string, answer: WaitingAnswer): void {
		const record = this.record(runtimeId, agentId);
		const request = record.pending.get(requestId);
		if (!request || !record.process?.alive) throw new Error('that request is no longer waiting');
		// The project grant is only offered where its file is known.
		const response = answer.type === 'allow-project' && !record.settings ? null : permissionResponse(request, answer);
		if (!response) throw new Error('that answer does not fit the request');
		record.process.send(controlResponse(requestId, response));
		record.pending.delete(requestId);
		this.update(runtimeId, record);
	}

	/** A person looked at the agent: a finished turn is seen. */
	seen(runtimeId: string, agentId: string): void {
		const record = this.table(runtimeId).get(agentId);
		if (!record?.finished) return;
		record.finished = false;
		this.update(runtimeId, record);
	}

	/** Stops the agent's process, in the ADR's order; the row stays, stopped. */
	async stop(runtimeId: string, agentId: string): Promise<void> {
		const record = this.table(runtimeId).get(agentId);
		const process = record?.process;
		if (!record || !process) return;
		await process.stop({ busy: record.turns > 0, pending: [...record.pending.keys()] });
	}

	/** Stops the agent if it runs and removes its row. The transcript stays. */
	async forget(runtimeId: string, agentId: string): Promise<void> {
		await this.stop(runtimeId, agentId);
		const table = this.table(runtimeId);
		if (!table.delete(agentId)) return;
		this.persist(runtimeId);
		this.emit(runtimeId, agentId, 'removed');
	}

	/** Stops every process of every runtime: the plugin is unloading. */
	stopAll(): Promise<void> {
		const stops: Promise<void>[] = [];
		for (const [runtimeId, table] of this.runtimes) {
			for (const agentId of table.keys()) stops.push(this.stop(runtimeId, agentId));
		}
		return Promise.all(stops).then(() => undefined);
	}

	/** Drops the runtimes no longer configured, stopping their processes. */
	prune(runtimeIds: ReadonlySet<string>): void {
		for (const [runtimeId, table] of [...this.runtimes]) {
			if (runtimeIds.has(runtimeId)) continue;
			for (const agentId of table.keys()) void this.stop(runtimeId, agentId);
			this.runtimes.delete(runtimeId);
			this.setups.delete(runtimeId);
		}
	}

	private table(runtimeId: string): Map<string, AgentRecord> {
		let table = this.runtimes.get(runtimeId);
		if (!table) {
			table = new Map();
			for (const stored of this.host.load(runtimeId)) {
				table.set(stored.id, {
					stored: { ...stored },
					process: null,
					...freshRecord(),
					turns: 0,
					finished: false,
					pending: new Map(),
					status: 'stopped',
					statusSeq: 0,
				});
			}
			this.runtimes.set(runtimeId, table);
		}
		return table;
	}

	private record(runtimeId: string, agentId: string): AgentRecord {
		const record = this.table(runtimeId).get(agentId);
		if (!record) throw new Error(NO_SUCH_AGENT);
		return record;
	}

	private persist(runtimeId: string): void {
		this.host.save(
			runtimeId,
			[...this.table(runtimeId).values()].map((record) => ({ ...record.stored })),
		);
	}

	/**
	 * Starts the agent's process. `how` forces one way of starting, for the
	 * second attempt after Claude refused the first; `replay` are the prompts
	 * that attempt never read, written again here.
	 */
	private spawn(runtimeId: string, record: AgentRecord, how?: AgentRecord['spawnedWith'], replay: string[] = []): void {
		const setup = this.setups.get(runtimeId);
		if (!setup) throw new Error('the runtime has not found claude yet');
		const { cwd, sessionId } = record.stored;
		// Resolved again for this process, as Claude resolves its cwd at start.
		record.where = null;
		record.reportedCwd = '';
		// A session that never had a turn has nothing to resume, and `--resume`
		// on it fails; its id is simply started again. A row from before
		// `started` was recorded looks for the transcript instead.
		const resume = how
			? how === 'resume'
			: record.stored.started === true || this.host.exists(this.transcriptFile(runtimeId, record));
		const argv = claudeArgv({
			binary: setup.binary,
			sessionId,
			resume,
			permissionMode: setup.permissionMode,
			extraArgs: this.host.extraArgs?.(),
		});
		const process: ClaudeProcess = new ClaudeProcess({
			argv,
			cwd,
			env: this.host.env(setup.binary),
			spawn: this.host.spawn,
			timers: this.host.timers,
			onEvent: (event) => this.onEvent(runtimeId, record, process, event),
			onExit: (info) => this.onExit(runtimeId, record, process, info),
		});
		record.process = process;
		record.settings = this.host.localSettings?.(cwd) ?? null;
		record.spawnedWith = resume ? 'resume' : 'session-id';
		record.initSeen = false;
		record.unclaimed = [];
		record.retried = how !== undefined;
		record.turns = 0;
		record.finished = false;
		record.pending.clear();
		process.start();
		// A spawn that failed outright has already exited and cleared the record.
		if (record.process !== process) return;
		for (const text of replay) {
			try {
				process.send(userMessage(text));
			} catch {
				break;
			}
			record.unclaimed.push(text);
			record.turns++;
		}
		this.update(runtimeId, record);
	}

	/** Where Claude writes the row's current transcript (`claudeConfigDir`, the real cwd). */
	private transcriptFile(runtimeId: string, record: AgentRecord): string {
		if (!record.where) {
			const { cwd } = record.stored;
			const realCwd = record.reportedCwd || this.host.realpath?.(cwd) || cwd;
			const env = this.host.env(this.setups.get(runtimeId)?.binary ?? '');
			record.where = { configDir: claudeConfigDir(env, this.host.home ?? homedir(), realCwd), realCwd };
		}
		return claudeTranscriptFile(record.where.configDir, record.where.realCwd, record.stored.sessionId);
	}

	/** The session has had a turn: from now on it is resumed. */
	private markStarted(runtimeId: string, record: AgentRecord): void {
		if (record.stored.started) return;
		record.stored.started = true;
		this.persist(runtimeId);
	}

	private onEvent(runtimeId: string, record: AgentRecord, process: ClaudeProcess, event: StreamEvent): void {
		if (record.process !== process) return;
		switch (event.type) {
			case 'init': {
				record.initSeen = true;
				record.unclaimed = [];
				let moved = false;
				// Claude's own cwd, which is where it files the transcript.
				if (event.cwd && event.cwd !== record.reportedCwd) {
					const before = this.transcriptFile(runtimeId, record);
					record.reportedCwd = event.cwd;
					record.where = null;
					moved = this.transcriptFile(runtimeId, record) !== before;
				}
				// `/clear` (and a compact) rotates the session in the same process;
				// the new id comes with the next init (ADR-0007 amendment), and its
				// transcript is written by then (measured 2026-11-06).
				if (event.sessionId && SESSION_ID_RE.test(event.sessionId) && event.sessionId !== record.stored.sessionId) {
					record.stored.sessionId = event.sessionId;
					this.persist(runtimeId);
					moved = true;
				}
				this.markStarted(runtimeId, record);
				if (moved) this.emit(runtimeId, record.stored.id, 'session');
				return;
			}
			case 'result': {
				record.turns = Math.max(0, record.turns - 1);
				// A `--resume` Claude refused at startup reports it as a result
				// before any init; its exit decides what happens next.
				if (event.isError && !record.initSeen && record.spawnedWith === 'resume') {
					this.update(runtimeId, record);
					return;
				}
				if (!event.isError) this.markStarted(runtimeId, record);
				if (record.turns === 0) record.finished = true;
				if (event.isError && !event.terminalReason.startsWith('aborted')) {
					const reason = event.terminalReason ? ` (${event.terminalReason})` : '';
					this.host.notice(
						`Herdr: ${record.stored.name || 'Claude'}: ${event.message || event.subtype || 'the turn failed'}${reason}`,
					);
				}
				this.update(runtimeId, record);
				return;
			}
			case 'permission': {
				record.pending.set(event.request.requestId, event.request);
				this.update(runtimeId, record);
				return;
			}
			case 'cancel': {
				if (record.pending.delete(event.requestId)) this.update(runtimeId, record);
				return;
			}
			case 'control': {
				// Nothing else is declared, so nothing else should come; answer it
				// rather than leave Claude waiting for ever.
				try {
					process.send(controlError(event.requestId, `Unsupported control request subtype: ${event.subtype}`));
				} catch {
					// The process is going; its exit says so.
				}
				return;
			}
			default:
				return;
		}
	}

	private onExit(
		runtimeId: string,
		record: AgentRecord,
		process: ClaudeProcess,
		info: { code: number | null; stopping: boolean; error: string },
	): void {
		if (record.process !== process) return;
		record.process = null;
		record.turns = 0;
		record.finished = false;
		record.pending.clear();
		// Claude refused how it was started: the session id is taken (the row
		// had started after all), or there is no conversation under it. Started
		// once more the other way, with what the refused process never read.
		const fallback =
			!info.stopping && !record.retried && !record.initSeen ? startupFallback(record.spawnedWith, info.error) : null;
		if (fallback) {
			if (fallback === 'resume') record.stored.started = true;
			else delete record.stored.started;
			this.persist(runtimeId);
			try {
				this.spawn(runtimeId, record, fallback, record.unclaimed);
				return;
			} catch {
				// No setup any more: reported as the exit it was.
			}
		}
		if (!info.stopping && info.code !== 0) {
			this.host.notice(`Herdr: ${record.stored.name || 'Claude'} stopped: ${info.error}`);
		}
		this.update(runtimeId, record);
	}

	private statusOf(record: AgentRecord): ClaudeAgentStatus {
		if (!record.process?.alive) return 'stopped';
		if (record.pending.size > 0) return 'blocked';
		if (record.turns > 0) return 'working';
		return record.finished ? 'done' : 'idle';
	}

	/** Recomputes the status and tells the listeners; the request may have moved too. */
	private update(runtimeId: string, record: AgentRecord): void {
		const status = this.statusOf(record);
		if (status !== record.status) {
			record.status = status;
			record.statusSeq = ++this.statusSeq;
		}
		this.emit(runtimeId, record.stored.id, 'status');
	}

	private view(runtimeId: string, record: AgentRecord): ClaudeAgentView {
		const first = record.pending.values().next();
		let request: PendingRequest | null = null;
		if (!first.done) {
			request = this.requestViews.get(first.value) ?? pendingRequestOf(first.value, record.settings);
			this.requestViews.set(first.value, request);
		}
		const status = this.statusOf(record);
		return {
			...record.stored,
			status,
			blockKind: status === 'blocked' && request ? (request.kind === 'question' ? 'question' : 'permission') : null,
			request: status === 'blocked' ? request : null,
			statusSeq: record.statusSeq,
			started: record.stored.started === true,
			transcriptPath: this.transcriptFile(runtimeId, record),
		};
	}

	private emit(runtimeId: string, agentId: string, change: ClaudeAgentChange): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(runtimeId, agentId, change);
			} catch {
				// One bad subscriber must not stop the others.
			}
		}
	}
}
