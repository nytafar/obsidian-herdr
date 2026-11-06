/**
 * The runtime kind seam (ADR-0004, ADR-0005).
 *
 * A runtime is a kind on a target (`runtimes.ts`). Everything that differs by
 * kind goes through one {@link RuntimeKindAdapter}: how a connection is
 * opened (transport, client, scope), how a terminal tab reaches a pane, what
 * the folder and row actions send, how the native view's prompt box delivers
 * text, and which of those exist at all. The plugin holds one adapter per kind
 * and asks the one of the runtime in question; nothing outside an adapter
 * decides by kind or by target.
 *
 * The native view's inputs come through the same seam: a kind with a native
 * view supplies a {@link NativeSessionAdapter} — a session watcher per live
 * connection and a transcript source per target — and the session models
 * never learn which kind they read (ADR-0006).
 *
 * The herdr kind is `herdrKind.ts`, today's code behind this interface. The
 * herdr-core kind is `herdrCoreKind.ts`: its agent list, actions, senders and
 * terminal tabs run over `hc connect`. The `claude` kind is `claudeKind.ts`:
 * Claude Code processes the plugin starts itself, over pipes, with no
 * multiplexer at all (ADR-0007). {@link unavailableKind} remains for a
 * kind a build lists but cannot run at all.
 *
 * Features one kind lacks are capabilities, not errors (ADR-0004): the UI
 * reads {@link RuntimeCapabilities} and leaves out what a kind cannot do.
 */

import type { ActionHost } from '../actions';
import type { TerminalSessionOptions } from '../bridge/terminalSession';
import type {
	Connection,
	ConnectionClient,
	ConnectionDriver,
	ConnectionScope,
	ConnectionTunnel,
	Endpoint,
} from '../connection';
import type { KeySender, PromptClient, PromptSender } from '../native/promptSender';
import type { WaitingResponder } from '../native/pendingRequest';
import type { SessionWatcher } from '../native/sessionWatcher';
import type { TranscriptSource } from '../native/transcriptSource';
import type { CommandCatalogSource } from '../native/commandCatalog';
import type { PaneSession } from '../views/paneTerminal';
import type { RuntimeKind } from '../runtimes';
import type { TabLabels } from '../tabLabels';
import type { AgentProbe } from '../agents/catalog';

/**
 * What a runtime of a kind can do, as the UI asks it. herdr has all of it;
 * herdr-core has no tabs, splits, rename or pane focus (ADR-0005), and its
 * native view needs the Claude session hook per terminal (ADR-0006).
 */
export interface RuntimeCapabilities {
	/** "New tab here", and tab labels for grouping. */
	tabs: boolean;
	/** "Split here". */
	splits: boolean;
	/** "Start agent here", from the folder menus and the list toolbar. */
	startAgent: boolean;
	/** "Rename agent" in the row menu. */
	rename: boolean;
	/** Focusing the pane in the runtime's own UI from a row. */
	focus: boolean;
	/** "Terminate agent" in the row menu. */
	close: boolean;
	/**
	 * Pins live on the runtime, shared with its other clients (herdr-core's
	 * `herdr.pinned` label, ADR-0005), rather than in this plugin's settings.
	 */
	sharedPins: boolean;
	/**
	 * Agents are the plugin's own processes, and a row outlives its process
	 * as a stopped, resumable session (the `claude` kind, ADR-0007): the row
	 * menu offers "Stop agent" for a running row, "Forget agent" for a
	 * stopped one, and graduation to a multiplexer runtime.
	 */
	resumable: boolean;
	/**
	 * "Open shell here": a plain shell in a terminal tab, not an agent (the
	 * `claude` kind's pty, ADR-0007's D2 and ADR-0008).
	 */
	shells: boolean;
	/**
	 * The native view, which follows the agent session the kind reports. A
	 * kind that has it supplies {@link RuntimeKindAdapter.native}, which also
	 * says on which targets its transcripts can be read (ADR-0002, ADR-0006).
	 */
	nativeView: boolean;
}

export const HERDR_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
	tabs: true,
	splits: true,
	startAgent: true,
	rename: true,
	focus: true,
	close: true,
	sharedPins: false,
	resumable: false,
	shells: false,
	nativeView: true,
});

