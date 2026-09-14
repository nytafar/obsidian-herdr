/**
 * Terminal view (PRD M13, M15, S16, S18; T9).
 *
 * One main-area tab per herdr pane. The view is the Obsidian half of that tab
 * and nothing else: it opens and closes, takes state, measures its host element
 * and titles its header. The pane's terminal itself — the `TerminalSession`
 * bridge, the `TerminalRenderer`, and the plumbing between them — belongs to
 * `PaneTerminal` (`./paneTerminal.ts`, issue #83), which this drives through
 * `attach`, `detach`, `setVisible`, `setIdentity`, `reconnect`,
 * `connectionArrived`, `resize` and `status`, and serves as its
 * `PaneTerminalHost`: the settings, the endpoint, the herdr argv and Obsidian's
 * `Notice` all reach it from here.
 *
 * Since issue #92 that lifecycle is one **pane surface** among two
 * (`../native/surface.ts`, ADR-0002): the tab's **render mode** decides which
 * one is mounted, `PaneSurfaceHolder` performs the swap, and the native
 * surface is the other. The tab's own render mode lives in its view state and
 * is switched from the tab menu or the `Switch render mode` command; a tab
 * that never chose follows `settings.terminalEngine`, the global default.
 *
 * What stays here, then:
 *
 * - **Hide and reveal.** Obsidian gives an inactive tab `display: none`, so a
 *   hidden leaf measures 0x0; `VisibilityTracker` turns a run of measurements
 *   into one `setVisible(false)` after `HIDE_GRACE_MS`, which is what hands the
 *   session back to herdr and disposes the renderer (#15, notes/memory.md).
 * - **The title.** `getDisplayText` asks the pinned endpoint's scope what the
 *   pane is called (#36, #43), and a burst of scope events is coalesced into
 *   one `updateHeader` per animation frame.
 * - **Settings effects.** `applySetting` is the only thing the plugin calls
 *   when a setting changes (#84). The matrix in `./paneTerminal.ts` names the
 *   effect; this decides where it runs — the title here, the rest on the
 *   lifecycle — and holds it back while the leaf is hidden.
 * - **Keys Obsidian would swallow.** Obsidian's keymap listens for `keydown` on
 *   `window` in the capture phase and ignores `defaultPrevented`, so no DOM
 *   listener of ours can run first; the workspace scope, however, defers to the
 *   active leaf's `view.scope`, and `onHostKey` answers from there (#47). It
 *   never sends bytes: a key it keeps for the terminal still reaches the
 *   renderer's input element and goes down the usual input path.
 *
 * Attach mode comes from `settings.defaultAttachMode`: control attaches with
 * `--takeover` (PRD M15, the herdr TUI pane then follows Obsidian's size),
 * observe is read-only (PRD S16) and never sends input or resizes. The header
 * actions toggle the mode — which restarts the bridge — and reconnect after a
 * close.
 *
 * Guidelines: no `innerHTML`, no inline styles (see `styles.css`), every
 * listener goes through `registerDomEvent` / `registerEvent` / `register`, and
 * `main.ts` finds this view with `getLeavesOfType` instead of holding a
 * reference.
 *
 * The DOM-free decisions live as exported pure functions at the top of this
 * file (state parsing, the tab title, the hide/reveal state machine, the keymap
 * protocol) and in `./paneTerminal.ts`; `tests/terminalView.test.ts` and
 * `tests/paneTerminal.test.ts` cover them. What is left needs a real workspace,
 * so it is smoke-tested by hand (recipe in `tests/README.md`).
 */

import {
	ItemView,
	Menu,
	Notice,
	Platform,
	Scope,
	setIcon,
	setTooltip,
	type App,
	type ViewStateResult,
	type WorkspaceLeaf,
} from 'obsidian';
import type HerdrPlugin from '../main';
import {
	cursorOptions,
	normalizeTerminalTitleSource,
	scrollbackBytes,
	type AttachMode,
	type TerminalTitleSource,
} from '../settings';
import { terminalArgvPrefix } from '../herdr/ssh';
import { LOCAL_ENDPOINT_ID, type EndpointSession } from '../connection';
import { TerminalSession, type TerminalSessionMode } from '../bridge/terminalSession';
import { createRenderer } from './renderer/create';
import { agentDisplayName } from './rowModel';
import {
	PaneTerminal,
	SettingEffectQueue,
	spawnEnv,
	type DebounceTimers,
	type PaneIdentity,
	type PaneTerminalHost,
	type StatusLine,
	type TerminalEffect,
	type TerminalSetting,
} from './paneTerminal';
import type { PaneState, WorkspaceScope } from '../herdr/scope';
import type { HerdrClient } from '../herdr/client';
import type { TabLabelCache } from '../tabLabels';
import type { HostKeyDecision } from './input/inputRouter';
import {
	engineForRenderMode,
	isRenderMode,
	normalizeRenderMode,
	RENDER_MODES,
	RENDER_MODE_NAMES,
	type RenderMode,
} from '../native/renderMode';
import {
	effectiveRenderMode,
	NativePaneSurface,
	PaneSurfaceHolder,
	renderModeAvailability,
	surfaceKindFor,
	type PaneSurface,
	type PaneSurfaceKind,
} from '../native/surface';

