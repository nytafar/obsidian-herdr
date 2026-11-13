/**
 * The endpoint resolver (issue #182): the one place that answers "what is
 * behind endpoint id X".
 *
 * A terminal tab, a native view, the agent list and the plugin root each hold
 * an endpoint id and ask about it: its endpoint, its kind's adapter, its
 * connection, the native adapter that can back a native view there, the
 * client a native view sends through, the pins. Two rules decide every
 * answer, and they are written here once:
 *
 * - **the connection is this endpoint's or null**: the published connection
 *   is handed out only when its endpoint is the one asked about, never on
 *   another's behalf (issue #54; the same pane id on two runtimes is two
 *   panes);
 * - **the native adapter** is the endpoint's kind's, and only where that kind
 *   can read the endpoint's transcripts (`nativeAdapterFor`, ADR-0006).
 *
 * The kinds, the published connection and the settings are injected, so the
 * rules are tested against fakes (`tests/endpointResolver.test.ts`).
 */

import {
	EndpointSessions,
	endpointOf,
	resolveEndpoint,
	type Connection,
	type ConnectionClient,
	type ConnectionScope,
	type Endpoint,
	type EndpointSession,
} from '../connection';
import { isPanePinned, pinnedPaneIds, togglePanePin, type HerdrSettings } from '../settings';
import type { RuntimeConfig, RuntimeKind, RuntimeSettings } from '../runtimes';
import type { TabLabels } from '../tabLabels';
import type { CommandCatalogSource } from '../native/commandCatalog';
import type { PromptClient } from '../native/promptSender';
import type { SessionWatcher } from '../native/sessionWatcher';
import type { TranscriptSource } from '../native/transcriptSource';
import { nativeAdapterFor, type NativeSessionAdapter, type RuntimeActions, type RuntimeKindAdapter } from './kind';

/** The session one endpoint id has on the published connection. */
export type ResolvedSession = EndpointSession<ConnectionClient, ConnectionScope, TabLabels>;

export interface EndpointResolverDeps {
	/** One adapter per kind (ADR-0004). */
	readonly kinds: Readonly<Record<RuntimeKind, RuntimeKindAdapter>>;
	/** The published connection, or null while none is (the coordinator's). */
	current(): Connection | null;
	/** Read per call: the registry and the pins as they are now. */
	settings(): RuntimeSettings & Pick<HerdrSettings, 'pinnedPanes'>;
	/** Persists the settings after a pin stored there changed. */
	save(): Promise<void>;
	/**
	 * The actions of the runtime the list points at, and that runtime's id: a
	 * pin a kind keeps on the runtime itself can only be written through them.
	 */
	listActions(): { endpointId: string; actions: RuntimeActions };
}

export class EndpointResolver {
	/** The tab-label cache's lifetime and the endpoint-match rule (issue #81). */
	private readonly sessions: EndpointSessions<ConnectionClient, ConnectionScope, TabLabels>;

	constructor(private readonly deps: EndpointResolverDeps) {
		this.sessions = new EndpointSessions<ConnectionClient, ConnectionScope, TabLabels>({
			current: () => deps.current(),
			// The kind's own source: herdr's `tab.list` cache, herdr-core's
			// `herdr-app` tabs.
			createTabLabels: (connection) =>
				this.kindOf(connection.endpoint.runtime.kind).createTabLabels(
					connection,
					() => deps.current() === connection,
				),
		});
	}

	/** The adapter of a kind (ADR-0004). */
	kindOf(kind: RuntimeKind): RuntimeKindAdapter {
		return this.deps.kinds[kind];
	}

	/** Why runtimes of this kind cannot connect in this build, or null. */
	kindUnavailable(kind: RuntimeKind): string | null {
		return this.kindOf(kind).unavailable;
	}

	/**
	 * What `endpointId` names on the published connection, or null when that
	 * connection is another runtime's: a terminal pinned to one must not read
	 * titles or labels from the other (issue #54).
	 */
	session(endpointId: string): ResolvedSession | null {
		return this.sessions.for(endpointId);
	}

	/**
	 * The published connection when it is `endpointId`'s, else null. The one
	 * place that rule is written.
	 */
	connection(endpointId: string): Connection | null {
		const current = this.deps.current();
		return current?.endpoint.id === endpointId ? current : null;
	}

	/**
	 * The endpoint an id names: the published connection's own snapshot when it
	 * matches, else one rebuilt from the settings as they are now, else null
	 * when the settings no longer describe it. A restored or pinned terminal
	 * starts without any connection, hence the settings half.
	 */
	endpoint(endpointId: string): Endpoint | null {
		return this.session(endpointId)?.endpoint ?? resolveEndpoint(endpointId, this.deps.settings());
	}

