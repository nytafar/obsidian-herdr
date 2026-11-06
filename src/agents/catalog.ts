/**
 * The agent CLI catalog (issue #125): which agents the + button and its menu
 * offer on a runtime, and how each one is started there.
 *
 * A **profile** is one agent CLI: an id, a name, an icon, the herdr agent kind
 * it is (what herdr's `agent.start` takes, and what the row's mark shows), the
 * program it runs and its default arguments, which runtime kinds can start
 * it, and whether it has a native view (Claude only, for now). The built-in
 * profiles are herdr's own agent kinds; a user adds their own in settings (a
 * wrapper, `codex --profile work`, extra flags), and hc's templates join on a
 * herdr-core runtime.
 *
 * What is installed is the runtime's **probe**, run once per connection by the
 * runtime's kind (`RuntimeKindAdapter.probeAgents`) and cached for it
 * (`agents/catalogs.ts`). {@link buildCatalog} merges the two: a built-in
 * shows only where its program was found (and, on herdr, where the server's
 * version accepts its kind), a user entry always shows, greyed with the reason
 * when it cannot start there.
 *
 * Pure: no `obsidian` import, no I/O. Tested in `tests/agentCatalog.test.ts`.
 */

import { herdrVersionAtLeast } from '../herdr/version';
import type { RuntimeConfig, RuntimeKind } from '../runtimes';

/** One of herdr's agent kinds, as the catalog ships it. */
export interface BuiltinAgent {
	/** herdr's kind (`agent.start --kind`), and the profile's id. */
	kind: string;
	/** What the menu and the settings call it. */
	name: string;
	/** The program it runs, where it differs from the kind. */
	program?: string;
	/**
	 * The first herdr release whose `agent.start` accepts the kind; absent for
	 * a kind every supported release has. Read from `herdr agent start --help`
	 * of 0.8.2, 0.9.0, 0.9.1 and 0.9.5 on 2026-11-06 (`docs/architecture.md`).
	 */
	since?: string;
}

/**
 * herdr's agent kinds, in the order the menu lists them: the kinds the plugin
 * always offered first, then the rest of herdr 0.9.5's list.
 */
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
	{ kind: 'claude', name: 'Claude Code' },
	{ kind: 'codex', name: 'Codex' },
	{ kind: 'gemini', name: 'Gemini' },
	{ kind: 'opencode', name: 'OpenCode' },
	{ kind: 'pi', name: 'Pi' },
	{ kind: 'cursor', name: 'Cursor', program: 'cursor-agent' },
	{ kind: 'amp', name: 'Amp' },
	{ kind: 'copilot', name: 'Copilot' },
	{ kind: 'kimi', name: 'Kimi' },
	{ kind: 'droid', name: 'Droid' },
	{ kind: 'grok', name: 'Grok' },
	{ kind: 'qwen', name: 'Qwen' },
	{ kind: 'muse', name: 'Muse', since: '0.9.0' },
	{ kind: 'devin', name: 'Devin' },
	{ kind: 'agy', name: 'Agy' },
	{ kind: 'cline', name: 'Cline' },
	{ kind: 'omp', name: 'Omp' },
	{ kind: 'mastracode', name: 'Mastra Code' },
	{ kind: 'kiro', name: 'Kiro' },
	{ kind: 'hermes', name: 'Hermes' },
	{ kind: 'kilo', name: 'Kilo' },
	{ kind: 'qodercli', name: 'Qoder' },
	{ kind: 'letta', name: 'Letta', since: '0.9.1' },
	{ kind: 'maki', name: 'Maki' },
];

/** The kind a profile falls back to, and the one a fresh user entry starts as. */
export const DEFAULT_AGENT_KIND = 'claude';

/** A user's own entry, as `data.json` stores it under `agentProfiles`. */
export interface UserAgentProfile {
	/** `user-…`, generated once; the default and the hidden list refer to it. */
	id: string;
	/** Empty shows the program's name. */
	name: string;
	/** The herdr agent kind it is: what `agent.start` gets, and the icon. */
	agent: string;
	/** The program to run; empty runs the kind's own. A leading `~/` is the home. */
	command: string;
	/** Arguments after the program, plain words only. */
	args: string[];
}

