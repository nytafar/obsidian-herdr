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
 * - `working` — **Queue**, enabled. With the plugin's queue (#159,
 *   `./promptQueue.ts`) the prompt is held as a row above the box and goes
 *   when the turn ends; without one it is handed over at once and Claude
 *   consumes it inside the running turn. Behind rows already waiting, a
 *   prompt is held whatever the status, so it never overtakes them.
 * - `blocked` — disabled. Only `blocked` refuses, with `agent_blocked`, and the
 *   waiting card is the way past it.
 * - `unknown` — disabled, and the box says why: there is no agent in this pane.
 *
 * A failed send is a Notice and the text stays in the box, because the text is
 * the only copy of what the user wrote.
 *
 * **The pane gate** (review of #169, `./paneGate.ts`): while the session bar
 * drives one of Claude's pickers on a herdr or herdr-core pane, or one may
 * still be open there, the sender says why ({@link PromptSender.blocked});
 * the button is disabled with that as its label, a send is refused with it,
 * and the session bar says it under the pickers. Typed text in a picker
 * would be taken by it, and its Enter saves the user's default.
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
 * **Images** (#144) are pasted or dropped onto the box and wait in a strip
 * above the text, each with a thumbnail and a remove button, until the prompt
 * goes with them; a prompt may then be a picture alone. A paste takes images
 * only when the clipboard holds no plain text, so copying from a spreadsheet
 * or a document (which also puts a picture of the selection there) still
 * pastes the text. Whether images can go at all is the sender's to say
 * (`imagesUnavailable`): where they cannot, a paste or drop of one says why
 * in a notice and attaches nothing.
 *
 * Guidelines: no `innerHTML`, no inline styles (`styles.css` has the classes),
 * every listener goes through a `Component` that is unloaded on `destroy`.
 */

import { Component, Notice } from 'obsidian';
import { imagesUnavailable, type PromptSender } from './promptSender';
import { imageFileProblem, MAX_PROMPT_IMAGES, type PromptImage } from './promptImages';
import type { PaneQueue } from './promptQueue';
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
	/**
	 * The pane's queue (#159), read per send: a prompt it holds becomes a row
	 * and is not sent from here. Left out, every prompt is sent at once.
	 */
	queue?: () => PaneQueue | null;
	/** How a failure reaches the user. Defaults to an Obsidian notice. */
	notify?: (message: string) => void;
	/**
	 * Called once the box exists, so a suggest can attach to it (#98). What it
	 * returns says how to take that attachment away again, and — for something
	 * that draws a popover over the box — whether the popover is open, because
	 * the enter belongs to it while it is (#103).
	 */
	onInput?: (inputEl: HTMLTextAreaElement) => PromptInputAttachment;
	/**
	 * Reads a pasted or dropped file as base64. Defaults to the file's own
	 * bytes; a test passes a fake.
	 */
	readFile?: (file: ImageFile) => Promise<string>;
}

/** What the box reads of a pasted or dropped file: a browser `File`, narrowed. */
export interface ImageFile {
	name: string;
	type: string;
	size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** The bytes of a file, base64. */
async function fileBase64(file: ImageFile): Promise<string> {
	return Buffer.from(await file.arrayBuffer()).toString('base64');
}

/** What a paste or drop event carries, narrowed to what the box reads. */
interface TransferLike {
	files?: ArrayLike<ImageFile> | null;
	types?: ArrayLike<string> | null;
	getData?: (format: string) => string;
}

/** The files a paste or drop carries. */
function transferFiles(transfer: TransferLike | null | undefined): ImageFile[] {
	return transfer?.files ? Array.from(transfer.files) : [];
}

/** Whether a drag carries files at all, which is all `dragover` may ask. */
export function carriesFiles(transfer: TransferLike | null | undefined): boolean {
	return Array.from(transfer?.types ?? []).includes('Files');
}

/**
 * The images a paste should attach: the clipboard's image files, but none
 * when it also holds plain text, which is then what is pasted.
 */
export function pastedImages(transfer: TransferLike | null | undefined): ImageFile[] {
	const images = transferFiles(transfer).filter((file) => file.type.startsWith('image/'));
	if (!images.length) return [];
	const text = transfer?.getData?.('text/plain') ?? '';
	return text.trim() ? [] : images;
}

/** A data URL for an image's bytes, for a thumbnail. */
export function imageDataUrl(mediaType: string, data: string): string {
	return `data:${mediaType};base64,${data}`;
}

/** What a paste or drop says when the pane's runtime cannot take images. */
export function imagesRefusedMessage(reason: string): string {
	return `Gjetr: images cannot be sent here (${reason}).`;
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
	return `Gjetr: could not send the prompt (${reason})`;
}

/** The box, its button and the one send path they share. */
export class PromptBox {
	private readonly options: PromptBoxOptions;
	private readonly component = new Component();
	private rootEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private buttonEl: HTMLButtonElement | null = null;
	/** Stop, for a sender that can interrupt (ADR-0007); null otherwise. */
	private stopEl: HTMLButtonElement | null = null;
	private hintEl: HTMLElement | null = null;
	/** What `onInput` hung on the text area; null when nothing did. */
	private attachment: PromptInputHandle | null = null;
	/** Images waiting to go with the next prompt (#144), in the order added. */
	private images: PromptImage[] = [];
	/** The strip that shows them, above the text area. */
	private imagesEl: HTMLElement | null = null;
	/** The strip's remove buttons' listeners, replaced on every draw. */
	private imagesComponent: Component | null = null;
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
		// Images waiting to be sent (#144), above the text they go with.
		this.imagesEl = root.createDiv({ cls: ['herdr-native-prompt-images', 'herdr-is-hidden'] });
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
		if (this.options.sender.interrupt) {
			const stopEl = controls.createEl('button', { cls: 'herdr-native-prompt-stop', text: 'Stop' });
			stopEl.setAttr('aria-label', 'Stop the running turn');
			this.stopEl = stopEl;
			this.component.registerDomEvent(stopEl, 'click', () => {
				void this.interrupt();
			});
		}
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
		this.component.registerDomEvent(inputEl, 'paste', (event: ClipboardEvent) => {
			const files = pastedImages(event.clipboardData);
			if (!files.length) return;
			const reason = this.imagesRefused();
			if (reason) {
				this.notify(imagesRefusedMessage(reason));
				return;
			}
			event.preventDefault();
			void this.attachImages(files);
		});
		// A file dragged over the box may be dropped on it. Anything else
		// dragged (text, a note's link) is the text area's, as always.
		this.component.registerDomEvent(root, 'dragover', (event: DragEvent) => {
			if (!carriesFiles(event.dataTransfer)) return;
			event.preventDefault();
			root.addClass('herdr-is-drop-target');
		});
		this.component.registerDomEvent(root, 'dragleave', () => root.removeClass('herdr-is-drop-target'));
		this.component.registerDomEvent(root, 'drop', (event: DragEvent) => {
			root.removeClass('herdr-is-drop-target');
			const files = transferFiles(event.dataTransfer);
			if (!files.length) return;
			// Never the browser's own drop: it would type the file's path.
			event.preventDefault();
			const reason = this.imagesRefused();
			if (reason) {
				this.notify(imagesRefusedMessage(reason));
				return;
			}
			void this.attachImages(files);
		});
		this.render();
		const attachment = this.options.onInput?.(inputEl);
		this.attachment =
			typeof attachment === 'function' ? { close: attachment } : (attachment ?? null);
	}

	/** Drops the box and every listener on it. Idempotent. */
	destroy(): void {
		this.attachment?.close();
		this.attachment = null;
		this.imagesComponent?.unload();
		this.imagesComponent = null;
		this.imagesEl = null;
		this.images = [];
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.inputEl = null;
		this.buttonEl = null;
		this.stopEl = null;
		this.hintEl = null;
	}

	/** Ends the running turn through the sender; a failure is a notice. */
	async interrupt(): Promise<void> {
		const sender = this.options.sender;
		if (!sender.interrupt || this.status !== 'working') return;
		try {
			await sender.interrupt(this.options.paneId());
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.notify(`Gjetr: could not stop the turn (${reason})`);
		}
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

	/**
	 * Puts the cursor in the text area (#145). False when there is none to
	 * take it: not mounted, hidden behind the waiting card, or locked because
	 * there is no agent.
	 */
	focus(): boolean {
		if (!this.canFocus()) return false;
		this.inputEl?.focus();
		return true;
	}

	/** Whether {@link focus} would take; see there. */
	canFocus(): boolean {
		const inputEl = this.inputEl;
		return Boolean(inputEl && !inputEl.disabled && !this.rootEl?.hasClass('herdr-is-hidden'));
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

	/** The images waiting to go with the next prompt, for tests. */
	get attachedImages(): readonly PromptImage[] {
		return this.images;
	}

	/**
	 * Why no image may be attached now, or null when one may: the sender's
	 * reason first, then a box that is locked because there is no agent.
	 */
	imagesRefused(): string | null {
		const reason = imagesUnavailable(this.options.sender, this.options.paneId());
		if (reason) return reason;
		const hint = promptBoxState(this.status).hint;
		return hint ? hint.replace(/\.$/, '').toLowerCase() : null;
	}

	/**
	 * Reads pasted or dropped files and puts the images among them in the
	 * strip. A file that is no image Claude takes, or too large, is a notice
	 * and is left out; the others are attached.
	 */
	async attachImages(files: readonly ImageFile[]): Promise<void> {
		const read = this.options.readFile ?? fileBase64;
		for (const file of files) {
			const problem = imageFileProblem(file);
			if (problem) {
				this.notify(`Gjetr: ${problem}.`);
				continue;
			}
			if (this.images.length >= MAX_PROMPT_IMAGES) {
				this.notify(`Gjetr: a prompt takes at most ${MAX_PROMPT_IMAGES} images.`);
				break;
			}
			let data: string;
			try {
				data = await read(file);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.notify(`Gjetr: could not read ${file.name || 'the image'} (${reason})`);
				continue;
			}
			// The box went while the file was read.
			if (!this.imagesEl) return;
			this.images = [...this.images, { mediaType: file.type, data, name: file.name || 'Pasted image' }];
			this.renderImages();
		}
	}

	/** Takes one waiting image out of the strip. */
	removeImage(image: PromptImage): void {
		const next = this.images.filter((candidate) => candidate !== image);
		if (next.length === this.images.length) return;
		this.images = next;
		this.renderImages();
	}

	/** Draws the strip of waiting images; hidden while there are none. */
	private renderImages(): void {
		const stripEl = this.imagesEl;
		if (!stripEl) return;
		this.imagesComponent?.unload();
		this.imagesComponent = null;
		stripEl.empty();
		stripEl.toggleClass('herdr-is-hidden', this.images.length === 0);
		if (!this.images.length) return;
		const component = new Component();
		component.load();
		this.imagesComponent = component;
		for (const image of this.images) {
			const itemEl = stripEl.createDiv({ cls: 'herdr-native-prompt-image' });
			itemEl.createEl('img', {
				cls: 'herdr-native-prompt-image-thumb',
				attr: { src: imageDataUrl(image.mediaType, image.data), alt: image.name },
			});
			const removeEl = itemEl.createEl('button', {
				cls: 'herdr-native-prompt-image-remove',
				text: '×',
				attr: { 'aria-label': `Remove ${image.name}` },
			});
			component.registerDomEvent(removeEl, 'click', () => this.removeImage(image));
		}
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
		// A picture may go alone (#144); nothing at all is no prompt.
		const images = this.images;
		if (text.trim() === '' && !images.length) return;
		const queue = this.options.queue?.() ?? null;
		if (queue?.holds(this.status)) {
			// Held, not sent (#159): the row is the copy now, so the box empties.
			queue.add(text, images);
			inputEl.value = '';
			this.dropManualHeight();
			this.images = [];
			this.renderImages();
			return;
		}
		// The pane gate (review of #169): while the session bar drives one of
		// Claude's pickers, or one may still be open, nothing is typed into
		// the pane. The text stays; the bar says why.
		const blocked = this.blocked();
		if (blocked) {
			this.notify(sendFailureMessage(new Error(blocked)));
			return;
		}
		this.sending = true;
		this.render();
		try {
			if (images.length) await this.options.sender.send(this.options.paneId(), text, images);
			else await this.options.sender.send(this.options.paneId(), text);
			// Nothing is echoed into the view: the prompt appears when the
			// transcript says it did (ADR-0003). Only what went out is taken out
			// of the box: typing stays enabled during the request, so anything
			// composed meanwhile is the user's next prompt, not this one.
			if (this.inputEl) {
				this.inputEl.value = remainingDraft(this.inputEl.value, text);
				this.dropManualHeight();
			}
			// The same for images: one added while this went out stays.
			if (images.length) {
				this.images = this.images.filter((image) => !images.includes(image));
				this.renderImages();
			}
		} catch (error) {
			this.notify(sendFailureMessage(error));
		} finally {
			this.sending = false;
			this.render();
		}
	}

	/**
	 * Puts a queued row back to be edited (#159): its text before whatever is
	 * in the box already, which is never thrown away, and its images with the
	 * ones waiting, up to the most a prompt takes.
	 */
	restore(text: string, images: readonly PromptImage[] = []): void {
		const inputEl = this.inputEl;
		if (!inputEl) return;
		const draft = inputEl.value;
		inputEl.value = draft.trim() === '' ? text : text === '' ? draft : `${text}\n${draft}`;
		const room = MAX_PROMPT_IMAGES - this.images.length;
		if (room < images.length) this.notify(`Gjetr: a prompt takes at most ${MAX_PROMPT_IMAGES} images.`);
		if (images.length && room > 0) {
			this.images = [...images.slice(0, room), ...this.images];
			this.renderImages();
		}
		if (this.canFocus()) inputEl.focus();
	}

	/** Draws the button again: the pane gate opened or shut (review of #169). */
	refresh(): void {
		this.render();
	}

	/** Why nothing may be typed into the pane now, from the sender; null when it may. */
	private blocked(): string | null {
		return this.options.sender.blocked?.(this.options.paneId()) ?? null;
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
		// Only a running turn has anything to stop.
		this.stopEl?.toggleClass('herdr-is-hidden', this.status !== 'working');
		if (this.buttonEl) {
			const blocked = this.blocked();
			this.buttonEl.setText(state.label);
			this.buttonEl.disabled = !state.enabled || this.sending || blocked !== null;
			if (blocked) this.buttonEl.setAttr('aria-label', blocked);
			else this.buttonEl.removeAttribute('aria-label');
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
