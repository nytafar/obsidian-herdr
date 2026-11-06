/**
 * The lines the native view shows around its turns: the empty line, the
 * read-failure line with Try again and Details (#146), and what the agent is
 * doing (#94). One instance per attached view. The status line is appended to
 * the view's root at once, as the live region it is (#142); the other two when
 * they first appear. Where each sits is the stylesheet's `order`, not the DOM's.
 *
 * The failure line is one short line saying what failed, a Try again beside
 * it, and the runtime's own words behind a Details disclosure rather than in
 * the line.
 */

import type { Component } from 'obsidian';
import type { AgentStatus } from '../herdr/types.gen';

/** The failure line's own words; the runtime's are behind Details. */
export const READ_FAILURE_LINE = 'Could not read this transcript.';

/**
 * What the view says the agent is doing, or an empty string when it should say
 * nothing at all.
 *
 * herdr's five states, not anything read out of the transcript: a turn that has
 * stopped and a turn that is thinking look the same in the file, and the status
 * is the only thing that tells them apart (ADR-0003). `blocked` gets a line of
 * its own until the waiting card exists; `idle`, `done` and `unknown` get
 * nothing, because a finished session should read as prose and nothing else.
 */
export function workingLine(status: AgentStatus): string {
	if (status === 'working') return 'Working…';
	if (status === 'blocked') return 'Waiting for you.';
	return '';
}

/** What the empty line is drawn from. */
export interface EmptyFacts {
	/** Whether any turn is drawn. */
	hasTurns: boolean;
	/** Why the transcript cannot be read (a runtime's own limit), or null. */
	readProblem: string | null;
	/** Whether the session has a transcript path yet. */
	hasPath: boolean;
}

/** What {@link SessionLines} needs from the view around it. */
export interface SessionLinesOptions {
	/** The view's listeners, so the Try again button goes with the view. */
	component: Component;
	/** Reads the transcript again (#146); left out, the line offers no retry. */
	onRetry?: () => void;
}

/** The read-failure line's parts, built once and kept while the view is attached. */
interface FailureLine {
	el: HTMLElement;
	detailEl: HTMLElement;
}

/** The empty line, the read-failure line and the status line of one attached view. */
export class SessionLines {
	private emptyEl: HTMLElement | null = null;
	/**
	 * Why the transcript cannot be read, with Try again and Details (#146).
	 * Built on the first problem and then only shown and hidden, so its button
	 * has one listener for the life of the view.
	 */
	private failure: FailureLine | null = null;
	/**
	 * What the agent is doing, shown between blocks. A live region, there from
	 * the first draw and clipped while it says nothing (#142): one that
	 * appears together with its words is not read, one that is there and gets
	 * them is.
	 */
	private readonly statusEl: HTMLElement;

	constructor(
		private readonly root: HTMLElement,
		private readonly options?: SessionLinesOptions,
	) {
		this.statusEl = root.createDiv({
			cls: ['herdr-native-status', 'herdr-native-sizer', 'herdr-native-visually-hidden'],
			attr: { role: 'status', 'aria-live': 'polite' },
		});
	}

	/**
	 * The line shown when there is nothing to show, and nothing when there is;
	 * or, above whatever is shown, why the transcript cannot be read (a
	 * runtime's own limit), which an empty view would otherwise hide. A view
	 * that cannot read its transcript says that and nothing else: "no turns
	 * yet" under it would be a guess.
	 */
	updateEmpty(facts: EmptyFacts): void {
		const problem = facts.readProblem;
		this.updateFailure(problem);
		if (facts.hasTurns || problem) {
			this.emptyEl?.remove();
			this.emptyEl = null;
			return;
		}
		const text = facts.hasPath ? 'No turns in this session yet.' : 'No session yet.';
		if (!this.emptyEl) {
			this.emptyEl = this.root.createDiv({ cls: ['herdr-native-empty', 'herdr-native-sizer'] });
		}
		this.emptyEl.setText(text);
	}

	/** Shows the failure line with the runtime's words behind Details, or hides it. */
	private updateFailure(problem: string | null): void {
		if (!problem) {
			this.failure?.el.addClass('herdr-is-hidden');
			return;
		}
		const failure = (this.failure ??= this.buildFailure());
		failure.detailEl.setText(problem);
		failure.el.removeClass('herdr-is-hidden');
	}

	private buildFailure(): FailureLine {
		// An alert: the reader asked for nothing, and the view stopped keeping up.
		const el = this.root.createDiv({
			cls: ['herdr-native-read-failure', 'herdr-native-sizer'],
			attr: { role: 'alert' },
		});
		const line = el.createDiv({ cls: 'herdr-native-read-failure-line' });
		line.createSpan({ cls: 'herdr-native-read-failure-text', text: READ_FAILURE_LINE });
		const onRetry = this.options?.onRetry;
		if (onRetry && this.options) {
			const button = line.createEl('button', {
				cls: 'herdr-native-read-retry',
				text: 'Try again',
			});
			this.options.component.registerDomEvent(button, 'click', () => onRetry());
		}
		const details = el.createEl('details', { cls: 'herdr-native-read-details' });
		details.createEl('summary', { text: 'Details' });
		const detailEl = details.createDiv({ cls: 'herdr-native-read-detail' });
		return { el, detailEl };
	}

	/**
	 * What the agent is doing between blocks (#94). herdr's `agent_status`, not
	 * anything guessed from the transcript: a turn that has stopped writing and
	 * a turn that is thinking look identical in the file.
	 */
	updateStatus(status: AgentStatus): void {
		const text = workingLine(status);
		// Same words, nothing to write: a live region re-reads what it is given.
		if (this.statusEl.textContent === text) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass('herdr-native-visually-hidden', text === '');
	}
}
