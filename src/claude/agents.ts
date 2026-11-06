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
 * **Terminal view** (ADR-0007's D2). An agent's process is headless or its
 * TUI, never both: `claude --resume <id> --permission-mode <mode>` on a pty
 * from `script(1)` under the fd-3 watchdog (`./pty.ts`), shared by every
 * terminal tab that shows it (`./sharedPty.ts`). A terminal tab that
 * attaches asks for the TUI; a tab switched to the native view, or a native
 * prompt, asks for the headless process. The process changes only between
 * turns (`./viewSwitch.ts`): the old one stops in its own stop order and the
 * other starts with `--resume`, about a second either way. A native prompt
 * that sets off a switch is delivered to the headless process the switch
 * starts, and its `send` settles then; if a stop overtakes the switch it is
 * rejected, never kept for later. A tab that attaches during a switch waits
 * for it and then follows whatever runs; it never turns the switch into a
 * stop. The TUI keeps running when its tabs close, and a reopened tab
 * repaints from its replay buffer. Its status is what Claude reports with OSC 7501
 * (`./programStatus.ts`), which the plugin turns on by answering Claude's
 * probe; a blocked TUI is answered in the terminal, since there is no
 * `can_use_tool` there. A `/clear` typed in the TUI is not seen: the row
 * keeps the session from before it.
 *
 * **Stopping holds** (the D2 review). Stop, Forget, graduation's release,
 * a removed runtime and unload hold the row before the process is told to
 * end, so nothing that arrives meanwhile (a tab attaching, a turn ending,
 * the runtime connecting) starts it again: only a person does, once a Stop
 * is over (a tab opened or reconnected then, a prompt, Resume); a released
 * row only when graduation gives it back. A hidden tab shown again is not a
 * person asking: it says the agent stopped, and waits for a Reconnect. Unload also ends every process the table ever
 * started, in a row or not, and nothing starts after it.
 *
 * No Obsidian: everything outside the table comes through {@link ClaudeAgentsHost}.
 */

import type { BlockKind } from '../native/sessionWatcher';
import type { PendingRequest, WaitingAnswer } from '../native/pendingRequest';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { isAbsolute, resolve, type PlatformPath } from 'node:path';
import { claudeTranscriptFile } from '../native/transcriptSource';
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '../runtimes';
import {
	claudeArgv,
	claudeTuiArgv,
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
import { PROGRAM_STATUS_REPLY, ProgramStatusScanner, type ProgramState, type ProgramStatusScan } from './programStatus';
import type { LocalSettingsTarget } from './projectRoot';
import type { PtyPlatform, PtySpawn, PtyTools } from './pty';
import { SharedPty, type PtyAttachment, type PtyOpenHow, type PtyViewer } from './sharedPty';
import { planViewSwitch, TUI_BUSY, type ClaudeProcessMode } from './viewSwitch';

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
	/**
	 * A permission mode this row always starts in, whatever its runtime's is.
	 * Set only by a caller that must not run in the runtime's mode: the
	 * getting-started flow's "Ask Claude" pins the asking mode (ADR-0008), so
	 * its installer command always arrives as a permission card, now and
	 * after a resume. Absent on every other row.
	 */
	permissionMode?: ClaudePermissionMode;
	/**
	 * This row's permission cards offer only Allow once and Deny: no grant for
	 * the session, none for the project. Set with the pinned mode by "Ask
	 * Claude" (ADR-0008), whose installer command would otherwise be one
	 * click from a lasting Bash rule for `curl` and `sh` in the vault's
	 * settings. Absent on every other row.
	 */
	allowOnceOnly?: boolean;
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

/**
 * Whatever `data.json` holds, turned into stored rows; anything else is
 * dropped. A cwd must be absolute on this platform (`paths`, injected so
 * Windows' drive and UNC paths are tested here too).
 */
export function normalizeClaudeSessions(
	value: unknown,
	paths: Pick<PlatformPath, 'isAbsolute'> = nodePath,
): Record<string, StoredClaudeSession[]> {
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
			if (!id || seen.has(id) || !SESSION_ID_RE.test(sessionId) || !paths.isAbsolute(cwd)) continue;
			seen.add(id);
			sessions.push({
				id,
				sessionId,
				cwd,
				name: typeof row.name === 'string' ? row.name : '',
				...(row.started === true ? { started: true } : {}),
				...((CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(row.permissionMode)
					? { permissionMode: row.permissionMode as ClaudePermissionMode }
					: {}),
				...(row.allowOnceOnly === true ? { allowOnceOnly: true } : {}),
			});
		}
		if (sessions.length > 0) result[runtimeId] = sessions;
	}
	return result;
}

/**
 * An agent's status, as the scope and the watcher read it. `unknown` is a TUI
 * that has not reported one (OSC 7501 needs Claude Code 2.1.295 or later).
 */
export type ClaudeAgentStatus = 'stopped' | 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

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
	/** What runs: the headless process, the TUI of the terminal view, or nothing. */
	mode: ClaudeProcessMode;
	/** Its cards offer only Allow once and Deny ({@link StoredClaudeSession.allowOnceOnly}). */
	allowOnceOnly?: boolean;
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
	/** How a TUI gets its pty (ADR-0007's D2); absent where there is none (Windows). */
	pty?: ClaudePtyHost;
	/**
	 * Asks the user a yes-or-no question; true for yes. Absent, the answer is
	 * no: nothing that needs one happens.
	 */
	confirm?(question: ClaudeQuestion): Promise<boolean>;
}

