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
 * The herdr kind is `herdrKind.ts`, today's code behind this interface. The
 * herdr-core kind is {@link unavailableKind} until its client, scope and
 * terminal tab land: it can be added, edited and selected, and every attempt
 * to use it says it is not available yet rather than half-connecting.
 *
 * Features one kind lacks are capabilities, not errors (ADR-0004): the UI
 * reads {@link RuntimeCapabilities} and leaves out what a kind cannot do.
 */

import type { ActionHost } from '../actions';
import type { TerminalSessionOptions } from '../bridge/terminalSession';
import type {
	ConnectionClient,
	ConnectionDriver,
	ConnectionScope,
	ConnectionTunnel,
	Endpoint,
} from '../connection';
import type { KeySender, PromptClient, PromptSender } from '../native/promptSender';
import type { PaneSession } from '../views/paneTerminal';
import type { RuntimeKind } from '../runtimes';

/**
 * What a runtime of a kind can do, as the UI asks it. herdr has all of it;
 * herdr-core has no tabs, splits, rename or pane focus, and no agent session
 * for the native view to follow (ADR-0005).
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
	 * The native view, which follows the agent session the kind reports. Only
	 * on a `local` target even then: the transcript is a file on the pane's
	 * own host (ADR-0002).
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
	nativeView: true,
});

/** ADR-0005's mapping: start and close exist, the rest has no hc method. */
export const HERDR_CORE_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
	tabs: false,
	splits: false,
	startAgent: true,
	rename: false,
	focus: false,
	close: true,
	nativeView: false,
});

/** Why the native view is not offered for a kind without agent sessions. */
export const NATIVE_NO_SESSION_REASON = 'no agent session on herdr-core';

/** What every use of a herdr-core runtime says until its kind lands. */
export const HERDR_CORE_UNAVAILABLE =
	'herdr-core runtimes are not available in this version of the plugin yet';

/**
 * The folder and row actions, as the plugin calls them. herdr's are
 * `HerdrActions` (`actions.ts`); results are the kind's own and only the two
 * booleans are read by callers.
 */
export interface RuntimeActions {
	newTabHere(folderAbsPath: string): Promise<unknown>;
	splitHere(folderAbsPath: string): Promise<unknown>;
	startAgentHere(folderAbsPath: string): Promise<unknown>;
	/** True when the pane is gone, so the caller drops its row and tabs. */
	closePane(paneId: string, endpointId: string): Promise<boolean>;
	renameAgent(paneId: string, name: string): Promise<unknown>;
	/** True when the runtime focused the pane. */
	focusPane(paneId: string): Promise<boolean>;
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
	readonly capabilities: Readonly<RuntimeCapabilities>;
	/**
	 * Why the kind itself rules the native view out, whatever the target, or
	 * null when only the target decides.
	 */
	readonly nativeUnavailable: string | null;
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
	/** Folder and row actions over the plugin's action host. */
	createActions(host: ActionHost): RuntimeActions;
	/** The native view's prompt box, over the client of the tab's runtime. */
	promptSender(client: () => PromptClient | null): PromptSender;
	/** The waiting card's key presses, over the same client. */
	keySender(client: () => PromptClient | null): KeySender;
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
		capabilities,
		nativeUnavailable,
		connection: null,
		terminalCommand: () => {
			throw refuse();
		},
		createTerminalSession: () => {
			throw refuse();
		},
		createActions: (host) => {
			const say = (): void => host.notice(`Herdr: ${reason}.`);
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
	};
}

/**
 * Why a pane on this runtime cannot be shown in the native view, or null when
 * it can: the kind's own reason first, then the target's (ADR-0002).
 */
export function nativeViewBlock(
	adapter: Pick<RuntimeKindAdapter, 'capabilities' | 'nativeUnavailable'>,
	remote: boolean,
): { remote: boolean; kindReason: string | null } {
	if (!adapter.capabilities.nativeView) {
		return { remote, kindReason: adapter.nativeUnavailable ?? NATIVE_NO_SESSION_REASON };
	}
	return { remote, kindReason: null };
}
