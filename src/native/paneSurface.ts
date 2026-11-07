/**
 * The pane surface seam (issue #92, ADR-0002).
 *
 * A terminal tab shows a pane through exactly one **pane surface**: something
 * that takes a host element and a pane identity, gives them back, goes hidden
 * and applies a setting. There are two adapters. The terminal lifecycle
 * (`../views/paneTerminal.ts`) is one as it stands — its public methods are
 * this interface, so nothing there changed for native mode — and
 * `NativePaneSurface` (`./surface.ts`) is the other.
 *
 * Which one a tab mounts is its view's decision (`./renderMode.ts`, #104),
 * and {@link PaneSurfaceHolder} performs the swap: detach the old surface,
 * then build and attach the new one. The terminal view owns the holder and
 * feeds it a factory, which is the seam `tests/paneSurface.test.ts` fakes.
 *
 * A pane whose transcripts cannot be reached from here keeps a terminal
 * surface (ADR-0002): everything the native view reads is a path on the
 * transcript's host, and herdr over SSH has no adapter for that, so {@link
 * paneViewAvailability} reports native as unavailable there and {@link
 * effectivePaneView} falls back. Which runtimes can is the kind's to say
 * (`nativeViewBlock` in `../runtime/kind.ts`).
 */

import type { PaneIdentity, TerminalEffect } from '../views/paneTerminal';
import { type PaneView } from './renderMode';

/**
 * What a terminal tab drives, whichever way the pane is shown. Every method is
 * the terminal lifecycle's, with the same meaning, so `PaneTerminal` satisfies
 * this without a wrapper and without a change of its own.
 */
export interface PaneSurface {
	/** The view opened, or the tab switched to this surface: take the element. */
	attach(hostEl: HTMLElement): Promise<void>;
	/** The view closed, or the tab switched away: give everything back. */
	detach(): Promise<void>;
	/** The leaf was revealed or has been hidden past the grace period (#15). */
	setVisible(visible: boolean): Promise<void>;
	/** The tab was pointed at another pane, endpoint or attach mode. */
	setIdentity(identity: PaneIdentity): Promise<void>;
	/** One named effect of a settings change (#84); most surfaces ignore most. */
	apply(effect: TerminalEffect): Promise<void>;
}

/** The two adapters a view can be drawn by. */
export type PaneSurfaceKind = 'terminal' | 'native';

/**
 * Which adapter shows a pane in this view. The two vocabularies coincide
 * today — a view is exactly the surface that draws it — but they are separate
 * seams: the view is what the user chose and what the tab stores, the kind is
 * what {@link PaneSurfaceHolder} mounts.
 */
export function surfaceKindFor(view: PaneView): PaneSurfaceKind {
	return view === 'native' ? 'native' : 'terminal';
}

/** Why the native view is not offered on a remote endpoint (ADR-0002). */
export const NATIVE_REMOTE_REASON = 'local panes only';

/** Whether a view can be chosen here, and why not when it cannot. */
export interface PaneViewAvailability {
	available: boolean;
	/** Shown beside the unavailable view in the menu; null when it is available. */
	reason: string | null;
}

/**
 * Where a pane lives, as far as the native view cares: on another machine
 * whose transcripts cannot be reached, and whether its runtime's kind rules
 * the view out by itself (ADR-0004).
 */
export interface PaneWhere {
	/**
	 * On another machine, with no way to read its transcripts from here. A
	 * remote runtime whose kind reads them over its connection is not `remote`
	 * in this sense.
	 */
	remote: boolean;
	/**
	 * Why the native view cannot be offered here, or null/absent when only the
	 * target decides: the kind's reason (a kind with no agent session), or the
	 * pane's own (an hc terminal with no Claude session label, ADR-0006).
	 */
	kindReason?: string | null;
	/**
	 * Why the terminal view cannot be offered for the pane's kind, or
	 * null/absent when it can: the `claude` kind has no terminal in this
	 * version (ADR-0007's D2), so its tabs show the native view.
	 */
	terminalReason?: string | null;
}

/**
 * Whether a pane on this endpoint can be shown in this view. Only the native
 * view is ever unavailable: on a runtime whose kind has no agent session to
 * follow, and on a remote endpoint, where the transcript it reads is a path on
 * the pane's own host and the SSH adapters are not built yet (ADR-0002,
 * ADR-0003). The kind's reason comes first, since it holds on any target.
 */