/**
 * ADR-0005's mapping: start and close exist, the rest has no hc method. The
 * native view follows the session label the Claude hook writes (ADR-0006).
 */
export const HERDR_CORE_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
	tabs: false,
	splits: false,
	startAgent: true,
	rename: false,
	focus: false,
	close: true,
	sharedPins: true,
	resumable: false,
	shells: false,
	nativeView: true,
});

/**
 * ADR-0007's `claude` kind: agents are started and stopped, nothing else. No
 * tabs, splits or focus exist without a multiplexer, and a rename would only
 * rename a stored row, so it is left out with the rest.
 */
export const CLAUDE_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
	tabs: false,
	splits: false,
	startAgent: true,
	rename: false,
	focus: false,
	close: true,
	sharedPins: false,
	resumable: true,
	shells: true,
	nativeView: true,
});

/**
 * How far a runtime's report of an agent's session can be trusted (#137,
 * ADR-0010):
 *
 * - `trusted` — the session the runtime puts on a pane is that pane's agent's.
 * - `hint` — the runtime reports one, but it may belong to another pane: herdr
 *   hears Codex's session from a hook that runs in Codex's shared daemon and
 *   reports to the pane that started the daemon (finding `agent-codex`), and
 *   nothing tells such a report from a right one.
 * - `absent` — the runtime reports no session for that agent at all.
 *
 * The native view is offered only on a trusted binding: a hint would show
 * another pane's conversation as this one's.
 */
export type SessionBinding = 'trusted' | 'hint' | 'absent';

/**
 * Each kind's session bindings, by the agent catalog's ids; an agent not
 * listed is `absent`, since nothing measured says its sessions can be taken.
 *
 * - **herdr** reports Claude's session from Claude's own `SessionStart` hook,
 *   per pane; Codex's only correctly under `--no-daemon`, which herdr cannot
 *   tell apart (measured 2026-11-06, `docs/architecture.md`, "A second agent:
 *   Codex").
 * - **herdr-core** has the plugin's Claude session hook label (ADR-0006) and
 *   nothing for any other agent.
 * - **claude** runs Claude and holds its session itself (ADR-0007).
 */
export const AGENT_SESSIONS: Readonly<Record<RuntimeKind, Readonly<Record<string, SessionBinding>>>> = Object.freeze({
	herdr: Object.freeze({ claude: 'trusted', codex: 'hint' }),
	'herdr-core': Object.freeze({ claude: 'trusted' }),
	claude: Object.freeze({ claude: 'trusted' }),
});

/** How far a runtime of `kind` can be trusted on `agent`'s session. */
export function sessionBinding(kind: RuntimeKind, agent: string): SessionBinding {
	return AGENT_SESSIONS[kind]?.[agent] ?? 'absent';
}

/** Why the native view is not offered for a kind without agent sessions. */
export const NATIVE_NO_SESSION_REASON = 'no agent session for this runtime kind';

/**
 * Why the native view is not offered for a runtime whose kind has one but
 * cannot reach its transcripts from here, on a target that is not remote.
 * The remote case has its own reason (`NATIVE_REMOTE_REASON`).
 */
export const NATIVE_NO_TRANSCRIPT_REASON = 'transcripts not readable here';

/**
 * How a runtime's transcripts are reached: `local`, files on this machine; or
 * `rpc`, over the runtime's own connection (herdr-core's `file.read`,
 * ADR-0006).
 */
export type TranscriptAccess = 'local' | 'rpc';

/**
 * What the native view reads of a runtime kind (ADR-0003, ADR-0006). The
 * session models ask for it per runtime, and never for another runtime's on
 * its behalf.
 */
