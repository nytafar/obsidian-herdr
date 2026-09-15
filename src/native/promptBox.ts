/**
 * The prompt box (issue #97, ADR-0003).
 *
 * The multi-line box under the transcript, and the button beside it. It owns
 * no state of its own beyond the text being typed: what it may do is herdr's
 * `agent_status`, which the native surface feeds it on every transition
 * ({@link PromptBox.setStatus}), and what a send *is* belongs to the sender
 * (`./promptSender.ts`).
 *
 * The status table, from the design (`findings/native-view-design.md`) and the
 * facts under it (`docs/architecture.md`, "Agent prompts and session
 * identity"):
 *
 * - `idle`, `done` — **Send**. A freshly started Claude with no session yet is
 *   `idle`, so the first prompt of a session goes out through this same path
 *   and the view starts tailing when herdr reports the new `agent_session`.
 * - `working` — **Queue**, enabled: herdr accepts a prompt mid-turn and Claude
 *   consumes it inside the running turn. Nothing is echoed here; the steer
 *   appears when its enqueue line arrives from the transcript.
 * - `blocked` — disabled. Only `blocked` refuses, with `agent_blocked`, and the
 *   waiting card is the way past it.
 * - `unknown` — disabled, and the box says why: there is no agent in this pane.
 *
 * A failed send is a Notice and the text stays in the box, because the text is
 * the only copy of what the user wrote.
 *
 * **Enter sends** (#103), which reverses #97's "enter is a newline, mod+enter
 * sends": the box reads as a chat input, not as a form, and that is what every
 * chat the user already has does. Shift+enter is the newline, mod+enter still
 * sends so no muscle memory breaks, and two things own the enter before this
 * box does — an input method between `compositionstart` and `compositionend`
 * (#49, `event.isComposing`), and the autocomplete's popover while it is open
 * (#98), which uses the enter to pick a suggestion. Neither is a plugin hotkey:
 * everything is a listener on this element (Obsidian guidelines).
 *
 * The box grows with what is typed through CSS alone (`field-sizing: content`
 * between a min and a max height in `styles.css`): no height is ever measured
 * or written here. A drag on the text area's own resizer is the browser
 * writing a height on the element, and it wins — until the box is emptied,
 * when that height is dropped so the next prompt starts at the usual size.
 *
 * Guidelines: no `innerHTML`, no inline styles (`styles.css` has the classes),
 * every listener goes through a `Component` that is unloaded on `destroy`.
 */

import { Component, Notice } from 'obsidian';
import type { PromptSender } from './promptSender';
import type { AgentStatus } from '../herdr/types.gen';

/** What the box shows for one agent status. */
export interface PromptBoxState {
	/** The button's label, sentence case. */
	label: string;
	/** Whether a prompt may be sent at all. */
	enabled: boolean;
	/** Why not, when the reason is not on screen already. Empty for none. */
	hint: string;
}

/** Said when there is no agent to prompt. */
export const NO_AGENT_HINT = 'No agent in this pane.';

/**
 * What the box may do in one agent status. `blocked` gets no hint of its own:
 * the view already says "Waiting for you." above the box, and the waiting card
 * will say it better.
 */
export function promptBoxState(status: AgentStatus): PromptBoxState {
	if (status === 'working') return { label: 'Queue', enabled: true, hint: '' };
	if (status === 'blocked') return { label: 'Send', enabled: false, hint: '' };
	if (status === 'unknown') return { label: 'Send', enabled: false, hint: NO_AGENT_HINT };
	return { label: 'Send', enabled: true, hint: '' };
}

export interface PromptBoxOptions {
	/** The pane to prompt, read per send: a tab can be pointed at another. */
	paneId: () => string;
	sender: PromptSender;
	/** How a failure reaches the user. Defaults to an Obsidian notice. */
	notify?: (message: string) => void;
	/**
	 * Called once the box exists, so a suggest can attach to it (#98). What it
	 * returns says how to take that attachment away again, and — for something
	 * that draws a popover over the box — whether the popover is open, because
	 * the enter belongs to it while it is (#103).
	 */
	onInput?: (inputEl: HTMLTextAreaElement) => PromptInputAttachment;
}

