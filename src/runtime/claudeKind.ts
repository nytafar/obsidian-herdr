/**
 * The `claude` kind (ADR-0007): "Claude, run by Obsidian", the simple mode
 * that needs no multiplexer. Local only.
 *
 * - **Agents** are Claude Code processes the plugin starts itself, in
 *   stream-json mode over plain pipes (`../claude/process.ts`), one table of
 *   them for the plugin's lifetime (`../claude/agents.ts`). Their rows are
 *   stored in the plugin's data and come back **stopped** after a restart.
 * - **Connection.** There is no transport: discovery finds the `claude`
 *   binary (the override, else the usual directories and the login shell's
 *   PATH), the client answers at once and its one `connected` edge loads the
 *   stored rows into the scope (`../claude/scope.ts`).
 * - **Native view.** The session, status, block kind and the pending request
 *   come from the stream (`../claude/sessionWatcher.ts`); content is this
 *   machine's transcript files, as for a local herdr (ADR-0003). Prompts and
 *   the interrupt go to the process's stdin, and the waiting card answers
 *   permissions, questions and plans with a `control_response`.
 * - **Terminal view** (ADR-0007's D2, the recorded exception to "not a
 *   PTY"): Claude's own TUI on a pty from `script(1)` under a POSIX `sh`
 *   fd-3 watchdog (`../claude/pty.ts`), one process per agent, headless or
 *   TUI, switched between turns (`../claude/viewSwitch.ts`). A tab is a
 *   {@link ClaudeTerminalSession} attached to the agent's TUI, which outlives
 *   the tab. Linux only: off on macOS until its written path is verified
 *   there ({@link CLAUDE_TERMINAL_UNVERIFIED}), none on Windows.
 * - **Shell tabs** (ADR-0008): a plain shell in a folder on the same pty, a
 *   tab and not a row (`../claude/shells.ts`), with an optional command run
 *   first.
 * - **Lifecycle.** Unload stops every process and shell (`dispose`). A
 *   runtime switch does not: the processes are the table's, and the rows
 *   come back live.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { PlatformPath } from 'node:path';
import type { ConnectionTunnel } from '../connection';
import { expandHome, resolveHerdrBinary, type DiscoveryResult } from '../herdr/binary';
import { ClaudeActions } from '../claude/actions';
import { ALLOW_ONCE_NO_TERMINAL, ClaudeAgents, type ClaudeQuestion, type StoredClaudeSession } from '../claude/agents';
import type { ClaudeSpawn, ClaudeTimers } from '../claude/process';
import {
	defaultPtySpawn,
	defaultPtyTools,
	ptyPlatformOf,
	type PtyPlatform,
	type PtySpawn,
	type PtyTools,
} from '../claude/pty';
import { ClaudeShells, isShellId } from '../claude/shells';
import { ClaudeTerminalSession } from '../claude/terminalSession';
import { ClaudeClient, ClaudeScope, NoTabLabels } from '../claude/scope';
import { localSettingsTarget, nodeProjectRootEnv, type LocalSettingsTarget } from '../claude/projectRoot';
import { claudeSessionWatcher } from '../claude/sessionWatcher';
import { NO_CONNECTION_MESSAGE } from '../native/promptSender';
import type { SessionWatcher } from '../native/sessionWatcher';
import { LocalTranscriptSource } from '../native/transcriptSource';
import { CLAUDE_PERMISSION_MODE_LABELS, normalizePermissionMode } from '../runtimes';
import { clearTimer, setTimer } from '../timers';
import { CLAUDE_CAPABILITIES, type RuntimeKindAdapter, type StatusLine } from './kind';

/** Why a `claude` tab has no terminal view on Windows: no `script(1)`, and ConPTY needs native code. */
export const CLAUDE_TERMINAL_UNAVAILABLE = 'not available on Windows, which has no script(1)';

/** Why it has none on macOS yet (ADR-0007: "on macOS once verified"). */
export const CLAUDE_TERMINAL_UNVERIFIED =
	'not available on macOS yet: its script(1) path is written but not verified there';

/** Why a machine without a pty has no terminal view. */
export function claudeTerminalUnavailable(platform: NodeJS.Platform): string {
	return platform === 'darwin' ? CLAUDE_TERMINAL_UNVERIFIED : CLAUDE_TERMINAL_UNAVAILABLE;
}