export const TERMINAL_VIEW_TYPE = 'herdr-terminal';

/**
 * Persisted view state. `paneId` is a herdr pane id such as `w4:p1`;
 * `endpointId` is the herdr it lives on (`local` or `ssh:<host>:<socket>`,
 * issue #54), because pane ids are only unique per server.
 */
export interface TerminalViewState {
	paneId: string;
	mode: AttachMode;
	endpointId: string;
	/**
	 * The tab's render mode (issue #92), or undefined while the tab has never
	 * chosen one and follows the global default.
	 */
	renderMode?: RenderMode;
}

/**
 * Parses whatever Obsidian hands `setState` (a restored workspace layout may hold
 * anything). Returns null when there is no usable pane id; an unknown mode falls
 * back to control, which is the documented default (PRD M15). A state saved
 * before endpoints existed has no endpoint id and is treated as local, which
 * is the only endpoint a plugin of that age could have opened it on. An
 * unreadable or missing render mode is left unset (issue #92), which is how a
 * tab says it follows the global default.
 */
export function parseTerminalState(raw: unknown): TerminalViewState | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const paneId = typeof record.paneId === 'string' ? record.paneId.trim() : '';
	if (paneId.length === 0) return null;
	const endpointId = typeof record.endpointId === 'string' ? record.endpointId.trim() : '';
	return {
		paneId,
		mode: record.mode === 'observe' ? 'observe' : 'control',
		endpointId: endpointId.length > 0 ? endpointId : LOCAL_ENDPOINT_ID,
		// Deliberately not normalized to the default: a tab with no stored render
		// mode follows the global one, and an unreadable value is such a tab.
		...(isRenderMode(record.renderMode) ? { renderMode: record.renderMode } : {}),
	};
}

/**
 * True when a leaf's persisted state points at this pane on this endpoint.
 * Used by `main.ts`. Both parts must match: `w4:p1` on the local herdr and
 * `w4:p1` on a remote one are different terminals (issue #54).
 */
export function stateMatchesPane(raw: unknown, paneId: string, endpointId: string): boolean {
	const state = parseTerminalState(raw);
	return state?.paneId === paneId && state.endpointId === endpointId;
}

/**
 * What the tab and the view header say (issue #36).
 *
 * The same choice the agent list makes — {@link agentDisplayName}: the agent's
 * own name from `agent.list`, else the stripped terminal title, else the pane
 * id. Deliberately *not* `pane.agent`, which is the kind ("claude") and would
 * title every tab the same, and not `pane.label`, which is herdr's tab label
 * with a status prefix in it.
 *
 * A pane the scope has not answered for yet (a pane started from the file pane
 * is opened before `agent.list` lands) falls back to its id, so the tab is
 * still identifiable; the view subscribes to `added`/`changed` and re-reads
 * this as soon as a name arrives.
 *
 * A view with no pane at all — only a restored layout whose state was lost gets
 * there — is titled with nothing rather than a fixed "Herdr terminal" (issue
 * #37): the icon already says which plugin owns the tab, and a constant in the
 * view header was the one place the header disagreed with the tab.
 *
 * With the *herdr tab label* source (issue #43) the title is the label of the
 * herdr tab the pane runs in, read from the shared cache and passed in here so
 * this stays pure. With sharing off (issue #29) a herdr tab is exactly one
 * agent, so the label alone names it. While sharing is on and the tab holds
 * more than one agent pane, the agent name is appended, or two terminals would
 * carry the same title. A label the cache does not have yet, or a herdr without
 * `tab.list`, falls back to the agent name.
 */
export function terminalTabTitle(
	pane: PaneState | undefined,
	paneId: string,
	title?: TitleContext,
): string {
	if (!pane) return paneId;
	const name = agentDisplayName(pane);
	if (!title || title.source !== 'tab') return name;
	const label = title.tabLabel?.trim();
	if (!label) return name;
	return title.sharing && title.agentsInTab > 1 ? `${label} — ${name}` : label;
}

/** What {@link terminalTabTitle} needs beyond the pane to apply the setting. */
export interface TitleContext {
	source: TerminalTitleSource;
	/** The herdr tab's label from the cache, or undefined until it is known. */
	tabLabel: string | undefined;
	/** `settings.splitIntoFolderTab`: whether a tab may hold two agents at all. */
	sharing: boolean;
	/** Agent panes the scope lists in the pane's tab, this one included. */
	agentsInTab: number;
}