/** One entry of the catalog, built-in, template or the user's. */
export interface AgentProfile {
	id: string;
	name: string;
	/** herdr's agent kind; the row mark's key (`views/kindIcons.ts`). */
	agent: string;
	/** The program as it is probed and run. */
	command: string;
	/** Default arguments after the program. */
	args: readonly string[];
	/** Where it came from. */
	source: 'builtin' | 'user' | 'template';
	/** The hc template's name, for a `template` entry. */
	template?: string;
	/** Whether the plugin has a native view for it: Claude only, for now. */
	native: boolean;
}

/**
 * What `startAgentHere` is given for one profile on one runtime kind:
 * `agent.start`'s `kind` and `args` on herdr, the launch line's program and
 * arguments (or the template) on herdr-core.
 */
export interface AgentLaunch {
	kind: string;
	command?: string;
	args?: readonly string[];
	template?: string;
	/** What the notice calls the agent. */
	label?: string;
}

/** An hc template from `templates.list`. */
export interface HcTemplate {
	name: string;
	description?: string;
	/** Set when hc cannot use the template; the entry shows it greyed. */
	error?: string;
}

/**
 * What a runtime's probe found, once per connection. `found` holds the
 * programs, as {@link programsToProbe} gave them, that exist on the machine;
 * null when the probe could not run, which leaves every entry unverified
 * rather than hiding them all.
 */
export interface AgentProbe {
	found: ReadonlySet<string> | null;
	/** herdr's server version, which gates its kinds. */
	herdrVersion?: string | null;
	/** hc's templates, on herdr-core. */
	templates?: readonly HcTemplate[];
	/** Why the probe could not run, when `found` is null. */
	error?: string | null;
	/**
	 * The programs this probe was asked about. A program outside it (a user
	 * entry added since) is unverified, not missing. Absent: every program.
	 */
	checked?: ReadonlySet<string>;
}

/** One line of the menu, or of the settings list. */
export interface CatalogEntry {
	profile: AgentProfile;
	/** Whether it can be started on this runtime now. */
	available: boolean;
	/** Why not, or what is unverified; null when there is nothing to say. */
	reason: string | null;
	/** Whether the probe found its program; null while unverified. */
	found: boolean | null;
	/** Hidden by the user: left out of the menu, kept in the settings list. */
	hidden: boolean;
	/** The runtime's default: what a left click on + starts. */
	isDefault: boolean;
}

/** Arguments a launch line can carry: plain words, nothing a shell reads twice. */
const PLAIN_ARG = /^[A-Za-z0-9._=/:@+,-]+$/;
/** A program: a name or a path, `~/` allowed at the front, never an option. */
const PLAIN_PROGRAM = /^(~\/)?[A-Za-z0-9._+/-]+$/;

/** Why an argument cannot be used, or null. */
export function argIssue(arg: string): string | null {
	return PLAIN_ARG.test(arg) ? null : `not a plain argument: ${arg}`;
}

/** Why a program cannot be used, or null. */
export function commandIssue(command: string): string | null {
	if (command.startsWith('-') || !PLAIN_PROGRAM.test(command)) return `not a plain command: ${command}`;
	return null;
}

/** Splits the settings' argument field on whitespace. */
export function parseArgs(text: string): string[] {
	return text.split(/\s+/).filter((part) => part.length > 0);
}

/** The program a herdr kind runs. */
export function programOf(kind: string): string {
	return BUILTIN_AGENTS.find((agent) => agent.kind === kind)?.program ?? kind;
}

function builtinProfile(agent: BuiltinAgent): AgentProfile {
	return {
		id: agent.kind,
		name: agent.name,
		agent: agent.kind,
		command: agent.program ?? agent.kind,
		args: [],
		source: 'builtin',
		native: agent.kind === 'claude',
	};
}

/** Every built-in profile, in menu order. */
export function builtinProfiles(): AgentProfile[] {
	return BUILTIN_AGENTS.map(builtinProfile);
}

