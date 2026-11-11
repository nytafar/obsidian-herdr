/**
 * The settings tab on Obsidian's declarative settings API (issue #156,
 * ADR-0011). {@link settingDefinitions} is the single description of the tab:
 * the active runtime's line on the root, then one page per area, each from
 * its own module. Every control reads and writes through
 * `getControlValue`/`setControlValue`, which go to `effects.ts`: store,
 * save, then the key's effect.
 */

import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import type HerdrPlugin from '../main';
import type { ConnectionStatusSource, HerdrSettings } from '../settings';
import { ConfirmModal } from '../views/modals';
import { buildDefaultAgentSetting } from '../agents/settingsSection';
import { readSetting, writeSetting, type TabKey } from './effects';
import type { ListCallbacks } from './lists';
import { AgentCatalogSession, isCatalogKey, readCatalogSetting, writeCatalogSetting, type CatalogKey } from './agentCatalog';
import { parseRuntimeKey, type RuntimeField } from './runtimeKeys';
import { activeRuntimeLine, redrawsPage, runtimesPage, type RuntimesHost } from './runtimes';
import { agentsPage } from './agents';
import { viewsPage } from './views';
import { terminalPage } from './terminal';
import { agentListPage } from './agentList';

/**
 * The whole tab, root first. Values are read at render time, through
 * `settings`. Every fact is shown in one place, next to where it is acted
 * on: the root names the active runtime and whether it is connected, the
 * runtime's own page says how.
 */
export function settingDefinitions(
	settings: () => HerdrSettings,
	runtimes: RuntimesHost,
	catalog: AgentCatalogSession,
): SettingDefinitionItem<TabKey | CatalogKey>[] {
	return [
		activeRuntimeLine(runtimes),
		runtimesPage(settings, runtimes),
		agentsPage(settings, catalog.definitions()),
		viewsPage(settings),
		terminalPage(settings),
		agentListPage(),
	];
}

export class HerdrSettingTab extends PluginSettingTab {
	private readonly plugin: HerdrPlugin;
	private readonly connection: ConnectionStatusSource;
	/** What a runtime page's rows redraw on: every write to a `runtimes.<id>.<field>` key. */
	private readonly runtimeWrites = new Set<(id: string, field: RuntimeField) => void>();
	/** The agent CLI catalog of this opening of the tab: its machine probes (issue #179). */
	private readonly catalog: AgentCatalogSession;

	constructor(app: App, plugin: HerdrPlugin, connection: ConnectionStatusSource) {
		super(app, plugin);
		this.plugin = plugin;
		this.connection = connection;
		this.catalog = new AgentCatalogSession({
			settings: () => plugin.settings,
			probe: (runtimeId) => plugin.agentCatalogs.cachedProbeFor(runtimeId),
			refresh: (runtimeId, again) => plugin.agentCatalogs.refresh(runtimeId, again),
			nativeReachable: (runtime) => plugin.nativeReachable(runtime),
			newMachineProbes: () => plugin.newMachineProbes(),
			write: (key, value) => this.setControlValue(key, value),
			saved: async () => {
				await plugin.saveSettings();
				plugin.refreshAgentList();
			},
			confirm: (text) => new ConfirmModal(this.app, { ...text, warning: true }).ask(),
			update: () => this.update(),
		});
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return settingDefinitions(() => this.plugin.settings, this.runtimesHost(this.listCallbacks()), this.catalog);
	}

	getControlValue(key: string): unknown {
		if (isCatalogKey(key)) return readCatalogSetting(this.plugin.settings, key);
		return readSetting(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (isCatalogKey(key)) {
			// A catalog value shows in its row's line and on its page's entry,
			// so the definitions are read again; a field being typed in is kept.
			if (await writeCatalogSetting(this.plugin.settings, key, value, this.plugin)) this.update();
			return;
		}
		await writeSetting(this.plugin.settings, key, value, this.plugin);
		const runtime = parseRuntimeKey(key);
		if (!runtime) return;
		for (const listener of [...this.runtimeWrites]) listener(runtime.id, runtime.field);
		if (redrawsPage(runtime.field)) this.update();
	}

	/** Closing the tab ends its machine probes: the next opening asks again. */
	hide(): void {
		this.catalog.end();
		super.hide();
	}

	/** What a runtime page's default agent is handed (issue #125). */
	private listCallbacks(): ListCallbacks {
		const { plugin } = this;
		return {
			save: () => plugin.saveSettings(),
			refreshAgentList: () => plugin.refreshAgentList(),
			nativeReachable: (runtime) => plugin.nativeReachable(runtime),
			agents: {
				probe: (runtimeId) => plugin.agentCatalogs.cachedProbeFor(runtimeId),
			},
		};
	}

	/** What the Runtimes page is handed (#178). */
	private runtimesHost(lists: ListCallbacks): RuntimesHost {
		const { plugin } = this;
		return {
			kindUnavailable: (kind) => plugin.kindUnavailable(kind),
			activate: (id) => plugin.switchRuntime(id),
			save: () => plugin.saveSettings(),
			refreshRuntimes: () => plugin.refreshRuntimes(),
			confirm: (text) => new ConfirmModal(this.app, { ...text, warning: true }).ask(),
			update: () => this.update(),
			openPage: (path) => this.openPage(path),
			canOpenPages: this.pageOpener() !== null,
			connection: this.connection,
			onRuntimeWrite: (listener) => {
				this.runtimeWrites.add(listener);
				return () => {
					this.runtimeWrites.delete(listener);
				};
			},
			sessionHook: {
				status: () => plugin.sessionHookStatus(),
				review: (onDone) => plugin.openSessionHook(onDone),
			},
			drawDefaultAgent: (el, runtime) => buildDefaultAgentSetting(el, runtime, plugin.settings, lists),
		};
	}

	/**
	 * Opens one of this tab's pages by its path. Obsidian 1.13 has no public
	 * call for it; its settings modal's `openPagePath(tabId, path)` is what
	 * its own search results use (`docs/architecture.md`, "The settings tab").
	 * Where a build lacks it, the page stays as it is and the user opens the
	 * row by hand.
	 */
	private openPage(path: string[]): void {
		this.pageOpener()?.(path);
	}

	/** The settings modal's `openPagePath` for this tab, or null where the build has none. */
	private pageOpener(): ((path: string[]) => void) | null {
		const modal = (this.app as unknown as { setting?: { openPagePath?: (tabId: string, path: string[]) => unknown } })
			.setting;
		if (!modal || typeof modal.openPagePath !== 'function') return null;
		return (path) => {
			modal.openPagePath?.(this.plugin.manifest.id, path);
		};
	}
}
