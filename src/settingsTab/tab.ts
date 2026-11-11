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
import type { MachineProbes } from '../agents/machines';
import { ConfirmModal } from '../views/modals';
import { readSetting, writeSetting, type ControlKey } from './effects';
import { agentCatalogDefinition, blockOf, runtimeListDefinition, type ListCallbacks } from './lists';
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
): SettingDefinitionItem<ControlKey>[] {
	return [
		statusDefinition(renderStatus),
		runtimesPage(settings, runtimeListDefinition(settings, lists)),
		agentsPage(settings, agentCatalogDefinition(settings, lists)),
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
	/** The user agent CLI whose form is open (issue #125). */
	private editingAgent: string | null = null;
	/** Which machines have which agent CLIs, probed once per opening of the tab (issue #125). */
	private machines: MachineProbes | null = null;

	constructor(app: App, plugin: HerdrPlugin, renderStatus: RenderStatus) {
		super(app, plugin);
		this.plugin = plugin;
		this.renderStatus = renderStatus;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return settingDefinitions(() => this.plugin.settings, this.renderStatus, this.listCallbacks());
	}

	getControlValue(key: string): unknown {
		return readSetting(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await writeSetting(this.plugin.settings, key, value, this.plugin);
	}

	/** Closing the tab ends its machine probes: the next opening asks again. */
	hide(): void {
		this.machines?.dispose();
		this.machines = null;
		super.hide();
	}

	/**
	 * What the runtime list and the agent catalog are handed until #178 and
	 * #179. A redraw is `update()`, which draws the open page again.
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
				refresh: (runtimeId, again) => plugin.agentCatalogs.refresh(runtimeId, again),
				editing: () => this.editingAgent,
				edit: (id) => {
					this.editingAgent = id;
					redisplay();
				},
				machines: () => (this.machines ??= plugin.newMachineProbes()),
			},
		};
	}
}
