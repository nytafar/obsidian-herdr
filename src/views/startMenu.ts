/**
 * The + button's right-click menu (issue #125): the active runtime's agent
 * catalog, the default first and checked, each entry starting that agent at
 * the vault root. An entry that cannot start there is shown greyed with the
 * reason rather than left out. Pure, so the view only draws what this says;
 * tested in `tests/agentCatalog.test.ts`.
 */

import { iconForKind } from './kindIcons';
import { launchOf, menuEntries, type AgentLaunch, type CatalogEntry } from '../agents/catalog';

export interface StartMenuItem {
	title: string;
	icon: string;
	/** The runtime's default, which a left click starts. */
	checked: boolean;
	disabled: boolean;
	/** What starting it hands `startAgentHere`; null for a disabled entry. */
	launch: AgentLaunch | null;
}

/** The menu for a catalog, or one disabled line when it is empty. */
export function startMenuItems(catalog: readonly CatalogEntry[]): StartMenuItem[] {
	const items = menuEntries(catalog).map((entry): StartMenuItem => {
		const { profile } = entry;
		const icon = profile.template ? 'file-text' : iconForKind(profile.agent);
		if (!entry.available) {
			return {
				title: `${profile.name} (${entry.reason ?? 'cannot start here'})`,
				icon,
				checked: false,
				disabled: true,
				launch: null,
			};
		}
		return { title: profile.name, icon, checked: entry.isDefault, disabled: false, launch: launchOf(profile) };
	});
	if (items.length > 0) return items;
	return [{ title: 'No agent CLI found', icon: 'bot', checked: false, disabled: true, launch: null }];
}

/** The + button's tooltip: what a left click starts, and where the rest is. */
export function startButtonLabel(catalog: readonly CatalogEntry[]): string {
	const chosen = catalog.find((entry) => entry.isDefault);
	const start = chosen ? `Start ${chosen.profile.name} in the vault` : 'Start agent in the vault';
	return `${start}. Right-click to choose another.`;
}