/** A user entry as a profile. */
export function userProfile(user: UserAgentProfile): AgentProfile {
	const command = user.command.trim() || programOf(user.agent);
	const name = user.name.trim() || [command, ...user.args].join(' ');
	return {
		id: user.id,
		name,
		agent: user.agent,
		command,
		args: [...user.args],
		source: 'user',
		native: user.agent === 'claude',
	};
}

/** An hc template as a profile; its program is hc's business, not probed. */
export function templateProfile(template: HcTemplate): AgentProfile {
	return {
		id: `template:${template.name}`,
		name: template.name,
		agent: '',
		command: template.name,
		args: [],
		source: 'template',
		template: template.name,
		native: false,
	};
}

/** A fresh user id that collides with nothing in `taken`. */
export function newAgentProfileId(taken: Iterable<string>, random: () => number = Math.random): string {
	const used = new Set(taken);
	for (;;) {
		const id = `user-${Math.floor(random() * 36 ** 6)
			.toString(36)
			.padStart(6, '0')}`;
		if (!used.has(id)) return id;
	}
}

/**
 * Whatever `data.json` holds under `agentProfiles`, as user entries. An entry
 * without an id is dropped, a duplicate id keeps its first, and an unknown
 * agent kind is kept: a newer herdr may know it.
 */
export function normalizeUserProfiles(value: unknown): UserAgentProfile[] {
	if (!Array.isArray(value)) return [];
	const result: UserAgentProfile[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const id = typeof record.id === 'string' ? record.id.trim() : '';
		if (id === '' || seen.has(id)) continue;
		seen.add(id);
		const agent = typeof record.agent === 'string' && record.agent.trim() ? record.agent.trim() : DEFAULT_AGENT_KIND;
		result.push({
			id,
			name: typeof record.name === 'string' ? record.name : '',
			agent,
			command: typeof record.command === 'string' ? record.command : '',
			args: Array.isArray(record.args)
				? record.args.filter((arg): arg is string => typeof arg === 'string' && arg !== '')
				: [],
		});
	}
	return result;
}

/** A list of unique non-empty strings, or empty. */
export function normalizeIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** Runtime id to profile id, strings only. */
export function normalizeDefaultAgents(value: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
	for (const [runtimeId, profileId] of Object.entries(value as Record<string, unknown>)) {
		if (typeof profileId === 'string' && profileId !== '') result[runtimeId] = profileId;
	}
	return result;
}

/**
 * Why a profile cannot be started on a runtime of this kind, or null when it
 * can, whatever is installed:
 *
 * - **herdr** starts a kind with `agent.start`, which runs the kind's own
 *   program: a user entry with another command cannot go through it, and
 *   neither can an hc template.
 * - **herdr-core** runs any program in the user's shell, and its templates.
 * - **Claude, run by Obsidian** runs `claude` with its own arguments, so only
 *   the built-in Claude profile.
 */
export function kindIssue(profile: AgentProfile, kind: RuntimeKind): string | null {
	if (kind === 'claude') {
		return profile.source === 'builtin' && profile.agent === 'claude'
			? null
			: 'Claude, run by Obsidian starts Claude Code only, with its own arguments';
	}
	if (profile.source === 'template') {
		return kind === 'herdr-core' ? null : 'hc templates run on herdr-core only';
	}
	const issue = commandIssue(profile.command) ?? profile.args.map(argIssue).find((found) => found !== null) ?? null;
	if (issue) return issue;
	if (kind === 'herdr' && profile.command !== programOf(profile.agent)) {
		return `herdr starts ${profile.agent} with its own program; clear the command to use it here`;
	}
	return null;
}

/** The runtime kinds a profile can be started on. */
export function profileKinds(profile: AgentProfile): RuntimeKind[] {
	return (['herdr', 'herdr-core', 'claude'] as const).filter((kind) => kindIssue(profile, kind) === null);
}

