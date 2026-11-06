/**
 * The agent catalog of the runtime the list points at (issue #125), with its
 * probe cached per connection: the probe runs when a connection is published
 * (or on first use), once for that connection and that list of programs, and
 * never per spawn. A reconnect is a new connection, so it probes again;
 * adding a user entry with a new program probes once more on the same one.
 *
 * What to probe for is `catalog.ts`; how is the runtime kind's own
 * `probeAgents` (ADR-0004: nothing outside an adapter decides by kind or
 * target). No `obsidian` import; tested in `tests/agentCatalog.test.ts`.
 */

import type { Connection, Endpoint } from '../connection';
import type { RuntimeConfig } from '../runtimes';
import {
	buildCatalog,
	defaultEntry,
	launchOf,
	programsToProbe,
	type AgentCatalogSettings,
	type AgentLaunch,
	type AgentProbe,
	type CatalogEntry,
} from './catalog';

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
}

interface CachedProbe {
	pending: Promise<AgentProbe>;
	result: AgentProbe | null;
}

export class AgentCatalogs {
	/** Per connection, keyed by the program list it was asked for. */
	private readonly probes = new WeakMap<object, Map<string, CachedProbe>>();

	constructor(private readonly host: AgentCatalogsHost) {}

	/** The runtime the catalog is about: the connection's, else the active one. */
	private runtime(): Readonly<RuntimeConfig> {
		return (this.host.connection()?.endpoint ?? this.host.endpoint()).runtime;
	}

	/**
	 * The probe for this connection, started on the first call and shared by
	 * every later one. Never rejects: a failed probe is `found: null` with
	 * the error, which leaves the catalog unverified.
	 */
	probe(connection: Connection): Promise<AgentProbe> {
		const programs = programsToProbe(connection.endpoint.runtime.kind, this.host.settings());
		const key = programs.join('\n');
		let byPrograms = this.probes.get(connection);
		if (!byPrograms) {
			byPrograms = new Map();
			this.probes.set(connection, byPrograms);
		}
		const cached = byPrograms.get(key);
		if (cached) return cached.pending;
		let started: Promise<AgentProbe>;
		try {
			started = this.host.probe(connection, programs) ?? Promise.resolve<AgentProbe>({ found: null });
		} catch (error) {
			started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		const record: CachedProbe = {
			result: null,
			pending: started.then(
				(result) => result,
				(error: unknown) => ({ found: null, error: error instanceof Error ? error.message : String(error) }),
			),
		};
		void record.pending.then((result) => {
			record.result = result;
		});
		byPrograms.set(key, record);
		return record.pending;
	}

	/** The probe that already landed for the published connection, or null. */
	cachedProbe(): AgentProbe | null {
		const connection = this.host.connection();
		if (!connection) return null;
		const programs = programsToProbe(connection.endpoint.runtime.kind, this.host.settings());
		return this.probes.get(connection)?.get(programs.join('\n'))?.result ?? null;
	}

	/**
	 * The landed probe of this runtime, when the published connection is
	 * this runtime's; null otherwise. The settings tab reads it.
	 */
	cachedProbeFor(runtimeId: string): AgentProbe | null {
		return this.host.connection()?.endpoint.id === runtimeId ? this.cachedProbe() : null;
	}

	/**
	 * Probes the published connection; true once a probe landed, false
	 * without a connection. `again` drops what this connection found first,
	 * for "Check again" after installing a CLI.
	 */
	async check(again = false): Promise<boolean> {
		const connection = this.host.connection();
		if (!connection) return false;
		if (again) this.probes.delete(connection);
		await this.probe(connection);
		return true;
	}

	/** The catalog as far as it is known now, without waiting for a probe. */
	cachedCatalog(): CatalogEntry[] {
		return buildCatalog({ runtime: this.runtime(), settings: this.host.settings(), probe: this.cachedProbe() });
	}

	/** The catalog once the published connection's probe has landed. */
	async catalog(): Promise<CatalogEntry[]> {
		const connection = this.host.connection();
		const probe = connection ? await this.probe(connection) : null;
		// The connection may have been replaced meanwhile; the catalog is the
		// one of the runtime it was asked about.
		const runtime = connection ? connection.endpoint.runtime : this.runtime();
		return buildCatalog({ runtime, settings: this.host.settings(), probe });
	}

	/**
	 * What a left click on + starts: the runtime's default, or null when
	 * nothing in its catalog can start.
	 */
	async defaultLaunch(): Promise<AgentLaunch | null> {
		const entry = defaultEntry(await this.catalog());
		return entry ? launchOf(entry.profile) : null;
	}
}
