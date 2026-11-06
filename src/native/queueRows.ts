/**
 * The queued prompts above the prompt box (issue #159).
 *
 * Two kinds of row, in the order the agent will see them:
 *
 * - **Queued in Claude**: prompts Claude itself holds (typed in the terminal,
 *   or handed over with Send now), from their transcript enqueue until a line
 *   spends it (`pendingQueue`, #157). No actions: the TUI offers nothing
 *   addressable per prompt, and its Up would pull the user's own terminal
 *   input back too. Shown only while the agent works or is blocked; at rest
 *   Claude's queue has run, so an entry still pending there is a record the
 *   parser could not pair, not a prompt waiting.
 * - **Queued**: the plugin's own rows (`./promptQueue.ts`), with Send now,
 *   Edit and Discard.
 *
 * Guidelines: no `innerHTML`, no inline styles, every listener on a
 * `Component` that goes with the draw.
 */

import { Component } from 'obsidian';
import type { AgentStatus } from '../herdr/types.gen';
import type { PaneQueue, QueuedPrompt } from './promptQueue';

/** What the rows read, per draw. */
export interface QueueRowsOptions {
	/** The pane's queue, or null while the view has no pane. */
	queue: () => PaneQueue | null;
	/** The agent's status, as the view shows it. */
	status: () => AgentStatus;
	/** The prompts Claude holds, oldest first, from the transcript. */
	heldByAgent: () => readonly string[];
	/** Puts a row taken back into the prompt box. */
	onEdit: (row: QueuedPrompt) => void;
}

/** What a row says under its text. */
export function queuedRowNote(row: QueuedPrompt, status: AgentStatus): string {
	if (row.sending) return 'Sending…';
	if (row.error) return `Not sent: ${row.error}`;
	if (status === 'blocked') return 'Queued. Goes once the agent is no longer waiting for you.';
	if (status === 'working') return 'Queued for the next turn. Send now goes in at the agent’s next step.';
	return 'Queued.';
}

/** The words of a prompt Claude holds, without the stand-ins of pasted images. */
export function heldText(content: string): string {
	return content.replace(/\[Image #\d+\]/g, '').trim();
}

/** How many images go with a row, in words, or empty. */
export function imagesNote(count: number): string {
	if (count === 0) return '';
	return count === 1 ? '1 image' : `${count} images`;
}

export class QueueRows {
	private readonly options: QueueRowsOptions;
	private readonly rootEl: HTMLElement;
	private drawn: Component | null = null;
	/** What the last draw showed, so a transcript batch that moves none of it redraws nothing. */
	private shown = '';

	constructor(parentEl: HTMLElement, options: QueueRowsOptions) {
		this.options = options;
		this.rootEl = parentEl.createDiv({ cls: ['herdr-native-queue', 'herdr-native-sizer', 'herdr-is-hidden'] });
	}

	/**
	 * Draws every row again when what they show moved; there are few. Called
	 * on every change of the session, which streams while the agent works, so
	 * an unchanged draw is skipped and a button is never replaced under a click.
	 */
	render(): void {
		const status = this.options.status();
		const held = status === 'working' || status === 'blocked' ? this.options.heldByAgent() : [];
		const queue = this.options.queue();
		const rows = queue?.rows ?? [];
		const shown = JSON.stringify([
			status,
			held,
			queue !== null,
			rows.map((row) => [row.id, row.sending, row.error]),
		]);
		if (shown === this.shown) return;
		this.shown = shown;
		this.drawn?.unload();
		this.drawn = null;
		const root = this.rootEl;
		root.empty();
		root.toggleClass('herdr-is-hidden', held.length === 0 && rows.length === 0);
		if (!held.length && !rows.length) return;
		const component = new Component();
		component.load();
		this.drawn = component;
		for (const content of held) {
			const rowEl = root.createDiv({ cls: ['herdr-native-queue-row', 'herdr-is-agent-held'] });
			const bodyEl = rowEl.createDiv({ cls: 'herdr-native-queue-body' });
			bodyEl.createDiv({ cls: 'herdr-native-queue-text', text: heldText(content) });
			bodyEl.createDiv({ cls: 'herdr-native-queue-note', text: 'Queued in Claude.' });
		}
		if (!queue) return;
		for (const row of rows) this.renderRow(root, component, queue, row, status);
	}

	/** Takes the rows away. */
	destroy(): void {
		this.drawn?.unload();
		this.drawn = null;
		this.rootEl.remove();
	}

	private renderRow(
		root: HTMLElement,
		component: Component,
		queue: PaneQueue,
		row: QueuedPrompt,
		status: AgentStatus,
	): void {
		const rowEl = root.createDiv({ cls: 'herdr-native-queue-row' });
		rowEl.toggleClass('herdr-is-failed', row.error !== null);
		const bodyEl = rowEl.createDiv({ cls: 'herdr-native-queue-body' });
		bodyEl.createDiv({ cls: 'herdr-native-queue-text', text: row.text });
		const images = imagesNote(row.images.length);
		const note = queuedRowNote(row, status);
		bodyEl.createDiv({ cls: 'herdr-native-queue-note', text: images ? `${images}. ${note}` : note });
		const actionsEl = rowEl.createDiv({ cls: 'herdr-native-queue-actions' });
		const sendEl = actionsEl.createEl('button', { cls: 'herdr-native-queue-send', text: 'Send now' });
		sendEl.disabled = row.sending || !queue.canSendNow(status);
		const editEl = actionsEl.createEl('button', { cls: 'herdr-native-queue-edit', text: 'Edit' });
		editEl.disabled = row.sending;
		const discardEl = actionsEl.createEl('button', { cls: 'herdr-native-queue-discard', text: 'Discard' });
		discardEl.disabled = row.sending;
		component.registerDomEvent(sendEl, 'click', () => {
			void queue.sendNow(row.id);
		});
		component.registerDomEvent(editEl, 'click', () => {
			const taken = queue.take(row.id);
			if (taken) this.options.onEdit(taken);
		});
		component.registerDomEvent(discardEl, 'click', () => {
			queue.discard(row.id);
		});
	}
}
