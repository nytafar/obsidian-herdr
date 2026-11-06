/**
 * The two lines the native view shows around its turns: the empty line, which
 * also says why a transcript cannot be read, and what the agent is doing
 * (#94). One instance per attached view. The status line is appended to the
 * view's root at once, as the live region it is (#142); the empty line when it
 * first appears. Where each sits is the stylesheet's `order`, not the DOM's.
 */

import type { AgentStatus } from '../herdr/types.gen';

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

/** The empty line and the status line of one attached view. */
export class SessionLines {
	private emptyEl: HTMLElement | null = null;
	/**
	 * What the agent is doing, shown between blocks. A live region, there from
	 * the first draw and clipped while it says nothing (#142): one that
	 * appears together with its words is not read, one that is there and gets
	 * them is.
	 */
	private readonly statusEl: HTMLElement;

	constructor(private readonly root: HTMLElement) {
		this.statusEl = root.createDiv({
			cls: ['herdr-native-status', 'herdr-native-sizer', 'herdr-native-visually-hidden'],
			attr: { role: 'status', 'aria-live': 'polite' },
		});
	}

	/**
	 * The line shown when there is nothing to show, and nothing when there is;
	 * or, above whatever is shown, why the transcript cannot be read (a
	 * runtime's own limit), which an empty view would otherwise hide.
	 */
	updateEmpty(facts: EmptyFacts): void {
		const problem = facts.readProblem;
		if (facts.hasTurns && !problem) {
			this.emptyEl?.remove();
			this.emptyEl = null;
			return;
		}
		const text = problem ?? (facts.hasPath ? 'No turns in this session yet.' : 'No session yet.');
		if (!this.emptyEl) {
			this.emptyEl = this.root.createDiv({ cls: ['herdr-native-empty', 'herdr-native-sizer'] });
		}
		this.emptyEl.setText(text);
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
