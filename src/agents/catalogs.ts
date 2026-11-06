/**
 * The agent catalog of the runtime the list points at (issue #125), with its
 * probe cached per connection: the probe runs once the connection is live
 * (its `connected` edge, {@link AgentCatalogs.connected}), once for that
 * connection and that list of programs, and never per spawn or per repaint.
 * A reconnect is a new connection, so it probes again; adding a user entry
 * with a new program probes once more on the same one, when something asks
 * (the menu, "Check again", the settings tab drawing after an edit).
 *
 * Every probe waits for the connection's first round trip (`ping`, which is
 * herdr's version and hc's `hello`) before it asks anything: a connection is
 * published before that answered, and a probe taken then would read no
 * server version and get "not connected" from herdr-core, and keep that for
 * the whole connection.
 *
 * Reading never probes: {@link AgentCatalogs.cachedCatalog} and
 * {@link AgentCatalogs.cachedProbeFor} build from what landed, so the view's
 * render and the settings tab stay free of I/O. A probe that lands tells the
 * host (`changed`), which repaints.
 *
 * What to probe for is `catalog.ts`; how is the runtime kind's own
 * `probeAgents` (ADR-0004: nothing outside an adapter decides by kind or
 * target). No `obsidian` import; tested in `tests/agentCatalog.test.ts`.
 */

import type { Connection, Endpoint } from '../connection';
import type { RuntimeConfig } from '../runtimes';
import { clearTimer, setTimer } from '../timers';
import {
	buildCatalog,
	defaultEntry,
	launchOf,
	machinePhrase,
	programsToProbe,
	type AgentCatalogSettings,
	type AgentLaunch,
	type AgentProbe,
	type CatalogEntry,
} from './catalog';
import { machineKeyOf } from './machines';

/** How long a start may wait on a probe before it says that it is waiting. */
export const PROBE_WAIT_NOTICE_MS = 400;

export interface AgentCatalogsHost {
	/** The published connection, or null. */
	connection(): Connection | null;
	/** The runtime the plugin points at while no connection is published. */
	endpoint(): Endpoint;
	/** Live settings: the user's entries, the hidden list, the defaults. */
	settings(): AgentCatalogSettings;
	/**
	 * The kind's probe over this connection, or null for a kind that has
	 * none (the `claude` kind, whose catalog is Claude alone).
	 */
	probe(connection: Connection, programs: readonly string[]): Promise<AgentProbe> | null;
	/** A probe of the published connection landed: repaint what shows it. */
	changed?(): void;
	/** Something the user should see, like a start waiting on a probe. */
	notice?(message: string): void;
}