export interface NativeSessionAdapter<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	/**
	 * How this endpoint's transcripts are reached, or null when they cannot be
	 * from this machine, which rules the native view out on that endpoint
	 * whatever the capability says (herdr over SSH).
	 */
	transcriptAccess(endpoint: Endpoint): TranscriptAccess | null;
	/**
	 * The session watcher over one live connection of this kind, or null when
	 * this connection cannot back one. Called again for every new connection;
	 * the plugin keeps one per connection.
	 */
	watcher(connection: Connection<C, S, T>): SessionWatcher | null;
	/**
	 * Where this endpoint's transcripts are read, or null while they cannot be.
	 * `connection` is the published connection when it is this endpoint's,
	 * else null: a `local` source needs none and stays readable while another
	 * runtime is active, an `rpc` one has nothing to read through without it.
	 * Return the same object for as long as it stays usable, since a session
	 * model reopens its tail whenever the source it is given changes.
	 */
	transcripts(endpoint: Endpoint, connection: Connection<C, S, T> | null): TranscriptSource | null;
	/**
	 * Where the prompt box's `/` list is read for this endpoint (#98): the
	 * machine the agent runs on. Not given, or null, is this machine's files,
	 * read synchronously; an `rpc` endpoint gives a source over `connection`
	 * (the same rule as {@link transcripts}), or the built-ins without one,
	 * never this machine's commands.
	 */
	commandCatalog?(endpoint: Endpoint, connection: Connection<C, S, T> | null): CommandCatalogSource | null;
}

/** What every use of a herdr-core runtime said before its kind landed. */
export const HERDR_CORE_UNAVAILABLE =
	'herdr-core runtimes are not available in this version of the plugin yet';

/** One line of the settings tab's connection status. */
export interface StatusLine {
	text: string;
	warning?: boolean;
}

/**
 * The folder and row actions, as the plugin calls them. herdr's are
 * `HerdrActions` (`actions.ts`); results are the kind's own and only the two
 * booleans are read by callers.
 */
export interface RuntimeActions {
	newTabHere(folderAbsPath: string): Promise<unknown>;
	splitHere(folderAbsPath: string): Promise<unknown>;
	/**
	 * Starts an agent in the folder. `options` is how graduation (ADR-0007)
	 * starts `claude --resume <id>` there: the kind to start instead of the
	 * default one, and arguments after its program. Without it, the default
	 * agent kind with no arguments, as from the menus.
	 */
	startAgentHere(folderAbsPath: string, options?: StartAgentOptions): Promise<unknown>;
	/** True when the pane is gone, so the caller drops its row and tabs. */
	closePane(paneId: string, endpointId: string): Promise<boolean>;
	renameAgent(paneId: string, name: string): Promise<unknown>;
	/** True when the runtime focused the pane. */
	focusPane(paneId: string): Promise<boolean>;
	/**
	 * Pins or unpins on the runtime; only for a kind with
	 * {@link RuntimeCapabilities.sharedPins}. True when the runtime took it.
	 */
	setPinned?(paneId: string, pinned: boolean): Promise<boolean>;
	/**
	 * Gets a row's agent ready to be opened, for a kind whose rows can be
	 * stopped (`claude`: spawns a stopped one with `--resume`). Absent where a
	 * row is always a live pane.
	 */
	resumeAgent?(paneId: string): Promise<void>;
	/** Removes a stopped row for good; only a kind whose rows can be stopped. */
	forgetAgent?(paneId: string, endpointId: string): Promise<boolean>;
	/**
	 * What graduating a row needs (ADR-0007): its cwd and session, after its
	 * process has stopped, and the permission mode it ran in. Null when the
	 * row has no conversation to continue.
	 */
	releaseForGraduation?(paneId: string): Promise<GraduationRelease | null>;
	/**
	 * A plain shell in the folder, in a terminal tab (the `claude` kind's
	 * pty, ADR-0008); `command` runs first, in plain view. Resolves to the
	 * shell's pane id, or null when it could not be opened. Only a kind with
	 * {@link RuntimeCapabilities.shells}.
	 */
	openShellHere?(folderAbsPath: string, command?: string): Promise<string | null>;
}

/** A row handed to another runtime (ADR-0007). */
export interface GraduationRelease {
	cwd: string;
	sessionId: string;
	/** The `--permission-mode` the row ran with, so the new pane keeps it; absent for none. */
	permissionMode?: string;
}

/**
 * The agent `startAgentHere` starts, when it is not the runtime's default
 * (`agents/catalog.ts`'s `launchOf` builds one per catalog entry).
 */