export function paneViewAvailability(view: PaneView, where: PaneWhere): PaneViewAvailability {
	if (view === 'terminal' && where.terminalReason) {
		return { available: false, reason: where.terminalReason };
	}
	if (view === 'native' && where.kindReason) {
		return { available: false, reason: where.kindReason };
	}
	if (view === 'native' && where.remote) {
		return { available: false, reason: NATIVE_REMOTE_REASON };
	}
	return { available: true, reason: null };
}

/**
 * The view a tab actually shows: its own once it has chosen one, else the
 * global default — and never native on a remote endpoint, which falls back to
 * a terminal. Only what is *shown* falls back; the tab keeps the preference it
 * stored, so moving the same tab to a local pane shows native again (#104).
 */
export function effectivePaneView(input: {
	/** The tab's stored view, or null while it follows the default. */
	stored: PaneView | null;
	/** The global default view, normalized. */
	fallback: PaneView;
	remote: boolean;
	kindReason?: string | null;
	terminalReason?: string | null;
}): PaneView {
	const view = input.stored ?? input.fallback;
	if (paneViewAvailability(view, input).available) return view;
	// A kind with no terminal shows the native view whenever it can.
	if (view === 'terminal' && paneViewAvailability('native', input).available) return 'native';
	return 'terminal';
}

/**
 * The one surface a tab has mounted, and the swap from one to the next.
 *
 * Kept deliberately dumb: the view decides *which* kind (that is
 * {@link effectiveRenderMode} plus {@link surfaceKindFor}) and this performs
 * it, in the one order that is safe — the old surface gives its pane back
 * before the new one asks for it. Asking for the kind already mounted does
 * nothing at all, so a settings change that moves between two terminal engines
 * still reaches the terminal lifecycle as an ordinary `engine` effect rather
 * than as a swap.
 */
export class PaneSurfaceHolder {
	private surface: PaneSurface | null = null;
	private mounted: PaneSurfaceKind | null = null;
	/**
	 * Which request the holder is serving. Every `show` takes the next number
	 * and gives up if another `show` or a `release` has taken one since: a
	 * detach can take a while, and what the tab wanted when it started is not
	 * necessarily what it wants when the detach comes back.
	 */
	private request = 0;
	/** The detach in flight, so the next mount waits for it rather than racing it. */
	private detaching: Promise<void> | null = null;

	constructor(private readonly create: (kind: PaneSurfaceKind) => PaneSurface) {}

	/** The mounted surface, or null before the first `show` and after `release`. */
	get current(): PaneSurface | null {
		return this.surface;
	}

	/** Which kind is mounted, or null when none is. */
	get kind(): PaneSurfaceKind | null {
		return this.mounted;
	}

	/**
	 * Makes `kind` the mounted surface on `hostEl`, building and attaching it if
	 * it is not the one already there. Returns the surface, or null when the
	 * request was overtaken while the old surface was detaching — by the view
	 * closing, or by another view — in which case nothing is mounted and
	 * nothing was built.
	 */
	async show(kind: PaneSurfaceKind, hostEl: HTMLElement): Promise<PaneSurface | null> {
		const current = this.surface;
		if (current && this.mounted === kind) return current;
		const request = ++this.request;
		await this.detachCurrent();
		// A surface attached now would outlive the view that asked for it: its
		// model subscription and its tail would stay behind `onClose` (#92, #94).
		if (request !== this.request) return null;
		const surface = this.create(kind);
		this.surface = surface;
		this.mounted = kind;
		await surface.attach(hostEl);
		return surface;
	}

	/** Detaches the mounted surface and forgets it. Idempotent; used by `onClose`. */
	async release(): Promise<void> {
		this.request++;
		await this.detachCurrent();
	}

	/**
	 * Gives the mounted surface back, and waits for a detach already in flight
	 * when there is no surface left to give: the old one must be gone before the
	 * next is attached, however many switches overlapped.
	 */
	private async detachCurrent(): Promise<void> {
		const surface = this.surface;
		if (surface) {
			this.surface = null;
			this.mounted = null;
			const detaching = surface.detach().finally(() => {
				if (this.detaching === detaching) this.detaching = null;
			});
			this.detaching = detaching;
		}
		await this.detaching;
	}
}
