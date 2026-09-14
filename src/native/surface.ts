/**
 * The pane surface seam (issue #92, ADR-0002).
 *
 * A terminal tab shows a pane through exactly one **pane surface**: something
 * that takes a host element and a pane identity, gives them back, goes hidden
 * and applies a setting. There are two adapters. The terminal lifecycle
 * (`../views/paneTerminal.ts`) is one as it stands — its public methods are
 * this interface, so nothing there changed for native mode — and
 * {@link NativePaneSurface} below is the other.
 *
 * Which one a tab mounts is its render mode's decision (`./renderMode.ts`),
 * and {@link PaneSurfaceHolder} performs the swap: detach the old surface,
 * then build and attach the new one. The terminal view owns the holder and
 * feeds it a factory, which is the seam `tests/paneSurface.test.ts` fakes.
 *
 * Remote endpoints keep a terminal surface (ADR-0002): everything the native
 * view reads is a path on the transcript's host, and the SSH adapters for that
 * do not exist yet, so {@link renderModeAvailability} reports native as
 * unavailable there and {@link effectiveRenderMode} falls back.
 */

import type { PaneIdentity, StatusLine, TerminalEffect } from '../views/paneTerminal';
import {
	engineForRenderMode,
	NATIVE_RENDER_MODE,
	type RenderMode,
} from './renderMode';

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

/** The two adapters a render mode can choose between. */
export type PaneSurfaceKind = 'terminal' | 'native';

/** Which adapter shows a pane in this render mode. */
export function surfaceKindFor(mode: RenderMode): PaneSurfaceKind {
	return mode === NATIVE_RENDER_MODE ? 'native' : 'terminal';
}

/** Why the native view is not offered on a remote endpoint (ADR-0002). */
export const NATIVE_REMOTE_REASON = 'local panes only';

/** Whether a render mode can be chosen here, and why not when it cannot. */
export interface RenderModeAvailability {
	available: boolean;
	/** Shown beside the unavailable mode in the menu; null when it is available. */
	reason: string | null;
}

/**
 * Whether a pane on this endpoint can be shown in this render mode. Only the
 * native mode is ever unavailable, and only on a remote endpoint: the
 * transcript it reads is a path on the pane's own host and the SSH adapters
 * are not built yet (ADR-0002, ADR-0003).
 */
export function renderModeAvailability(
	mode: RenderMode,
	where: { remote: boolean },
): RenderModeAvailability {
	if (mode === NATIVE_RENDER_MODE && where.remote) {
		return { available: false, reason: NATIVE_REMOTE_REASON };
	}
	return { available: true, reason: null };
}

/**
 * The render mode a tab actually renders in: its own once it has chosen one,
 * else the global default — and never native on a remote endpoint, where it
 * keeps a terminal surface on the default engine instead.
 */
export function effectiveRenderMode(input: {
	/** The tab's stored render mode, or null while it follows the default. */
	stored: RenderMode | null;
	/** The global default render mode, normalized. */
	fallback: RenderMode;
	remote: boolean;
}): RenderMode {
	const mode = input.stored ?? input.fallback;
	if (renderModeAvailability(mode, { remote: input.remote }).available) return mode;
	return engineForRenderMode(mode);
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
	 * it is not the one already there. Returns the surface either way.
	 */
	async show(kind: PaneSurfaceKind, hostEl: HTMLElement): Promise<PaneSurface> {
		const current = this.surface;
		if (current && this.mounted === kind) return current;
		await this.release();
		const surface = this.create(kind);
		this.surface = surface;
		this.mounted = kind;
		await surface.attach(hostEl);
		return surface;
	}

	/** Detaches the mounted surface and forgets it. Idempotent; used by `onClose`. */
	async release(): Promise<void> {
		const surface = this.surface;
		if (!surface) return;
		this.surface = null;
		this.mounted = null;
		await surface.detach();
	}
}

/** What {@link NativePaneSurface} needs from the view around it. */
export interface NativePaneSurfaceOptions {
	identity: PaneIdentity;
	/** The strip under the view, so native mode says what it is doing too. */
	onStatus: (line: StatusLine) => void;
}

/**
 * The native surface (issue #92): for now, an empty view that says there is no
 * session yet.
 *
 * This is the prefactor's half of the native view. It proves the seam — a tab
 * can be switched to native and back and get a working terminal again — and
 * leaves the session model, the reducer and the transcript source to the
 * issues that follow (#91). Everything it draws takes Obsidian's own theming
 * through `styles.css`: no inline styles, and no `innerHTML`.
 */
export class NativePaneSurface implements PaneSurface {
	private identity: PaneIdentity;
	private readonly onStatus: (line: StatusLine) => void;
	/** The element this surface added to the host; removed again on detach. */
	private rootEl: HTMLElement | null = null;

	constructor(options: NativePaneSurfaceOptions) {
		this.identity = options.identity;
		this.onStatus = options.onStatus;
	}

	async attach(hostEl: HTMLElement): Promise<void> {
		this.rootEl?.remove();
		const root = hostEl.createDiv({ cls: 'herdr-native-view' });
		// `markdown-preview-view` is what gives the view the reading-mode
		// typography the user has set, which is the appearance the native view
		// is meant to have (native-view-design.md).
		root.addClass('markdown-preview-view');
		root.createDiv({ cls: 'herdr-native-empty', text: 'No session yet.' });
		this.rootEl = root;
		this.report();
	}

	async detach(): Promise<void> {
		this.rootEl?.remove();
		this.rootEl = null;
	}

	/** Nothing to hand back: there is no child process and no canvas here yet. */
	async setVisible(): Promise<void> {}

	async setIdentity(identity: PaneIdentity): Promise<void> {
		this.identity = identity;
		this.report();
	}

	/** Colours, cursors and engines are a terminal's business, not this view's. */
	async apply(): Promise<void> {}

	private report(): void {
		this.onStatus({
			text: this.identity.paneId
				? `Native view of ${this.identity.paneId}. No session yet.`
				: 'Native view. No pane.',
			warning: false,
			detail: null,
		});
	}
}