/**
 * How long a terminal's leaf must stay hidden before the view gives its renderer
 * and its bridge session back (#15). Long enough that flipping between two tabs
 * costs nothing, short enough that a terminal left in a background tab stops
 * burning a WASM terminal, a dpr-scaled canvas and a 60 fps repaint loop.
 */
export const HIDE_GRACE_MS = 30_000;

/** What a measurement did to the tracker's state. */
export type VisibilityChange = 'hidden' | 'revealed' | null;

/**
 * The hide/reveal decision, with no DOM in it: the view feeds it measurements
 * ("does the host still have a box?") and it decides when the grace period has
 * run out. Timers are injected, like the lifecycle's debounce, so
 * `tests/terminalView.test.ts` can run the whole state machine without a
 * browser.
 *
 * Obsidian gives an inactive tab's content `display: none`, so a hidden leaf
 * measures 0x0 — that, plus `layout-change` and `onResize`, is how the view
 * finds out. Only transitions matter: a stream of "still hidden" measurements
 * must not keep pushing the deadline out.
 */
export class VisibilityTracker {
	private hiddenNow = false;
	private handle: number | null = null;

	constructor(
		private readonly graceMs: number,
		/** Called once, `graceMs` after the host went away, if it is still away. */
		private readonly onGraceExpired: () => void,
		private readonly timers: DebounceTimers,
	) {}

	get hidden(): boolean {
		return this.hiddenNow;
	}

	/** True while a grace period is running. */
	get pending(): boolean {
		return this.handle !== null;
	}

	/** Feeds one measurement. Returns the transition it caused, or null. */
	update(visible: boolean): VisibilityChange {
		if (visible) {
			if (!this.hiddenNow) return null;
			this.hiddenNow = false;
			this.cancel();
			return 'revealed';
		}
		if (this.hiddenNow) return null;
		this.hiddenNow = true;
		this.arm();
		return 'hidden';
	}

	/**
	 * Starts the grace period when the host is hidden and nothing is pending. The
	 * view calls this after a (re)start too: a reconnect while hidden mounts a new
	 * renderer that nothing would otherwise come back to free.
	 */
	arm(): void {
		if (!this.hiddenNow || this.handle !== null) return;
		this.handle = this.timers.setTimeout(() => {
			this.handle = null;
			this.onGraceExpired();
		}, this.graceMs);
	}

	/** Drops a pending grace period. Idempotent; always called from `onClose`. */
	cancel(): void {
		if (this.handle === null) return;
		this.timers.clearTimeout(this.handle);
		this.handle = null;
	}
}

/** True when someone set `window.herdrPerf` in the dev console. */
function perfEnabled(): boolean {
	return (window as unknown as { herdrPerf?: unknown }).herdrPerf === true;
}

/**
 * A `Scope` handler's return is its whole protocol (see `HostKeyDecision`):
 * `undefined` keeps looking in the parent scope, `true` stops without touching
 * the event, `false` makes Obsidian prevent and stop it at the window.
 */
export function keymapReturn(decision: HostKeyDecision): boolean | undefined {
	switch (decision) {
		case 'host':
			return undefined;
		case 'terminal':
			return true;
		case 'drop':
			return false;
	}
}

/**
 * Whether the policy applies at all (#47): only to a control-mode terminal
 * whose input element has the focus. An observe-mode pane never takes input,
 * and a terminal leaf that is active but not focused — the user clicked its
 * header — must leave every key to Obsidian, or Cmd+O would vanish into nothing.
 */
export function hostKeyPolicyApplies(input: {
	mode: TerminalSessionMode | null;
	focusInside: boolean;
}): boolean {
	return input.mode === 'control' && input.focusInside;
}

export class TerminalView extends ItemView {
	private readonly plugin: HerdrPlugin;
	/** The pane's session and renderer, and every race between them (#83). */
	private readonly terminal: PaneTerminal;
	/** Last title the pinned endpoint's scope gave, kept while that scope is away. */
	private lastTitle = '';
	private hostEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private toggleActionEl: HTMLElement | null = null;
	/** Hide/reveal state machine; null before `onOpen` and after `onClose`. */
	private visibility: VisibilityTracker | null = null;
	/** Unsubscribes from the scope currently bound; replaced by `bindScope`. */
	private unbindScope: (() => void)[] = [];
	/** Pending `updateHeader` frame, so a burst of `changed` retitles once (#36). */
	private pendingHeader = 0;
	/**
	 * Effects a settings change asked for while this leaf was hidden (#84), run
	 * on reveal. The queue itself is DOM-free and lives in `./paneTerminal.ts`.
	 */
	private readonly pendingEffects = new SettingEffectQueue();
	/**
	 * The render mode this tab chose for itself (#92), or null while it follows
	 * the global default. Persisted in the view state, so it survives a restart.
	 */
	private storedRenderMode: RenderMode | null = null;
	/**
	 * The one surface this tab has mounted, and the swap between them (#92).
	 * The terminal adapter is {@link terminal} itself, kept for the view's whole
	 * life so a switch to native and back re-attaches the same lifecycle.
	 */
	private readonly surfaces = new PaneSurfaceHolder((kind) => this.createSurface(kind));

