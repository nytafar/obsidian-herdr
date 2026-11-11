/**
 * The part of the tab still drawn imperatively, as in 0.7.1: the agent CLI
 * catalog (#179), a `render` definition around its old builder, and
 * {@link ListCallbacks}, what that builder (and the runtime page's default
 * agent, which is the catalog's) is handed. The runtime list became a
 * declarative `list` in #178 (`runtimes.ts`).
 */

import type { Setting, SettingDefinitionRender } from 'obsidian';
import type { AgentProbe } from '../agents/catalog';
import type { MachineProbes } from '../agents/machines';
import { buildAgentCatalogSettings } from '../agents/settingsSection';
import type { HerdrSettings } from '../settings';
import type { RuntimeConfig } from '../runtimes';

/**
 * What the agent catalog may do besides write into the settings it was
 * handed. The tab builds it from the plugin.
 */
export interface ListCallbacks {
	/** Persist the settings as they now are. */
	save: () => Promise<void>;
	/** Draw the page again, for a change that shows or hides rows. */
	redisplay: () => void;
	/** Repaint every open agent list (issue #20). */
	refreshAgentList: () => void;
	/**
	 * Whether a runtime's transcripts can be read from here, which the agent
	 * catalog's native flag needs beside the agent seam's gate (ADR-0010).
	 * Not given reads as true.
	 */
	nativeReachable?: (runtime: RuntimeConfig) => boolean;
	/** Asks before something destructive; resolves true to go ahead. */
	confirm: (text: { title: string; body: string; confirm: string }) => Promise<boolean>;
	/**
	 * The agent catalog (issue #125): the probe that landed for this runtime's
	 * published connection (null when none did, or it is not the connected
	 * one), a probe of the published connection (true once one landed), and
	 * which user entry's form is open.
	 */
	agents?: {
		probe: (runtimeId: string) => AgentProbe | null;
		/** Probes this runtime if it is the published one and is not up to date; true once a new probe landed. */
		refresh: (runtimeId: string, again?: boolean) => Promise<boolean>;
		editing: () => string | null;
		edit: (id: string | null) => void;
		/**
		 * The per-machine probes of this opening of the tab: which machines,
		 * across every configured runtime, each agent CLI was found on.
		 */
		machines?: () => MachineProbes;
	};
}

/**
 * The row a `render` definition is handed, emptied and turned into a plain
 * block, so a builder can put rows of its own in it.
 */
export function blockOf(setting: Setting, ...classes: string[]): HTMLElement {
	const el = setting.settingEl;
	el.empty();
	el.addClass('herdr-settings-block', ...classes);
	return el;
}

/** The agent CLI catalog, until #179. */
export function agentCatalogDefinition(
	settings: () => HerdrSettings,
	callbacks: ListCallbacks,
): SettingDefinitionRender {
	return {
		name: 'Agent CLIs',
		desc: 'The agent CLIs the + button offers, and your own entries.',
		aliases: ['agent', 'add agent CLI', 'hide agent'],
		render: (setting) => buildAgentCatalogSettings(blockOf(setting), settings(), callbacks),
	};
}
