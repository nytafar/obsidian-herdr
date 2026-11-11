/**
 * The part of the tab that is still drawn imperatively, as in 0.7.1: the
 * runtime list (#178 replaces it), a `render` definition around its old
 * builder, and {@link ListCallbacks}, what that builder is handed. The agent
 * CLI catalog is `agentCatalog.ts` since #179.
 */

import type { Setting, SettingDefinitionRender } from 'obsidian';
import type { AgentProbe } from '../agents/catalog';
import type { HerdrSettings } from '../settings';
import type { RuntimeConfig, RuntimeKind } from '../runtimes';
import { buildRuntimesSection } from './runtimeList';

/**
 * What the runtime list may do besides write into the settings it was
 * handed. The tab builds it from the plugin.
 */
export interface ListCallbacks {
	/** Persist the settings as they now are. */
	save: () => Promise<void>;
	/** Persist, then rebuild the connection from them. Connection fields only. */
	saveAndReconnect: () => Promise<void>;
	/** Draw the page again, for a change that shows or hides rows. */
	redisplay: () => void;
	/** Repaint every open agent list (issue #20). */
	refreshAgentList: () => void;
	/**
	 * Make this runtime the active one: save, then reconnect at once, the same
	 * as the agent list's switcher (ADR-0004).
	 */
	activateRuntime: (id: string) => Promise<void>;
	/** A runtime's name or the list changed: retitle the switcher and the status bar. */
	refreshRuntimes: () => void;
	/** Why runtimes of this kind cannot connect in this build, or null when they can. */
	kindUnavailable: (kind: RuntimeKind) => string | null;
	/**
	 * Whether a runtime's transcripts can be read from here, which the agent
	 * catalog's native flag needs beside the agent seam's gate (ADR-0010).
	 * Not given reads as true.
	 */
	nativeReachable?: (runtime: RuntimeConfig) => boolean;
	/** The runtime whose form is open, or null. Held by the tab across redisplays. */
	editingRuntime: () => string | null;
	/** Opens the form for a runtime, or closes it with null, and redisplays. */
	editRuntime: (id: string | null) => void;
	/** Asks before something destructive; resolves true to go ahead. */
	confirm: (text: { title: string; body: string; confirm: string }) => Promise<boolean>;
	/**
	 * The active herdr-core runtime's Claude session hook (ADR-0006): its
	 * status line (null while not connected), and the review modal, which
	 * calls back after it wrote something.
	 */
	sessionHook?: {
		status: () => Promise<{ text: string; warning: boolean } | null>;
		review: (onDone: () => void) => void;
	};
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

/** The runtime list, until #178. */
export function runtimeListDefinition(
	settings: () => HerdrSettings,
	callbacks: ListCallbacks,
): SettingDefinitionRender {
	return {
		name: 'Runtimes',
		desc: 'The herdr, herdr-core or Claude runtimes to connect to, and which one is active.',
		aliases: ['runtime', 'herdr', 'herdr-core', 'SSH', 'socket', 'workspace', 'add runtime'],
		render: (setting) => buildRuntimesSection(blockOf(setting), settings(), callbacks),
	};
}