export interface StartAgentOptions {
	/** herdr's agent kind (`claude`), instead of the runtime's default. */
	kind?: string;
	/**
	 * The program to run instead of the kind's own (a user's wrapper). Only
	 * herdr-core can: herdr's `agent.start` runs the kind's own program.
	 */
	command?: string;
	/** Arguments after the agent's program, e.g. `['--resume', '<id>']`. */
	args?: readonly string[];
	/** An hc template to run instead of a program (herdr-core only). */
	template?: string;
	/** What the notice calls the agent; the kind when absent. */
	label?: string;
}

/**
 * One runtime kind. `C`, `S` and `T` are the client, scope and transport its
 * connection driver builds; the plugin's coordinator is typed on them.
 */
export interface RuntimeKindAdapter<
	C extends ConnectionClient = ConnectionClient,
	S extends ConnectionScope = ConnectionScope,
	T extends ConnectionTunnel = ConnectionTunnel,
> {
	readonly kind: RuntimeKind;
	/**
	 * Null when runtimes of this kind can be used; otherwise the clause every
	 * use reports (settings, the agent list, a connect attempt, a terminal).
	 */
	readonly unavailable: string | null;
	/**
	 * Why a terminal tab on this kind cannot start, whatever the connection
	 * does, or null when it can. The tab shows it at once instead of waiting
	 * for a connection (a kind this build cannot run).
	 */
	readonly terminalUnavailable: string | null;
	readonly capabilities: Readonly<RuntimeCapabilities>;
	/**
	 * Why the kind itself rules the native view out, whatever the target, or
	 * null when only the target decides.
	 */
	readonly nativeUnavailable: string | null;
	/**
	 * The native view's watcher and transcript source; null for a kind with no
	 * native view (`capabilities.nativeView` false).
	 */
	readonly native: NativeSessionAdapter<C, S, T> | null;
	/** Transport, client and scope for one connection attempt; null while unavailable. */
	readonly connection: ConnectionDriver<C, S, T> | null;
	/**
	 * The argv a terminal tab's bridge starts with on this endpoint. Throws a
	 * readable error when it cannot be built yet (no binary found, no host);
	 * the tab shows it and retries once a connection arrives.
	 */
	terminalCommand(endpoint: Endpoint): string[];
	/** The bridge process for one terminal tab, from the argv above. */
	createTerminalSession(options: TerminalSessionOptions, endpoint: Endpoint): PaneSession;
	/**
	 * Why a pane of this kind has no native view though the kind has one, or
	 * null: a `claude` shell tab, which is no agent.
	 */
	paneNativeReason?(paneId: string): string | null;
	/**
	 * Why a pane of this kind has no terminal view though the kind has one,
	 * or null: a `claude` agent pinned to Allow once (ADR-0008's installer),
	 * whose terminal dialog could save a lasting rule. Its tabs show the
	 * native view instead.
	 */
	paneTerminalReason?(endpoint: Endpoint, paneId: string): string | null;
	/** A tab title for a pane no scope lists (a `claude` shell tab), or null. */
	paneTitle?(paneId: string): string | null;
	/**
	 * The last terminal tab showing this pane closed. The `claude` kind ends a
	 * shell then; an agent's TUI keeps running for the next tab.
	 */
	terminalReleased?(endpoint: Endpoint, paneId: string): void;
	/**
	 * A tab switched its pane to a view (ADR-0007's D2): the `claude` kind
	 * moves an agent switched to the native view back to a headless process
	 * once its turn is over. A switch to the terminal needs no call: the
	 * terminal that attaches asks for the TUI itself.
	 */
	paneViewChosen?(endpoint: Endpoint, paneId: string, view: 'native' | 'terminal'): void;
	/** Folder and row actions over the plugin's action host. */
	createActions(host: ActionHost): RuntimeActions;
	/**
	 * Which of these programs exist on the machine this connection's agents
	 * run on, for the agent catalog (issue #125): asked once per connection
	 * (`agents/catalogs.ts`). Absent for a kind whose catalog needs no probe
	 * (the `claude` kind starts Claude only). Never expected to reject.
	 */
	probeAgents?(connection: Connection<C, S, T>, programs: readonly string[]): Promise<AgentProbe>;
	/** The native view's prompt box, over the client of the tab's runtime. */
	promptSender(client: () => PromptClient | null): PromptSender;
	/** The waiting card's key presses, over the same client. */
	keySender(client: () => PromptClient | null): KeySender;
	/**
	 * The waiting card's answers to a request the runtime itself is waiting
	 * on, over the same client; only a kind that reports such requests
	 * (`PaneSnapshot.request`, ADR-0007) has one.
	 */
	responder?(client: () => PromptClient | null): WaitingResponder;
	/**
	 * The tab labels views on this connection read, built once per connection.
	 * `alive()` is true while that connection is the published one.
	 */
	createTabLabels(connection: Connection<C, S, T>, alive: () => boolean): TabLabels;
	/**
	 * The settings tab's status lines for this kind, below the runtime line, or
	 * null for the herdr layout (binary, socket, server, workspace).
	 */
	statusLines(connection: Connection<C, S, T> | null): StatusLine[] | null;
}