	/** The adapter of the endpoint's kind, or null for an id the settings no longer hold. */
	kind(endpointId: string): RuntimeKindAdapter | null {
		const endpoint = this.endpoint(endpointId);
		return endpoint ? this.kindOf(endpoint.runtime.kind) : null;
	}

	/**
	 * The native adapter that can back a native view on this endpoint, or null.
	 * The one place `nativeAdapterFor` is asked with an endpoint's own kind.
	 */
	native(endpoint: Endpoint): NativeSessionAdapter | null {
		return nativeAdapterFor(this.kindOf(endpoint.runtime.kind), endpoint);
	}

	/**
	 * Whether a runtime's transcripts can be read from here: the runtime half
	 * of the native view's gate, which the agent catalog's native flag reads
	 * beside the agent seam's (ADR-0010).
	 */
	nativeReachable(runtime: Readonly<RuntimeConfig>): boolean {
		return this.native(endpointOf(runtime)) !== null;
	}

	/**
	 * The native view's session watcher for panes on this runtime (ADR-0006),
	 * or null while that runtime is not the published one or cannot back a
	 * native view. Never the published runtime's on another's behalf.
	 */
	watcher(endpointId: string): SessionWatcher | null {
		const connection = this.connection(endpointId);
		if (!connection) return null;
		return this.native(connection.endpoint)?.watcher(connection) ?? null;
	}

	/** Where this runtime's transcripts are read, or null while they cannot be. */
	transcripts(endpointId: string): TranscriptSource | null {
		const endpoint = this.endpoint(endpointId);
		if (!endpoint) return null;
		return this.native(endpoint)?.transcripts(endpoint, this.connection(endpointId)) ?? null;
	}

	/**
	 * Where a native tab's `/` list is read for the pane's agent (#98,
	 * ADR-0010): its runtime's machine, by the same connection rule as
	 * {@link transcripts}. Null is this machine's files, which the tab's
	 * suggest walks itself.
	 */
	commandCatalog(endpointId: string, agent: string): CommandCatalogSource | null {
		const endpoint = this.endpoint(endpointId);
		const native = endpoint ? this.native(endpoint) : null;
		if (!endpoint || !native?.commandCatalog) return null;
		return native.commandCatalog(endpoint, this.connection(endpointId), agent);
	}

	/**
	 * What a native view's prompt and key senders go through: its own
	 * runtime's client, only where the kind can back a native view there.
	 */
	client(endpointId: string): PromptClient | null {
		const session = this.session(endpointId);
		if (!session) return null;
		return this.native(session.endpoint) ? session.client : null;
	}

	/**
	 * Pane ids pinned on an endpoint (issue #35): from the plugin's settings,
	 * or, for a kind that keeps pins on the runtime (herdr-core's shared
	 * `herdr.pinned`, ADR-0005), from the rows of that endpoint's connection.
	 */
	pinnedPaneIds(endpointId: string): string[] {
		if (!this.sharedPins(endpointId)) return pinnedPaneIds(this.deps.settings(), endpointId);
		return (this.session(endpointId)?.scope.list() ?? [])
			.filter((pane) => pane.pinned === true)
			.map((pane) => pane.paneId);
	}

	isPanePinned(endpointId: string, paneId: string): boolean {
		if (!this.sharedPins(endpointId)) return isPanePinned(this.deps.settings(), endpointId, paneId);
		return this.session(endpointId)?.scope.get(paneId)?.pinned === true;
	}

	/** Pins or unpins where that endpoint's kind keeps pins. */
	async setPanePinned(endpointId: string, paneId: string, pinned: boolean): Promise<void> {
		if (this.sharedPins(endpointId)) {
			// Only the list's runtime can write the label; the row repaints when
			// the core's `labels` event comes back.
			const list = this.deps.listActions();
			if (list.endpointId !== endpointId) return;
			await list.actions.setPinned?.(paneId, pinned);
			return;
		}
		const settings = this.deps.settings();
		if (isPanePinned(settings, endpointId, paneId) !== pinned) togglePanePin(settings, endpointId, paneId);
		await this.deps.save();
	}

	private sharedPins(endpointId: string): boolean {
		return this.kind(endpointId)?.capabilities.sharedPins ?? false;
	}

	/**
	 * Drops the session of a connection that is no longer published, so its
	 * caches go with it. Call it on every replacement.
	 */
	sync(): void {
		this.sessions.sync();
	}

	/** Unload: drops the session whatever the coordinator still reports. */
	dispose(): void {
		this.sessions.dispose();
	}
}
