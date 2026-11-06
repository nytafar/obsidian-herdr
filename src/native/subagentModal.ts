/**
 * A subagent's transcript, opened on request from the line that shows it at
 * work (#147): its turns drawn the way the native view draws the session's,
 * following it while it works.
 *
 * The transcript is the session model's (`SessionModelView.subagentTranscript`),
 * held while this is open, so a subagent whose call has scrolled out of view
 * or finished goes on being read until the reader closes it. Obsidian's own
 * modal, so Escape and a click outside close it as any other does.
 */

import { Modal, type App } from 'obsidian';
import type { SubagentTranscript } from './subagents';
import { TurnRenderer, type TurnRendererOptions } from './turnRenderer';

/** The transcript drawn into an element, kept current until destroyed. */
export class SubagentTranscriptView {
	private readonly statusEl: HTMLElement;
	private readonly turnsEl: HTMLElement;
	private readonly renderer: TurnRenderer;
	private readonly unsubscribe: () => void;
	/** The turn ids drawn, in order, so a file read again from its start is drawn afresh. */
	private drawn: string[] = [];
	private destroyed = false;

	constructor(
		el: HTMLElement,
		private readonly transcript: SubagentTranscript,
		options: TurnRendererOptions,
	) {
		this.statusEl = el.createDiv({ cls: 'herdr-subagent-status' });
		this.turnsEl = el.createDiv({ cls: 'herdr-subagent-turns' });
		const sizerEl = this.turnsEl.createDiv({ cls: ['markdown-preview-view', 'markdown-rendered'] });
		this.renderer = new TurnRenderer(sizerEl, options);
		this.unsubscribe = transcript.on(() => this.draw());
		this.draw();
	}

	/** Draws what changed: every turn is reconciled, so one that did not change keeps its elements. */
	draw(): void {
		if (this.destroyed) return;
		const turns = this.transcript.state.turns;
		const running = this.transcript.running;
		this.statusEl.setText(running ? 'Working…' : 'Not working');
		this.statusEl.toggleClass('is-live', running);
		const ids = turns.map((turn) => turn.id);
		// Fewer turns, or others, is the file read again from its start.
		if (this.drawn.some((id, index) => ids[index] !== id)) this.renderer.clear();
		const pinned = this.atEnd();
		turns.forEach((turn, index) => {
			this.renderer.render(turn, running && index === turns.length - 1 ? 'working' : null);
		});
		this.drawn = ids;
		if (pinned) this.turnsEl.scrollTop = this.turnsEl.scrollHeight;
	}

	/** Lets the transcript go and drops what was drawn. */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.unsubscribe();
		this.renderer.clear();
		this.transcript.release();
	}

	/** Whether the reader is at the end of the turns, where new work is followed. */
	private atEnd(): boolean {
		const el = this.turnsEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
	}
}

/** The modal around {@link SubagentTranscriptView}. */
export class SubagentModal extends Modal {
	private view: SubagentTranscriptView | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly transcript: SubagentTranscript,
		private readonly options: TurnRendererOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('herdr-subagent-modal');
		this.setTitle(this.title);
		this.view = new SubagentTranscriptView(this.contentEl, this.transcript, this.options);
	}

	onClose(): void {
		this.view?.destroy();
		this.view = null;
		this.contentEl.empty();
	}
}