/** Why a shell tab has no native view. */
export const SHELL_NO_NATIVE = 'a shell has no agent session';

/** What a local runtime says when no `claude` can be found. */
const CLAUDE_NOT_FOUND =
	'claude was not found in /opt/homebrew/bin, /usr/local/bin, ~/.local/bin or the login shell PATH';

/**
 * Variables a parent Claude Code or herdr pane sets for its children. An
 * Obsidian started from one of those would hand them on, and a Claude that
 * sees them takes itself for a nested session or reports into a herdr pane
 * that is not its own. Configuration a user sets (`CLAUDE_CODE_USE_BEDROCK`
 * and the like) is kept.
 */
export const INHERITED_SESSION_VARIABLES: readonly string[] = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	'CLAUDE_CODE_SESSION_ATTENDED',
	'CLAUDE_CODE_MESSAGING_SOCKET',
	'CLAUDE_CODE_MESSAGING_TOKEN',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_PID',
	'HERDR_ENV',
	'HERDR_PANE_ID',
	'HERDR_TAB_ID',
	'HERDR_WORKSPACE_ID',
];

/**
 * The environment an agent starts with: the given one, its binary's folder on
 * PATH, no inherited session. `paths` is the platform's (`node:path`; tests
 * pass `win32`): an absolute binary by its rules, PATH split on its
 * delimiter, and on Windows the one PATH variable whatever its case (`Path`
 * there), since a copied environment is no longer case-insensitive.
 */
export function claudeEnv(
	base: NodeJS.ProcessEnv,
	binary: string,
	paths: Pick<PlatformPath, 'isAbsolute' | 'dirname' | 'delimiter'> = nodePath,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of INHERITED_SESSION_VARIABLES) delete env[name];
	if (paths.isAbsolute(binary)) {
		const windows = paths.delimiter === ';';
		const key = (windows ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : undefined) ?? 'PATH';
		const dir = paths.dirname(binary);
		const parts = (env[key] ?? '').split(paths.delimiter).filter(Boolean);
		if (!parts.includes(dir)) env[key] = [dir, ...parts].join(paths.delimiter);
	}
	return env;
}

/** `child_process.spawn`, never through a shell. */
export const defaultClaudeSpawn: ClaudeSpawn = (argv, options) => {
	const [command, ...args] = argv;
	if (!command) throw new Error('no claude binary');
	return nodeSpawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
};

const DEFAULT_TIMERS: ClaudeTimers = {
	setTimeout: (handler, ms) => setTimer(handler, ms),
	clearTimeout: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

export interface ClaudeKindHost {
	/** Colon-separated PATH additions from the settings, read per attempt. */
	extraPath(): string;
	/** The environment agents start from (PATH widened by the settings). */
	spawnEnv(): NodeJS.ProcessEnv;
	/** This vault's absolute path, the scope's id. */
	vaultPath(): string;
	/** The stored rows of a runtime, and how they are written back. */
	loadSessions(runtimeId: string): StoredClaudeSession[];
	saveSessions(runtimeId: string, sessions: StoredClaudeSession[]): void;
	notice(message: string): void;
	/** Injected in tests and probes; the real ones otherwise. */
	spawn?: ClaudeSpawn;
	timers?: ClaudeTimers;
	exists?: (path: string) => boolean;
	extraArgs?: () => readonly string[];
	home?: string;
	/** Where Claude writes a project rule for a cwd; the real resolution (`../claude/projectRoot.ts`) otherwise. */
	localSettings?: (cwd: string) => LocalSettingsTarget | null;
	/** Skips the login shell in discovery (tests). */
	skipLoginShell?: boolean;
	/** This machine's platform; `process.platform` otherwise. */
	platform?: NodeJS.Platform;
	/**
	 * The pty's platform (null: none), spawn and tools; the real ones
	 * otherwise, which is none on Windows and, until verified, on macOS.
	 */
	ptyPlatform?: PtyPlatform | null;
	ptySpawn?: PtySpawn;
	ptyTools?: PtyTools;
	/** The replay buffer's bound, for tests. */
	replayLimit?: number;
	/**
	 * Asks the user a yes-or-no question (a modal); absent, every answer is
	 * no. Asked before a TUI that reports no status is stopped.
	 */
	confirm?: (question: ClaudeQuestion) => Promise<boolean>;
}

export type ClaudeKind = RuntimeKindAdapter<ClaudeClient, ClaudeScope, ConnectionTunnel> & {
	/** The agent table, for unload and for pruning removed runtimes. */
	readonly agents: ClaudeAgents;
	/** Shell tabs; null where there is no pty (Windows). */
	readonly shells: ClaudeShells | null;
	/** Stops every process: the plugin is unloading. */
	dispose(): Promise<void>;
};

function discovery(binary: DiscoveryResult['binary'], error: string | null): DiscoveryResult {
	return { binary, status: null, identity: null, socketPath: '', error };
}

/** A row id: `cl-` and eight base-36 digits, unused in `taken`. */
export function newClaudeAgentId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		const id = `cl-${Math.floor(random() * 36 ** 8)
			.toString(36)
			.padStart(8, '0')}`;
		if (!taken.has(id)) return id;
	}
}

