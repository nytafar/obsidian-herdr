/**
 * The agent catalog in the settings tab (issue #125): the active runtime's
 * agent CLIs, each with whether its probe found it, a switch to hide it from
 * the + menu, and the user's own entries with their form; and a runtime's
 * default agent, in that runtime's form.
 *
 * The decisions are `catalog.ts`'s; this file draws them. The probe is the
 * plugin's (`ListCallbacks.agents`), read from its cache: the list draws
 * at once with what is known and draws again once a probe lands. Typing in a
 * user entry's form probes nothing; the tab drawing again (Done, Check
 * again, reopening it) brings the probe up to the entries as they are then.
 *
 * Each row also says which machines, across every configured runtime, have
 * its program (`machines.ts`): drawing the section asks each machine once
 * per opening of the tab, "Check again" asks again, and a row's line changes
 * in place as each machine answers. A built-in the active runtime's catalog
 * left out but another machine has is listed too, greyed: it is not in this
 * runtime's menu.
 */

import { Setting } from 'obsidian';
import type { HerdrSettings } from '../settings';
import type { ListCallbacks } from '../settingsTab/lists';
import { activeRuntimeOf, runtimeDisplayName, RUNTIME_KIND_LABELS, type RuntimeConfig } from '../runtimes';
import { offersNativeView } from './format';
import {
	foundOnAny,
	machineFailures,
	machineLine,
	machinesOf,
	type Machine,
	type MachineState,
} from './machines';
import {
	BUILTIN_AGENTS,
	builtinProfiles,
	buildCatalog,
	DEFAULT_AGENT_KIND,
	kindIssue,
	machinePhrase,
	newAgentProfileId,
	parseArgs,
	programOf,
	programsToProbe,
	profileKinds,
	UNVERIFIED_PREFIX,
	userProfile,
	type CatalogEntry,
	type UserAgentProfile,
} from './catalog';

/**
 * One entry's line under its name: what it runs, and what is known of it.
 * With `machines`, the line of every machine ({@link machineLine}) says where
 * it was found instead of the active runtime's probe, whose failure the
 * section then says once rather than on every row.
 */
export function entryDescription(
	entry: CatalogEntry,
	runtime: Pick<RuntimeConfig, 'target' | 'host'>,
	machines?: string,
): string {
	const { profile } = entry;
	const parts: string[] = [];
	parts.push(profile.template ? 'hc template.' : `Runs ${[profile.command, ...profile.args].join(' ')}.`);
	if (machines !== undefined) {
		if (machines) parts.push(machines);
		if (entry.found === false) parts.push('It may still start.');
		else if (entry.reason && !entry.reason.startsWith(UNVERIFIED_PREFIX)) parts.push(sentence(entry.reason));
	} else {
		if (entry.found === true) parts.push(`Found ${machinePhrase(runtime)}.`);
		if (entry.reason) parts.push(sentence(entry.reason));
		else if (entry.found === null && profile.source !== 'template') parts.push('Not checked yet.');
	}
	if (entry.isDefault) parts.push('Default.');
	if (entry.hidden) parts.push('Hidden from the menu.');
	if (entry.native) parts.push('Has the native view.');
	return parts.join(' ');
}