	constructor(leaf: WorkspaceLeaf, plugin: HerdrPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.terminal = new PaneTerminal({
			identity: {
				paneId: '',
				mode: plugin.settings.defaultAttachMode,
				endpointId: LOCAL_ENDPOINT_ID,
			},
			host: this.paneTerminalHost(),
			// Frames and timers from the window this leaf actually lives in, so a
			// popout keeps painting while the main window is hidden.
			scheduler: {
				requestAnimationFrame: (callback) =>
					this.containerEl.win.requestAnimationFrame(callback),
				cancelAnimationFrame: (handle) => this.containerEl.win.cancelAnimationFrame(handle),
				setTimeout: (callback, ms) => this.containerEl.win.setTimeout(callback, ms),
				clearTimeout: (handle) => this.containerEl.win.clearTimeout(handle),
			},
			createSession: (options) => new TerminalSession(options),
			createRenderer: (options) => createRenderer(options),
			macOS: Platform.isMacOS,
		});
		// #47: consulted by the workspace scope while this leaf is active, ahead
		// of the app's hotkeys, which are its parent and run on `undefined`. One
		// catch-all handler; the policy itself is the input router's. Obsidian
		// pushes and pops it with the active leaf, so there is nothing to tear down.
		this.scope = new Scope(this.app.scope);
		this.scope.register(null, null, (event) => this.onHostKey(event));
	}

	/**
	 * Everything the lifecycle cannot reach itself: the settings it mounts a
	 * renderer from, the endpoint it spawns against, and the three places it has
	 * to tell Obsidian something.
	 */
	private paneTerminalHost(): PaneTerminalHost {
		return {
			rendererOptions: () => {
				const settings = this.plugin.settings;
				return {
					fontFamily: settings.terminalFontFamily,
					fontSize: settings.terminalFontSize,
					// Colours: `obsidian` by default, which is the CSS variables (#26).
					theme: settings.terminalTheme,
					// Which library draws it (#27, #92): the tab's own render mode,
					// read fresh on every mount, so a switch or a changed default
					// lands on the next rebuild. `native` never reaches a terminal
					// surface, and would be the default engine if it did.
					engine: engineForRenderMode(this.renderMode()),
					// Cursor shape and blink (#52); both engines also take these in
					// place, so a change never rebuilds anything.
					...cursorOptions(settings),
					// Bytes, not lines — see `RendererOptions.scrollback`.
					scrollback: scrollbackBytes(settings),
					// Input is gated on the session's mode instead of here, so
					// toggling control/observe does not have to rebuild the terminal.
				};
			},
			cursorOptions: () => cursorOptions(this.plugin.settings),
			env: () => spawnEnv(process.env, this.plugin.settings.extraPath),
			endpointFor: (endpointId) => this.plugin.endpointFor(endpointId),
			// Local: `[<herdr>]`. Remote profile: `['ssh','-T',host,<remote herdr>]`
			// — terminals never go through the forwarded API socket (PRD S17).
			commandFor: (endpoint) =>
				terminalArgvPrefix({ remote: endpoint.remote }, this.plugin.herdrBinaryPath()),
			// Whether the plugin has connected to *anything*: a connection to the
			// other herdr still means the binary was found (issue #54).
			connected: () => this.plugin.client !== null,
			perfEnabled: () => perfEnabled(),
			onStatus: (line) => this.renderStatus(line),
			// A renderer is mounted, so the grace period has something to come back
			// and free: `arm()` is a no-op while the leaf is visible.
			onStarted: () => this.visibility?.arm(),
			onRendererError: (error) => {
				new Notice(`Herdr: terminal renderer failed to start (${String(error)})`);
			},
			onIdentityChanged: ({ switchedPane }) => {
				// Another agent's name has nothing to do with this one's.
				if (switchedPane) this.lastTitle = '';
				this.refreshHeader();
			},
		};
	}

	getViewType(): string {
		return TERMINAL_VIEW_TYPE;
	}

	/** The pane this tab is pointed at; the lifecycle holds the whole identity. */
	private get paneId(): string {
		return this.terminal.identity.paneId;
	}

	/**
	 * The render mode this tab renders in (#92): its own once it has switched,
	 * else the global default, read fresh so a tab that never chose follows a
	 * change to the setting.
	 */
	private renderMode(): RenderMode {
		return effectiveRenderMode({
			stored: this.storedRenderMode,
			fallback: normalizeRenderMode(this.plugin.settings.terminalEngine),
			// ADR-0002: the native view reads a transcript on the pane's own host,
			// so a tab pinned to a remote herdr keeps its terminal surface.
			remote: this.isRemote(),
		});
	}

