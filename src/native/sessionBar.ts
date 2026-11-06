/**
 * The session bar (issue #161; finding `native-view-header` §2): one slim
 * row under the prompt box with the model, effort and permission mode
 * pickers on the left and the context readout on the right.
 *
 * ```
 *  [Opus 5.5 ▾]  [◐ medium ▾]  [Manual ▾]                23k / 1M · 2%
 * ```
 *
 * A picker is a button that shows the current value (`—` while nothing has
 * stated it) and opens an Obsidian menu of the values the agent's format
 * offers, the current one checked. A pick goes to the runtime kind's
 * session-settings sender (`./sessionSettings.ts`); nothing is shown as
 * changed until the runtime or the transcript says it is (ADR-0003), and a
 * refusal is a notice with the runtime's words. A kind with no sender yet
 * shows the values, disabled, with the reason as the tooltip.
 *
 * Built once per attach and updated in place: a reply, a `/model` line or a
 * compaction rewrites a text or a class, never the row.
 *
 * Its own element, not the prompt box's: the waiting card hides the prompt
 * box (#99) and the bar stays, disabled, because the values are still worth
 * seeing while the agent asks something.
 *
 * Guidelines: no `innerHTML`, no inline styles (`styles.css`), every listener
 * on a `Component` unloaded on `destroy`.
 */

import { Component, Menu, Notice } from 'obsidian';
import type { AgentFormat } from '../agents/format';
import type { AgentStatus } from '../herdr/types.gen';
import type { SessionInfo } from './conversation';
import {
	contextReadout,
	effortText,
	isCurrentMode,
	isCurrentModel,
	modelText,
	modeText,
	pickerBlock,
	settingFailureMessage,
	type SessionSetting,
	type SessionSettingsSender,
	type SettingChoice,
	type SettingScope,
} from './sessionSettings';

/** What the bar is drawn from, as the surface reads it off the session model. */
export interface SessionBarState {
	info: SessionInfo;
	status: AgentStatus;
	connected: boolean;
	/** The format the session is read with; its vocabularies are the menus. */
	format: AgentFormat | null | undefined;
}

export interface SessionBarOptions {
	/** The pane to change, read per pick: a tab can be pointed at another. */
	paneId: () => string;
	/** The tab's runtime's sender, read per draw and per pick, or null for none yet. */
	sender: () => SessionSettingsSender | null;
	/** How a failure reaches the user. Defaults to an Obsidian notice. */
	notify?: (message: string) => void;
}

/** What each picker is called, for its tooltip and its label. */
const SETTING_NAMES: Readonly<Record<SessionSetting, string>> = {
	model: 'Model',
	effort: 'Effort',
	mode: 'Permission mode',
};

/** What the second group of a menu is called, for a kind that can also save the default. */
const DEFAULT_SCOPE_LABEL = 'Use for new sessions too';

interface Picker {
	setting: SessionSetting;
	buttonEl: HTMLButtonElement;
	fullEl: HTMLElement;
	shortEl: HTMLElement;
	/** True from a pick until the sender has answered it. */
	busy: boolean;
}

export class SessionBar {
	private readonly options: SessionBarOptions;
	private readonly component = new Component();
	private rootEl: HTMLElement | null = null;
	private readonly pickers = new Map<SessionSetting, Picker>();
	private readoutEl: HTMLElement | null = null;
	private tokensEl: HTMLElement | null = null;
	private percentEl: HTMLElement | null = null;
	/** The state last drawn, which a pick's menu reads. */
	private state: SessionBarState = { info: {}, status: 'unknown', connected: false, format: undefined };

	constructor(options: SessionBarOptions) {
		this.options = options;
	}

	/** Builds the row inside `parentEl`. Called once, from the surface's attach. */
	mount(parentEl: HTMLElement): void {
		this.component.load();
		// `herdr-native-sizer`: at the prompt box's width under a readable line width (#117).
		const root = parentEl.createDiv({ cls: ['herdr-native-session-bar', 'herdr-native-sizer'] });
		const pickersEl = root.createDiv({ cls: 'herdr-native-session-pickers' });
		for (const setting of ['model', 'effort', 'mode'] as const) {
			const buttonEl = pickersEl.createEl('button', {
				cls: ['herdr-native-session-picker', `herdr-native-session-${setting}`],
			});
			const fullEl = buttonEl.createSpan({ cls: 'herdr-native-session-value' });
			const shortEl = buttonEl.createSpan({ cls: 'herdr-native-session-short' });
			buttonEl.createSpan({ cls: 'herdr-native-session-chevron', text: '▾' });
			const picker: Picker = { setting, buttonEl, fullEl, shortEl, busy: false };
			this.pickers.set(setting, picker);
			this.component.registerDomEvent(buttonEl, 'click', (event: MouseEvent) => this.open(picker, event));
		}
		const readoutEl = root.createDiv({ cls: 'herdr-native-session-context' });
		this.tokensEl = readoutEl.createSpan({ cls: 'herdr-native-session-tokens' });
		readoutEl.createSpan({ cls: 'herdr-native-session-sep', text: ' · ' });
		this.percentEl = readoutEl.createSpan({ cls: 'herdr-native-session-percent' });
		this.readoutEl = readoutEl;
		this.rootEl = root;
		this.draw();
	}

