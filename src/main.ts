import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, HerdrSettings, HerdrSettingTab } from './settings';

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(
			new HerdrSettingTab(this.app, this, (el) => this.renderStatus(el)),
		);
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<HerdrSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...stored,
			remote: { ...DEFAULT_SETTINGS.remote, ...stored?.remote },
			notifications: {
				...DEFAULT_SETTINGS.notifications,
				...stored?.notifications,
				blocked: {
					...DEFAULT_SETTINGS.notifications.blocked,
					...stored?.notifications?.blocked,
				},
				done: {
					...DEFAULT_SETTINGS.notifications.done,
					...stored?.notifications?.done,
				},
			},
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Connection status shown at the top of the settings tab. Replaced once the
	 * herdr client lands; until then it states what is not wired up yet.
	 */
	private renderStatus(el: HTMLElement): void {
		el.createEl('p', {
			cls: 'herdr-status-text',
			text: 'Not connected. The herdr connection is not wired up in this build.',
		});
	}
}