/** A question for the user, as a confirmation modal shows it. Sentence case. */
export interface ClaudeQuestion {
	title: string;
	body: string;
	/** The confirming button, which does something that cannot be undone. */
	confirm: string;
}

/** What the user is asked before a TUI of unknown status is stopped for the native view. */
export function unknownTuiQuestion(name: string): ClaudeQuestion {
	return {
		title: 'Stop Claude in the terminal?',
		body:
			`${name || 'This agent'} has not reported whether it is working in its terminal view ` +
			'(that needs Claude Code 2.1.295 or later), so a turn may be running. ' +
			'Moving it to the native view stops it, and cuts off a running turn.',
		confirm: 'Stop and move',
	};
}

/** What starts a TUI on a pty. */
export interface ClaudePtyHost {
	platform: PtyPlatform;
	spawn: PtySpawn;
	tools: PtyTools;
	/** The replay buffer's bound; `REPLAY_LIMIT_BYTES` by default. */
	replayLimit?: number;
}

/** A terminal tab on an agent: attached to its TUI, or waiting for it. */
interface AgentViewer {
	viewer: PtyViewer;
	/** The attachment to the running TUI; null while waiting. */
	inner: PtyAttachment | null;
	/** What the tab was last told while waiting, so it is told once. */
	waiting: string | null;
	/** A person is in front of the tab. */
	looking: boolean;
}

/** What a tab says while its runtime has not found claude yet. */
export const WAIT_FOR_RUNTIME = 'waiting for this Claude runtime to connect';
/** What a tab says when the agent's process moves to the native view. */
export const MOVED_TO_NATIVE = 'the agent moved to the native view; reconnect to bring it back here';
/** What a tab says when the agent was stopped. */
export const AGENT_STOPPED = 'the agent stopped; reconnect to resume it here';
/** What a tab says when Claude itself quit (`/exit`). */
export const CLAUDE_QUIT = 'Claude quit; reconnect to resume it here';
/** Said while a Stop runs: nothing starts the agent until it is over. */
export const AGENT_STOPPING = 'the agent is stopping';
/** Said while graduation moves the session to another runtime. */
export const AGENT_RELEASED = 'the agent is moving to another runtime';
/** Said by a tab whose agent was forgotten, or whose runtime was removed. */
export const AGENT_FORGOTTEN = 'the agent was removed from the list';
/** Said once the plugin is unloading: nothing starts any more. */
export const PLUGIN_UNLOADING = 'the plugin is unloading';
/** A native prompt to a TUI of unknown status, when the user kept it (or nobody could be asked). */
export const PROMPT_NOT_SENT_KEPT = 'the prompt was not sent: the agent stayed in its terminal view';
/**
 * Why a row pinned to Allow once has no terminal view: Claude's own dialog
 * there offers "don't ask again", which saves a lasting rule.
 */
export const ALLOW_ONCE_NO_TERMINAL =
	"not offered for this agent, which may only be allowed once at a time: Claude's own dialog in the terminal can save a lasting rule";
/** A native prompt waiting for a switch that a stop overtook. */
export const PROMPT_NOT_SENT_STOPPED = 'the prompt was not sent: the agent was stopped first';

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
	/** The TUI, while the agent runs in its terminal view. */
	tui: SharedPty | null;
	/** The TUI's last OSC 7501 state; null before its first report. */
	tuiState: ProgramState | null;
	/** While the TUI is blocked: on what, when it said. */
	tuiBlock: BlockKind | null;
	/** The current TUI reported a turn, so it took its session. */
	tuiTurned: boolean;
	/** A tab typed into the current TUI, so while it reports nothing it may be mid-turn. */
	tuiTyped: boolean;
	/** The TUI the user is being asked about stopping (unknown status); null when no question is open. */
	asking: SharedPty | null;
	/** Which process the agent should run: the last view that asked (`./viewSwitch.ts`). */
	want: 'stream' | 'tui';
	/** Terminal tabs on the agent. */
	viewers: Set<AgentViewer>;
	/** A switch is stopping the old process, and starts this one once it has exited. */
	switching: 'stream' | 'tui' | null;
	/** Native prompts waiting for the headless process a switch starts; each settles its `send`. */
	queued: QueuedPrompt[];
	/** Bumped by every stop, so a switch overtaken by one starts nothing. */
	epoch: number;
	/** A Stop, Forget, graduation or unload is ending the process; settles once it has. */
	stopping: Promise<void> | null;
	/** Why nothing may start this agent's process now; null when anything may. */
	hold: Hold | null;
}

/** A native prompt that waits for its switch: delivered then, or rejected. */
interface QueuedPrompt {
	text: string;
	resolve(): void;
	reject(error: Error): void;
}

/**
 * Why an agent's process must not start again (the D2 review). Set by
 * whatever ended it, before it ends, so nothing that comes during the stop
 * (a tab attaching, a turn ending, the runtime connecting) restarts it:
 *
 * - `stopped`: Stop. A person starting it again lifts it: opening a tab
 *   or clicking Reconnect once the stop is over, a prompt, Resume. A hidden
 *   tab shown again does not.
 * - `released`: graduation. Only {@link ClaudeAgents.reclaim} lifts it,
 *   when the session did not move after all.
 * - `gone`: Forget, a removed runtime, unload. For good.
 */
interface Hold {
	kind: 'stopped' | 'released' | 'gone';
	/** What a tab and a prompt are told. */
	reason: string;
}

