/**
 * What the settings say about agent CLIs (issue #125): one catalog entry's
 * line, a user entry's "Where it starts", removing a user entry, and a
 * runtime's default agent, in that runtime's form. The catalog itself is the
 * Agents page's lists (`settingsTab/agentCatalog.ts`, issue #179).
 *
 * The decisions are `catalog.ts`'s; this file words them.
 */

import { Setting } from 'obsidian';
import type { HerdrSettings } from '../settings';
import type { ListCallbacks } from '../settingsTab/lists';
import { RUNTIME_KIND_LABELS, type RuntimeConfig } from '../runtimes';
import { buildCatalog, kindIssue, machinePhrase, profileKinds, UNVERIFIED_PREFIX, userProfile, type CatalogEntry, type UserAgentProfile } from './catalog';

/**
 * One entry's line under its name: what it runs, and what is known of it.
 * With `machines`, the line of every machine (`machineLine` in `machines.ts`) says where
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
