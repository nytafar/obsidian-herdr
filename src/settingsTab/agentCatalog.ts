/**
 * The agent CLI catalog on the Agents page (issue #179, on #125's model): a
 * `list` of the built-in agent CLIs, each a row with its machine line and
 * the eye, and a `list` of the user's own entries, each a `page` with its
 * fields. The decisions are `agents/catalog.ts`'s; this file describes them
 * as definitions.
 *
 * Every value a row shows is worked out when the definitions are read, so
 * what changes it ends in the tab's `update()`, which reads them again and
 * draws the open page in place: a control write (`setControlValue` on a
 * {@link CatalogKey}), an entry added or removed, and a machine answering.
 *
 * {@link AgentCatalogSession} is one opening of the settings: the machine
 * probes the first drawing of the catalog starts (`agents/machines.ts`), the
 * active runtime's own probe, and, where the build cannot leave a page, the
 * user entries removed from their own page while it is open. `end()`, from
 * the tab's `hide()` once the settings really close, stops all of it, so the
 * next opening asks every machine again.
 */

import type { SettingDefinition, SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import type { HerdrSettings } from '../settings';
import { activeRuntimeOf, runtimeDisplayName, RUNTIME_KIND_LABELS, type RuntimeConfig } from '../runtimes';
import { offersNativeView } from '../agents/format';
import {
	BUILTIN_AGENTS,
	builtinProfiles,
	buildCatalog,
	DEFAULT_AGENT_KIND,
	machinePhrase,
	newAgentProfileId,
	parseArgs,
	programOf,
	programsToProbe,
	userProfile,
	type AgentProbe,
	type CatalogEntry,
	type UserAgentProfile,
} from '../agents/catalog';
import { foundOnAny, machineFailures, machineLine, machinesOf, type MachineProbes, type MachineState } from '../agents/machines';
import { entryDescription, removeUserProfile, userProfileProblems } from '../agents/settingsSection';
import type { SettingsHost } from './effects';

/** The fields of a user entry a control edits. */
export const USER_PROFILE_FIELDS = ['name', 'agent', 'command', 'args'] as const;
export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number];

/** The Agents page's name, and the first step of every user entry's page path. */
export const AGENTS_PAGE = 'Agents';

/**
 * The keys of the catalog's controls, in the stored names: whether an entry
 * is hidden from the menu (`hiddenAgents.<id>`, true for hidden), and a
 * field of a user entry (`agentProfiles.<id>.<field>`). Ids are the stored
 * ones, so a key names the same entry for as long as it exists.
 */
export type CatalogKey = `hiddenAgents.${string}` | `agentProfiles.${string}.${UserProfileField}`;

type ParsedKey = { kind: 'hidden'; id: string } | { kind: 'profile'; id: string; field: UserProfileField };

function parseKey(key: string): ParsedKey | null {
	if (key.startsWith('hiddenAgents.')) {
		const id = key.slice('hiddenAgents.'.length);
		return id ? { kind: 'hidden', id } : null;
	}
	if (!key.startsWith('agentProfiles.')) return null;
	const rest = key.slice('agentProfiles.'.length);
	const dot = rest.lastIndexOf('.');
	if (dot <= 0) return null;
	const field = rest.slice(dot + 1);
	if (!(USER_PROFILE_FIELDS as readonly string[]).includes(field)) return null;
	return { kind: 'profile', id: rest.slice(0, dot), field: field as UserProfileField };
}

/** True when `key` is one of the catalog's. */
export function isCatalogKey(key: string): key is CatalogKey {
	return parseKey(key) !== null;
}

/** What a catalog control shows. Undefined for a user entry that is gone. */
export function readCatalogSetting(settings: HerdrSettings, key: string): unknown {
	const parsed = parseKey(key);
	if (!parsed) return undefined;
	if (parsed.kind === 'hidden') return settings.hiddenAgents.includes(parsed.id);
	const user = settings.agentProfiles.find((entry) => entry.id === parsed.id);
	if (!user) return undefined;
	return parsed.field === 'args' ? user.args.join(' ') : user[parsed.field];
}

/**
 * The catalog's write path: store the value as 0.7.1's form did (the command
 * trimmed, the arguments split into plain words), save, then repaint the
 * agent lists, whose + menu reads the catalog. False, with nothing written,
 * for a user entry that is gone.
 */