const HOLD_RANK: Record<Hold['kind'], number> = { stopped: 0, released: 1, gone: 2 };
const STOPPED_HOLD: Hold = { kind: 'stopped', reason: AGENT_STOPPED };

/** What a tab that attaches during a switch to the headless process says until it is over. */
export const WAIT_FOR_NATIVE_SWITCH = 'waiting for the agent to move to the native view first';
/** What a tab says while the agent's TUI starts for it. */
export const STARTING_TUI = 'starting Claude in the terminal';
/** Said to a native prompt while the agent moves to its terminal view. */
export const SWITCHING_TO_TUI = 'the agent is moving to its terminal view; prompt it there once it has';
/** A native prompt whose switch could not stop the TUI. */
export const PROMPT_NOT_SENT_STUCK = 'the prompt was not sent: the terminal view did not stop';

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

type Listener = (runtimeId: string, agentId: string, change: ClaudeAgentChange) => void;

/** A record for a row, with no process. */
function newRecord(stored: StoredClaudeSession): AgentRecord {
	return {
		stored,
		process: null,
		settings: null,
		where: null,
		reportedCwd: '',
		spawnedWith: 'session-id',
		initSeen: false,
		unclaimed: [],
		retried: false,
		turns: 0,
		finished: false,
		pending: new Map(),
		status: 'stopped',
		statusSeq: 0,
		tui: null,
		tuiState: null,
		tuiBlock: null,
		tuiTurned: false,
		tuiTyped: false,
		asking: null,
		want: 'stream',
		viewers: new Set(),
		switching: null,
		queued: [],
		epoch: 0,
		stopping: null,
		hold: null,
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
	/** The same, for a request whose agent is stopping. */
	private readonly stoppingViews = new WeakMap<ToolPermissionRequest, PendingRequest>();
	private statusSeq = 0;
	/** Records whose switch is being planned, so a status change inside it does not plan again. */
	private readonly settling = new Set<AgentRecord>();
	/**
	 * Every process this table started that has not exited, row or no row,
	 * and how to stop it: unload ends all of them, not only the table's.
	 */
	private readonly live = new Map<object, () => Promise<void>>();
	/** The plugin is unloading: nothing starts any more. */
	private disposed = false;

	constructor(private readonly host: ClaudeAgentsHost) {}

	/** How new processes of this runtime start; set by every connection to it. */
	configure(runtimeId: string, setup: ClaudeRuntimeSetup): void {
		this.setups.set(runtimeId, { ...setup });
		// Terminal tabs that waited for the runtime can start now.
		for (const record of this.runtimes.get(runtimeId)?.values() ?? []) {
			if (record.viewers.size > 0) this.settle(runtimeId, record);
		}
	}

	/** Every agent of a runtime, stored ones first loaded as stopped. */
	list(runtimeId: string): ClaudeAgentView[] {
		return [...this.table(runtimeId).values()].map((record) => this.view(runtimeId, record));
	}

	get(runtimeId: string, agentId: string): ClaudeAgentView | null {
		const record = this.table(runtimeId).get(agentId);
		return record ? this.view(runtimeId, record) : null;
	}

	/**
	 * The permission mode a runtime's agents start in, or one agent's own when
	 * its row pins one; null before the runtime is configured.
	 */
	permissionMode(runtimeId: string, agentId?: string): ClaudePermissionMode | null {
		const pinned = agentId ? this.table(runtimeId).get(agentId)?.stored.permissionMode : undefined;
		return pinned ?? this.setups.get(runtimeId)?.permissionMode ?? null;
	}

	/** Names in use on a runtime, for a new agent's name. */
	names(runtimeId: string): Set<string> {
		return new Set([...this.table(runtimeId).values()].map((record) => record.stored.name));
	}

	on(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * A new agent in `cwd`, stored and started at once (it idles until
	 * prompted). `options.permissionMode` pins the row to that mode instead of
	 * the runtime's, for every process it ever runs; `options.allowOnceOnly`
	 * pins its cards to Allow once and Deny.
	 */
	start(
		runtimeId: string,
		cwd: string,
		name: string,
		options: { permissionMode?: ClaudePermissionMode; allowOnceOnly?: boolean } = {},
	): ClaudeAgentView {
		const table = this.table(runtimeId);
		const id = this.host.newAgentId(new Set(table.keys()));
		const record = newRecord({
			id,
			sessionId: this.host.newSessionId(),
			cwd,
			name,
			...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
			...(options.allowOnceOnly ? { allowOnceOnly: true } : {}),
		});
		table.set(id, record);
		this.persist(runtimeId);
		this.emit(runtimeId, id, 'added');
		this.spawn(runtimeId, record);
		return this.view(runtimeId, record);
	}

	/** Spawns a stopped agent's process again (`--resume`), with no prompt. Throws while it may not start. */
	resume(runtimeId: string, agentId: string): void {
		const record = this.record(runtimeId, agentId);
		this.refuseHeld(record);
		if (record.process || record.tui || record.switching) return;
		// A person asked: a Stop no longer holds it.
		record.hold = null;
		this.spawn(runtimeId, record);
	}

	/**
	 * Sends a prompt, resuming a stopped agent first. An agent in its terminal
	 * view moves to a headless process once its TUI is idle, and gets the
	 * prompt there: the promise settles once the prompt is written to that
	 * process, or rejects with why it never will be (a stop came first, the
	 * process could not start). Never kept for later. Rejects with a readable
	 * error.
	 */
	prompt(runtimeId: string, agentId: string, text: string): Promise<void> {
		try {
			return this.promptNow(runtimeId, agentId, text);
		} catch (error) {
			return Promise.reject(asError(error));
		}
	}

	private promptNow(runtimeId: string, agentId: string, text: string): Promise<void> {
		const record = this.record(runtimeId, agentId);
		this.refuseHeld(record);
		if (record.switching === 'tui') throw new Error(SWITCHING_TO_TUI);
		if (record.switching === 'stream') {
			// The switch under way delivers it with the others.
			this.wantStream(record);
			return this.enqueue(record, text);
		}
		if (record.tui) {
			if (record.tui.isStopping) throw new Error(AGENT_STOPPING);
			const status = this.statusOf(record);
			if (status === 'working' || status === 'blocked') throw new Error(TUI_BUSY);
			const sent = this.enqueue(record, text);
			this.wantStream(record);
			this.settle(runtimeId, record);
			return sent;
		}
		if (record.process?.isStopping) throw new Error(AGENT_STOPPING);
		// A person prompting a stopped agent resumes it.
		record.hold = null;
		this.wantStream(record);
		if (!record.process) this.spawn(runtimeId, record);
		const process = record.process;
		if (!process?.alive) throw new Error('the agent could not be started');
		process.send(userMessage(text));
		if (!record.initSeen) record.unclaimed.push(text);
		record.turns++;
		record.finished = false;
		this.update(runtimeId, record);
		return Promise.resolve();
	}

	/** Throws while a stop runs, or while a hold only something else may lift is on. */
	private refuseHeld(record: AgentRecord): void {
		if (this.disposed) throw new Error(PLUGIN_UNLOADING);
		if (record.hold && record.hold.kind !== 'stopped') throw new Error(record.hold.reason);
		if (record.stopping) throw new Error(AGENT_STOPPING);
	}

	private enqueue(record: AgentRecord, text: string): Promise<void> {
		return new Promise<void>((resolve, reject) => record.queued.push({ text, resolve, reject }));
	}

	/** Rejects every prompt still waiting for a switch: none is ever sent later. */
	private dropQueued(record: AgentRecord, reason: string): void {
		for (const prompt of record.queued.splice(0)) prompt.reject(new Error(reason));
	}

	/** The `interrupt` control request, while a turn runs; Esc for a TUI, which is Claude's own key for it. */
	interrupt(runtimeId: string, agentId: string): void {
		const record = this.record(runtimeId, agentId);
		if (record.tui?.alive) {
			record.tui.write('\x1b');
			return;
		}
		if (!record.process?.alive) throw new Error('the agent is not running');
		record.process.interrupt();
	}

	/** Answers a pending permission request. Throws a readable error. */
	respond(runtimeId: string, agentId: string, requestId: string, answer: WaitingAnswer): void {
		const record = this.record(runtimeId, agentId);
		const request = record.pending.get(requestId);
		// A stop denies what waits first, so an answer now would come after
		// Claude was already told no.
		if (request && record.process?.isStopping) throw new Error('the agent is stopping, so this request was denied');
		if (!request || !record.process?.alive) throw new Error('that request is no longer waiting');
		// The project grant is only offered where its file is known, and no
		// grant at all on a row pinned to Allow once.
		const offered =
			!(record.stored.allowOnceOnly && (answer.type === 'allow-session' || answer.type === 'allow-project')) &&
			!(answer.type === 'allow-project' && !record.settings);
		const response = offered ? permissionResponse(request, answer) : null;
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

	/**
	 * Stops the agent's process, in the ADR's order (a TUI in its own); the
	 * row stays, stopped, and its terminal tabs say so. Nothing restarts it
	 * until a person does (a tab opened or reconnected after the stop, a
	 * prompt, Resume); a hidden tab shown again is not one.
	 */
	async stop(runtimeId: string, agentId: string): Promise<void> {
		const record = this.table(runtimeId).get(agentId);
		if (record) await this.halt(runtimeId, record, STOPPED_HOLD);
	}

	/**
	 * Graduation (ADR-0007): stops the agent's process and holds the row so
	 * that nothing here starts its session again while another runtime
	 * resumes it. True once the process is confirmed gone; the row stays
	 * held until it is forgotten or {@link reclaim}ed.
	 */
	async release(runtimeId: string, agentId: string): Promise<boolean> {
		const record = this.table(runtimeId).get(agentId);
		if (!record) return false;
		await this.halt(runtimeId, record, { kind: 'released', reason: AGENT_RELEASED });
		return !record.process && !record.tui;
	}

	/** Graduation did not move the session after all: the row is stopped, and a person may resume it. */
	reclaim(runtimeId: string, agentId: string): void {
		const record = this.table(runtimeId).get(agentId);
		if (record?.hold?.kind === 'released') record.hold = STOPPED_HOLD;
	}

	/**
	 * Ends the agent's processes and holds it (above) before anything is
	 * awaited, so whatever comes during the stop starts nothing: prompts
	 * waiting for a switch are rejected, tabs waiting for one are closed, and
	 * a tab or a prompt that arrives is refused until it is over.
	 */
	private async halt(runtimeId: string, record: AgentRecord, hold: Hold): Promise<void> {
		if (!record.hold || HOLD_RANK[hold.kind] >= HOLD_RANK[record.hold.kind]) record.hold = hold;
		record.epoch++;
		record.want = 'stream';
		this.dropQueued(record, PROMPT_NOT_SENT_STOPPED);
		for (const entry of [...record.viewers]) {
			if (entry.inner) continue;
			record.viewers.delete(entry);
			entry.viewer.closed(record.hold.reason);
		}
		const stops: Promise<void>[] = [];
		const process = record.process;
		if (process) stops.push(process.stop({ busy: record.turns > 0, pending: [...record.pending.keys()] }));
		if (record.tui) stops.push(record.tui.stop());
		if (stops.length === 0) return;
		const stopping: Promise<void> = Promise.all(stops).then(
			() => undefined,
			() => undefined,
		);
		record.stopping = stopping;
		// The waiting card says the agent is stopping until it has.
		this.update(runtimeId, record);
		try {
			await stopping;
		} finally {
			if (record.stopping === stopping) record.stopping = null;
		}
	}

	/**
	 * A terminal tab asks for the agent (ADR-0007's D2): its TUI, started now
	 * when nothing runs, switched to when the headless process is idle, and
	 * waited for while a turn runs or a switch is under way. Throws when this
	 * machine has no pty, and while the agent may not start (it is stopping,
	 * moving to another runtime, forgotten, or the plugin is unloading), or
	 * when a hidden tab is shown again (`how.revealed`) on a stopped agent:
	 * that is no person asking, so it says the agent stopped instead.
	 */
	openTerminal(runtimeId: string, agentId: string, viewer: PtyViewer, how: PtyOpenHow = {}): PtyAttachment {
		const record = this.record(runtimeId, agentId);
		if (!this.host.pty) throw new Error('the terminal view is not available on this platform');
		if (record.stored.allowOnceOnly) throw new Error(ALLOW_ONCE_NO_TERMINAL);
		if (record.stopping && record.hold) throw new Error(record.hold.reason);
		this.refuseHeld(record);
		// A tab coming back into view did not ask for anything: Reconnect does.
		if (how.revealed && record.hold) throw new Error(record.hold.reason);
		// Opening a tab on a stopped agent is a person resuming it.
		record.hold = null;
		const entry: AgentViewer = { viewer, inner: null, waiting: null, looking: false };
		record.viewers.add(entry);
		record.want = 'tui';
		if (record.tui?.alive && !record.tui.isStopping && !record.switching) this.attachViewer(record, entry);
		// A switch decides nothing for it; the tab waits for the switch, then for whatever runs.
		else if (record.switching === 'stream') this.tellWaiting(record, WAIT_FOR_NATIVE_SWITCH);
		else if (record.switching === 'tui') this.tellWaiting(record, STARTING_TUI);
		const attachment: PtyAttachment = {
			write: (data) => {
				const written = entry.inner?.write(data) ?? false;
				if (written) record.tuiTyped = true;
				return written;
			},
			resize: (cols, rows) => entry.inner?.resize(cols, rows) ?? false,
			reply: (data) => entry.inner?.reply(data) ?? false,
			repaint: () => entry.inner?.repaint(),
			looking: (on) => {
				if (entry.looking === on) return;
				entry.looking = on;
				if (on && record.tui && record.finished) {
					record.finished = false;
					this.update(runtimeId, record);
				}
			},
			detach: () => {
				entry.inner?.detach();
				entry.inner = null;
				if (!record.viewers.delete(entry)) return;
				// Nobody waits for a TUI any more; one that runs keeps running.
				if (record.viewers.size === 0 && !record.tui) record.want = 'stream';
			},
		};
		this.settle(runtimeId, record);
		return attachment;
	}

	/** A tab switched to the native view: the agent goes back to a headless process once its TUI is idle. */
	useNative(runtimeId: string, agentId: string): void {
		const record = this.table(runtimeId).get(agentId);
		if (!record) return;
		this.wantStream(record);
		this.settle(runtimeId, record);
	}

	/**
	 * A native view asked for the headless process: terminal tabs still
	 * waiting for the TUI get nothing now, and say so.
	 */
	private wantStream(record: AgentRecord): void {
		record.want = 'stream';
		for (const entry of [...record.viewers]) {
			if (entry.inner) continue;
			record.viewers.delete(entry);
			entry.viewer.closed(MOVED_TO_NATIVE);
		}
	}

	/** Stops the agent if it runs and removes its row, which nothing starts again. The transcript stays. */
	async forget(runtimeId: string, agentId: string): Promise<void> {
		const table = this.table(runtimeId);
		const record = table.get(agentId);
		if (!record) return;
		await this.halt(runtimeId, record, { kind: 'gone', reason: AGENT_FORGOTTEN });
		if (table.get(agentId) !== record) return;
		table.delete(agentId);
		this.persist(runtimeId);
		this.emit(runtimeId, agentId, 'removed');
	}

	/**
	 * Stops every process this table ever started, in a row or not: the
	 * plugin is unloading. Nothing starts after it.
	 */
	stopAll(): Promise<void> {
		this.disposed = true;
		const stops: Promise<void>[] = [];
		for (const [runtimeId, table] of this.runtimes) {
			for (const record of table.values()) {
				stops.push(this.halt(runtimeId, record, { kind: 'gone', reason: PLUGIN_UNLOADING }));
			}
		}
		// Whatever a row no longer tracks; a process already stopping returns its own stop.
		for (const stop of this.live.values()) stops.push(stop());
		return Promise.all(stops).then(() => undefined);
	}

	/** Drops the runtimes no longer configured, stopping their processes for good. */
	prune(runtimeIds: ReadonlySet<string>): void {
		for (const [runtimeId, table] of [...this.runtimes]) {
			if (runtimeIds.has(runtimeId)) continue;
			for (const record of table.values()) {
				void this.halt(runtimeId, record, { kind: 'gone', reason: AGENT_FORGOTTEN });
			}
			this.runtimes.delete(runtimeId);
			this.setups.delete(runtimeId);
		}
	}

	private table(runtimeId: string): Map<string, AgentRecord> {
		let table = this.runtimes.get(runtimeId);
		if (!table) {
			table = new Map();
			for (const stored of this.host.load(runtimeId)) table.set(stored.id, newRecord({ ...stored }));
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
	 * that attempt never read, written again here. Returns how many of them
	 * were written. Throws while the agent may not start.
	 */
	private spawn(runtimeId: string, record: AgentRecord, how?: AgentRecord['spawnedWith'], replay: string[] = []): number {
		this.mayStart(record);
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
			permissionMode: record.stored.permissionMode ?? setup.permissionMode,
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
		if (record.process !== process) return 0;
		this.live.set(process, () => process.stop({ busy: true, pending: [] }));
		let written = 0;
		for (const text of replay) {
			try {
				process.send(userMessage(text));
			} catch {
				break;
			}
			written++;
			record.unclaimed.push(text);
			record.turns++;
		}
		this.update(runtimeId, record);
		return written;
	}

	/** Throws when nothing may start the agent's process: unload, or a hold (see {@link Hold}). */
	private mayStart(record: AgentRecord): void {
		if (this.disposed) throw new Error(PLUGIN_UNLOADING);
		if (record.hold) throw new Error(record.hold.reason);
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
				// A `--resume` Claude refused at startup reports it as a result
				// before any init; its exit decides what happens next. No turn
				// ended: the agent is not idle, so no switch takes it away before
				// the other way of starting gets its prompts.
				if (event.isError && !record.initSeen && record.spawnedWith === 'resume') {
					this.update(runtimeId, record);
					return;
				}
				record.turns = Math.max(0, record.turns - 1);
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
		this.live.delete(process);
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

	private modeOf(record: AgentRecord): ClaudeProcessMode {
		if (record.tui?.alive) return 'tui';
		return record.process?.alive ? 'stream' : 'stopped';
	}

	private statusOf(record: AgentRecord): ClaudeAgentStatus {
		if (record.tui?.alive) {
			if (record.tuiState === 'working') return 'working';
			if (record.tuiState === 'blocked') return 'blocked';
			// Never reported: not known to be idle, whatever it is doing.
			if (record.tuiState === null) return 'unknown';
			return record.finished ? 'done' : 'idle';
		}
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
		this.settle(runtimeId, record);
	}

	/** Moves the agent to the process its views want, when that may happen now (`./viewSwitch.ts`). */
	private settle(runtimeId: string, record: AgentRecord): void {
		if (record.switching || this.settling.has(record)) return;
		// A forgotten row, or a removed runtime's, has nothing to start.
		if (this.runtimes.get(runtimeId)?.get(record.stored.id) !== record) return;
		// Stopped, released, forgotten or unloading: only a person starts it again.
		if (record.hold || this.disposed) return;
		this.settling.add(record);
		try {
			const status = this.statusOf(record);
			const step = planViewSwitch({
				want: record.want,
				mode: this.modeOf(record),
				// A TUI nobody typed into cannot be mid-turn, reported or not.
				status: status === 'unknown' && !record.tuiTyped ? 'idle' : status,
				stopping: record.process?.isStopping === true || record.tui?.isStopping === true,
				viewers: record.viewers.size,
				queued: record.queued.length,
			});
			switch (step.action) {
				case 'stay':
					return;
				case 'wait':
					this.tellWaiting(record, step.reason);
					return;
				case 'start-tui':
					// A tab restored before its runtime connected waits for it.
					if (!this.setups.has(runtimeId)) this.tellWaiting(record, WAIT_FOR_RUNTIME);
					else this.startTuiOrClose(runtimeId, record);
					return;
				case 'start-stream':
					this.spawnStreamOrNotice(runtimeId, record);
					return;
				case 'switch':
					void this.switchProcess(runtimeId, record, record.want);
					return;
				case 'confirm':
					this.askToStopTui(runtimeId, record);
					return;
			}
		} finally {
			this.settling.delete(record);
		}
	}

	/**
	 * A TUI of unknown status that a native view asked to leave: stopped only
	 * once the user says so. No: the prompts waiting for it are rejected, and
	 * the agent stays in its terminal view, so nothing asks again until a
	 * native view does.
	 */
	private askToStopTui(runtimeId: string, record: AgentRecord): void {
		const tui = record.tui;
		if (!tui || record.asking === tui) return;
		record.asking = tui;
		const asked = this.host.confirm?.(unknownTuiQuestion(record.stored.name)) ?? Promise.resolve(false);
		void asked
			.catch(() => false)
			.then((yes) => {
				if (record.asking === tui) record.asking = null;
				const status = this.statusOf(record);
				const busy = status === 'working' || status === 'blocked';
				const applies =
					record.tui === tui &&
					!tui.isStopping &&
					!record.switching &&
					!record.hold &&
					!this.disposed &&
					record.want === 'stream' &&
					this.runtimes.get(runtimeId)?.get(record.stored.id) === record;
				if (yes && applies && !busy) {
					void this.switchProcess(runtimeId, record, 'stream');
					return;
				}
				if (record.tui === tui) {
					// It stays in its terminal view (told so, a tab took it back, or
					// it reported a turn meanwhile): what waited for the switch is
					// not sent, now or later.
					this.dropQueued(record, yes && busy ? TUI_BUSY : PROMPT_NOT_SENT_KEPT);
					if (!yes) record.want = 'tui';
				}
				// Gone meanwhile: the settle below starts the headless process for what waits.
				this.update(runtimeId, record);
			});
	}

	private tellWaiting(record: AgentRecord, reason: string): void {
		for (const entry of record.viewers) {
			if (entry.inner || entry.waiting === reason) continue;
			entry.waiting = reason;
			entry.viewer.waiting(reason);
		}
	}

	/**
	 * Stops what runs (it is idle: no interrupt, no pending request) and,
	 * once it has exited, starts `target`, unless a stop overtook it. What
	 * comes meanwhile does not change the target: a native prompt joins the
	 * queue a switch to the headless process delivers, and a tab that
	 * attaches waits, then follows whatever runs. Only a switch to the
	 * headless process that carries no prompt gives way to a tab that asked
	 * for the TUI since, since the last view to ask wins.
	 */
	private async switchProcess(runtimeId: string, record: AgentRecord, target: 'stream' | 'tui'): Promise<void> {
		const epoch = record.epoch;
		record.switching = target;
		if (target === 'tui') this.tellWaiting(record, STARTING_TUI);
		try {
			if (record.tui) await record.tui.stop();
			else if (record.process) await record.process.stop({ busy: false, pending: [] });
		} finally {
			record.switching = null;
		}
		if (record.epoch !== epoch || record.hold || record.process || record.tui) {
			// A stop already rejected its prompts; an old process that would not
			// stop leaves them nowhere to go.
			this.dropQueued(record, record.epoch !== epoch || record.hold ? PROMPT_NOT_SENT_STOPPED : PROMPT_NOT_SENT_STUCK);
			this.update(runtimeId, record);
			return;
		}
		const tabsWant = record.want === 'tui' && record.viewers.size > 0;
		if (target === 'stream' && (record.queued.length > 0 || !tabsWant)) this.spawnStreamOrNotice(runtimeId, record);
		else if (tabsWant) this.startTuiOrClose(runtimeId, record);
		else if (record.want === 'stream') this.spawnStreamOrNotice(runtimeId, record);
		else this.update(runtimeId, record);
	}

	/**
	 * Starts the headless process with the prompts queued for it, and settles
	 * each one's `send`: written, or rejected with why not.
	 */
	private spawnStreamOrNotice(runtimeId: string, record: AgentRecord): void {
		const queued = record.queued.splice(0);
		let written: number;
		try {
			written = this.spawn(
				runtimeId,
				record,
				undefined,
				queued.map((prompt) => prompt.text),
			);
		} catch (error) {
			const message = asError(error).message;
			for (const prompt of queued) prompt.reject(new Error(message));
			// Nobody waits on a send to hear it otherwise.
			if (queued.length === 0) this.host.notice(`Herdr: ${record.stored.name || 'Claude'} could not start: ${message}`);
			this.update(runtimeId, record);
			return;
		}
		queued.forEach((prompt, index) => {
			if (index < written) prompt.resolve();
			else prompt.reject(new Error('the prompt was not sent: the agent could not be started'));
		});
	}

	private startTuiOrClose(runtimeId: string, record: AgentRecord, how?: AgentRecord['spawnedWith']): void {
		try {
			this.spawnTui(runtimeId, record, how);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			record.want = 'stream';
			for (const entry of [...record.viewers]) {
				record.viewers.delete(entry);
				entry.viewer.closed(reason);
			}
			this.update(runtimeId, record);
		}
	}

	/** The grid the TUI starts at: the first tab that measured one, else 80x24. */
	private tuiSize(record: AgentRecord): { cols: number; rows: number } {
		const entries = [...record.viewers];
		const sized =
			entries.find((entry) => entry.viewer.control && entry.viewer.size()) ?? entries.find((entry) => entry.viewer.size());
		return sized?.viewer.size() ?? { cols: 80, rows: 24 };
	}

	/**
	 * Starts the agent's TUI, `--resume` once its session started, with the
	 * runtime's permission mode, and attaches the tabs waiting for it. `how`
	 * forces the way of starting, for the second attempt after a refusal.
	 */
	private spawnTui(runtimeId: string, record: AgentRecord, how?: AgentRecord['spawnedWith']): void {
		this.mayStart(record);
		const setup = this.setups.get(runtimeId);
		if (!setup) throw new Error('the runtime has not found claude yet');
		const pty = this.host.pty;
		if (!pty) throw new Error('the terminal view is not available on this platform');
		const { cwd, sessionId } = record.stored;
		record.where = null;
		record.reportedCwd = '';
		const resume = how
			? how === 'resume'
			: record.stored.started === true || this.host.exists(this.transcriptFile(runtimeId, record));
		const program = claudeTuiArgv({
			binary: setup.binary,
			sessionId,
			resume,
			permissionMode: record.stored.permissionMode ?? setup.permissionMode,
			extraArgs: this.host.extraArgs?.(),
		});
		const size = this.tuiSize(record);
		const scanner = new ProgramStatusScanner();
		const tui: SharedPty = new SharedPty({
			program,
			cwd,
			env: this.host.env(setup.binary),
			cols: size.cols,
			rows: size.rows,
			platform: pty.platform,
			stopSignal: 'SIGTERM',
			spawn: pty.spawn,
			tools: pty.tools,
			timers: this.host.timers,
			...(pty.replayLimit ? { replayLimit: pty.replayLimit } : {}),
			onData: (bytes) => this.onTuiData(runtimeId, record, tui, scanner.push(bytes)),
			onExit: (info) => this.onTuiExit(runtimeId, record, tui, info),
		});
		record.tui = tui;
		record.tuiState = null;
		record.tuiBlock = null;
		record.tuiTurned = false;
		record.tuiTyped = false;
		record.spawnedWith = resume ? 'resume' : 'session-id';
		record.retried = how !== undefined;
		record.finished = false;
		tui.start();
		// A spawn that failed outright has already exited and closed the tabs.
		if (record.tui !== tui) return;
		this.live.set(tui, () => tui.stop());
		for (const entry of record.viewers) this.attachViewer(record, entry);
		this.update(runtimeId, record);
	}

	private attachViewer(record: AgentRecord, entry: AgentViewer): void {
		const tui = record.tui;
		if (!tui || entry.inner) return;
		if (entry.waiting !== null) {
			entry.waiting = null;
			entry.viewer.waiting(null);
		}
		entry.inner = tui.attach(entry.viewer);
	}

	private onTuiData(runtimeId: string, record: AgentRecord, tui: SharedPty, scan: ProgramStatusScan): void {
		if (record.tui !== tui) return;
		// Claude reports its status only to a terminal that says it can read it.
		if (scan.probe) tui.write(PROGRAM_STATUS_REPLY);
		const report = scan.reports.at(-1);
		if (!report) return;
		if (scan.reports.some((each) => each.state === 'working')) {
			record.tuiTurned = true;
			this.markStarted(runtimeId, record);
		}
		record.tuiState = report.state;
		record.tuiBlock = report.state === 'blocked' ? (report.kind ?? 'permission') : null;
		if (report.state === 'working' || report.state === 'blocked') record.finished = false;
		// "Done" lasts until a person looks; a tab looked at sees it at once.
		if (report.state === 'done') record.finished = ![...record.viewers].some((entry) => entry.looking);
		this.update(runtimeId, record);
	}

	private onTuiExit(
		runtimeId: string,
		record: AgentRecord,
		tui: SharedPty,
		info: { code: number | null; stopping: boolean; error: string },
	): void {
		this.live.delete(tui);
		if (record.tui !== tui) return;
		record.tui = null;
		record.tuiState = null;
		record.tuiBlock = null;
		record.finished = false;
		const output = tui.outputText();
		// Claude refused how it was started; once more the other way, for the tabs still there.
		const fallback =
			!info.stopping && !record.retried && !record.tuiTurned && !record.hold
				? startupFallback(record.spawnedWith, output)
				: null;
		if (fallback) {
			if (fallback === 'resume') record.stored.started = true;
			else delete record.stored.started;
			this.persist(runtimeId);
			for (const entry of record.viewers) entry.inner = null;
			if (record.viewers.size > 0) {
				this.startTuiOrClose(runtimeId, record, fallback);
				return;
			}
		}
		// A switch to the headless process lets the tabs it showed go, and
		// keeps the ones that attached during it: they wait for the switch.
		const toNative = record.switching === 'stream' && !record.hold;
		const reason = toNative ? MOVED_TO_NATIVE : info.stopping ? (record.hold?.reason ?? AGENT_STOPPED) : CLAUDE_QUIT;
		for (const entry of [...record.viewers]) {
			const attached = entry.inner !== null;
			entry.inner = null;
			if (toNative && !attached) continue;
			record.viewers.delete(entry);
			entry.viewer.closed(reason);
		}
		if (!record.switching) record.want = 'stream';
		if (!info.stopping && !fallback && info.code !== 0) {
			const last = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? info.error;
			this.host.notice(`Herdr: ${record.stored.name || 'Claude'} stopped: ${last.slice(0, 200)}`);
		}
		this.update(runtimeId, record);
	}

	private view(runtimeId: string, record: AgentRecord): ClaudeAgentView {
		if (record.tui) return this.tuiView(runtimeId, record);
		const first = record.pending.values().next();
		let request: PendingRequest | null = null;
		if (!first.done) {
			request = this.requestViews.get(first.value) ?? this.cardOf(record, first.value);
			this.requestViews.set(first.value, request);
			if (record.process?.isStopping) {
				const stopping = this.stoppingViews.get(first.value) ?? { ...request, stopping: true };
				this.stoppingViews.set(first.value, stopping);
				request = stopping;
			}
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
			mode: this.modeOf(record),
		};
	}

	/** The waiting card for a request: without grants on a row pinned to Allow once. */
	private cardOf(record: AgentRecord, request: ToolPermissionRequest): PendingRequest {
		const card = pendingRequestOf(request, record.settings);
		return record.stored.allowOnceOnly ? { ...card, session: null, project: null } : card;
	}

	/** An agent in its terminal view: the status Claude reported, no request (it is answered in the TUI). */
	private tuiView(runtimeId: string, record: AgentRecord): ClaudeAgentView {
		const status = this.statusOf(record);
		return {
			...record.stored,
			status,
			blockKind: status === 'blocked' ? (record.tuiBlock ?? 'permission') : null,
			request: null,
			statusSeq: record.statusSeq,
			started: record.stored.started === true,
			transcriptPath: this.transcriptFile(runtimeId, record),
			mode: this.modeOf(record),
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
