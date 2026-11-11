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
import { buildDefaultAgentSetting } from '../agents/settingsSection';
import { readSetting, writeSetting, type TabKey } from './effects';
import { agentCatalogDefinition, blockOf, type ListCallbacks } from './lists';
import { parseRuntimeKey, type RuntimeField } from './runtimeKeys';
import { redrawsPage, runtimesPage, type RuntimesHost } from './runtimes';
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
	runtimes: RuntimesHost,
): SettingDefinitionItem<TabKey>[] {
	return [
		statusDefinition(renderStatus),
		runtimesPage(settings, runtimes),
		agentsPage(settings, agentCatalogDefinition(settings, lists)),
		viewsPage(settings),
		terminalPage(settings),
		agentListPage(),
	];
}

export class HerdrSettingTab extends PluginSettingTab {
	private readonly plugin: HerdrPlugin;
	private readonly renderStatus: RenderStatus;
	/** What a runtime page's rows redraw on: every write to a `runtimes.<id>.<field>` key. */
	private readonly runtimeWrites = new Set<(id: string, field: RuntimeField) => void>();
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
		const lists = this.listCallbacks();
		return settingDefinitions(() => this.plugin.settings, this.renderStatus, lists, this.runtimesHost(lists));
	}

	getControlValue(key: string): unknown {
		return readSetting(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await writeSetting(this.plugin.settings, key, value, this.plugin);
		const runtime = parseRuntimeKey(key);
		if (!runtime) return;
		for (const listener of [...this.runtimeWrites]) listener(runtime.id, runtime.field);
		if (redrawsPage(runtime.field)) this.update();
	}

	/** Closing the tab ends its machine probes: the next opening asks again. */
	hide(): void {
		this.machines?.dispose();
		this.machines = null;
		super.hide();
	}

	/**
	 * What the agent catalog is handed until #179. A redraw is `update()`,
	 * which draws the open page again.
	 */
	private listCallbacks(): ListCallbacks {
		const { plugin } = this;
		const redisplay = (): void => this.update();
		return {
			save: () => plugin.saveSettings(),
			redisplay,
			refreshAgentList: () => plugin.refreshAgentList(),
			nativeReachable: (runtime) => plugin.nativeReachable(runtime),
			confirm: (text) => new ConfirmModal(this.app, { ...text, warning: true }).ask(),
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
		const modal = (this.app as unknown as { setting?: { openPagePath?: (tabId: string, path: string[]) => unknown } })
			.setting;
		if (typeof modal?.openPagePath !== 'function') return;
		modal.openPagePath(this.plugin.manifest.id, path);
	}
}
