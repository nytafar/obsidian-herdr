/**
 * The command catalog (issues #98, #137): what a `/` in the prompt box may
 * offer, as the prompt box sees it, whichever agent the pane runs.
 *
 * Where the entries come from is the agent's (`AgentFormat.commands`,
 * `../agents/format.ts`): Claude Code's are its command and skill files in
 * three scopes plus a list of built-ins (`../agents/claude/commands.ts`);
 * another agent's may be a fixed list compiled into it. Where they are read
 * is the runtime's (`NativeSessionAdapter.commandCatalog`): this machine's
 * files, or another machine's over the runtime's connection. This module is
 * the part neither decides: the entry, its scope's precedence, matching a
 * query and the usage counts (#149).
 */

/** How long a loaded catalog is reused before it is read again. */
export const CATALOG_TTL_MS = 5000;

/** Where an entry came from; also its precedence, highest first. */
export type CommandScope = 'project' | 'user' | 'plugin' | 'builtin';

/** A command, a skill or a built-in: one thing a `/` can offer. */
export interface CatalogEntry {
	/** What is typed after the slash, namespaces included: `ns:deep`. */
	name: string;
	scope: CommandScope;
	kind: 'command' | 'skill' | 'builtin';
	/** What the entry says it does, empty when it says nothing. */
	description: string;
	/** What its arguments are, empty when it says nothing. */
	argumentHint: string;
	/** The file it was read from, symlinks resolved; null for a built-in. */
	path: string | null;
}

/** Scope order, strongest first. A name is taken by the first scope that has it. */
export const SCOPE_ORDER: readonly CommandScope[] = ['project', 'user', 'plugin', 'builtin'];

/** One entry per name, the strongest scope's, in name order. */
export function byPrecedence(found: readonly CatalogEntry[]): CatalogEntry[] {
	const byName = new Map<string, CatalogEntry>();
	for (const scope of SCOPE_ORDER) {
		for (const entry of found) {
			// The scopes are pushed nearest-first within a scope too, so the first
			// entry of a name in a scope is the one that wins it.
			if (entry.scope === scope && !byName.has(entry.name)) byName.set(entry.name, entry);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How often each command has been picked from the `/` popover, by name (#149):
 * kept in the plugin's data, so the commands a user reaches for come first.
 */
export type CommandUsage = Readonly<Record<string, number>>;

/** A stored usage map with anything that is not a positive count dropped. */
export function normalizeCommandUsage(value: unknown): Record<string, number> {
	const result: Record<string, number> = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
	for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
		if (name !== '' && typeof count === 'number' && Number.isFinite(count) && count >= 1) {
			result[name] = Math.floor(count);
		}
	}
	return result;
}

/** The usage map with one more pick of `name`; the map given is not changed. */
export function withCommandUsed(usage: CommandUsage, name: string): Record<string, number> {
	const next = normalizeCommandUsage(usage);
	next[name] = (next[name] ?? 0) + 1;
	return next;
}

/**
 * The entries a query offers. Matching is case-insensitive and on the name
 * only: a description is there to be read, not to be searched.
 *
 * A typed query ranks prefix matches before substring matches, then the more
 * used before the less (#149), then by name, whatever the scope: a project
 * command that starts with the query must not sit under a built-in that only
 * contains it. A bare `/` lists everything grouped by scope, in precedence
 * order (project, user, plugin, built-in), by use and then name inside a group.
 */
export function matchCommands(
	entries: CatalogEntry[],
	query: string,
	usage: CommandUsage = {},
): CatalogEntry[] {
	const needle = query.toLowerCase();
	const ranked: { entry: CatalogEntry; tier: number }[] = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		if (needle === '') ranked.push({ entry, tier: SCOPE_ORDER.indexOf(entry.scope) });
		else if (name.startsWith(needle)) ranked.push({ entry, tier: 0 });
		else if (name.includes(needle)) ranked.push({ entry, tier: 1 });
	}
	const uses = (entry: CatalogEntry): number => usage[entry.name] ?? 0;
	return ranked
		.sort(
			(a, b) =>
				a.tier - b.tier ||
				uses(b.entry) - uses(a.entry) ||
				a.entry.name.localeCompare(b.entry.name),
		)
		.map(({ entry }) => entry);
}

/** Where a `/` list comes from for one runtime: this machine, or another. */
export interface CommandCatalogSource {
	/**
	 * The catalog for a pane's cwd on that runtime's machine: at once when it
	 * is known, else a promise that settles on what could be read in time.
	 * `paneId` names the pane, for a source whose user scope depends on the
	 * pane's own agent process (a herdr pane's `CLAUDE_CONFIG_DIR`, issue #132).
	 */
	catalog(cwd: string, paneId?: string): CatalogEntry[] | Promise<CatalogEntry[]>;
}

/** The name a scope root would be shown under. Exported for the suggest (#98). */
export function scopeLabel(scope: CommandScope): string {
	if (scope === 'builtin') return 'Built-in';
	return `${scope[0]?.toUpperCase() ?? ''}${scope.slice(1)}`;
}
