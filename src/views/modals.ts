/**
 * Two small modals the agent row menu needs (issue #35): a yes-or-no
 * confirmation before a pane is closed, and a one-line prompt for a new agent
 * name. Both resolve a promise when they close, so a caller reads
 * `if (await confirm(...))` and never wires callbacks.
 *
 * Layout is Obsidian's own: `Setting` rows for the input and the buttons, the
 * `mod-warning` button for the destructive choice, no classes of ours and no
 * inline styles. Enter confirms and Escape cancels, the second through the
 * modal's own scope.
 */

import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
	title: string;
	body: string;
	/** Text on the confirming button. Sentence case. */
	confirm: string;
	/** Draw the confirming button as a warning, for something that destroys. */
	warning?: boolean;
}

/** A yes-or-no modal. Resolves true on confirm, false on cancel or dismiss. */
export class ConfirmModal extends Modal {
	private resolve: ((value: boolean) => void) | null = null;
	private confirmed = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
	) {
		super(app);
	}

	/** Opens the modal and answers when it closes. */
	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	override onOpen(): void {
		const { options } = this;
		this.setTitle(options.title);
		this.contentEl.createEl('p', { text: options.body });
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText(options.confirm).onClick(() => {
					this.confirmed = true;
					this.close();
				});
				if (options.warning) button.setWarning();
				else button.setCta();
			});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve?.(this.confirmed);
		this.resolve = null;
	}
}

export interface PromptOptions {
	title: string;
	/** Line under the input explaining what is accepted. */
	label: string;
	initial: string;
	/** Text on the confirming button. Sentence case. */
	confirm: string;
}

/**
 * A one-line text prompt. Resolves the entered text on confirm (Enter or the
 * button) and null on cancel or dismiss. The text is returned as typed; the
 * caller decides what an empty answer means.
 */
export class PromptModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;
	private value: string;
	private submitted = false;

	constructor(
		app: App,
		private readonly options: PromptOptions,
	) {
		super(app);
		this.value = options.initial;
	}

	/** Opens the modal and answers when it closes. */
	ask(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	override onOpen(): void {
		const { options } = this;
		this.setTitle(options.title);
		new Setting(this.contentEl).setDesc(options.label).addText((text) => {
			text.setValue(this.value).onChange((value) => {
				this.value = value;
			});
			text.inputEl.select();
			// Enter in the field is the same as the button; `keydown` so the
			// event is ours before the modal's scope sees it.
			text.inputEl.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' || event.isComposing) return;
				event.preventDefault();
				this.submit();
			});
		});
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel').onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText(options.confirm).setCta().onClick(() => this.submit());
			});
	}

	private submit(): void {
		this.submitted = true;
		this.close();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve?.(this.submitted ? this.value : null);
		this.resolve = null;
	}
}