/** The one probe slot of a connection. */
interface Slot {
	/** The program list the newest probe was asked for. */
	key: string;
	/** The newest probe. */
	pending: Promise<AgentProbe>;
	/** Whether {@link pending} has landed. */
	done: boolean;
	/**
	 * The newest probe that landed on this connection, whatever list it was
	 * for: a changed list keeps showing what is known until its own lands.
	 */
	landed: AgentProbe | null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AgentCatalogs {
	/** One slot per connection: only the newest program list is kept. */
	private readonly slots = new WeakMap<object, Slot>();

	constructor(private readonly host: AgentCatalogsHost) {}

	/** The runtime the catalog is about: the connection's, else the active one. */
	private runtime(): Readonly<RuntimeConfig> {
		return (this.host.connection()?.endpoint ?? this.host.endpoint()).runtime;
	}

	private key(connection: Connection): string {
		return programsToProbe(connection.endpoint.runtime.kind, this.host.settings()).join('\n');
	}

	/**
	 * The probe for this connection and the current program list, started on
	 * the first call and shared by every later one; `force` starts a fresh
	 * one. Never rejects: a failed probe is `found: null` with the error,
	 * which leaves the catalog unverified.
	 */
	probe(connection: Connection, force = false): Promise<AgentProbe> {
		const programs = programsToProbe(connection.endpoint.runtime.kind, this.host.settings());
		const key = programs.join('\n');
		const slot = this.slots.get(connection);
		if (slot && slot.key === key && !force) return slot.pending;
		const next: Slot = { key, pending: Promise.resolve({ found: null }), done: false, landed: slot?.landed ?? null };
		next.pending = this.run(connection, programs).then((result) => {
			const landed: AgentProbe = { ...result, checked: new Set(programs) };
			// A newer probe on this connection replaced this one meanwhile.
			if (this.slots.get(connection) !== next) return landed;
			next.done = true;
			next.landed = landed;
			if (this.host.connection() === connection) this.host.changed?.();
			return landed;
		});
		this.slots.set(connection, next);
		return next.pending;
	}

	/** Waits for the connection to be live, then asks the kind. */
	private async run(connection: Connection, programs: readonly string[]): Promise<AgentProbe> {
		try {
			await connection.client.ping();
		} catch (error) {
			return { found: null, error: message(error) };
		}
		try {
			return (await this.host.probe(connection, programs)) ?? { found: null };
		} catch (error) {
			return { found: null, error: message(error) };
		}
	}

	/**
	 * The connection's `connected` edge, the first and every one after a
	 * reconnect: probes once it has not been, and again when what landed was
	 * a failure, which may have been the outage itself.
	 */
	connected(connection: Connection): void {
		const slot = this.slots.get(connection);
		if (!slot || slot.key !== this.key(connection)) {
			void this.probe(connection);
			return;
		}
		if (slot.done && slot.landed?.found === null) void this.probe(connection, true);
	}

	/**
	 * The published connection's probe when it runs on this machine (a key of
	 * `machines.ts`) and its kind probes, shared with the catalog's own; null
	 * otherwise. The settings tab's per-machine lines read it first.
	 */
	liveProbeOn(machineKey: string): Promise<AgentProbe> | null {
		const connection = this.host.connection();
		if (!connection || machineKeyOf(connection.endpoint.runtime) !== machineKey) return null;
		if (programsToProbe(connection.endpoint.runtime.kind, this.host.settings()).length === 0) return null;
		return this.probe(connection);
	}

	/** The newest probe that landed for the published connection, or null. */
	cachedProbe(): AgentProbe | null {
		const connection = this.host.connection();
		return connection ? (this.slots.get(connection)?.landed ?? null) : null;
	}

	/**
	 * The landed probe of this runtime, when the published connection is
	 * this runtime's; null otherwise. The settings tab reads it.
	 */
	cachedProbeFor(runtimeId: string): AgentProbe | null {
		return this.host.connection()?.endpoint.id === runtimeId ? this.cachedProbe() : null;
	}

	/**
	 * Brings this runtime's probe up to date, for the settings tab: true once
	 * a probe it did not already have landed, so the tab draws again exactly
	 * once; false when there is nothing new, or the published connection is
	 * not this runtime's. `again` drops what this connection found first,
	 * for "Check again" after installing a CLI.
	 */
	async refresh(runtimeId: string, again = false): Promise<boolean> {
		const connection = this.host.connection();
		if (!connection || connection.endpoint.id !== runtimeId) return false;
		const slot = this.slots.get(connection);
		if (!again && slot && slot.done && slot.key === this.key(connection)) return false;
		await this.probe(connection, again);
		return this.host.connection() === connection;
	}

	/** The catalog as far as it is known now, without probing. */
	cachedCatalog(): CatalogEntry[] {
		return buildCatalog({ runtime: this.runtime(), settings: this.host.settings(), probe: this.cachedProbe() });
	}

	/**
	 * The catalog for the + menu: at once from what landed, bringing a
	 * changed program list up to date in the background; waiting, with a
	 * notice when that takes a moment, only while nothing has landed yet.
	 */
	async catalog(): Promise<CatalogEntry[]> {
		const connection = this.host.connection();
		if (!connection) return this.cachedCatalog();
		const slot = this.slots.get(connection);
		if (slot?.landed) {
			if (slot.key !== this.key(connection)) void this.probe(connection);
			return this.cachedCatalog();
		}
		const probe = await this.waitFor(connection);
		// The connection may have been replaced meanwhile; the catalog is the
		// one of the runtime it was asked about.
		return buildCatalog({ runtime: connection.endpoint.runtime, settings: this.host.settings(), probe });
	}

	/** The connection's probe, saying so when it takes a moment. */
	private async waitFor(connection: Connection): Promise<AgentProbe> {
		const pending = this.probe(connection);
		const where = machinePhrase(connection.endpoint.runtime);
		const timer = setTimer(() => {
			this.host.notice?.(`Herdr: checking which agent CLIs are installed ${where}…`);
		}, PROBE_WAIT_NOTICE_MS);
		try {
			return await pending;
		} finally {
			clearTimer(timer);
		}
	}

	/**
	 * What a left click on + starts: the runtime's default, or null when
	 * nothing in its catalog can start. It goes at once when the default is
	 * known (a probe landed, or the runtime has a default of its own) and
	 * waits for the probe only to find the first installed one.
	 */
	async defaultLaunch(): Promise<AgentLaunch | null> {
		const connection = this.host.connection();
		const known = this.cachedCatalog();
		const chosen = defaultEntry(known);
		const runtime = this.runtime();
		const stored = this.host.settings().defaultAgents[runtime.id];
		const settled =
			!connection ||
			this.slots.get(connection)?.landed != null ||
			(chosen !== null && stored !== undefined && chosen.profile.id === stored);
		const entry = settled ? chosen : defaultEntry(await this.catalog());
		return entry ? launchOf(entry.profile) : null;
	}
}