/**
 * A kind this build lists but cannot run yet. Its runtimes can be added and
 * selected; connecting fails at once with {@link unavailable}, a terminal tab
 * shows it, and an action that slips past the capabilities says it instead
 * of sending anything.
 */
export function unavailableKind(
	kind: RuntimeKind,
	reason: string,
	capabilities: Readonly<RuntimeCapabilities>,
	nativeUnavailable: string | null,
): RuntimeKindAdapter<never, never, never> {
	const refuse = (): Error => new Error(reason);
	return {
		kind,
		unavailable: reason,
		terminalUnavailable: reason,
		capabilities,
		nativeUnavailable,
		native: null,
		connection: null,
		terminalCommand: () => {
			throw refuse();
		},
		createTerminalSession: () => {
			throw refuse();
		},
		createActions: (host) => {
			const say = (): void => host.notice(`Gjetr: ${reason}.`);
			return {
				newTabHere: () => Promise.resolve(say()),
				splitHere: () => Promise.resolve(say()),
				startAgentHere: () => Promise.resolve(say()),
				closePane: () => {
					say();
					return Promise.resolve(false);
				},
				renameAgent: () => Promise.resolve(say()),
				focusPane: () => {
					say();
					return Promise.resolve(false);
				},
			};
		},
		promptSender: () => ({ send: () => Promise.reject(refuse()) }),
		keySender: () => ({ sendKeys: () => Promise.reject(refuse()) }),
		createTabLabels: () => {
			throw refuse();
		},
		statusLines: () => null,
	};
}

/**
 * The native adapter that can back a native view of a pane on this endpoint,
 * or null when none can: the kind has no native view, or its transcripts are
 * out of reach on this target.
 */
export function nativeAdapterFor(
	adapter: Pick<RuntimeKindAdapter, 'capabilities' | 'native'>,
	endpoint: Endpoint,
): NativeSessionAdapter | null {
	const native = adapter.native;
	if (!adapter.capabilities.nativeView || !native) return null;
	return native.transcriptAccess(endpoint) === null ? null : native;
}

/**
 * Why a pane on this runtime cannot be shown in the native view, or null when
 * it can: the kind's own reason first, then the target's (ADR-0002).
 *
 * Gated on the capability and on transcript access, not on the target as
 * such: a remote runtime whose kind reads its transcripts over the
 * connection (`rpc`) is offered the view. `remote` is true only for a pane on
 * another machine whose transcripts cannot be reached, which is what herdr
 * over SSH still is.
 */
export function nativeViewBlock(
	adapter: Pick<RuntimeKindAdapter, 'capabilities' | 'nativeUnavailable' | 'native'>,
	endpoint: Endpoint,
): { remote: boolean; kindReason: string | null } {
	if (!adapter.capabilities.nativeView || !adapter.native) {
		return { remote: false, kindReason: adapter.nativeUnavailable ?? NATIVE_NO_SESSION_REASON };
	}
	if (nativeAdapterFor(adapter, endpoint)) return { remote: false, kindReason: null };
	if (endpoint.runtime.target === 'ssh') return { remote: true, kindReason: null };
	return { remote: false, kindReason: NATIVE_NO_TRANSCRIPT_REASON };
}