/** Whether herdr at this version accepts the kind in `agent.start`. */
export function herdrAcceptsKind(kind: string, version: string | null | undefined): boolean {
	const builtin = BUILTIN_AGENTS.find((agent) => agent.kind === kind);
	// A user's kind herdr may know: asking is safe, a refusal is an ordinary error.
	if (!builtin) return true;
	return builtin.since === undefined || herdrVersionAtLeast(version, builtin.since);
}

/** The settings slice the catalog reads. */
export interface AgentCatalogSettings {
	agentProfiles: readonly UserAgentProfile[];
	hiddenAgents: readonly string[];
	defaultAgents: Readonly<Record<string, string>>;
}

/**
 * The programs a runtime of this kind probes for: every built-in it can
 * start, then the user entries' own commands. Deduplicated, in order. The
 * `claude` kind probes nothing: its runtime found `claude` to connect at all.
 */
export function programsToProbe(kind: RuntimeKind, settings: Pick<AgentCatalogSettings, 'agentProfiles'>): string[] {
	if (kind === 'claude') return [];
	const programs: string[] = [];
	const add = (program: string): void => {
		if (!programs.includes(program) && commandIssue(program) === null) programs.push(program);
	};
	for (const profile of builtinProfiles()) add(profile.command);
	for (const user of settings.agentProfiles) add(userProfile(user).command);
	return programs;
}

/** Where the probe's answer is shown: "on this machine", "on xl". */
export function machinePhrase(runtime: Pick<RuntimeConfig, 'target' | 'host'>): string {
	return runtime.target === 'ssh' && runtime.host.trim() ? `on ${runtime.host.trim()}` : 'on this machine';
}

/** How an entry's reason starts when the runtime's probe failed. */
export const UNVERIFIED_PREFIX = 'could not check what is installed: ';

export interface BuildCatalogInput {
	runtime: Pick<RuntimeConfig, 'id' | 'kind' | 'target' | 'host'>;
	settings: AgentCatalogSettings;
	/** The runtime's probe, or null while none ran (not connected, still probing). */
	probe: AgentProbe | null;
}

/**
 * The runtime's catalog: the default first, then built-ins in their order,
 * hc templates, and the user's entries. Hidden entries are in it with
 * `hidden` set; the menu leaves them out ({@link menuEntries}), the settings
 * list shows them.
 *
 * - A built-in the kind cannot start is left out. One whose program the probe
 *   did not find is left out, and on herdr so is one the server's version
 *   does not accept. Without a probe every built-in the kind can start is in,
 *   unverified.
 * - A user entry is always in: greyed with the reason when its kind cannot
 *   start it. One whose program was not found stays startable, with the
 *   reason: the probe looks where the runtime's shells look, but a user who
 *   added the entry knows better than a PATH that came out different.
 * - A program the probe was not asked about (an entry added since) is
 *   unverified, like everything before the first probe.
 * - The default is the runtime's stored choice while it is available, else
 *   the first available entry that is not hidden and was not missed by the
 *   probe, else the first available one that is not hidden.
 */
