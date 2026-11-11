/**
 * The session bar (issue #161; finding `native-view-header` §2): the model,
 * effort and permission mode pickers on the left and the context readout on
 * the right, in the prompt box's toolbar strip since #173.
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
 * The readout is a button (#171): a click shows the agent's context
 * breakdown in a popover over the bar. A kind that can ask without writing
 * to the conversation has a reader (the `claude` kind's
 * `get_context_usage`); elsewhere the format's context command (`/context`)
 * goes through the prompt, idle or done only, and the breakdown is the
 * report the transcript then gives (`SessionInfo.contextReport`), which the
 * parser keeps out of the turns (`./contextBreakdown.ts`).
 *
 * Its own component, mounted into the strip the prompt box keeps for it
 * (`PromptBox.barSlot`): while the waiting card stands in for the box (#99)
 * the box folds down to that strip, so the bar stays in sight, disabled,
 * because the values are still worth seeing while the agent asks something.
 *
 * The readout carries both of its forms (#173, `./composerLook.ts`): the
 * `46k / 200k · 23%` text and a ring drawn as an SVG arc, and the readout
 * setting only says which one shows, through a class.
 *
 * Guidelines: no `innerHTML`, no inline styles (`styles.css`), every listener
 * on a `Component` unloaded on `destroy`.
 */

import { Component, Menu, Notice, setIcon } from 'obsidian';
import type { AgentFormat } from '../agents/format';
import type { AgentStatus } from '../herdr/types.gen';
import {
	breakdownHeadline,
	contextBlock,
	contextFailureMessage,
	CONTEXT_WAIT_MS,
	type ContextBreakdown,
	type ContextUsageReader,
} from './contextBreakdown';
import type { SessionInfo } from './conversation';
import {
	contextReadoutLabel,
	DEFAULT_CONTEXT_READOUT_STYLE,
	GAUGE_CLASS,
	gaugeDash,
	type ContextReadoutStyle,
} from './composerLook';
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
	type SettingQuestion,
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
	/**
	 * The tab's runtime's way of asking for the context breakdown without
	 * writing to the conversation (#171), read per click, or null.
	 */
	contextUsage?: () => ContextUsageReader | null;
	/**
	 * Sends a context command through the prompt, for a kind with no reader:
	 * the prompt sender's own path. Without it, and without a reader, the
	 * readout opens nothing.
	 */
	sendCommand?: (paneId: string, text: string) => Promise<void>;
	/**
	 * Why nothing may be typed into the pane now (the pane gate, review of
	 * #169): the readout's context command waits, and the bar says why under
	 * the pickers, since the prompt box only disables its button.
	 */
	sendBlocked?: (paneId: string) => string | null;
	/** How a failure reaches the user. Defaults to an Obsidian notice. */
	notify?: (message: string) => void;
	/**
	 * Puts a question the agent asks on the way to a change to the user
	 * ("Switch model?" on herdr and herdr-core, #169), resolving true for yes.
	 * Without it the pick itself is the answer.
	 */
	confirm?: (question: SettingQuestion) => Promise<boolean>;
}

/** Why a context command's output never came. */
export const CONTEXT_TIMEOUT = 'it did not reach the transcript in time';

/** A context command sent, waiting for a report newer than `seen`. */
interface ContextWait {
	seen: string | undefined;
	settle: (report: ContextBreakdown | Error) => void;
}

/** What each picker is called, for its tooltip and its label. */
const SETTING_NAMES: Readonly<Record<SessionSetting, string>> = {
	model: 'Model',
	effort: 'Effort',
	mode: 'Permission mode',
};

/** What the second group of a menu is called, for a kind that can also save the default. */
const DEFAULT_SCOPE_LABEL = 'Use for new sessions too';

/** What the second group does, under its name (finding `native-view-session-settings` §3). */
export function defaultScopeNote(setting: SessionSetting, agent: string): string {
	const what = setting === 'effort' ? 'default for this model in new sessions' : 'default for new sessions';
	return `Also becomes ${agent}'s ${what}, in and outside Obsidian.`;
}

