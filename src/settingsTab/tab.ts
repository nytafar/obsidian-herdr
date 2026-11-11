/**
 * The settings tab on Obsidian's declarative settings API (issue #156,
 * ADR-0011). {@link settingDefinitions} is the single description of the tab:
 * the connection status block on the root, then one page per area, each from
 * its own module. Every control reads and writes through
 * `getControlValue`/`setControlValue`, which go to `effects.ts`: store,
 * save, then the key's effect.
 */

import { App, PluginSettingTab, type SettingDefinitionItem, type SettingDefinitionRender } from 'obsidian';
import type HerdrPlugin from '../main';
import type { HerdrSettings, RenderStatus } from '../settings';
import { ConfirmModal } from '../views/modals';
import { readSetting, writeSetting, type ControlKey } from './effects';
import { blockOf, runtimeListDefinition, type ListCallbacks } from './lists';
import { AgentCatalogSession, isCatalogKey, readCatalogSetting, writeCatalogSetting, type CatalogKey } from './agentCatalog';
import { runtimesPage } from './runtimes';
import { agentsPage } from './agents';
import { viewsPage } from './views';
import { terminalPage } from './terminal';
import { agentListPage } from './agentList';

/** The connection status block (PRD M1-M3, M6, S5) at the top of the root. */
function statusDefinition(renderStatus: RenderStatus): SettingDefinitionRender {
	return {
		name: 'Connection status',
		aliases: ['server', 'socket', 'binary', 'protocol'],
		render: (setting) => renderStatus(blockOf(setting, 'herdr-settings-status')),
	};
}

/** The whole tab, root first. Values are read at render time, through `settings`. */
export function settingDefinitions(
	settings: () => HerdrSettings,
	renderStatus: RenderStatus,
	lists: ListCallbacks,
	catalog: AgentCatalogSession,
): SettingDefinitionItem<ControlKey | CatalogKey>[] {
	return [
		statusDefinition(renderStatus),
		runtimesPage(settings, runtimeListDefinition(settings, lists)),
		agentsPage(settings, catalog.definitions()),
		viewsPage(settings),
		terminalPage(settings),
		agentListPage(),
	];
}

export class HerdrSettingTab extends PluginSettingTab {
	private readonly plugin: HerdrPlugin;
	private readonly renderStatus: RenderStatus;
	/** The runtime whose form is open; survives the redraws its fields cause. */
	private editing: string | null = null;
	/** The agent CLI catalog of this opening of the tab: its machine probes (issue #179). */
	private readonly catalog: AgentCatalogSession;

	constructor(app: App, plugin: HerdrPlugin, renderStatus: RenderStatus) {
		super(app, plugin);
		this.plugin = plugin;
		this.renderStatus = renderStatus;
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
		return settingDefinitions(() => this.plugin.settings, this.renderStatus, this.listCallbacks(), this.catalog);
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
	}

	/** Closing the tab ends its machine probes: the next opening asks again. */
	hide(): void {
		this.catalog.end();
		super.hide();
	}

	/**
	 * What the runtime list is handed until #178. A redraw is `update()`,
	 * which draws the open page again.
	 */
	private listCallbacks(): ListCallbacks {
		const { plugin } = this;
		const redisplay = (): void => this.update();
		return {
			save: () => plugin.saveSettings(),
			saveAndReconnect: async () => {
				await plugin.saveSettings();
				plugin.scheduleReconnect();
			},
			redisplay,
			refreshAgentList: () => plugin.refreshAgentList(),
			activateRuntime: (id) => plugin.switchRuntime(id),
			refreshRuntimes: () => plugin.refreshRuntimes(),
			kindUnavailable: (kind) => plugin.kindUnavailable(kind),
			nativeReachable: (runtime) => plugin.nativeReachable(runtime),
			editingRuntime: () => this.editing,
			editRuntime: (id) => {
				this.editing = id;
				redisplay();
			},
			confirm: (text) => new ConfirmModal(this.app, { ...text, warning: true }).ask(),
			sessionHook: {
				status: () => plugin.sessionHookStatus(),
				review: (onDone) => plugin.openSessionHook(onDone),
			},
			agents: {
				probe: (runtimeId) => plugin.agentCatalogs.cachedProbeFor(runtimeId),
			},
		};
	}
}
