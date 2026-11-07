/**
 * An image from a prompt, full size (#144): what a click on a thumbnail in the
 * native view opens. Obsidian's own modal, so Escape and a click outside close
 * it as any other does; the picture is scaled down to fit and never up
 * (`styles.css`), and its bytes go when the modal does.
 */

import { Modal, type App } from 'obsidian';
import type { ShownImage } from './turnRenderer';

export class ImageModal extends Modal {
	constructor(
		app: App,
		private readonly image: ShownImage,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('herdr-image-modal');
		this.setTitle(this.image.label);
		this.contentEl.createEl('img', {
			cls: 'herdr-image-modal-img',
			attr: { src: this.image.src, alt: this.image.label },
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