export function createClaudeKind(host: ClaudeKindHost): ClaudeKind {
	const os = host.platform ?? process.platform;
	const platform = host.ptyPlatform === undefined ? ptyPlatformOf(os) : host.ptyPlatform;
	const terminalUnavailable = platform ? null : claudeTerminalUnavailable(os);
	const timers = host.timers ?? DEFAULT_TIMERS;
	const pty = platform
		? {
				platform,
				spawn: host.ptySpawn ?? defaultPtySpawn,
				tools: host.ptyTools ?? defaultPtyTools(platform),
				...(host.replayLimit ? { replayLimit: host.replayLimit } : {}),
			}
		: null;
	const agents = new ClaudeAgents({
		load: (runtimeId) => host.loadSessions(runtimeId),
		save: (runtimeId, sessions) => host.saveSessions(runtimeId, sessions),
		env: (binary) => claudeEnv(host.spawnEnv(), binary),
		exists: host.exists ?? ((path) => existsSync(path)),
		realpath: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return path;
			}
		},
		notice: (message) => host.notice(message),
		newSessionId: () => randomUUID(),
		newAgentId: (taken) => newClaudeAgentId(taken),
		spawn: host.spawn ?? defaultClaudeSpawn,
		timers,
		extraArgs: host.extraArgs,
		home: host.home,
		localSettings:
			host.localSettings ??
			((cwd) => localSettingsTarget(cwd, { ...nodeProjectRootEnv(), ...(host.home ? { home: host.home } : {}) })),
		...(pty ? { pty } : {}),
		...(host.confirm ? { confirm: host.confirm } : {}),
	});
	// A shell is no Claude session either: the same inherited variables go.
	const shells = pty ? new ClaudeShells({ ...pty, timers, env: () => claudeEnv(host.spawnEnv(), '') }) : null;
	const localTranscripts = new LocalTranscriptSource();
	const watchers = new WeakMap<ClaudeScope, SessionWatcher>();
	const refuse = (): Error => new Error(`The terminal view is ${terminalUnavailable ?? CLAUDE_TERMINAL_UNAVAILABLE}.`);
	return {
		kind: 'claude',
		agents,
		shells,
		dispose: async () => {
			await Promise.all([agents.stopAll(), shells?.stopAll()]);
		},
		unavailable: null,
		terminalUnavailable,
		capabilities: pty ? CLAUDE_CAPABILITIES : { ...CLAUDE_CAPABILITIES, shells: false },
		nativeUnavailable: null,
		native: {
			transcriptAccess: () => 'local',
			watcher: (connection) => {
				const scope = connection.scope;
				let watcher = watchers.get(scope);
				if (!watcher) {
					watcher = claudeSessionWatcher(agents, connection.endpoint.runtime.id);
					watchers.set(scope, watcher);
				}
				return watcher;
			},
			// This machine's files: readable whichever runtime is active.
			transcripts: () => localTranscripts,
		},
		connection: {
			discover: async (endpoint) => {
				const runtime = endpoint.runtime;
				const binary = await resolveHerdrBinary({
					override: runtime.binary,
					extraPath: host.extraPath(),
					binaryName: 'claude',
					skipLoginShell: host.skipLoginShell,
				});
				if (binary) return discovery(binary, null);
				return discovery(
					null,
					runtime.binary.trim() ? `claude is not executable at ${runtime.binary.trim()}` : CLAUDE_NOT_FOUND,
				);
			},
			discoveryIssue: (_endpoint, found) => (found.binary ? null : (found.error ?? 'claude binary not found')),
			createTunnel: () => null,
			createClient: (_socketPath, endpoint, found) =>
				new ClaudeClient(agents, endpoint.runtime.id, {
					binary: found.binary?.path ?? expandHome(endpoint.runtime.binary || 'claude'),
					permissionMode: normalizePermissionMode(endpoint.runtime.permissionMode),
				}),
			createScope: (endpoint, client) => {
				const scope = new ClaudeScope(agents, endpoint.runtime.id, host.vaultPath());
				client.onDispose(() => scope.dispose());
				return scope;
			},
			prime: (_client, scope, retired) => {
				if (!retired()) scope.load();
				return Promise.resolve();
			},
			start: (client) => client.start(),
		},
		// Nothing to find: the session attaches to a pty the plugin keeps, and
		// the agent table knows the runtime's binary.
		terminalCommand: () => {
			if (!pty) throw refuse();
			return ['script'];
		},
		createTerminalSession: (options, endpoint) => {
			if (!pty) throw refuse();
			const runtimeId = endpoint.runtime.id;
			return new ClaudeTerminalSession(options, (target, viewer, how) => {
				if (isShellId(target)) {
					if (!shells) throw refuse();
					return shells.attach(target, viewer);
				}
				return agents.openTerminal(runtimeId, target, viewer, how);
			});
		},
		paneNativeReason: (paneId) => (isShellId(paneId) ? SHELL_NO_NATIVE : null),
		paneTerminalReason: (endpoint, paneId) =>
			agents.get(endpoint.runtime.id, paneId)?.allowOnceOnly ? ALLOW_ONCE_NO_TERMINAL : null,
		paneTitle: (paneId) => {
			const cwd = isShellId(paneId) ? shells?.cwd(paneId) : null;
			return cwd ? `Shell: ${nodePath.basename(cwd) || cwd}` : null;
		},
		terminalReleased: (_endpoint, paneId) => {
			// An agent's TUI stays for the next tab; a shell has no other way back.
			if (isShellId(paneId)) void shells?.close(paneId);
		},
		paneViewChosen: (endpoint, paneId, view) => {
			if (view === 'native' && !isShellId(paneId)) agents.useNative(endpoint.runtime.id, paneId);
		},
		createActions: (actionHost) => new ClaudeActions(actionHost, agents, shells),
		promptSender: (client) => ({
			// Images go as stream-json image blocks (#144); the TUI, when it
			// is up, hands the prompt to the headless process like any other.
			async send(paneId, text, images = []) {
				const connected = client();
				if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
				await connected.request('agent.prompt', {
					target: paneId,
					text,
					...(images.length ? { images: [...images] } : {}),
				});
			},
			imagesUnavailable: () => null,
			async interrupt(paneId) {
				const connected = client();
				if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
				await connected.request('agent.interrupt', { target: paneId });
			},
		}),
		// Nothing here is a terminal to press keys in; the card answers requests instead.
		keySender: () => ({ sendKeys: () => Promise.reject(refuse()) }),
		responder: (client) => ({
			async respond(paneId, requestId, answer) {
				const connected = client();
				if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
				await connected.request('agent.respond', { target: paneId, request: requestId, answer });
			},
		}),
		createTabLabels: () => new NoTabLabels(),
		statusLines: (connection) => (connection ? claudeStatusLines(connection, terminalUnavailable) : null),
	};
}

/** The settings tab's status for a `claude` runtime. */
export function claudeStatusLines(
	connection: {
		client: Pick<ClaudeClient, 'setup'>;
		scope: Pick<ClaudeScope, 'size' | 'running'>;
	},
	/** Why there is no terminal view here; null where there is one. */
	terminalUnavailable: string | null = null,
): StatusLine[] {
	const { setup } = connection.client;
	const { size, running } = connection.scope;
	return [
		{ text: `Claude: ${setup.binary}` },
		{ text: `Permission mode: ${CLAUDE_PERMISSION_MODE_LABELS[setup.permissionMode]}` },
		{ text: `Agents: ${running} running, ${size - running} stopped` },
		{
			text:
				terminalUnavailable === null
					? "Terminal view: Claude's own TUI on a pty from script(1)."
					: `Terminal view: ${terminalUnavailable}; agents open in the native view.`,
		},
	];
}