/** What a mode read from the transcript says it is, where a runtime reports the mode nowhere (#170). */
export const AT_LAST_PROMPT = 'at the last prompt';

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
	private readoutEl: HTMLButtonElement | null = null;
	private tokensEl: HTMLElement | null = null;
	private percentEl: HTMLElement | null = null;
	/** The gauge's arc, an SVG circle whose dash is the share used (#173). */
	private arcEl: SVGCircleElement | null = null;
	/** How the readout reads (#173), from the setting. */
	private readoutStyle: ContextReadoutStyle = DEFAULT_CONTEXT_READOUT_STYLE;
	/** Why nothing may be typed into the pane now, when something stops it. */
	private noteEl: HTMLElement | null = null;
	/** True from a click on the readout until the breakdown came or failed. */
	private contextBusy = false;
	/** A context command waiting for its output in the transcript. */
	private contextWait: ContextWait | null = null;
	/** The open breakdown popover and its own listeners, or null. */
	private popover: { el: HTMLElement; component: Component } | null = null;
	/** The state last drawn, which a pick's menu reads. */
	private state: SessionBarState = { info: {}, status: 'unknown', connected: false, format: undefined };
	/**
	 * The mode the agent's footer showed when last read (#170), on a kind
	 * that reads it (`SessionSettingsSender.readMode`), with the transcript's
	 * mode at that time: it is shown until the transcript says another one
	 * (a new prompt), or the tab points at another pane.
	 */
	private footerMode: { paneId: string; mode: string; base: string | undefined } | null = null;

	constructor(options: SessionBarOptions) {
		this.options = options;
	}

	/** Builds the row inside `parentEl`. Called once, from the surface's attach. */
	mount(parentEl: HTMLElement): void {
		this.component.load();
		// Inside the prompt box's strip (#173), which has the readable width already.
		const root = parentEl.createDiv({ cls: 'herdr-native-session-bar' });
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
		const readoutEl = root.createEl('button', { cls: 'herdr-native-session-context' });
		// The gauge (#173): a track and an arc over it, the arc's length the
		// share used. `pathLength` makes the dash a percentage, so the arc is
		// one attribute and never a style. Hidden in the detail form.
		const ringEl = readoutEl.createSvg('svg', {
			cls: 'herdr-native-session-ring',
			attr: { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
		});
		const circle = { cx: '8', cy: '8', r: '6', pathLength: '100' };
		ringEl.createSvg('circle', { cls: 'herdr-native-session-ring-track', attr: circle });
		this.arcEl = ringEl.createSvg('circle', {
			cls: 'herdr-native-session-ring-arc',
			attr: { ...circle, 'stroke-dasharray': gaugeDash(null) },
		});
		this.tokensEl = readoutEl.createSpan({ cls: 'herdr-native-session-tokens' });
		readoutEl.createSpan({ cls: 'herdr-native-session-sep', text: ' · ' });
		this.percentEl = readoutEl.createSpan({ cls: 'herdr-native-session-percent' });
		this.component.registerDomEvent(readoutEl, 'click', () => {
			void this.openContext();
		});
		this.readoutEl = readoutEl;
		this.noteEl = root.createDiv({ cls: ['herdr-native-session-note', 'herdr-is-hidden'] });
		this.noteEl.setAttr('role', 'status');
		this.rootEl = root;
		this.draw();
	}

	/** Drops the row and every listener on it. Idempotent. */
	destroy(): void {
		this.closeContext();
		this.contextWait?.settle(new Error('the view closed'));
		this.contextWait = null;
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.pickers.clear();
		this.readoutEl = null;
		this.tokensEl = null;
		this.percentEl = null;
		this.arcEl = null;
		this.noteEl = null;
	}

	/** The readout setting changed (#173): a class, nothing drawn again. */
	setReadoutStyle(style: ContextReadoutStyle): void {
		if (style === this.readoutStyle) return;
		this.readoutStyle = style;
		this.draw();
	}

	/** The session moved: rewrites what changed in place. */
	update(state: SessionBarState): void {
		this.state = state;
		const report = state.info.contextReport;
		const wait = this.contextWait;
		if (wait && report && report.id !== wait.seen) wait.settle(report);
		this.draw();
	}

	/** The values a picker offers, from the session's format. */
	private choices(setting: SessionSetting): SettingChoice[] {
		const format = this.state.format;
		if (!format) return [];
		if (setting === 'model') return [...(format.models ?? [])];
		if (setting === 'effort') return format.efforts.map((effort) => ({ value: effort, label: effortText(effort).full }));
		// Only the modes the kind can set (herdr and hc: what `shift+tab` reaches).
		const reachable = this.options.sender()?.modes;
		return format.modes
			.filter((mode) => !reachable || reachable.some((other) => isCurrentMode(other, mode, format.modeLabels)))
			.map((mode) => ({ value: mode, label: modeText(mode, format.modeLabels).full }));
	}

	/** The mode to show: the footer's when it was read since the last prompt, else the transcript's. */
	private shownMode(): { mode: string | undefined; fromFooter: boolean } {
		const recorded = this.state.info.permissionMode;
		const footer = this.footerMode;
		if (footer && footer.paneId === this.options.paneId() && footer.base === recorded) {
			return { mode: footer.mode, fromFooter: true };
		}
		return { mode: recorded, fromFooter: false };
	}

	/** Reads the agent's footer, on a kind that can, and shows what it says. Never throws. */
	private async readFooter(sender: SessionSettingsSender, paneId: string): Promise<void> {
		if (!sender.readMode) return;
		let mode: string | null = null;
		try {
			mode = await sender.readMode(paneId);
		} catch {
			// Unread: the transcript's mode stays, labelled as such.
		}
		if (mode && this.options.paneId() === paneId) {
			this.footerMode = { paneId, mode, base: this.state.info.permissionMode };
		}
		this.draw();
	}

	/** Whether `choice` is what the session runs with now. */
	private isCurrent(setting: SessionSetting, choice: SettingChoice): boolean {
		const { info, format } = this.state;
		if (setting === 'model') return isCurrentModel(info.model, choice);
		if (setting === 'effort') return info.effort === choice.value;
		return isCurrentMode(this.shownMode().mode, choice.value, format?.modeLabels);
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
		const mode = this.shownMode();
		const texts: Record<SessionSetting, { full: string; short: string }> = {
			model: modelText(info.model),
			effort: effortText(info.effort),
			mode: modeText(mode.mode, format?.modeLabels),
		};
		// Where the runtime reports the mode nowhere, the transcript's is as of the last prompt.
		const stale = mode.mode !== undefined && !mode.fromFooter && this.options.sender()?.readMode !== undefined;
		for (const picker of this.pickers.values()) {
			const text = texts[picker.setting];
			setTextIfChanged(picker.fullEl, text.full);
			setTextIfChanged(picker.shortEl, text.short);
			const reason = this.block(picker.setting);
			picker.buttonEl.disabled = reason !== null || picker.busy;
			const name = SETTING_NAMES[picker.setting];
			const value = picker.setting === 'mode' && stale ? `${text.full} (${AT_LAST_PROMPT})` : text.full;
			const label = reason ? `${name}: ${value}. ${reason}` : `${name}: ${value}`;
			if (picker.buttonEl.getAttribute('aria-label') !== label) picker.buttonEl.setAttr('aria-label', label);
		}
		const blocked = this.sendBlocked();
		if (this.noteEl) {
			setTextIfChanged(this.noteEl, blocked ?? '');
			this.noteEl.toggleClass('herdr-is-hidden', blocked === null);
		}
		this.rootEl?.toggleClass('herdr-has-note', blocked !== null);
		const readout = contextReadout(info);
		if (this.tokensEl) setTextIfChanged(this.tokensEl, readout.tokens);
		if (this.percentEl) setTextIfChanged(this.percentEl, readout.percent);
		const readoutEl = this.readoutEl;
		if (readoutEl) {
			readoutEl.toggleClass('herdr-is-hidden', readout.tokens === '');
			readoutEl.toggleClass('herdr-has-window', readout.percent !== '');
			readoutEl.toggleClass('herdr-is-warning', readout.warning);
			readoutEl.toggleClass(GAUGE_CLASS, this.readoutStyle === 'gauge');
			const dash = gaugeDash(readout.share);
			if (this.arcEl && this.arcEl.getAttribute('stroke-dasharray') !== dash) {
				this.arcEl.setAttr('stroke-dasharray', dash);
			}
			const reason = this.contextBlock();
			readoutEl.disabled = reason !== null || this.contextBusy;
			const title = contextReadoutLabel(readout, this.readoutStyle);
			const label = reason ? `${title}. ${reason}` : title;
			if (readoutEl.getAttribute('aria-label') !== label) readoutEl.setAttr('aria-label', label);
		}
	}

	/** Why the readout opens no breakdown now, or null when it does. */
	private contextBlock(): string | null {
		return contextBlock({
			status: this.state.status,
			connected: this.state.connected,
			paneId: this.options.paneId(),
			reader: Boolean(this.options.contextUsage?.()),
			command: this.options.sendCommand ? this.state.format?.contextCommand : undefined,
			sendBlock: this.sendBlocked(),
		});
	}

	/** Why nothing may be typed into the pane now, or null. */
	private sendBlocked(): string | null {
		const paneId = this.options.paneId();
		return paneId ? (this.options.sendBlocked?.(paneId) ?? null) : null;
	}

	/**
	 * A click on the readout: closes an open breakdown, else asks for one
	 * and shows it. A failure is a notice with the runtime's words.
	 */
	async openContext(): Promise<void> {
		if (this.popover) {
			this.closeContext();
			return;
		}
		if (this.contextBusy || this.contextBlock() !== null) return;
		const paneId = this.options.paneId();
		const reader = this.options.contextUsage?.() ?? null;
		this.contextBusy = true;
		this.draw();
		try {
			const breakdown = reader ? await reader.read(paneId) : await this.askCommand(paneId);
			if (this.rootEl) this.showContext(breakdown);
		} catch (error) {
			if (this.rootEl) this.notify(contextFailureMessage(error));
		} finally {
			this.contextBusy = false;
			this.draw();
		}
	}

	/**
	 * Sends the format's context command through the prompt and settles with
	 * the first report newer than the one the session held when it went.
	 */
	private askCommand(paneId: string): Promise<ContextBreakdown> {
		const command = this.state.format?.contextCommand;
		const send = this.options.sendCommand;
		if (!command || !send) return Promise.reject(new Error('this agent has no context command'));
		return new Promise<ContextBreakdown>((resolve, reject) => {
			const wait: ContextWait = {
				seen: this.state.info.contextReport?.id,
				settle: (report) => {
					if (this.contextWait !== wait) return;
					this.contextWait = null;
					window.clearTimeout(timer);
					if (report instanceof Error) reject(report);
					else resolve(report);
				},
			};
			const timer = window.setTimeout(() => wait.settle(new Error(CONTEXT_TIMEOUT)), CONTEXT_WAIT_MS);
			this.contextWait = wait;
			send(paneId, command).catch((error: unknown) =>
				wait.settle(error instanceof Error ? error : new Error(String(error))),
			);
		});
	}

	/** Draws the breakdown in a popover over the bar; Escape, a click outside or the close button ends it. */
	private showContext(breakdown: ContextBreakdown): void {
		const root = this.rootEl;
		if (!root) return;
		this.closeContext();
		const component = new Component();
		component.load();
		const el = root.createDiv({ cls: 'herdr-native-context-popover' });
		el.setAttr('role', 'dialog');
		el.setAttr('aria-label', 'Context usage');
		const head = el.createDiv({ cls: 'herdr-native-context-head' });
		head.createSpan({ cls: 'herdr-native-context-title', text: breakdownHeadline(breakdown) });
		const close = head.createEl('button', { cls: ['clickable-icon', 'herdr-native-context-close'] });
		setIcon(close, 'x');
		close.setAttr('aria-label', 'Close');
		component.registerDomEvent(close, 'click', () => this.closeContext());
		if (breakdown.categories.length) {
			const table = el.createEl('table', { cls: 'herdr-native-context-table' });
			const headRow = table.createEl('thead').createEl('tr');
			for (const name of ['Category', 'Tokens', 'Share']) headRow.createEl('th', { text: name });
			const body = table.createEl('tbody');
			for (const category of breakdown.categories) {
				const row = body.createEl('tr');
				row.createEl('td', { text: category.name });
				row.createEl('td', { cls: 'herdr-native-context-number', text: category.tokens });
				row.createEl('td', { cls: 'herdr-native-context-number', text: category.share });
			}
		}
		component.registerDomEvent(el, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Escape') this.closeContext();
		});
		// The document the bar is in (a popout window has its own).
		const doc = (root as Partial<Pick<HTMLElement, 'doc'>>).doc;
		if (doc) {
			component.registerDomEvent(doc, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Escape') this.closeContext();
			});
			component.registerDomEvent(doc, 'mousedown', (event: MouseEvent) => {
				const target = event.target;
				if (target instanceof Node && (el.contains(target) || this.readoutEl?.contains(target))) return;
				this.closeContext();
			});
		}
		this.popover = { el, component };
		this.readoutEl?.setAttr('aria-expanded', 'true');
	}

	/** Takes the breakdown popover down, if one is open. */
	private closeContext(): void {
		const popover = this.popover;
		if (!popover) return;
		this.popover = null;
		popover.component.unload();
		popover.el.remove();
		this.readoutEl?.setAttr('aria-expanded', 'false');
	}

	/**
	 * Opens a picker's menu: every value, the current one checked. The mode
	 * picker on a kind that reads the agent's footer reads it first, so the
	 * check is on the mode the agent shows now (#170).
	 */
	private open(picker: Picker, event: MouseEvent): void {
		const sender = this.options.sender();
		if (!sender || picker.busy || this.block(picker.setting) !== null) return;
		const at = { x: event.clientX, y: event.clientY };
		if (picker.setting === 'mode' && sender.readMode) {
			const paneId = this.options.paneId();
			void this.readFooter(sender, paneId).then(() => {
				if (this.rootEl && !picker.busy && this.block(picker.setting) === null) this.showMenu(picker, sender, at);
			});
			return;
		}
		this.showMenu(picker, sender, at);
	}

	private showMenu(picker: Picker, sender: SessionSettingsSender, at: { x: number; y: number }): void {
		const choices = this.choices(picker.setting);
		const menu = new Menu();
		const scopes = picker.setting === 'mode' ? sender.scopes.slice(0, 1) : sender.scopes;
		const agent = this.state.format?.name ?? 'the agent';
		scopes.forEach((scope, index) => {
			if (index > 0) {
				menu.addSeparator();
				menu.addItem((item) => item.setTitle(DEFAULT_SCOPE_LABEL).setIsLabel(true));
				menu.addItem((item) => item.setTitle(defaultScopeNote(picker.setting, agent)).setIsLabel(true));
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
		menu.showAtPosition(at);
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
			const pending =
				target.setting === 'model'
					? sender.setModel(paneId, value, scope, this.options.confirm)
					: target.setting === 'effort'
						? sender.setEffort(paneId, value, scope)
						: sender.setMode(paneId, value);
			// A kind that changes one thing at a time says so now (`unavailable`).
			this.draw();
			await pending;
		} catch (error) {
			this.notify(settingFailureMessage(target.setting, error));
		} finally {
			target.busy = false;
			// Whatever happened, the footer says where the mode is now.
			if (target.setting === 'mode') await this.readFooter(sender, paneId);
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
