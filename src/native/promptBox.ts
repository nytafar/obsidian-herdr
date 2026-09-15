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
 * Guidelines: no `innerHTML`, no inline styles (`styles.css` has the classes),
 * every listener goes through a `Component` that is unloaded on `destroy`, and
 * mod+enter is a listener on this element, not a hotkey the plugin registers.
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
	 * returns is called when the box goes, so an open popover goes with it.
	 */
	onInput?: (inputEl: HTMLTextAreaElement) => (() => void) | void;
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
	/** Undoes what `onInput` hung on the text area; null when nothing did. */
	private closeInput: (() => void) | null = null;
	private status: AgentStatus = 'unknown';
	/** True from the moment a send starts until herdr has answered it. */
	private sending = false;

	constructor(options: PromptBoxOptions) {
		this.options = options;
	}

	/** Builds the box inside `parentEl`. Called once, from the surface's attach. */
	mount(parentEl: HTMLElement): void {
		this.component.load();
		const root = parentEl.createDiv({ cls: 'herdr-native-prompt-box' });
		const inputEl = root.createEl('textarea', {
			cls: 'herdr-native-prompt-input',
			// The placeholder is gone once something is typed; the label is not.
			attr: { rows: '3', placeholder: 'Message the agent…', 'aria-label': 'Message the agent' },
		});
		const controls = root.createDiv({ cls: 'herdr-native-prompt-controls' });
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
		// Enter is a newline in a multi-line box; mod+enter sends, which is what
		// the terminal it replaces does. Not a plugin hotkey: nothing is bound
		// outside this element (Obsidian guidelines).
		this.component.registerDomEvent(inputEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			void this.send();
		});
		this.render();
		const closeInput = this.options.onInput?.(inputEl);
		this.closeInput = typeof closeInput === 'function' ? closeInput : null;
	}

	/** Drops the box and every listener on it. Idempotent. */
	destroy(): void {
		this.closeInput?.();
		this.closeInput = null;
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.inputEl = null;
		this.buttonEl = null;
		this.hintEl = null;
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
			if (this.inputEl) this.inputEl.value = remainingDraft(this.inputEl.value, text);
		} catch (error) {
			this.notify(sendFailureMessage(error));
		} finally {
			this.sending = false;
			this.render();
		}
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
