/**
 * What is left of the 0.7.1 builders' plumbing: {@link ListCallbacks}, what
 * a runtime page's default agent (the catalog's setting, issue #125) is
 * handed, and {@link blockOf} for `render` rows. The runtime list is a
 * declarative `list` since #178 (`runtimes.ts`), the agent CLI catalog since
 * #179 (`agentCatalog.ts`).
 */

import type { Setting } from 'obsidian';
import type { AgentProbe } from '../agents/catalog';
import type { RuntimeConfig } from '../runtimes';

/**
 * What a runtime's default agent setting may do besides write into the
 * settings it was handed. The tab builds it from the plugin.
 */
export interface ListCallbacks {
	/** Persist the settings as they now are. */
	save: () => Promise<void>;
	/** Repaint every open agent list (issue #20). */
	refreshAgentList: () => void;
	/**
	 * Whether a runtime's transcripts can be read from here, which the agent
	 * catalog's native flag needs beside the agent seam's gate (ADR-0010).
	 * Not given reads as true.
	 */
	nativeReachable?: (runtime: RuntimeConfig) => boolean;
	/**
	 * The probe that landed for this runtime's published connection (null
	 * when none did, or it is not the connected one), for a runtime's
	 * default agent (issue #125).
	 */
	agents?: {
		probe: (runtimeId: string) => AgentProbe | null;
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
