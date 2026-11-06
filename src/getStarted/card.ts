/**
 * The "Get started" card (ADR-0008): drawn in the agent list when no runtime
 * connects, and in a modal behind the `Get started` command. What it offers
 * and when is `./flow.ts`; this file draws the model and maps a click on one
 * of its buttons to the flow's action.
 *
 * Buttons carry their action in `data-herdr-start`, and the one delegated
 * click listener each host registers (the list's `registerDomEvent`, the
 * modal's content element) reads it, so a redraw never piles up listeners.
 * Links are plain anchors, which Obsidian opens in the browser. No inline
 * styles: everything is a class in `styles.css`.
 */

import { App, Modal } from 'obsidian';
import type { GetStartedFlow, GetStartedModel, Offer } from './flow';

/** What a card button does. */
export type GetStartedAction =
	| 'simple'
	| 'copy'
	| 'terminal'
	| 'ask-claude'
	| 'check-again'
	| 'use-herdr-core';

const ACTIONS: readonly GetStartedAction[] = [
	'simple',
	'copy',
	'terminal',
	'ask-claude',
	'check-again',
	'use-herdr-core',
];

/** The attribute a card button keeps its action in. */
export const ACTION_ATTR = 'data-herdr-start';

const BUTTON_CLASS = 'herdr-get-started-button';

/** The action of the card button an event landed on, or null. */
export function getStartedActionOf(target: unknown): GetStartedAction | null {
	const el = target as { closest?: (selector: string) => Element | null } | null;
	const button = el?.closest?.(`button.${BUTTON_CLASS}`) ?? null;
	if (!button || button.getAttribute('disabled') !== null) return null;
	const action = button.getAttribute(ACTION_ATTR);
	return ACTIONS.includes(action as GetStartedAction) ? (action as GetStartedAction) : null;
}

/** Runs a card action on the flow. */
export function runGetStartedAction(flow: GetStartedFlow, action: GetStartedAction): Promise<unknown> {
	switch (action) {
		case 'simple':
			return flow.startSimpleMode();
		case 'copy':
			return flow.copyInstaller();
		case 'terminal':
			return flow.runInTerminal();
		case 'ask-claude':
			return flow.askClaude();
		case 'check-again':
			return flow.rescan();
		case 'use-herdr-core':
			return flow.useHerdrCore();
	}
}

function button(parent: HTMLElement, text: string, action: GetStartedAction, cta = false): HTMLElement {
	const el = parent.createEl('button', { cls: cta ? [BUTTON_CLASS, 'mod-cta'] : BUTTON_CLASS, text });
	el.setAttr('type', 'button');
	el.setAttr(ACTION_ATTR, action);
	return el;
}

/** A button for an offer, disabled with its reason under it when unavailable. */
function offerButton(parent: HTMLElement, text: string, action: GetStartedAction, offer: Offer): void {
	const el = button(parent, text, action);
	if (offer.available) return;
	el.setAttr('disabled', 'true');
	el.setAttr('aria-disabled', 'true');
	parent.createDiv({ cls: 'herdr-get-started-reason', text: offer.reason });
}

function command(parent: HTMLElement, text: string): void {
	parent.createDiv({ cls: 'herdr-get-started-command' }).createEl('code', { text });
}

function section(parent: HTMLElement, title: string): HTMLElement {
	const el = parent.createDiv({ cls: 'herdr-get-started-section' });
	el.createDiv({ cls: 'herdr-get-started-heading', text: title });
	return el;
}

/** Draws the card for `model` into `parent`. */
export function renderGetStartedCard(parent: HTMLElement, model: GetStartedModel, why?: string): HTMLElement {
	const card = parent.createDiv({ cls: 'herdr-get-started' });
	card.createDiv({ cls: 'herdr-get-started-title', text: 'Get started' });
	if (why) card.createDiv({ cls: 'herdr-get-started-why', text: why });
	if (!model.scanned) {
		card.createDiv({ cls: 'herdr-get-started-note', text: 'Looking for Claude Code and herdr-core on this machine…' });
	}

	// 1. Simple mode now.
	const simple = section(card, 'Start now with Claude, run by Obsidian');
	if (model.simple.available) {
		simple.createDiv({
			cls: 'herdr-get-started-note',
			text: 'Obsidian runs Claude Code for you. No multiplexer needed; agents stop when Obsidian closes.',
		});
		const row = simple.createDiv({ cls: 'herdr-get-started-actions' });
		button(row, 'Start Claude in this vault', 'simple', true);
	} else if (model.scanned) {
		simple.createDiv({
			cls: 'herdr-get-started-note',
			text: 'Claude Code was not found on this machine. Install it with its official installer in your terminal, then check again:',
		});
		command(simple, model.simple.command);
		simple.createEl('a', { href: model.simple.docsUrl, text: 'Setup guide' });
	}

	// 2. Install herdr-core.
	const install = section(card, 'Install herdr-core');
	install.createDiv({
		cls: 'herdr-get-started-note',
		text: "herdr-core keeps agents running after Obsidian closes. Its official installer is this command; the plugin never downloads anything itself:",
	});
	command(install, model.install.command);
	const ways = install.createDiv({ cls: 'herdr-get-started-actions' });
	button(ways, 'Copy', 'copy');
	offerButton(ways, 'Run in a terminal tab', 'terminal', model.install.terminal);
	offerButton(ways, 'Ask Claude', 'ask-claude', model.install.askClaude);
	if (model.install.askClaude.available) {
		install.createDiv({
			cls: 'herdr-get-started-reason',
			text: 'Claude asks before it runs the command; nothing runs until you allow it.',
		});
	}

	// After the install.
	const after = install.createDiv({ cls: 'herdr-get-started-after' });
	if (model.after.found) {
		after.createDiv({ cls: 'herdr-get-started-note', text: `herdr-core found: ${model.after.hcPath}` });
		const row = after.createDiv({ cls: 'herdr-get-started-actions' });
		button(
			row,
			model.after.existingId ? 'Use herdr-core on this machine' : 'Add herdr-core on this machine',
			'use-herdr-core',
			true,
		);
	} else if (model.scanned) {
		after.createDiv({ cls: 'herdr-get-started-note', text: 'herdr-core is not installed yet.' });
	}
	const check = after.createDiv({ cls: 'herdr-get-started-actions' });
	button(check, 'Check again', 'check-again');

	// 3. herdr instead.
	const herdr = section(card, 'Prefer the herdr terminal app?');
	herdr.createEl('a', { href: model.herdrDocsUrl, text: 'Install herdr' });
	return card;
}

/** The card in a modal, for the `Get started` command. */
export class GetStartedModal extends Modal {
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly flow: GetStartedFlow,
	) {
		super(app);
	}

	override onOpen(): void {
		this.contentEl.addClass('herdr-get-started-modal');
		// Torn down with the modal: the content element goes in `onClose`.
		this.contentEl.addEventListener('click', this.onClick);
		this.unsubscribe = this.flow.subscribe(() => this.draw());
		this.draw();
		this.flow.ensureScanned();
	}

	private readonly onClick = (event: MouseEvent): void => {
		const action = getStartedActionOf(event.target);
		if (!action) return;
		// Each of these opens or switches something; the modal is in the way.
		if (action !== 'copy' && action !== 'check-again') this.close();
		void runGetStartedAction(this.flow, action);
	};

	private draw(): void {
		this.contentEl.empty();
		renderGetStartedCard(this.contentEl, this.flow.model());
	}

	override onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.removeEventListener('click', this.onClick);
		this.contentEl.empty();
	}
}
