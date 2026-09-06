/**
 * Transition notifications (PRD M12, T5).
 *
 * The rule herdr's event stream forces on us: `pane.updated` arrives about ten
 * times a second per pane and most of those only move `revision`, so the scope
 * (`src/herdr/scope.ts`) already collapses them into `changed` events carrying
 * the previous and next `PaneState`. This module reacts to *status transitions*
 * inside that stream, never to raw updates:
 *
 *   - only transitions **into** `blocked` (an agent wants you) and **into**
 *     `done` (an agent finished unseen) are interesting; `working`, `idle` and
 *     `unknown` are noise;
 *   - a pane that just fired is muted for {@link DEBOUNCE_MS}, because an agent
 *     can flap blocked → working → blocked within a second;
 *   - a pane whose terminal view is open in Obsidian never notifies: the user is
 *     looking straight at it;
 *   - escalation is per settings: `Notice` whenever enabled, OS notification only
 *     when the Obsidian window does not have focus (notes/electron-node.md).
 *
 * Everything Obsidian- or Electron-shaped is injected through
 * {@link NotifierDeps}, including the clock, so the whole decision path is unit
 * testable without a DOM.
 */

import type { NotificationSettings, NotifiedTransition } from './settings';
import type { PaneState } from './herdr/scope';

/** Per-pane mute window after a notification fires (PRD M12). */
export const DEBOUNCE_MS = 2000;

/** Statuses worth interrupting the user for. */
const NOTIFIED: readonly NotifiedTransition[] = ['blocked', 'done'];

/** What a single transition asks the host to do. */
export interface NotifyPlan {
	paneId: string;
	transition: NotifiedTransition;
	title: string;
	body: string;
	/** Show an Obsidian `Notice`. */
	notice: boolean;
	/** Show an OS notification (only ever true while the window is unfocused). */
	os: boolean;
}

export interface NotifierDeps {
	/** Monotonic-ish clock in milliseconds. Injected so tests can step it. */
	now(): number;
	/** Read live settings; the user can toggle these while the plugin runs. */
	settings(): NotificationSettings;
	/** True when a terminal view for this pane is open in Obsidian (PRD M12). */
	isTerminalOpen(paneId: string): boolean;
	/** True when the Obsidian window has focus, i.e. `document.hasFocus()`. */
	windowFocused(): boolean;
	/** Show an Obsidian `Notice`. */
	showNotice(message: string, plan: NotifyPlan): void;
	/** Show an OS notification through the renderer `Notification` API. */
	showOsNotification(title: string, body: string, plan: NotifyPlan): void;
}

/** True for a transition the plugin notifies about (PRD M12). */
export function isNotifiedTransition(
	prev: PaneState,
	next: PaneState,
): next is PaneState & { agentStatus: NotifiedTransition } {
	if (prev.agentStatus === next.agentStatus) return false;
	return (NOTIFIED as readonly string[]).includes(next.agentStatus);
}

/**
 * Human-readable name of a pane: the agent's herdr name (`agent.list`), then the
 * pane label, then the terminal title, then the id. Never `pane.agent`: that is
 * the kind, so every notification would read "claude".
 */
export function paneName(pane: PaneState): string {
	return pane.name.trim() || pane.label.trim() || pane.title.trim() || pane.paneId;
}

function planFor(pane: PaneState, transition: NotifiedTransition): NotifyPlan {
	const name = paneName(pane);
	const verb = transition === 'blocked' ? 'needs you' : 'is done';
	return {
		paneId: pane.paneId,
		transition,
		title: `Herdr: ${name} ${verb}`,
		body: pane.title.trim() || pane.cwd || pane.paneId,
		notice: false,
		os: false,
	};
}

/**
 * Decides what a `changed` event should trigger, without doing it.
 *
 * Returns `null` when nothing should happen. The debounce map is the caller's,
 * so this function stays pure; {@link TransitionNotifier} owns one.
 */
export function decideNotification(
	prev: PaneState,
	next: PaneState,
	lastFiredAt: number | undefined,
	deps: Pick<NotifierDeps, 'now' | 'settings' | 'isTerminalOpen' | 'windowFocused'>,
): NotifyPlan | null {
	if (!isNotifiedTransition(prev, next)) return null;
	// The user is already watching this pane inside Obsidian.
	if (deps.isTerminalOpen(next.paneId)) return null;
	if (lastFiredAt !== undefined && deps.now() - lastFiredAt < DEBOUNCE_MS) return null;

	const transition = next.agentStatus;
	const settings = deps.settings()[transition];
	const plan = planFor(next, transition);
	plan.notice = settings.notice;
	// An OS notification while the window is focused would duplicate the Notice.
	plan.os = settings.os && !deps.windowFocused();
	if (!plan.notice && !plan.os) return null;
	return plan;
}

/**
 * Stateful wrapper around {@link decideNotification}: keeps the per-pane
 * debounce map and calls the host. Feed it every scope `changed` event and tell
 * it about `removed` panes so the map does not grow forever.
 */
export class TransitionNotifier {
	private readonly lastFired = new Map<string, number>();

	constructor(private readonly deps: NotifierDeps) {}

	/** Handles one scope `changed` event. Returns the plan it acted on, if any. */
	onChanged(prev: PaneState, next: PaneState): NotifyPlan | null {
		const plan = decideNotification(prev, next, this.lastFired.get(next.paneId), this.deps);
		if (!plan) return null;
		this.lastFired.set(plan.paneId, this.deps.now());
		if (plan.notice) this.deps.showNotice(plan.title, plan);
		if (plan.os) this.deps.showOsNotification(plan.title, plan.body, plan);
		return plan;
	}

	/** Drops the debounce entry of a pane that left the scope. */
	forget(paneId: string): void {
		this.lastFired.delete(paneId);
	}

	/** Drops every debounce entry, e.g. when the scoped workspace changes. */
	reset(): void {
		this.lastFired.clear();
	}
}

/**
 * Sends an OS notification from the Obsidian renderer (notes/electron-node.md).
 *
 * The HTML5 API is the supported path; Electron's `Notification` class is
 * main-process only. Permission is usually already granted in a packaged
 * Electron app, and when it is not this quietly does nothing — the `Notice` in
 * the same plan is the fallback.
 */
export function sendOsNotification(title: string, body: string, onClick?: () => void): boolean {
	if (typeof Notification === 'undefined') return false;
	if (Notification.permission !== 'granted') {
		if (Notification.permission === 'default') void Notification.requestPermission();
		return false;
	}
	try {
		const notification = new Notification(title, { body });
		if (onClick) notification.onclick = () => onClick();
		return true;
	} catch {
		// Some platforms throw when the notification centre is unavailable.
		return false;
	}
}

/**
 * What the plugin loses when a server does not know an optional method. The
 * client reports each method once per session (PRD M3); this turns that method
 * name into a sentence the user can act on.
 */
const DEGRADED_WITHOUT: Record<string, string> = {
	'session.snapshot': 'agents load in three calls instead of one',
	'agent.list': 'agent rows show titles instead of names',
	'tab.list': 'tabs show their ids instead of their labels',
};

/** Notice text for an optional method this herdr rejected as unknown (PRD M3). */
export function unsupportedMethodMessage(method: string): string {
	const degraded = DEGRADED_WITHOUT[method] ?? 'the feature that needs it stays off';
	return `Herdr: this herdr does not support ${method}; ${degraded}.`;
}