	/** Whether this tab is pinned to a remote herdr (issue #54, ADR-0002). */
	private isRemote(): boolean {
		return this.terminal.identity.endpointId !== LOCAL_ENDPOINT_ID;
	}

	/** The adapter for a kind: the tab's own lifecycle, or a fresh native view. */
	private createSurface(kind: PaneSurfaceKind): PaneSurface {
		if (kind === 'terminal') return this.terminal;
		return new NativePaneSurface({
			// The view's own app, per the Obsidian guidelines, for the Markdown it
			// renders and the links it opens (#93).
			app: this.app,
			identity: this.terminal.identity,
			onStatus: (line) => this.renderStatus(line),
			// Plugin-held and reference counted, so two tabs on one pane read one
			// transcript (ADR-0003).
			models: this.plugin.sessionModels,
		});
	}

	/**
	 * The published connection when it is the herdr this view is pinned to
	 * (issue #81), with its scope, tab labels and endpoint snapshot; null while
	 * the list is connected elsewhere, or to nothing. The one place this view
	 * asks that question.
	 */
	private endpointSession(): EndpointSession<HerdrClient, WorkspaceScope, TabLabelCache> | null {
		return this.plugin.endpointSession(this.terminal.identity.endpointId);
	}

	/**
	 * Agent name of the pane, or the herdr tab label when the setting says so
	 * (PRD M13, issues #36, #43), falling back to the pane id.
	 */
	getDisplayText(): string {
		// Only the pinned endpoint's scope may name this pane: the other herdr's
		// `w4:p1` is a different agent (issue #54). While the list is connected
		// elsewhere the last title that scope gave stays, rather than the id.
		const paneId = this.paneId;
		const scope = paneId ? this.endpointSession()?.scope : null;
		const pane = scope?.get(paneId);
		if (pane) this.lastTitle = terminalTabTitle(pane, paneId, this.titleContext(pane));
		return this.lastTitle || terminalTabTitle(pane, paneId);
	}

	/**
	 * The setting and the cached label for the pane's tab. Reads only: the cache
	 * is asked to fetch from `bindScope`, never from a title read, which Obsidian
	 * calls on every header repaint.
	 */
	private titleContext(pane: PaneState): TitleContext {
		const settings = this.plugin.settings;
		const source = normalizeTerminalTitleSource(settings.terminalTitleSource);
		if (source !== 'tab') return { source, tabLabel: undefined, sharing: false, agentsInTab: 1 };
		const session = this.endpointSession();
		const agentsInTab = session
			? session.scope.list().filter((other) => other.tabId === pane.tabId).length
			: 1;
		return {
			source,
			tabLabel: session?.tabLabels.get(pane.tabId),
			sharing: settings.splitIntoFolderTab,
			agentsInTab,
		};
	}

	override getIcon(): string {
		return 'square-terminal';
	}

	override getState(): Record<string, unknown> {
		const { paneId, mode, endpointId } = this.terminal.identity;
		// Only a tab that chose stores a render mode: one that never did keeps
		// following the global default across restarts (#92).
		const renderMode = this.storedRenderMode;
		return { paneId, mode, endpointId, ...(renderMode ? { renderMode } : {}) };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const parsed = parseTerminalState(state);
		if (!parsed) return;
		this.storedRenderMode = parsed.renderMode ?? null;
		// A change clears the old pane's output, retitles through
		// `onIdentityChanged` and restarts the bridge; anything else is a no-op.
		// The endpoint may have moved too, and native is local-only (ADR-0002),
		// so the render mode is re-decided after it.
		await this.setIdentity(parsed);
	}

	protected override async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('herdr-terminal-view');
		this.hostEl = container.createDiv({ cls: 'herdr-terminal-host' });
		this.statusEl = container.createDiv({ cls: 'herdr-terminal-status' });

		this.toggleActionEl = this.addAction('eye', 'Switch to observe mode', () => {
			this.detached('mode toggle', () => this.toggleMode());
		});
		this.updateToggleAction();
		this.addAction('refresh-cw', 'Reconnect', () => {
			this.detached('reconnect', () => this.terminal.reconnect());
		});