export function buildCatalog(input: BuildCatalogInput): CatalogEntry[] {
	const { runtime, settings, probe } = input;
	const kind = runtime.kind;
	const hidden = new Set(settings.hiddenAgents);
	const where = machinePhrase(runtime);
	const probed = probe?.found ?? null;
	const checked = probe?.checked ?? null;
	/** Whether the probe found the program; null while it is unverified. */
	const lookup = (program: string): boolean | null => {
		if (probed === null || (checked !== null && !checked.has(program))) return null;
		return probed.has(program);
	};
	const unverified = probe?.error ? `${UNVERIFIED_PREFIX}${probe.error}` : null;
	const entries: CatalogEntry[] = [];
	const push = (profile: AgentProfile, available: boolean, reason: string | null, wasFound: boolean | null): void => {
		entries.push({ profile, available, reason, found: wasFound, hidden: hidden.has(profile.id), isDefault: false });
	};

	for (const profile of builtinProfiles()) {
		if (kindIssue(profile, kind) !== null) continue;
		if (kind === 'claude') {
			push(profile, true, null, true);
			continue;
		}
		if (kind === 'herdr' && probe && !herdrAcceptsKind(profile.agent, probe.herdrVersion)) continue;
		const wasFound = lookup(profile.command);
		if (wasFound === null) push(profile, true, probed === null ? unverified : null, null);
		else if (wasFound) push(profile, true, null, true);
	}

	if (kind === 'herdr-core') {
		for (const template of probe?.templates ?? []) {
			const profile = templateProfile(template);
			const error = template.error?.trim();
			push(profile, !error, error ? `hc cannot use this template: ${error}` : null, null);
		}
	}

	for (const user of settings.agentProfiles) {
		const profile = userProfile(user);
		const issue = kindIssue(profile, kind);
		if (issue) {
			push(profile, false, issue, null);
			continue;
		}
		if (kind === 'herdr' && probe && !herdrAcceptsKind(profile.agent, probe.herdrVersion)) {
			push(profile, false, `this herdr (${probe.herdrVersion ?? 'unknown version'}) cannot start ${profile.agent}`, null);
			continue;
		}
		const wasFound = lookup(profile.command);
		if (wasFound === null) push(profile, true, probed === null ? unverified : null, null);
		else if (wasFound) push(profile, true, null, true);
		else push(profile, true, `${profile.command} was not found ${where}; it may still start`, false);
	}

	const wanted = settings.defaultAgents[runtime.id];
	const chosen =
		entries.find((entry) => entry.profile.id === wanted && entry.available) ??
		entries.find((entry) => entry.available && !entry.hidden && entry.found !== false) ??
		entries.find((entry) => entry.available && !entry.hidden);
	if (!chosen) return entries;
	chosen.isDefault = true;
	return [chosen, ...entries.filter((entry) => entry !== chosen)];
}

/** What the + menu lists: every entry not hidden, the default first. */
export function menuEntries(catalog: readonly CatalogEntry[]): CatalogEntry[] {
	return catalog.filter((entry) => !entry.hidden || entry.isDefault);
}

/** The entry a left click on + starts, or null when none can start. */
export function defaultEntry(catalog: readonly CatalogEntry[]): CatalogEntry | null {
	return catalog.find((entry) => entry.isDefault) ?? null;
}

/** How `startAgentHere` starts a profile. */
export function launchOf(profile: AgentProfile): AgentLaunch {
	if (profile.template) return { kind: profile.template, template: profile.template, label: profile.name };
	const own = profile.command === programOf(profile.agent);
	return {
		kind: profile.agent || DEFAULT_AGENT_KIND,
		...(own ? {} : { command: profile.command }),
		...(profile.args.length > 0 ? { args: [...profile.args] } : {}),
		label: profile.name,
	};
}

/**
 * The per-runtime defaults from a stored `data.json`: its own
 * `defaultAgents`, or, for a file from before #125, its one global
 * `defaultAgentKind` given to every herdr and herdr-core runtime, so a user
 * who chose codex still gets codex; a newer build's runtime kept aside
 * (`foreign`) is given it too, so it has it once that build reads it. `claude`, the old default that every
 * saved file holds, is not written: Claude leads every catalog it is
 * installed in, so the fallback starts it anyway, and an explicit default
 * would keep starting it after the user hid it. `migrated` asks for one
 * write-back, which drops the old key.
 */
export function migrateDefaultAgents(
	stored: unknown,
	runtimes: readonly { id: string; kind: string }[],
): { defaultAgents: Record<string, string>; migrated: boolean } {
	const record = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>;
	const defaultAgents = normalizeDefaultAgents(record.defaultAgents);
	const legacy = record.defaultAgentKind;
	if (!('defaultAgentKind' in record)) return { defaultAgents, migrated: false };
	const kind = typeof legacy === 'string' ? legacy.trim() : '';
	if (kind !== '' && kind !== DEFAULT_AGENT_KIND && !('defaultAgents' in record)) {
		for (const runtime of runtimes) {
			if (runtime.kind === 'claude') continue;
			defaultAgents[runtime.id] ??= kind;
		}
	}
	return { defaultAgents, migrated: true };
}