export async function writeCatalogSetting(
	settings: HerdrSettings,
	key: CatalogKey,
	value: unknown,
	host: Pick<SettingsHost, 'saveSettings' | 'refreshAgentList'>,
): Promise<boolean> {
	const parsed = parseKey(key);
	if (!parsed) return false;
	if (parsed.kind === 'hidden') {
		const others = settings.hiddenAgents.filter((id) => id !== parsed.id);
		settings.hiddenAgents = value === true ? [...others, parsed.id] : others;
	} else {
		const user = settings.agentProfiles.find((entry) => entry.id === parsed.id);
		if (!user) return false;
		const text = typeof value === 'string' ? value : '';
		if (parsed.field === 'args') user.args = parseArgs(text);
		else if (parsed.field === 'command') user.command = text.trim();
		else if (parsed.field === 'agent') user.agent = text || DEFAULT_AGENT_KIND;
		else user.name = text;
	}
	await host.saveSettings();
	host.refreshAgentList();
	return true;
}

/** What the catalog needs from the tab and the plugin. */
export interface AgentCatalogHost {
	settings(): HerdrSettings;
	/** The probe that landed for this runtime's published connection, or null. */
	probe(runtimeId: string): AgentProbe | null;
	/** Probes this runtime if it is the published one and not up to date; true once a new probe landed. */
	refresh(runtimeId: string, again?: boolean): Promise<boolean>;
	/** Whether this runtime's transcripts can be read from here (ADR-0010). */
	nativeReachable(runtime: RuntimeConfig): boolean;
	/** Fresh per-machine probes, for one opening of the settings. */
	newMachineProbes(): MachineProbes;
	/** The tab's `setControlValue`, for the eye, which is a button rather than a control. */
	write(key: CatalogKey, value: unknown): Promise<void>;
	/** Persist the settings and repaint the agent lists, after an entry is added or removed. */
	saved(): Promise<void>;
	/** Asks before something destructive; resolves true to go ahead. */
	confirm(text: { title: string; body: string; confirm: string }): Promise<boolean>;
	/** The tab's `update()`: read the definitions again and draw the open page. */
	update(): void;
	/**
	 * Opens a page of the tab by its path of page ids. Obsidian has no public
	 * call for it; where the build lacks the one the tab uses, nothing happens.
	 */
	openPage(path: string[]): void;
	/** Whether {@link openPage} can open anything in this build. */
	canOpenPages(): boolean;
}

/** A page with the `id` Obsidian finds it by (1.14.5 reads `id ?? name`; not in its typings yet). */
type IdentifiedPage<K extends string> = SettingDefinitionPage<K> & { id: string };

export class AgentCatalogSession {
	private probes: MachineProbes | null = null;
	/** Bumped by {@link end}: a probe of an earlier opening that lands draws nothing. */
	private opening = 0;
	/** Every probe already followed, so drawing again does not follow it twice. */
	private readonly watched = new WeakSet<Promise<unknown>>();
	/**
	 * User entries removed from their own page in this opening, by id, with
	 * their name, where the build cannot go back to the list: their pages say so.
	 */
	private readonly removed = new Map<string, string>();

	constructor(private readonly host: AgentCatalogHost) {}

	/**
	 * Called by every drawing of the catalog (its first row's `render`): asks
	 * each machine what it has not been asked in this opening, and the active
	 * runtime for its probe, and draws the page again when an answer lands.
	 * A machine newly asked draws it again at once, so its rows say
	 * "Checking …".
	 */
	draw(): void {
		const settings = this.host.settings();
		const runtime = activeRuntimeOf(settings);
		const probes = (this.probes ??= this.host.newMachineProbes());
		const machines = machinesOf(settings.runtimes, settings.activeRuntime);
		const asked = this.follow(probes.probeAll(machines, programsToProbe('herdr-core', settings)));
		const opening = this.opening;
		void this.host.refresh(runtime.id).then((landed) => {
			if (landed) this.changed(opening);
		});
		if (asked) void Promise.resolve().then(() => this.changed(opening));
	}

	/** "Check again": the active runtime's probe and every machine, once more. */
	checkAgain(): void {
		const settings = this.host.settings();
		const runtime = activeRuntimeOf(settings);
		const opening = this.opening;
		void this.host.refresh(runtime.id, true).then((landed) => {
			if (landed) this.changed(opening);
		});
		if (!this.probes) return;
		const machines = machinesOf(settings.runtimes, settings.activeRuntime);
		this.follow(this.probes.probeAll(machines, programsToProbe('herdr-core', settings), true));
		this.host.update();
	}

	/** The settings closed: nothing of this opening draws any more, and the next one asks again. */
	end(): void {
		this.probes?.dispose();
		this.probes = null;
		this.opening++;
		this.removed.clear();
	}

	/** A new user entry, at the end of the list, its page opened where the build can. */
	async add(): Promise<void> {
		const settings = this.host.settings();
		const user: UserAgentProfile = {
			id: newAgentProfileId([...settings.agentProfiles.map((entry) => entry.id), ...this.removed.keys()]),
			name: '',
			agent: DEFAULT_AGENT_KIND,
			command: '',
			args: [],
		};
		settings.agentProfiles = [...settings.agentProfiles, user];
		await this.host.saved();
		this.host.update();
		this.host.openPage([AGENTS_PAGE, user.id]);
	}