		this.registerDomEvent(this.hostEl, 'wheel', (event) => this.terminal.handleWheel(event));
		// #49: an input method owns every key between these two, Enter included,
		// so the input layer must not encode any of them. Registered on the host
		// because both engines put their own input element inside it, and
		// composition events bubble.
		this.registerDomEvent(this.hostEl, 'compositionstart', () =>
			this.terminal.setComposing(true),
		);
		this.registerDomEvent(this.hostEl, 'compositionend', () =>
			this.terminal.setComposing(false),
		);
		this.bindScope();
		this.register(
			this.plugin.onScopeReplaced(() => {
				// The scope object itself is replaced on every connect, so the old
				// subscription is dead: rebind before deciding anything about a retry.
				this.bindScope();
				// Only a start that failed for want of a herdr retries; the
				// lifecycle knows whether this was one.
				this.detached('reconnect', () => this.terminal.connectionArrived());
			}),
		);
		this.register(() => {
			for (const off of this.unbindScope.splice(0)) off();
			if (this.pendingHeader) this.containerEl.win.cancelAnimationFrame(this.pendingHeader);
			this.pendingHeader = 0;
		});
		// A theme switch changes every colour the renderer was handed (PRD S18).
		// The same `theme` effect as the setting, and it runs whether or not any
		// value differs: the vault's variables moved under the renderer (#84).
		this.registerEvent(
			this.app.workspace.on('css-change', () => this.applySetting('cssVariables')),
		);

		// The grace timer lives on the leaf's own window, not the global one, so a
		// pop-out closing takes it down with it.
		this.visibility = new VisibilityTracker(HIDE_GRACE_MS, () => this.onGraceExpired(), {
			setTimeout: (cb, ms) => this.containerEl.win.setTimeout(cb, ms),
			clearTimeout: (handle) => this.containerEl.win.clearTimeout(handle),
		});
		this.register(() => this.visibility?.cancel());
		// A tab that goes to the background has its content hidden rather than
		// resized, so both of these are really "measure the host again".
		this.registerEvent(this.app.workspace.on('layout-change', () => this.checkVisibility()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkVisibility()));

		const observer = new ResizeObserver(() => {
			this.checkVisibility();
			this.terminal.resize();
		});
		observer.observe(this.hostEl);
		this.register(() => observer.disconnect());

