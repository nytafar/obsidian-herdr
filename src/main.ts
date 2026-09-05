import { App, Modal, Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, HerdrSettings, HerdrSettingTab } from './settings';
import { GhosttyWebRenderer } from './views/renderer/ghosttyWeb';

/** Colour ramp, bold/underline and a box drawing line; enough to eyeball the renderer. */
const SAMPLE_ANSI =
	'\x1b[1mHerdr renderer smoke test\x1b[0m\r\n' +
	'\x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m \x1b[2mdim\x1b[0m\r\n' +
	[0, 1, 2, 3, 4, 5, 6, 7]
		.map((i) => `\x1b[3${i}m${i}\x1b[0m\x1b[9${i}m${i}\x1b[0m`)
		.join(' ') +
	'\r\n\x1b[48;5;24m 256-colour \x1b[0m \x1b[38;2;255;128;0mtruecolour\x1b[0m\r\n' +
	'┌──────────┐\r\n│ box draw │\r\n└──────────┘\r\n' +
	'unicode: äöü 漢字 🐑\r\n$ ';

export default class HerdrPlugin extends Plugin {
	settings!: HerdrSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(
			new HerdrSettingTab(this.app, this, (el) => this.renderStatus(el)),
		);
		// Renderer smoke test (PRD M14): no herdr connection involved, it only
		// writes a canned ANSI sample so the ghostty-web bundle can be eyeballed.
		this.addCommand({
			id: 'renderer-smoke-test',
			name: 'Show renderer smoke test',
			callback: () => {
				new RendererSmokeModal(this.app).open();
			},
		});
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

/**
 * Dev-only harness for PRD M14: mounts `GhosttyWebRenderer` in a modal and writes
 * a canned ANSI sample. Nothing here touches herdr.
 */
class RendererSmokeModal extends Modal {
	private renderer: GhosttyWebRenderer | undefined;

	constructor(app: App) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle('Herdr renderer smoke test');
		const host = this.contentEl.createDiv({ cls: 'herdr-terminal-host' });
		const renderer = new GhosttyWebRenderer({ scrollback: 200 });
		this.renderer = renderer;
		void renderer
			.mount(host)
			.then(() => {
				renderer.write(new TextEncoder().encode(SAMPLE_ANSI));
				renderer.focus();
			})
			.catch((err: unknown) => {
				new Notice(`Herdr: renderer failed to start (${String(err)})`);
			});
	}

	override onClose(): void {
		this.renderer?.dispose();
		this.renderer = undefined;
		this.contentEl.empty();
	}
}