/** What something hung on the text area tells the box about itself (#103). */
export interface PromptInputHandle {
	/** Called when the box goes, so an open popover goes with it. */
	close: () => void;
	/** True while a popover is showing over the box and owns the enter key. */
	isOpen?: () => boolean;
}

/** A handle, or the bare teardown a caller that draws nothing returns. */
export type PromptInputAttachment = PromptInputHandle | (() => void) | void;

/**
 * Whether this keystroke is a send.
 *
 * Enter sends (#103). Shift+enter is the text area's newline, and an enter that
 * an input method is composing with belongs to the input method (#49) — neither
 * reaches this box at all. Mod+enter stays a send, whatever else is held.
 */
export function isSendKey(event: {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	isComposing?: boolean;
}): boolean {
	if (event.key !== 'Enter' || event.isComposing) return false;
	if (event.ctrlKey || event.metaKey) return true;
	return !event.shiftKey;
}

/**
 * What stays in the box once `sent` has gone out of it: nothing when the box
 * still holds exactly what was sent, the tail when the user went on typing
 * after it, and the whole draft when it is no longer that prompt at all. The
 * text in the box is the only copy of what the user wrote, so nothing that was
 * not sent is ever thrown away.
 */
export function remainingDraft(current: string, sent: string): string {
	if (current === sent) return '';
	return current.startsWith(sent) ? current.slice(sent.length) : current;
}