	/** Drops the row and every listener on it. Idempotent. */
	destroy(): void {
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.pickers.clear();
		this.readoutEl = null;
		this.tokensEl = null;
		this.percentEl = null;
	}

	/** The session moved: rewrites what changed in place. */
	update(state: SessionBarState): void {
		this.state = state;
		this.draw();
	}

	/** The values a picker offers, from the session's format. */
	private choices(setting: SessionSetting): SettingChoice[] {
		const format = this.state.format;
		if (!format) return [];
		if (setting === 'model') return [...(format.models ?? [])];
		if (setting === 'effort') return format.efforts.map((effort) => ({ value: effort, label: effortText(effort).full }));
		return format.modes.map((mode) => ({ value: mode, label: modeText(mode, format.modeLabels).full }));
	}

	/** Whether `choice` is what the session runs with now. */
	private isCurrent(setting: SessionSetting, choice: SettingChoice): boolean {
		const { info, format } = this.state;
		if (setting === 'model') return isCurrentModel(info.model, choice);
		if (setting === 'effort') return info.effort === choice.value;
		return isCurrentMode(info.permissionMode, choice.value, format?.modeLabels);
	}

	/** Why `setting` cannot be changed now, or null when it can. */
	private block(setting: SessionSetting): string | null {
		return pickerBlock({
			setting,
			status: this.state.status,
			connected: this.state.connected,
			sender: this.options.sender(),
			paneId: this.options.paneId(),
			choices: this.choices(setting).length,
		});
	}

	private draw(): void {
		if (!this.rootEl) return;
		const { info, format } = this.state;
		const texts: Record<SessionSetting, { full: string; short: string }> = {
			model: modelText(info.model),
			effort: effortText(info.effort),
			mode: modeText(info.permissionMode, format?.modeLabels),
		};
		for (const picker of this.pickers.values()) {
			const text = texts[picker.setting];
			setTextIfChanged(picker.fullEl, text.full);
			setTextIfChanged(picker.shortEl, text.short);
			const reason = this.block(picker.setting);
			picker.buttonEl.disabled = reason !== null || picker.busy;
			const name = SETTING_NAMES[picker.setting];
			const label = reason ? `${name}: ${text.full}. ${reason}` : `${name}: ${text.full}`;
			if (picker.buttonEl.getAttribute('aria-label') !== label) picker.buttonEl.setAttr('aria-label', label);
		}
		const readout = contextReadout(info);
		if (this.tokensEl) setTextIfChanged(this.tokensEl, readout.tokens);
		if (this.percentEl) setTextIfChanged(this.percentEl, readout.percent);
		const readoutEl = this.readoutEl;
		if (readoutEl) {
			readoutEl.toggleClass('herdr-is-hidden', readout.tokens === '');
			readoutEl.toggleClass('herdr-has-window', readout.percent !== '');
			readoutEl.toggleClass('herdr-is-warning', readout.warning);
			if (readoutEl.getAttribute('aria-label') !== readout.title) readoutEl.setAttr('aria-label', readout.title);
		}
	}

	/** Opens a picker's menu: every value, the current one checked. */
	private open(picker: Picker, event: MouseEvent): void {
		const sender = this.options.sender();
		if (!sender || picker.busy || this.block(picker.setting) !== null) return;
		const choices = this.choices(picker.setting);
		const menu = new Menu();
		const scopes = picker.setting === 'mode' ? sender.scopes.slice(0, 1) : sender.scopes;
		scopes.forEach((scope, index) => {
			if (index > 0) {
				menu.addSeparator();
				menu.addItem((item) => item.setTitle(DEFAULT_SCOPE_LABEL).setIsLabel(true));
			}
			for (const choice of choices) {
				menu.addItem((item) =>
					item
						.setTitle(choice.label)
						.setChecked(index === 0 && this.isCurrent(picker.setting, choice))
						.onClick(() => {
							void this.pick(picker.setting, choice.value, scope);
						}),
				);
			}
		});
		menu.showAtMouseEvent(event);
	}

	/** Sends one pick; the button stays disabled until the sender answers. */
	async pick(setting: SessionSetting, value: string, scope: SettingScope): Promise<void> {
		const target = this.pickers.get(setting);
		const sender = this.options.sender();
		if (!target || !sender || target.busy) return;
		const paneId = this.options.paneId();
		target.busy = true;
		this.draw();
		try {
			if (target.setting === 'model') await sender.setModel(paneId, value, scope);
			else if (target.setting === 'effort') await sender.setEffort(paneId, value, scope);
			else await sender.setMode(paneId, value);
		} catch (error) {
			this.notify(settingFailureMessage(target.setting, error));
		} finally {
			target.busy = false;
			this.draw();
		}
	}

	private notify(message: string): void {
		if (this.options.notify) {
			this.options.notify(message);
			return;
		}
		new Notice(message);
	}
}

/** Writes a text only when it differs, so an update that changes nothing touches nothing. */
function setTextIfChanged(el: HTMLElement, text: string): void {
	if (el.textContent !== text) el.setText(text);
}