	/**
	 * Removes a user entry after asking, with every runtime's default that
	 * named it. From its own page, goes back to the list where the build can,
	 * and otherwise leaves the page saying it was removed.
	 */
	async remove(id: string, fromItsPage = false): Promise<void> {
		const settings = this.host.settings();
		const user = settings.agentProfiles.find((entry) => entry.id === id);
		if (!user) return;
		const name = userProfile(user).name;
		const confirmed = await this.host.confirm({
			title: `Remove "${name}"?`,
			body: 'It leaves the + menu on every runtime.',
			confirm: 'Remove',
		});
		if (!confirmed || !settings.agentProfiles.some((entry) => entry.id === id)) return;
		removeUserProfile(settings, id);
		const back = fromItsPage && this.host.canOpenPages();
		if (fromItsPage && !back) this.removed.set(id, name);
		await this.host.saved();
		this.host.update();
		if (back) this.host.openPage([AGENTS_PAGE]);
	}

	/** The Agents page's mark: a warning while one of the user's entries cannot start here. */
	status(): 'warning' | null {
		const settings = this.host.settings();
		const runtime = activeRuntimeOf(settings);
		const catalog = buildCatalog({
			runtime,
			settings,
			probe: this.host.probe(runtime.id),
			nativeReachable: this.host.nativeReachable(runtime),
		});
		return catalog.some((entry) => entry.profile.source === 'user' && !entry.available) ? 'warning' : null;
	}

	/** The catalog's part of the Agents page: its heading row, the built-ins, the user's entries. */
	definitions(): SettingDefinitionItem<CatalogKey>[] {
		const settings = this.host.settings();
		const runtime = activeRuntimeOf(settings);
		const reachable = this.host.nativeReachable(runtime);
		const catalog = buildCatalog({ runtime, settings, probe: this.host.probe(runtime.id), nativeReachable: reachable });

		const probes = this.probes;
		const machines = probes ? machinesOf(settings.runtimes, settings.activeRuntime) : [];
		const programs = programsToProbe('herdr-core', settings);
		const states: ReadonlyMap<string, MachineState> = probes?.states(machines) ?? new Map();
		const describe = (entry: CatalogEntry, extra: boolean): string => {
			const line =
				probes && entry.profile.source !== 'template' && programs.includes(entry.profile.command)
					? machineLine(entry.profile.command, machines, states)
					: undefined;
			const text = entryDescription(entry, runtime, line);
			return extra ? `${text} Not in the menu on ${runtimeDisplayName(runtime)}.` : text;
		};

		// Built-ins this runtime's catalog left out that another machine has: listed, greyed.
		const inCatalog = new Set(catalog.map((entry) => entry.profile.id));
		const elsewhere: CatalogEntry[] = builtinProfiles()
			.filter((profile) => !inCatalog.has(profile.id) && foundOnAny(profile.command, machines, states))
			.map((profile) => ({
				profile,
				available: false,
				reason: null,
				found: null,
				hidden: settings.hiddenAgents.includes(profile.id),
				isDefault: false,
				native: reachable && offersNativeView(runtime.kind, profile.agent),
			}));

		const failures = machineFailures(machines, states);
		const intro = `What the + button offers on ${runtimeDisplayName(runtime)} (${RUNTIME_KIND_LABELS[runtime.kind]}): a left click starts the default, a right click lists them all. Agent CLIs not installed ${machinePhrase(runtime)} are left out; your own entries always show. Each row says which of your runtimes' machines have it, checked once each time settings open.`;
		const header: SettingDefinition = {
			name: 'Agent CLIs',
			desc: failures ? `${intro} ${failures}` : intro,
			aliases: ['agent', 'hide agent', 'check again'],
			render: (setting) => {
				setting.addButton((button) => button.setButtonText('Check again').onClick(() => this.checkAgain()));
				this.draw();
			},
		};

		const builtins = [
			...catalog.filter((entry) => entry.profile.source !== 'user').map((entry) => this.builtinRow(entry, describe(entry, false))),
			...elsewhere.map((entry) => this.builtinRow(entry, describe(entry, true))),
		];

		const users = catalog.filter((entry) => entry.profile.source === 'user');
		const pages: IdentifiedPage<CatalogKey>[] = [];
		for (const entry of users) {
			const user = settings.agentProfiles.find((candidate) => candidate.id === entry.profile.id);
			if (user) pages.push(this.userPage(user, entry, describe(entry, false)));
		}
		for (const [id, name] of this.removed) pages.push(removedPage(id, name));
		const ids = pages.map((page) => page.id);

		return [
			{ type: 'group', items: [header] },
			{
				type: 'list',
				heading: 'Built-in agent CLIs',
				emptyState: `None found ${machinePhrase(runtime)}.`,
				items: builtins,
			},
			{
				type: 'list',
				heading: 'Your agent CLIs',
				emptyState: 'None yet. Add a wrapper, another command, or an agent with extra arguments.',
				addItem: { name: 'Add agent CLI', action: () => void this.add() },
				onDelete: (index) => {
					const id = ids[index];
					if (id && !this.removed.has(id)) void this.remove(id);
				},
				items: pages,
			},
		];
	}