		await this.showSurface();
	}

	/**
	 * Mounts the surface this tab's render mode asks for (#92). The holder does
	 * nothing when that is the surface already mounted, so this is also the
	 * "did anything change?" call after a setting, a switch or an endpoint move.
	 */
	private async showSurface(): Promise<void> {
		const host = this.hostEl;
		if (!host) return;
		await this.surfaces.show(surfaceKindFor(this.renderMode()), host);
	}

	/**
	 * Points the tab at another pane, endpoint or attach mode. The lifecycle is
	 * always told, mounted or not, so the terminal a switch back to a terminal
	 * render mode re-attaches is pointed at the right pane; the native surface
	 * is told when it is the one mounted.
	 */
	private async setIdentity(identity: PaneIdentity): Promise<void> {
		await this.terminal.setIdentity(identity);
		const surface = this.surfaces.current;
		if (surface && surface !== (this.terminal as PaneSurface)) await surface.setIdentity(identity);
		await this.showSurface();
	}

	protected override async onClose(): Promise<void> {
		this.visibility?.cancel();
		this.visibility = null;
		this.pendingEffects.clear();
		await this.surfaces.release();
		this.hostEl = null;
		this.statusEl = null;
		this.toggleActionEl = null;
		this.contentEl.empty();
	}

	/**
	 * Watches the scope for this pane so the tab title follows the agent (#36).
	 *
	 * The handlers read `this.paneId` at event time rather than capturing it, so
	 * a view that switches pane (issue #38 reuses one leaf) keeps working without
	 * rebinding. Only the title depends on this; the bridge is unaffected.
	 */
	private bindScope(): void {
		for (const off of this.unbindScope.splice(0)) off();
		const session = this.endpointSession();
		if (!session) return;
		const scope = session.scope;
		// The tab label comes from the shared cache (issue #43); this is where the
		// view asks it to cover the pane's tab, so `getDisplayText` never does.
		const labels = session.tabLabels;
		this.unbindScope.push(
			// `added` is the interesting one: a pane opened from the file pane is
			// shown before `agent.list` has answered, so its name arrives late.
			// A pane joining this pane's tab matters too: it changes the count that
			// decides whether the agent name is appended to the tab label.
			scope.on('added', (pane) => {
				if (pane.paneId === this.paneId) {
					labels.ensure(pane.tabId);
					this.scheduleHeader();
				} else if (pane.tabId === scope.get(this.paneId)?.tabId) {
					this.scheduleHeader();
				}
			}),
			scope.on('changed', (paneId) => {
				if (paneId === this.paneId) this.scheduleHeader();
			}),
			scope.on('removed', (pane) => {
				if (pane.tabId === scope.get(this.paneId)?.tabId) this.scheduleHeader();
			}),
		);
		this.unbindScope.push(labels.subscribe(() => this.scheduleHeader()));
		labels.ensure(scope.get(this.paneId)?.tabId);
		this.scheduleHeader();
	}

	/** Coalesces a burst of scope events into one retitle per animation frame. */
	private scheduleHeader(): void {
		if (this.pendingHeader) return;
		this.pendingHeader = this.containerEl.win.requestAnimationFrame(() => {
			this.pendingHeader = 0;
			this.refreshHeader();
		});
	}

	/**
	 * Makes Obsidian re-read `getDisplayText` for the tab and the view header.
	 *
	 * `updateHeader` is not in `obsidian.d.ts` even though every core view uses
	 * it, so it is called through an optional-method type: an Obsidian that ever
	 * drops it leaves a stale title instead of throwing inside a frame callback.
	 */
	private refreshHeader(): void {
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	/** Obsidian's own resize hook; the observer covers the rest. */
	override onResize(): void {
		this.checkVisibility();
		this.terminal.resize();
	}

	/**
	 * Runs one of the async steps nothing awaits — suspend, resume, restart — and
	 * makes sure a rejection is reported instead of becoming an unhandled one. A
	 * `void promise` here would have hidden exactly the failures that leave the
	 * view half torn down, so every fire-and-forget call goes through this.
	 */
	private detached(what: string, run: () => Promise<void>): void {
		run().catch((error: unknown) => {
			console.warn(`Herdr: terminal ${what} failed`, error);
		});
	}

	/**
	 * One measurement into the tracker. A hidden leaf's content has `display: none`
	 * and therefore no box at all, so a zero measurement means hidden and anything
	 * else means shown. Cheap enough to call from every resize and layout change.
	 */
	private checkVisibility(): void {
		const tracker = this.visibility;
		if (!tracker) return;
		const visible = this.hostVisible();
		if (visible === null) return;
		if (tracker.update(visible) === 'revealed') {
			this.detached('resume', async () => {
				await this.surfaces.current?.setVisible(true);
				// #84: whatever the settings changed while this tab was in the
				// background lands now, on a terminal someone can see.
				await this.flushPendingEffects();
			});
		}
	}

	/**
	 * The leaf has been hidden for the whole grace period: hand the session and
	 * the renderer back. Belt and braces first, because a measurement can be
	 * missed (a layout change nobody reported): never suspend a host that has a
	 * box right now.
	 */
	private onGraceExpired(): void {
		if (this.hostVisible() === true) {
			this.visibility?.update(true);
			return;
		}
		// Nothing queued survives the suspend: the renderer is given up, and the
		// one mounted on reveal reads every setting fresh (#84).
		this.pendingEffects.clear();
		this.detached('suspend', async () => {
			await this.surfaces.current?.setVisible(false);
		});
	}

	/** Whether the host element has a box at all; null when there is no host. */
	private hostVisible(): boolean | null {
		const host = this.hostEl;
		if (!host) return null;
		return host.clientWidth > 0 && host.clientHeight > 0;
	}

	/**
	 * The one entry point a settings change uses (issue #84).
	 * `HerdrPlugin.applyTerminalSetting()` names the setting that moved — or
	 * `cssVariables` for a vault theme switch — and the matrix decides what this
	 * terminal does about it: repaint, recursor, rebuild on the other engine,
	 * retitle, or wait for the next mount.
	 *
	 * A hidden leaf holds the renderer effects back. One that is merely hidden
	 * queues them until it is revealed; one the grace period already suspended
	 * (#15) drops them, because its next mount reads every setting again.
	 */
	applySetting(setting: TerminalSetting): void {
		const effect = this.pendingEffects.apply(setting, {
			hidden: this.visibility?.hidden === true,
			suspended: this.terminal.suspended,
		});
		if (effect) this.runEffect(effect);
	}

	/** One named effect, on the half of the tab that owns it. */
	private runEffect(effect: TerminalEffect): void {
		if (effect === 'title') {
			this.retitle();
			return;
		}
		// The next mount reads the setting itself, so there is nothing to run and
		// nothing that could fail.
		if (effect === 'next-mount') return;
		this.detached(`${effect} change`, () => this.applyEffect(effect));
	}

	/**
	 * One effect on the mounted surface. `engine` is the render mode's setting
	 * (#92): a changed default can mean the other surface altogether, and when
	 * it does not it is the lifecycle's ordinary renderer rebuild.
	 */
	private async applyEffect(effect: TerminalEffect): Promise<void> {
		if (effect === 'engine' && surfaceKindFor(this.renderMode()) !== this.surfaces.kind) {
			await this.showSurface();
			return;
		}
		await this.surfaces.current?.apply(effect);
	}

	/** Re-reads the title after the title setting changed (issue #43). */
	private retitle(): void {
		this.endpointSession()?.tabLabels.ensure();
		this.scheduleHeader();
	}

	/**
	 * The leaf is back on screen: run what it deferred, collapsed to the least
	 * work that lands every queued effect. Called after the resume, so a terminal
	 * the grace period had suspended has already remounted from the current
	 * settings and has nothing left queued to run.
	 */
	private async flushPendingEffects(): Promise<void> {
		for (const effect of this.pendingEffects.flush()) await this.applyEffect(effect);
	}

	/**
	 * Obsidian's keymap asking what to do with a keydown (#47). Answers only for
	 * a focused control-mode terminal; everything else is `undefined`, i.e.
	 * Obsidian's business as before. Keyup is not asked: the keymap listens to
	 * keydown alone.
	 */
	private onHostKey(event: KeyboardEvent): boolean | undefined {
		if (event.type !== 'keydown') return undefined;
		const host = this.hostEl;
		if (!host) return undefined;
		const active = host.ownerDocument.activeElement;
		const applies = hostKeyPolicyApplies({
			mode: this.terminal.sessionMode,
			focusInside: active !== null && host.contains(active),
		});
		if (!applies) return undefined;
		return keymapReturn(this.terminal.routeHostKey(event));
	}

	/** Header action: swap control/observe, which means a fresh bridge process. */
	private async toggleMode(): Promise<void> {
		const identity = this.terminal.identity;
		const mode: AttachMode = identity.mode === 'control' ? 'observe' : 'control';
		this.updateToggleAction(mode);
		// Keeps the layout file in step with what the view is actually doing.
		this.app.workspace.requestSaveLayout();
		await this.setIdentity({ ...identity, mode });
	}

	private updateToggleAction(mode: AttachMode = this.terminal.identity.mode): void {
		const el = this.toggleActionEl;
		if (!el) return;
		const observing = mode === 'observe';
		const title = observing ? 'Switch to control mode' : 'Switch to observe mode';
		setIcon(el, observing ? 'square-terminal' : 'eye');
		setTooltip(el, title);
		el.setAttribute('aria-label', title);
	}

	/**
	 * The tab header menu (#92). Obsidian calls this for "more options" and for
	 * a right-click on the tab, which is where a render mode is switched in
	 * place; the palette reaches the same menu through
	 * {@link switchRenderModeCommand}.
	 */
	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		this.addRenderModeItems(menu);
	}

	/** Opens the render mode menu over this view, for the command. */
	showRenderModeMenu(): void {
		const menu = new Menu();
		this.addRenderModeItems(menu);
		const box = this.containerEl.getBoundingClientRect();
		menu.showAtPosition({ x: box.left, y: box.top }, this.containerEl.doc);
	}

	/**
	 * One checkable item per render mode. Native is shown but disabled on a
	 * remote endpoint, with the reason in its title (ADR-0002), rather than
	 * hidden: a mode that is missing looks like a bug, one that says why does
	 * not.
	 */
	private addRenderModeItems(menu: Menu): void {
		const current = this.renderMode();
		const remote = this.isRemote();
		for (const mode of RENDER_MODES) {
			const { available, reason } = renderModeAvailability(mode, { remote });
			const name = RENDER_MODE_NAMES[mode];
			const title = reason === null ? name : `${name} (${reason})`;
			menu.addItem((item) => {
				item.setSection('herdr-render-mode')
					.setTitle(title)
					.setChecked(mode === current)
					.setDisabled(!available)
					.onClick(() => {
						if (available) this.detached('render mode switch', () => this.setRenderMode(mode));
					});
			});
		}
	}

	/**
	 * Switches this tab's render mode in place and remembers it in the view
	 * state, so it survives a restart. Between the two terminal modes this is
	 * the `engine` effect and the surface stays; to or from native it is a
	 * surface swap.
	 */
	async setRenderMode(mode: RenderMode): Promise<void> {
		if (this.storedRenderMode === mode) return;
		const before = this.renderMode();
		this.storedRenderMode = mode;
		// Keeps the layout file in step with what the view is actually doing.
		this.app.workspace.requestSaveLayout();
		// Pinning the mode the tab was following anyway changes nothing on
		// screen, and a rebuild would cost it its colours for no reason.
		if (this.renderMode() === before) return;
		await this.applyEffect('engine');
	}

	/** The strip under the terminal; what it says is the lifecycle's to decide. */
	private renderStatus(line: StatusLine): void {
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		el.toggleClass('mod-warning', line.warning);
		el.createSpan({ cls: 'herdr-terminal-status-text', text: line.text });
		if (line.detail) el.createSpan({ cls: 'herdr-terminal-status-detail', text: line.detail });
	}
}

/**
 * The `Switch render mode` command (#92), registered in `main.ts`. Answers for
 * the active terminal tab and nothing else, so the command hides itself in the
 * palette while another view has the focus.
 */
export function switchRenderModeCommand(app: App, checking: boolean): boolean {
	const view = app.workspace.getActiveViewOfType(TerminalView);
	if (!view) return false;
	if (!checking) view.showRenderModeMenu();
	return true;
}
