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
 * - **Terminal view.** None in this version: it needs `script(1)` (ADR-0007's
 *   D2), so the tab says why and stays native.
 * - **Lifecycle.** Unload stops every process (`dispose`). A runtime switch
 *   does not: the processes are the table's, and the rows come back live.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectionTunnel } from '../connection';
import { expandHome, resolveHerdrBinary, type DiscoveryResult } from '../herdr/binary';
import { ClaudeActions } from '../claude/actions';
import { ClaudeAgents, type StoredClaudeSession } from '../claude/agents';
import type { ClaudeSpawn, ClaudeTimers } from '../claude/process';
import { ClaudeClient, ClaudeScope, NoTabLabels } from '../claude/scope';
import { claudeSessionWatcher } from '../claude/sessionWatcher';
import { NO_CONNECTION_MESSAGE } from '../native/promptSender';
import type { SessionWatcher } from '../native/sessionWatcher';
import { LocalTranscriptSource } from '../native/transcriptSource';
import { CLAUDE_PERMISSION_MODE_LABELS, normalizePermissionMode } from '../runtimes';
import { clearTimer, setTimer } from '../timers';
import { CLAUDE_CAPABILITIES, type RuntimeKindAdapter, type StatusLine } from './kind';

/** Why a `claude` agent's tab has no terminal view in this version. */
export const CLAUDE_TERMINAL_UNAVAILABLE = 'not available yet for Claude run by Obsidian';

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

/** The environment an agent starts with: the given one, its binary's folder on PATH, no inherited session. */
export function claudeEnv(base: NodeJS.ProcessEnv, binary: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of INHERITED_SESSION_VARIABLES) delete env[name];
	if (binary.startsWith('/')) {
		const dir = dirname(binary);
		const parts = (env.PATH ?? '').split(':').filter(Boolean);
		if (!parts.includes(dir)) env.PATH = [dir, ...parts].join(':');
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
	/** Skips the login shell in discovery (tests). */
	skipLoginShell?: boolean;
}

export type ClaudeKind = RuntimeKindAdapter<ClaudeClient, ClaudeScope, ConnectionTunnel> & {
	/** The agent table, for unload and for pruning removed runtimes. */
	readonly agents: ClaudeAgents;
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
	const agents = new ClaudeAgents({
		load: (runtimeId) => host.loadSessions(runtimeId),
		save: (runtimeId, sessions) => host.saveSessions(runtimeId, sessions),
		env: (binary) => claudeEnv(host.spawnEnv(), binary),
		exists: host.exists ?? ((path) => existsSync(path)),
		notice: (message) => host.notice(message),
		newSessionId: () => randomUUID(),
		newAgentId: (taken) => newClaudeAgentId(taken),
		spawn: host.spawn ?? defaultClaudeSpawn,
		timers: host.timers ?? DEFAULT_TIMERS,
		extraArgs: host.extraArgs,
		home: host.home,
	});
	const localTranscripts = new LocalTranscriptSource();
	const watchers = new WeakMap<ClaudeScope, SessionWatcher>();
	const refuse = (): Error => new Error(`The terminal view is ${CLAUDE_TERMINAL_UNAVAILABLE}.`);
	return {
		kind: 'claude',
		agents,
		dispose: () => agents.stopAll(),
		unavailable: null,
		terminalUnavailable: CLAUDE_TERMINAL_UNAVAILABLE,
		capabilities: CLAUDE_CAPABILITIES,
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
		terminalCommand: () => {
			throw refuse();
		},
		createTerminalSession: () => {
			throw refuse();
		},
		createActions: (actionHost) => new ClaudeActions(actionHost, agents),
		promptSender: (client) => ({
			async send(paneId, text) {
				const connected = client();
				if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
				await connected.request('agent.prompt', { target: paneId, text });
			},
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
		statusLines: (connection) => (connection ? claudeStatusLines(connection) : null),
	};
}

/** The settings tab's status for a `claude` runtime. */
export function claudeStatusLines(connection: {
	client: Pick<ClaudeClient, 'setup'>;
	scope: Pick<ClaudeScope, 'size' | 'running'>;
}): StatusLine[] {
	const { setup } = connection.client;
	const { size, running } = connection.scope;
	return [
		{ text: `Claude: ${setup.binary}` },
		{ text: `Permission mode: ${CLAUDE_PERMISSION_MODE_LABELS[setup.permissionMode]}` },
		{ text: `Agents: ${running} running, ${size - running} stopped` },
		{ text: `Terminal view: ${CLAUDE_TERMINAL_UNAVAILABLE}; agents open in the native view.` },
	];
}