function sentence(text: string): string {
	const trimmed = text.trim();
	const upper = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

/**
 * The choices of a runtime's "Default agent" dropdown: first installed, then
 * every entry of its catalog that can start there, hidden ones included.
 */
export function defaultAgentChoices(catalog: readonly CatalogEntry[]): { id: string; name: string }[] {
	const choices = [{ id: '', name: 'First installed' }];
	for (const entry of catalog) {
		if (entry.available) choices.push({ id: entry.profile.id, name: entry.profile.name });
	}
	return choices;
}

/** The catalog a runtime's settings show: its probe when it is the active one. */
function catalogFor(runtime: RuntimeConfig, settings: HerdrSettings, callbacks: ListCallbacks): CatalogEntry[] {
	return buildCatalog({
		runtime,
		settings,
		probe: callbacks.agents?.probe(runtime.id) ?? null,
		nativeReachable: callbacks.nativeReachable?.(runtime) ?? true,
	});
}

/** "Default agent" in a runtime's form. */
export function buildDefaultAgentSetting(
	containerEl: HTMLElement,
	runtime: RuntimeConfig,
	settings: HerdrSettings,
	callbacks: ListCallbacks,
): void {
	const catalog = catalogFor(runtime, settings, callbacks);
	const stored = settings.defaultAgents[runtime.id] ?? '';
	new Setting(containerEl)
		.setName('Default agent')
		.setDesc(
			'What the + button in the agent list and the folder menus start on this runtime. First installed is the first agent CLI found on its machine.',
		)
		.addDropdown((dropdown) => {
			const choices = defaultAgentChoices(catalog);
			for (const choice of choices) dropdown.addOption(choice.id, choice.name);
			// A stored default this runtime cannot start now still shows as chosen.
			if (stored && !choices.some((choice) => choice.id === stored)) dropdown.addOption(stored, `${stored} (not available)`);
			dropdown.setValue(stored).onChange(async (value) => {
				const next = { ...settings.defaultAgents };
				if (value) next[runtime.id] = value;
				else delete next[runtime.id];
				settings.defaultAgents = next;
				await callbacks.save();
				callbacks.refreshAgentList();
			});
		});
}

/**
 * The agent CLIs of the active runtime, and the user's own entries. Draws
 * with the cached probe; when the active runtime has not been probed yet on
 * this connection, asks for one and draws again once it lands.
 */
export function buildAgentCatalogSettings(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: ListCallbacks,
): void {
	const runtime = activeRuntimeOf(settings);
	const agents = callbacks.agents;
	const probe = agents?.probe(runtime.id) ?? null;
	const reachable = callbacks.nativeReachable?.(runtime) ?? true;
	const catalog = buildCatalog({ runtime, settings, probe, nativeReachable: reachable });

	// Every machine of every runtime, each asked once per opening of the tab.
	const probes = agents?.machines?.() ?? null;
	const machines: Machine[] = probes ? machinesOf(settings.runtimes, settings.activeRuntime) : [];
	const programs = programsToProbe('herdr-core', settings);
	const isCurrent = probes?.beginDraw() ?? (() => false);
	const pending = probes?.probeAll(machines, programs) ?? [];
	const statesNow = (): Map<string, MachineState> => probes?.states(machines) ?? new Map<string, MachineState>();
	const states = statesNow();
	const lineFor = (entry: CatalogEntry, current: ReadonlyMap<string, MachineState>): string | undefined =>
		probes && entry.profile.source !== 'template' && programs.includes(entry.profile.command)
			? machineLine(entry.profile.command, machines, current)
			: undefined;
	const inCatalog = new Set(catalog.map((entry) => entry.profile.id));
	/** Built-ins this runtime's catalog left out that another machine has. */
	const elsewhere = (current: ReadonlyMap<string, MachineState>): CatalogEntry[] =>
		builtinProfiles()
			.filter((profile) => !inCatalog.has(profile.id) && foundOnAny(profile.command, machines, current))
			.map((profile) => ({
				profile,
				available: false,
				reason: null,
				found: null,
				hidden: settings.hiddenAgents.includes(profile.id),
				isDefault: false,
				native: reachable && offersNativeView(runtime.kind, profile.agent),
			}));

	const baseDesc = `What the + button offers on ${runtimeDisplayName(runtime)} (${RUNTIME_KIND_LABELS[runtime.kind]}): a left click starts the default, a right click lists them all. Agent CLIs not installed ${machinePhrase(runtime)} are left out; your own entries always show. Each row says which of your runtimes' machines have it, checked once each time settings open.`;
	const headerDesc = (current: ReadonlyMap<string, MachineState>): string => {
		const failures = machineFailures(machines, current);
		return failures ? `${baseDesc} ${failures}` : baseDesc;
	};
	const drawn: { row: Setting; entry: CatalogEntry; extra: boolean }[] = [];
	const describe = (entry: CatalogEntry, extra: boolean, current: ReadonlyMap<string, MachineState>): string => {
		const text = entryDescription(entry, runtime, lineFor(entry, current));
		return extra ? `${text} Not in the menu on ${runtimeDisplayName(runtime)}.` : text;
	};

	const header = new Setting(containerEl)
		.setName('Agent CLIs')
		.setDesc(headerDesc(states))
		.addButton((button) =>
			button
				.setButtonText('Check again')
				.setDisabled(!agents)
				.onClick(async () => {
					const landed = agents?.refresh(runtime.id, true);
					if (probes) watch(probes.probeAll(machines, programs, true));
					if (await landed) callbacks.redisplay();
				}),
		);

	// A machine that answered changes its rows in place; one that shows a
	// built-in not drawn yet draws the tab again, once.
	const drawnExtras = elsewhere(states)
		.map((entry) => entry.profile.id)
		.join('\n');
	let redrawn = false;
	const update = (): void => {
		if (redrawn || !isCurrent()) return;
		const current = statesNow();
		const extras = elsewhere(current)
			.map((entry) => entry.profile.id)
			.join('\n');
		if (extras !== drawnExtras) {
			redrawn = true;
			callbacks.redisplay();
			return;
		}
		header.setDesc(headerDesc(current));
		for (const { row, entry, extra } of drawn) row.setDesc(describe(entry, extra, current));
	};
	function watch(landing: readonly Promise<unknown>[]): void {
		for (const one of landing) void one.then(update);
	}

	const hidden = new Set(settings.hiddenAgents);
	const setHidden = async (id: string, hide: boolean): Promise<void> => {
		if (hide) hidden.add(id);
		else hidden.delete(id);
		settings.hiddenAgents = [...hidden];
		await callbacks.save();
		callbacks.refreshAgentList();
		callbacks.redisplay();
	};

	const rows = [
		...catalog.map((entry) => ({ entry, extra: false })),
		...elsewhere(states).map((entry) => ({ entry, extra: true })),
	];
	for (const { entry, extra } of rows) {
		const { profile } = entry;
		const row = new Setting(containerEl).setName(profile.name).setDesc(describe(entry, extra, states));
		drawn.push({ row, entry, extra });
		row.setClass('herdr-agent-profile');
		if (!entry.available) row.setClass('herdr-agent-unavailable');
		row.addExtraButton((button) =>
			button
				.setIcon(entry.hidden ? 'eye-off' : 'eye')
				.setTooltip(entry.hidden ? 'Show in the menu' : 'Hide from the menu')
				.onClick(() => void setHidden(profile.id, !entry.hidden)),
		);
		if (profile.source !== 'user') continue;
		row.addExtraButton((button) =>
			button
				.setIcon('pencil')
				.setTooltip('Edit agent CLI')
				.onClick(() => agents?.edit(agents.editing() === profile.id ? null : profile.id)),
		);
		row.addExtraButton((button) =>
			button
				.setIcon('trash-2')
				.setTooltip('Remove agent CLI')
				.onClick(async () => {
					const confirmed = await callbacks.confirm({
						title: `Remove "${profile.name}"?`,
						body: 'It leaves the + menu on every runtime.',
						confirm: 'Remove',
					});
					if (!confirmed) return;
					removeUserProfile(settings, profile.id);
					if (agents?.editing() === profile.id) agents.edit(null);
					await callbacks.save();
					callbacks.refreshAgentList();
					callbacks.redisplay();
				}),
		);
	}

	new Setting(containerEl)
		.setName('Add agent CLI')
		.setDesc('Your own entry: a wrapper, another command, or extra arguments for an agent.')
		.addButton((button) =>
			button.setButtonText('Add agent CLI').onClick(async () => {
				const user: UserAgentProfile = {
					id: newAgentProfileId([...settings.agentProfiles.map((entry) => entry.id)]),
					name: '',
					agent: DEFAULT_AGENT_KIND,
					command: '',
					args: [],
				};
				settings.agentProfiles = [...settings.agentProfiles, user];
				await callbacks.save();
				callbacks.refreshAgentList();
				if (agents) agents.edit(user.id);
				else callbacks.redisplay();
			}),
		);

	const editing = settings.agentProfiles.find((entry) => entry.id === agents?.editing());
	if (editing) buildUserProfileForm(containerEl, editing, callbacks);

	// Not probed for these entries on this runtime's connection yet: ask,
	// and draw again once, when it lands. Nothing to ask (the probe is up to
	// date, or the published connection is another runtime's) draws nothing.
	if (agents) {
		void agents.refresh(runtime.id).then((landed) => {
			if (landed) callbacks.redisplay();
		});
	}
	watch(pending);
}

/** Takes a user entry out, with every runtime's default that named it. */
export function removeUserProfile(settings: HerdrSettings, id: string): void {
	settings.agentProfiles = settings.agentProfiles.filter((entry) => entry.id !== id);
	settings.hiddenAgents = settings.hiddenAgents.filter((entry) => entry !== id);
	const defaults = { ...settings.defaultAgents };
	for (const [runtimeId, profileId] of Object.entries(defaults)) {
		if (profileId === id) delete defaults[runtimeId];
	}
	settings.defaultAgents = defaults;
}

/** Where a user entry starts, or what stops it, as one sentence per kind. */
export function userProfileProblems(user: UserAgentProfile): string {
	const profile = userProfile(user);
	const kinds = profileKinds(profile);
	const parts: string[] = [];
	if (kinds.length > 0) parts.push(`Starts on ${kinds.map((kind) => RUNTIME_KIND_LABELS[kind]).join(', ')}.`);
	for (const kind of ['herdr', 'herdr-core'] as const) {
		const issue = kindIssue(profile, kind);
		if (issue) parts.push(`${RUNTIME_KIND_LABELS[kind]}: ${sentence(issue)}`);
	}
	return parts.join(' ');
}

/** The fields of one user entry. Typing saves; nothing redraws the field. */
function buildUserProfileForm(containerEl: HTMLElement, user: UserAgentProfile, callbacks: ListCallbacks): void {
	new Setting(containerEl).setName(`Edit ${userProfile(user).name}`).setHeading();
	let problems: Setting | null = null;
	const changed = async (): Promise<void> => {
		problems?.setDesc(userProfileProblems(user));
		await callbacks.save();
		callbacks.refreshAgentList();
	};

	new Setting(containerEl)
		.setName('Name')
		.setDesc('What the menu calls it. Empty shows the command.')
		.addText((field) =>
			field
				.setPlaceholder(userProfile({ ...user, name: '' }).name)
				.setValue(user.name)
				.onChange(async (value) => {
					user.name = value;
					await changed();
				}),
		);

	new Setting(containerEl)
		.setName('Agent')
		.setDesc('Which agent it is: what herdr starts and detects, and the mark its rows show.')
		.addDropdown((dropdown) => {
			for (const agent of BUILTIN_AGENTS) dropdown.addOption(agent.kind, agent.name);
			if (!BUILTIN_AGENTS.some((agent) => agent.kind === user.agent)) dropdown.addOption(user.agent, user.agent);
			dropdown.setValue(user.agent).onChange(async (value) => {
				user.agent = value;
				await changed();
			});
		});

	new Setting(containerEl)
		.setName('Command')
		.setDesc(
			'The program to run, a name or a path; ~/ is the home of the machine it runs on. Empty runs the agent’s own program, the only one herdr can start; a command of your own starts on herdr-core.',
		)
		.addText((field) =>
			field
				.setPlaceholder(programOf(user.agent))
				.setValue(user.command)
				.onChange(async (value) => {
					user.command = value.trim();
					await changed();
				}),
		);

	new Setting(containerEl)
		.setName('Arguments')
		.setDesc('Added after the program, separated by spaces. Plain words only: letters, digits and ._=/:@+,-')
		.addText((field) =>
			field
				.setPlaceholder('--model sonnet')
				.setValue(user.args.join(' '))
				.onChange(async (value) => {
					user.args = parseArgs(value);
					await changed();
				}),
		);

	problems = new Setting(containerEl).setName('Where it starts').setDesc(userProfileProblems(user));

	new Setting(containerEl).addButton((button) =>
		button
			.setButtonText('Done')
			.setCta()
			.onClick(() => callbacks.agents?.edit(null)),
	);
}