/** What a failed send says, with herdr's own message in the tail. */
export function sendFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Herdr: could not send the prompt (${reason})`;
}

/** The box, its button and the one send path they share. */
export class PromptBox {
	private readonly options: PromptBoxOptions;
	private readonly component = new Component();
	private rootEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private buttonEl: HTMLButtonElement | null = null;
	private hintEl: HTMLElement | null = null;
	/** What `onInput` hung on the text area; null when nothing did. */
	private attachment: PromptInputHandle | null = null;
	private status: AgentStatus = 'unknown';
	/** True from the moment a send starts until herdr has answered it. */
	private sending = false;

	constructor(options: PromptBoxOptions) {
		this.options = options;
	}

	/** Builds the box inside `parentEl`. Called once, from the surface's attach. */
	mount(parentEl: HTMLElement): void {
		this.component.load();
		// `herdr-native-sizer`: the box sits at the width of the prose above it
		// when the vault asks for a readable line width (#117).
		const root = parentEl.createDiv({ cls: ['herdr-native-prompt-box', 'herdr-native-sizer'] });
		// The text area and the button share a row, the way a chat input does
		// (#103); the hint, when there is one, comes under them.
		const row = root.createDiv({ cls: 'herdr-native-prompt-row' });
		const inputEl = row.createEl('textarea', {
			cls: 'herdr-native-prompt-input',
			// The placeholder is gone once something is typed; the label is not.
			// `rows` is what sizes the box where `field-sizing` is not supported.
			attr: { rows: '2', placeholder: 'Message the agent…', 'aria-label': 'Message the agent' },
		});
		const controls = row.createDiv({ cls: 'herdr-native-prompt-controls' });
		this.hintEl = null;
		const buttonEl = controls.createEl('button', {
			cls: 'herdr-native-prompt-send',
			text: 'Send',
		});
		this.rootEl = root;
		this.inputEl = inputEl;
		this.buttonEl = buttonEl;
		this.component.registerDomEvent(buttonEl, 'click', () => {
			void this.send();
		});
		this.component.registerDomEvent(inputEl, 'keydown', (event: KeyboardEvent) => {
			// The popover owns the enter while it is open: it picks a suggestion
			// with it (#98), and the prompt is not finished yet.
			if (this.attachment?.isOpen?.()) return;
			if (!isSendKey(event)) return;
			event.preventDefault();
			void this.send();
		});
		this.component.registerDomEvent(inputEl, 'input', () => this.dropManualHeight());
		this.render();
		const attachment = this.options.onInput?.(inputEl);
		this.attachment =
			typeof attachment === 'function' ? { close: attachment } : (attachment ?? null);
	}

	/** Drops the box and every listener on it. Idempotent. */
	destroy(): void {
		this.attachment?.close();
		this.attachment = null;
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.inputEl = null;
		this.buttonEl = null;
		this.hintEl = null;
	}

	/**
	 * Takes the box off screen while the waiting card stands in its place (#99),
	 * and brings it back when the block is over.
	 *
	 * A class rather than a removal, and never an inline style (Obsidian
	 * guidelines): the draft in the box is the only copy of what the user wrote,
	 * so it has to survive a block it was typed through.
	 */
	setHidden(hidden: boolean): void {
		this.rootEl?.toggleClass('herdr-is-hidden', hidden);
	}

	/** herdr's view of the agent changed; the button follows it. */
	setStatus(status: AgentStatus): void {
		if (status === this.status) return;
		this.status = status;
		this.render();
	}

	/** The text as typed, for the suggest and for tests. */
	get text(): string {
		return this.inputEl?.value ?? '';
	}

	/**
	 * Sends what is in the box, if anything, and if the status allows it.
	 *
	 * The box is emptied only once herdr has taken the text: a failure keeps it,
	 * with a notice saying what herdr said.
	 */
	async send(): Promise<void> {
		const inputEl = this.inputEl;
		if (!inputEl || this.sending) return;
		if (!promptBoxState(this.status).enabled) return;
		const text = inputEl.value;
		if (text.trim() === '') return;
		this.sending = true;
		this.render();
		try {
			await this.options.sender.send(this.options.paneId(), text);
			// Nothing is echoed into the view: the prompt appears when the
			// transcript says it did (ADR-0003). Only what went out is taken out
			// of the box: typing stays enabled during the request, so anything
			// composed meanwhile is the user's next prompt, not this one.
			if (this.inputEl) {
				this.inputEl.value = remainingDraft(this.inputEl.value, text);
				this.dropManualHeight();
			}
		} catch (error) {
			this.notify(sendFailureMessage(error));
		} finally {
			this.sending = false;
			this.render();
		}
	}

	/**
	 * Gives an emptied box its usual size back.
	 *
	 * A drag on the resizer is the browser writing a height on the element, and
	 * that height beats the CSS auto-grow for as long as it is there, which is
	 * what the user asked for. An empty box is a finished prompt, so the height
	 * goes with it — by removing what the browser wrote, never by writing one
	 * here (no inline styles, Obsidian guidelines).
	 */
	private dropManualHeight(): void {
		const inputEl = this.inputEl;
		if (!inputEl || inputEl.value !== '') return;
		inputEl.removeAttribute('style');
	}

	private notify(message: string): void {
		if (this.options.notify) {
			this.options.notify(message);
			return;
		}
		new Notice(message);
	}

	/** Draws the button and the hint for the status the box is in. */
	private render(): void {
		const root = this.rootEl;
		if (!root) return;
		const state = promptBoxState(this.status);
		if (this.buttonEl) {
			this.buttonEl.setText(state.label);
			this.buttonEl.disabled = !state.enabled || this.sending;
		}
		// A blocked agent can still be typed at, so only "no agent" locks the
		// text itself.
		if (this.inputEl) this.inputEl.disabled = state.hint !== '';
		if (!state.hint) {
			this.hintEl?.remove();
			this.hintEl = null;
			return;
		}
		if (!this.hintEl) this.hintEl = root.createDiv({ cls: 'herdr-native-prompt-hint' });
		this.hintEl.setText(state.hint);
	}
}