	/** A built-in or template row: its line, and the eye. */
	private builtinRow(entry: CatalogEntry, desc: string): SettingDefinition<CatalogKey> {
		const { profile } = entry;
		return {
			name: profile.name,
			desc,
			render: (setting) => {
				setting.settingEl.toggleClass('herdr-agent-profile', true);
				setting.settingEl.toggleClass('herdr-agent-unavailable', !entry.available);
				setting.addExtraButton((button) =>
					button
						.setIcon(entry.hidden ? 'eye-off' : 'eye')
						.setTooltip(entry.hidden ? 'Show in the menu' : 'Hide from the menu')
						.onClick(() => void this.host.write(`hiddenAgents.${profile.id}`, !entry.hidden)),
				);
			},
		};
	}

	/** A user entry's page: its fields, where it starts, and removing it. */
	private userPage(user: UserAgentProfile, entry: CatalogEntry, desc: string): IdentifiedPage<CatalogKey> {
		const { id } = user;
		const agents: Record<string, string> = {};
		for (const agent of BUILTIN_AGENTS) agents[agent.kind] = agent.name;
		if (!(user.agent in agents)) agents[user.agent] = user.agent;
		const fields: SettingGroupItem<CatalogKey>[] = [
			{
				name: 'Name',
				desc: 'What the menu calls it. Empty shows the command.',
				control: { type: 'text', key: `agentProfiles.${id}.name`, placeholder: userProfile({ ...user, name: '' }).name },
			},
			{
				name: 'Agent',
				desc: 'Which agent it is: what herdr starts and detects, and the mark its rows show.',
				control: { type: 'dropdown', key: `agentProfiles.${id}.agent`, options: agents },
			},
			{
				name: 'Command',
				desc: 'The program to run, a name or a path; ~/ is the home of the machine it runs on. Empty runs the agent’s own program, the only one herdr can start; a command of your own starts on herdr-core.',
				control: { type: 'text', key: `agentProfiles.${id}.command`, placeholder: programOf(user.agent) },
			},
			{
				name: 'Arguments',
				desc: 'Added after the program, separated by spaces. Plain words only: letters, digits and ._=/:@+,-',
				control: { type: 'text', key: `agentProfiles.${id}.args`, placeholder: '--model sonnet' },
			},
			{
				name: 'Hide from the menu',
				desc: 'Keeps it out of the + menu on every runtime.',
				control: { type: 'toggle', key: `hiddenAgents.${id}` },
			},
			{ name: 'Where it starts', desc: userProfileProblems(user) },
			{
				name: 'Remove agent CLI',
				desc: 'Asks first. It leaves the + menu on every runtime.',
				render: (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText('Remove')
							.setDestructive()
							.onClick(() => void this.remove(id, true)),
					);
				},
			},
		];
		return {
			type: 'page',
			id,
			name: entry.profile.name,
			desc,
			status: entry.available ? null : 'warning',
			items: [{ type: 'group', items: fields }],
		};
	}

	/** Something the rows show changed: draw the open page again, unless the settings closed since. */
	private changed(opening: number): void {
		if (opening === this.opening) this.host.update();
	}

	/** Follows each probe not followed yet; true when there was one. */
	private follow(pending: readonly Promise<unknown>[]): boolean {
		let fresh = false;
		const opening = this.opening;
		for (const one of pending) {
			if (this.watched.has(one)) continue;
			this.watched.add(one);
			fresh = true;
			void one.then(() => this.changed(opening));
		}
		return fresh;
	}
}

/**
 * A user entry removed from its own page where the build has no call that
 * leaves a page: the page stays findable, hidden from the list, and says so,
 * until the settings close.
 */
function removedPage(id: string, name: string): IdentifiedPage<CatalogKey> {
	return {
		type: 'page',
		id,
		name,
		visible: false,
		items: [
			{
				type: 'group',
				items: [{ name: 'Removed', desc: `"${name}" is no longer in the + menu. Go back to the agent CLIs.`, searchable: false }],
			},
		],
	};
}
