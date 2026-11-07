/**
 * What the native view and the table of contents say about the turns a
 * session model does not hold (#152), and the button that loads them.
 *
 * The model holds the newest page of a long session (`TurnWindow`,
 * `./conversation.ts`); the turns before it are named, not held. Everything
 * that lists or searches turns says how many it cannot see, in these words.
 */

import type { Component } from 'obsidian';

/** The button's words, and what it says while it reads. */
export const LOAD_EARLIER = 'Load earlier turns';
export const LOADING_EARLIER = 'Loading earlier turns…';

/** "1 earlier turn is not loaded.", or as many as there are. */
export function earlierLine(count: number): string {
	return count === 1 ? '1 earlier turn is not loaded.' : `${count} earlier turns are not loaded.`;
}

/** What the bar needs from the view around it. */
export interface EarlierTurnsOptions {
	/** The listeners' owner: the button goes with it. */
	component: Component;
	/** Asks the model for another page. */
	onLoad: () => void;
	/** Classes of the bar, so the view and the TOC can each place it. */
	cls: string;
}

/**
 * A line saying how many earlier turns are not loaded, with the button that
 * loads them. Built once, then shown, hidden and reworded, so its button has
 * one listener for the life of its element.
 */
export class EarlierTurnsBar {
	private readonly el: HTMLElement;
	private readonly textEl: HTMLElement;
	private readonly buttonEl: HTMLButtonElement;

	constructor(parentEl: HTMLElement, options: EarlierTurnsOptions) {
		this.el = parentEl.createDiv({ cls: [options.cls, 'herdr-native-earlier', 'herdr-is-hidden'] });
		this.textEl = this.el.createSpan({ cls: 'herdr-native-earlier-text' });
		this.buttonEl = this.el.createEl('button', { cls: 'herdr-native-earlier-load', text: LOAD_EARLIER });
		options.component.registerDomEvent(this.buttonEl, 'click', () => options.onLoad());
	}

	/** How many turns are not loaded, and whether a load is reading. None hides the bar. */
	update(count: number, loading: boolean): void {
		this.el.toggleClass('herdr-is-hidden', count === 0);
		if (count === 0) return;
		this.textEl.setText(earlierLine(count));
		this.buttonEl.setText(loading ? LOADING_EARLIER : LOAD_EARLIER);
		this.buttonEl.disabled = loading;
	}

	/** The bar's element, for a view that keeps it first among others. */
	get element(): HTMLElement {
		return this.el;
	}
}
