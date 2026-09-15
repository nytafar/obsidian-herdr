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
 * Which one a tab mounts is its view's decision (`./renderMode.ts`, #104),
 * and {@link PaneSurfaceHolder} performs the swap: detach the old surface,
 * then build and attach the new one. The terminal view owns the holder and
 * feeds it a factory, which is the seam `tests/paneSurface.test.ts` fakes.
 *
 * Remote endpoints keep a terminal surface (ADR-0002): everything the native
 * view reads is a path on the transcript's host, and the SSH adapters for that
 * do not exist yet, so {@link paneViewAvailability} reports native as
 * unavailable there and {@link effectivePaneView} falls back.
 */

import { Component, Keymap, MarkdownRenderer, Notice, type App } from 'obsidian';
import type { PaneIdentity, StatusLine, TerminalEffect } from '../views/paneTerminal';
import { type PaneView } from './renderMode';
import type { TextEntry, ThinkingEntry, ToolEntry, Turn } from './reducer';
import {
	changedPath,
	changeLine,
	changeStateClass,
	sourceText,
	subagentReport,
	toolDetail,
	toolGroupSummary,
	turnItems,
	vaultNoteLink,
	type ToolGroupPresentation,
	type TurnItem,
} from './toolCalls';
import type { AgentStatus } from '../herdr/types.gen';
import { PromptBox, type PromptInputAttachment } from './promptBox';
import type { KeySender, PromptSender } from './promptSender';
import { waitingCard, type WaitingCardModel } from './waitingCard';
import { READABLE_WIDTH_CLASS, readableLineWidth, watchReadableLineWidth } from './readableWidth';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from './sessionModel';

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
 * Whether a pane on this endpoint can be shown in this view. Only the native
 * view is ever unavailable, and only on a remote endpoint: the transcript it
 * reads is a path on the pane's own host and the SSH adapters are not built
 * yet (ADR-0002, ADR-0003).
 */
export function paneViewAvailability(
	view: PaneView,
	where: { remote: boolean },
): PaneViewAvailability {
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
}): PaneView {
	const view = input.stored ?? input.fallback;
	if (paneViewAvailability(view, { remote: input.remote }).available) return view;
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

/** What {@link NativePaneSurface} needs from the view around it. */
export interface NativePaneSurfaceOptions {
	/** The view's own app, never the global one (Obsidian guidelines). */
	app: App;
	identity: PaneIdentity;
	/** The strip under the view, so native mode says what it is doing too. */
	onStatus: (line: StatusLine) => void;
	/** The plugin's session models; one is held for as long as this is attached. */
	models: SessionModels;
	/** How a typed prompt reaches the pane's agent (#97, `./promptSender.ts`). */
	sender: PromptSender;
	/** How the waiting card's "Trust this folder" reaches the agent (#99). */
	keySender: KeySender;
	/** How a failure reaches the user. Defaults to an Obsidian notice. */
	notify?: (message: string) => void;
	/**
	 * Switches this tab back to the terminal view, which is what the
	 * waiting card's "Open in terminal" does: every block can be answered there,
	 * including the three this view never answers itself (#99).
	 */
	openInTerminal: () => void;
	/**
	 * The global "Trust new folders automatically" setting (#99), read on every
	 * block so a change reaches an open view. The workspace trust prompt only,
	 * never a permission, a question or a plan.
	 */
	autoTrustFolders: () => boolean;
	/**
	 * Called with the prompt box's text area once it exists, so the view can
	 * hang an autocomplete on it (#98), returning how to close it again when
	 * the surface detaches and whether its popover is open (#103). Left out by
	 * tests that only render.
	 */
	onPromptInput?: (inputEl: HTMLTextAreaElement) => PromptInputAttachment;
	/**
	 * How much of a turn's tool calls to fold away (#95). Read on every draw, so
	 * a change to the setting reaches an open view through {@link
	 * NativePaneSurface.refresh}.
	 */
	presentation: () => ToolGroupPresentation;
	/**
	 * The vault's absolute path, for stripping it off the files the agent
	 * changed. Empty for a vault with no filesystem adapter, which simply leaves
	 * every path outside the vault.
	 */
	vaultPath: () => string;
}

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

/** What a failed trust answer says, with herdr's message in the tail (#99). */
export function trustFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Herdr: could not trust this folder (${reason})`;
}

/**
 * How far from the bottom still counts as the bottom (#106).
 *
 * A couple of lines' worth. Sub-pixel rounding, a fractional device pixel ratio
 * and a wheel notch that overshoots by a hair all leave a reader who never
 * meant to move a few pixels short of the end, and none of them should stop the
 * view from following.
 */
export const BOTTOM_SLACK_PX = 24;

/** Whether a scroll container is showing its end, within {@link BOTTOM_SLACK_PX}. */
export function isAtBottom(geometry: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}): boolean {
	const furthest = geometry.scrollHeight - geometry.clientHeight;
	return furthest - geometry.scrollTop <= BOTTOM_SLACK_PX;
}

/** One piece of a human prompt: literal text, or a wikilink to a note. */
export type PromptSegment =
	| { kind: 'text'; text: string }
	| { kind: 'link'; target: string; label: string };

/**
 * A human prompt split into text and wikilinks.
 *
 * Human prompts are shown as the human typed them — plain, pre-wrapped text,
 * not Markdown — with the one exception that a wikilink is a link, because a
 * prompt in this vault is usually half references (native-view-design.md).
 */
export function promptSegments(prompt: string): PromptSegment[] {
	const segments: PromptSegment[] = [];
	const pattern = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;
	let at = 0;
	for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
		if (match.index > at) segments.push({ kind: 'text', text: prompt.slice(at, match.index) });
		const target = (match[1] ?? '').trim();
		const alias = match[2]?.trim();
		segments.push({ kind: 'link', target, label: alias || target });
		at = match.index + match[0].length;
	}
	if (at < prompt.length) segments.push({ kind: 'text', text: prompt.slice(at) });
	return segments;
}

/**
 * The native surface (issues #92, #93): a pane's agent session as Obsidian
 * Markdown.
 *
 * It owns no content of its own. The session model (`./sessionModel.ts`) holds
 * the reduced transcript and says which turns moved; this draws those turns and
 * nothing else, which is what keeps a long history cheap to keep up to date.
 *
 * What renders how (native-view-design.md): assistant prose through
 * `MarkdownRenderer`, one element per block, so the vault's own wikilinks,
 * callouts and embeds come out as they do anywhere else; human prompts as plain
 * pre-wrapped text with their wikilinks linkified; a turn's consecutive tool
 * calls as one collapsed tool group with the vault changes and the sources it
 * made kept outside it (#95); thinking as a collapsed "Thought"; a steer where
 * it entered the turn.
 *
 * Guidelines: no `innerHTML`, no inline styles (everything is in `styles.css`),
 * `this.app` comes in from the view rather than the global, and every DOM
 * listener and every rendered Markdown child hangs off a `Component` that is
 * unloaded when its turn is redrawn or the surface detaches.
 */
export class NativePaneSurface implements PaneSurface {
	private identity: PaneIdentity;
	private readonly options: NativePaneSurfaceOptions;
	/** The element this surface added to the host; removed again on detach. */
	private rootEl: HTMLElement | null = null;
	private turnsEl: HTMLElement | null = null;
	/**
	 * The wrapper the turns are drawn into, inside the scroll container: the
	 * reading view's sizer, which is what the readable line width applies to
	 * (#117, `./readableWidth.ts`).
	 */
	private sizerEl: HTMLElement | null = null;
	private emptyEl: HTMLElement | null = null;
	/** What the agent is doing, shown between blocks; null when it is nothing. */
	private statusEl: HTMLElement | null = null;
	/** The model this surface holds, or null while it is detached or has no pane. */
	private handle: SessionHandleOf<SessionModelView> | null = null;
	private unsubscribe: (() => void) | null = null;
	/** One element per turn id, in the order the turns arrived. */
	private readonly turnEls = new Map<string, HTMLElement>();
	/** One component per turn: its listeners and its rendered Markdown. */
	private readonly turnComponents = new Map<string, Component>();
	/** The prompt box under the transcript (#97); null while detached. */
	private promptBox: PromptBox | null = null;
	/** The surface's own listeners: the scroll on the turns element (#106). */
	private readonly component = new Component();
	/**
	 * Whether the view is following the end of the session. True on open and
	 * after a rotation, off the moment the reader scrolls up, on again when they
	 * come back to the bottom (#106).
	 */
	private following = true;
	/** Watches the turns element and the turn being written; null where there is none. */
	private resizeObserver: ResizeObserver | null = null;
	/** The turn the observer is watching, so only one ever is. */
	private observedTurnEl: HTMLElement | null = null;
	/** The Markdown renders of the current draw, which finish after it does. */
	private renders: Promise<void>[] = [];
	/** The waiting card (#99); null whenever the agent is not blocked. */
	private waitingEl: HTMLElement | null = null;
	/** The card's listeners, unloaded whenever it is drawn again or goes. */
	private waitingComponent: Component | null = null;
	/** Whether this surface has already answered the block it is in (#99). */
	private trustSent = false;

	constructor(options: NativePaneSurfaceOptions) {
		this.options = options;
		this.identity = options.identity;
	}

	async attach(hostEl: HTMLElement): Promise<void> {
		this.rootEl?.remove();
		const root = hostEl.createDiv({ cls: 'herdr-native-view' });
		// The two classes Obsidian's own reading view puts on one element:
		// `createDiv("markdown-preview-view markdown-rendered")` in its app
		// bundle. `markdown-preview-view` gives the reading-mode typography the
		// user has set, and `markdown-rendered` is the ancestor almost every rule
		// for the rendered blocks keys on — in Obsidian 1.10's `app.css`, tables
		// are `.markdown-rendered table`, `.markdown-rendered td, .markdown-rendered th`
		// (cell padding, borders, `--table-*` variables) and
		// `.markdown-rendered th, .markdown-rendered td { text-align: start }`,
		// and code blocks are `.markdown-rendered pre` and `.markdown-rendered code`.
		// With only `markdown-preview-view` none of those reach, which is why
		// tables rendered unpadded and unthemed (#108). Themes key on the same
		// ancestor, so this needs no plugin CSS of its own.
		root.addClass('markdown-preview-view', 'markdown-rendered');
		// The turns are the view's one scroll container (#103), so everything that
		// acts on the scroll — following here, the TOC's jumps (#100), the
		// `content-visibility` estimates (#101) — acts on this element.
		const turns = root.createDiv({ cls: 'herdr-native-turns' });
		// Inside it, the wrapper the reading view builds (#117): the scroll
		// container keeps the full width of the tab, so the scrollbar stays at
		// its edge, and this is the element `--file-line-width` narrows.
		this.sizerEl = turns.createDiv({
			cls: ['herdr-native-sizer', 'markdown-preview-sizer', 'markdown-preview-section'],
		});
		this.turnsEl = turns;
		this.rootEl = root;
		this.component.load();
		// The setting is the vault's, and it may move under an open view (#117).
		this.applyReadableWidth();
		this.component.register(
			watchReadableLineWidth(this.options.app, () => this.applyReadableWidth()),
		);
		// The only thing a scroll does: say whether the view is still following.
		// Nothing is drawn, measured or unmounted here, because this runs on
		// every frame of a flick through a long session (#101).
		this.component.registerDomEvent(turns, 'scroll', () => {
			this.following = isAtBottom(turns);
		});
		this.watchForGrowth(turns);
		this.promptBox = new PromptBox({
			paneId: () => this.identity.paneId,
			sender: this.options.sender,
			onInput: this.options.onPromptInput,
		});
		this.promptBox.mount(root);
		this.bind();
	}

	async detach(): Promise<void> {
		this.unbind();
		this.clearWaiting();
		this.promptBox?.destroy();
		this.promptBox = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.observedTurnEl = null;
		this.component.unload();
		this.renders = [];
		this.rootEl?.remove();
		this.rootEl = null;
		this.turnsEl = null;
		this.sizerEl = null;
		this.emptyEl = null;
		this.statusEl = null;
	}

	/**
	 * Nothing to hand back: there is no child process and no canvas here, so a
	 * hidden tab keeps its session model and its subscription and is simply up
	 * to date when it is revealed (#94, ADR-0003).
	 *
	 * What it does not keep is a layout — a hidden leaf measures nothing — so a
	 * tab that was following is put back on the end when it is revealed, and a
	 * tab whose reader had scrolled up is left exactly where they left it (#106).
	 */
	async setVisible(visible: boolean): Promise<void> {
		if (visible) this.pinToBottom();
	}

	async setIdentity(identity: PaneIdentity): Promise<void> {
		const samePane = identity.paneId === this.identity.paneId;
		this.identity = identity;
		if (samePane) {
			this.report();
			return;
		}
		// Another pane is another session: let the old model go and start over.
		this.unbind();
		this.bind();
	}

	/** Colours, cursors and engines are a terminal's business, not this view's. */
	async apply(): Promise<void> {}

	/**
	 * Draws everything again from the model it already holds (#95): what the
	 * tool group setting changed is how the turns read, not what they hold.
	 */
	refresh(): void {
		if (!this.rootEl) return;
		this.renderAll();
	}

	/**
	 * Brings one turn into view and stops following, which is what a click in
	 * the table of contents does (#100, which calls this and draws the list).
	 * A turn id this session does not hold moves nothing: the TOC and the view
	 * share a session model, but a rotation can empty one before the other.
	 */
	scrollToTurn(turnId: string): void {
		const turnEl = this.turnEls.get(turnId);
		if (!turnEl) return;
		this.following = false;
		turnEl.scrollIntoView({ block: 'start' });
	}

	/**
	 * Takes the pane's session model and draws what it already holds.
	 *
	 * At the bottom of it, always: this runs on open and again whenever the tab
	 * is pointed at another pane, and another pane is another session the reader
	 * has read nothing of. Where they had scrolled to in the pane before it says
	 * nothing about where this one starts (#106).
	 */
	private bind(): void {
		if (!this.rootEl) return;
		this.following = true;
		if (this.identity.paneId) {
			this.handle = this.options.models.acquire(this.identity.paneId);
			this.unsubscribe = this.handle.model.on((change) => this.applyChange(change));
		}
		this.renderAll();
		this.report();
	}

	/** Gives the model back. Safe to call when nothing is held. */
	private unbind(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.handle?.release();
		this.handle = null;
		this.clearTurns();
	}

	private get model(): SessionModelView | null {
		return this.handle?.model ?? null;
	}

	/** Draws a change: a reset redraws everything, else only the turns named. */
	private applyChange(change: SessionChange): void {
		if (!this.rootEl) return;
		if (change.reset) {
			// Another session (`/clear`, `--resume`): its latest turn is what to
			// show, whatever the reader was reading in the one that is gone.
			this.following = true;
			this.renderAll();
		} else {
			const turns = this.model?.state.turns ?? [];
			for (const id of change.changedTurnIds) {
				const turn = turns.find((candidate) => candidate.id === id);
				if (turn) this.renderTurn(turn);
			}
			this.updateEmpty();
			this.settleScroll();
		}
		this.updateStatus();
		this.report();
	}

	private renderAll(): void {
		this.clearTurns();
		for (const turn of this.model?.state.turns ?? []) this.renderTurn(turn);
		this.updateEmpty();
		this.updateStatus();
		this.settleScroll();
	}

	/** Drops every turn element and the components that went with them. */
	private clearTurns(): void {
		for (const component of this.turnComponents.values()) component.unload();
		this.turnComponents.clear();
		this.turnEls.clear();
		if (this.observedTurnEl) {
			this.resizeObserver?.unobserve(this.observedTurnEl);
			this.observedTurnEl = null;
		}
		this.sizerEl?.empty();
	}

	/**
	 * Puts the readable-line-width class where Obsidian's own rule looks for it:
	 * on the element carrying `markdown-preview-view` (#117). Nothing is drawn
	 * again for it — the width is a stylesheet's business, not a layout this
	 * view computes.
	 */
	private applyReadableWidth(): void {
		this.rootEl?.toggleClass(READABLE_WIDTH_CLASS, readableLineWidth(this.options.app));
	}

	/**
	 * Draws one turn into its own element, which is created on first sight and
	 * reused afterwards: a turn that grows while Claude writes keeps its place
	 * in the view, and the turns around it are not touched.
	 */
	private renderTurn(turn: Turn): void {
		const sizerEl = this.sizerEl;
		if (!sizerEl) return;
		let turnEl = this.turnEls.get(turn.id);
		if (!turnEl) {
			turnEl = sizerEl.createDiv({ cls: 'herdr-native-turn' });
			this.turnEls.set(turn.id, turnEl);
			// The turn Claude is writing is the one that grows under the view.
			this.watchForGrowth(turnEl, this.observedTurnEl);
		}
		turnEl.empty();
		this.turnComponents.get(turn.id)?.unload();
		const component = new Component();
		component.load();
		this.turnComponents.set(turn.id, component);

		if (turn.prompt) {
			this.renderPrompt(turnEl.createDiv({ cls: 'herdr-native-prompt' }), turn.prompt, component);
		}
		// What to draw, and in which order, is `turnItems` (#95): the tool calls
		// folded into groups with the vault changes and sources left outside.
		for (const item of turnItems(turn.entries, this.options.presentation())) {
			this.renderItem(turnEl, item, component);
		}
	}

	private renderItem(turnEl: HTMLElement, item: TurnItem, component: Component): void {
		switch (item.kind) {
			case 'text':
				this.renderText(turnEl, item.entry, component);
				return;
			case 'thinking':
				this.renderThinking(turnEl, item.entry, component);
				return;
			case 'group':
				this.renderToolGroup(turnEl, item.tools);
				return;
			case 'change':
				this.renderVaultChange(turnEl, item.entry, component);
				return;
			case 'source':
				this.renderSource(turnEl, item.entry);
				return;
			case 'report':
				this.renderSubagentReport(turnEl, item.entry, component);
				return;
			case 'steer':
				// A steer is shown where it entered the running turn (CONTEXT.md).
				this.renderPrompt(
					turnEl.createDiv({ cls: 'herdr-native-steer' }),
					item.entry.text,
					component,
				);
				return;
		}
	}

	/** Assistant prose, through Obsidian's own renderer. */
	private renderText(turnEl: HTMLElement, entry: TextEntry, component: Component): void {
		const blockEl = turnEl.createDiv({ cls: 'herdr-native-block' });
		this.renderMarkdown(entry.text, blockEl, component);
	}

	/**
	 * A thought, collapsed (#95). A `details` rather than a click handler: the
	 * browser owns the open state, so a turn redrawn while Claude writes does not
	 * fight the reader, and nothing has to be torn down.
	 *
	 * A block with no text is an encrypted thought this build cannot read, and
	 * renders nothing rather than an empty disclosure.
	 */
	private renderThinking(
		turnEl: HTMLElement,
		entry: ThinkingEntry,
		component: Component,
	): void {
		if (!entry.text.trim()) return;
		const details = turnEl.createEl('details', { cls: 'herdr-native-thinking' });
		details.createEl('summary', { cls: 'herdr-native-thinking-summary', text: 'Thought' });
		const bodyEl = details.createDiv({ cls: 'herdr-native-thought' });
		this.renderMarkdown(entry.text, bodyEl, component);
	}

	/** The tool group: one summary line that expands to a row per call. */
	private renderToolGroup(turnEl: HTMLElement, tools: readonly ToolEntry[]): void {
		const details = turnEl.createEl('details', { cls: 'herdr-native-tools' });
		details.createEl('summary', {
			cls: 'herdr-native-tools-summary',
			text: toolGroupSummary(tools),
		});
		const vaultPath = this.options.vaultPath();
		for (const entry of tools) {
			const detail = toolDetail(entry, vaultPath);
			details.createDiv({
				cls: 'herdr-native-tool',
				text: detail ? `${entry.name} ${detail}` : entry.name,
			});
		}
	}

	/**
	 * A file the agent wrote or edited, at the point in the turn where it did.
	 * Inside the vault it is a link to the note, so a reader can go and read it;
	 * outside there is nothing to strip and nothing to open, so the path shows
	 * as it was. No diff either way (native-view-design.md).
	 *
	 * What the line says follows the call's status (#91): a change that was
	 * refused, or that nothing has answered yet, must not read as one that
	 * landed.
	 */
	private renderVaultChange(turnEl: HTMLElement, entry: ToolEntry, component: Component): void {
		const path = changedPath(entry);
		if (!path) return;
		const el = turnEl.createDiv({ cls: 'herdr-native-change' });
		const state = changeStateClass(entry.status);
		if (state) el.addClass(state);
		const { lead, trail } = changeLine(entry.status);
		el.appendText(lead);
		const link = vaultNoteLink(path, this.options.vaultPath());
		if (link) this.renderPrompt(el, `[[${link}]]`, component);
		else el.appendText(path);
		if (trail) el.appendText(trail);
	}

	/**
	 * What a subagent reported, as prose (#96): the turn's own text and the text
	 * of the agent it sent out read the same way, which is the point of showing
	 * it at all. The call that launched it stays folded in the tool group.
	 */
	private renderSubagentReport(
		turnEl: HTMLElement,
		entry: ToolEntry,
		component: Component,
	): void {
		const report = subagentReport(entry);
		if (!report) return;
		const blockEl = turnEl.createDiv({ cls: 'herdr-native-report' });
		this.renderMarkdown(report, blockEl, component);
	}

	/**
	 * A web search or a fetch: where the turn's facts came from.
	 *
	 * A fetch is the one page it asked for. A search is the query it ran and the
	 * pages it came back with, which live in the result rather than the input
	 * (#95, `./toolCalls.ts`); a search that returned none shows its query alone.
	 * External links are Obsidian's to open, so they get no handler of ours.
	 */
	private renderSource(turnEl: HTMLElement, entry: ToolEntry): void {
		const { label, url, links } = sourceText(entry);
		const el = turnEl.createDiv({ cls: 'herdr-native-source' });
		if (url) {
			el.createEl('a', { cls: 'external-link', text: label, href: url });
			return;
		}
		el.createDiv({ cls: 'herdr-native-source-query', text: label });
		for (const link of links) {
			el.createEl('a', {
				cls: ['herdr-native-source-link', 'external-link'],
				text: link.title,
				href: link.url,
			});
		}
	}

	/** A human prompt: text as typed, wikilinks as links Obsidian can follow. */
	private renderPrompt(el: HTMLElement, prompt: string, component: Component): void {
		for (const segment of promptSegments(prompt)) {
			if (segment.kind === 'text') {
				el.appendText(segment.text);
				continue;
			}
			const linkEl = el.createEl('a', {
				cls: 'internal-link',
				text: segment.label,
				href: segment.target,
				attr: { 'data-href': segment.target },
			});
			component.registerDomEvent(linkEl, 'click', (event) => {
				event.preventDefault();
				// A mod-click opens the note in a new tab, as a link in a note does.
				void this.options.app.workspace.openLinkText(
					segment.target,
					'',
					Keymap.isModEvent(event),
				);
			});
		}
	}

	/**
	 * Markdown through Obsidian's own renderer, so the vault's links, callouts
	 * and embeds come out exactly as they do in a note. It resolves relative
	 * links against `sourcePath`; a transcript is not a note in the vault, so
	 * that is the vault root.
	 *
	 * The render is async, so the draw is finished long before the view has its
	 * real height: the promise is kept, and {@link settleScroll} pins the view
	 * once every render of this draw has landed (#106).
	 */
	private renderMarkdown(markdown: string, el: HTMLElement, component: Component): void {
		this.renders.push(MarkdownRenderer.render(this.options.app, markdown, el, '', component));
	}

	/**
	 * Puts the view back on the end of the session, twice: now, and once the
	 * Markdown of this draw has rendered.
	 *
	 * A single `scrollTop = scrollHeight` after a draw lands short — the
	 * renderer has not run yet, and `content-visibility` makes the height an
	 * estimate besides (#101) — so the pin that counts is the later one. What
	 * lands later still, an image or an embed, is the resize observer's.
	 */
	private settleScroll(): void {
		this.pinToBottom();
		const renders = this.renders;
		if (renders.length === 0) return;
		this.renders = [];
		void Promise.allSettled(renders).then(() => this.pinToBottom());
	}

	/** The end of the session, while the view is following it and still mounted. */
	private pinToBottom(): void {
		const turnsEl = this.turnsEl;
		if (!turnsEl || !this.following) return;
		turnsEl.scrollTop = turnsEl.scrollHeight;
	}

	/**
	 * Watches an element for the height it gains after it was drawn, and gives
	 * up the one it was watching before.
	 *
	 * Two elements at a time and no more: the turns element, which changes when
	 * the leaf or the prompt box does, and the turn being written, which is the
	 * one growing under a reader who is at the bottom. Watching every turn would
	 * fire on every `content-visibility` change as the reader scrolls, which is
	 * exactly the per-turn work a long session cannot afford (#101).
	 *
	 * Guarded for an environment with no `ResizeObserver` at all: the tests run
	 * under node, where there is none, and the view must still mount.
	 */
	private watchForGrowth(el: HTMLElement, instead?: HTMLElement | null): void {
		if (typeof ResizeObserver === 'undefined') return;
		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(() => this.pinToBottom());
		}
		if (instead) this.resizeObserver.unobserve(instead);
		if (el !== this.turnsEl) this.observedTurnEl = el;
		this.resizeObserver.observe(el);
	}

	/** The line shown when there is nothing to show, and nothing when there is. */
	private updateEmpty(): void {
		const root = this.rootEl;
		if (!root) return;
		if (this.turnEls.size > 0) {
			this.emptyEl?.remove();
			this.emptyEl = null;
			return;
		}
		const text = this.model?.path ? 'No turns in this session yet.' : 'No session yet.';
		if (!this.emptyEl) {
			this.emptyEl = root.createDiv({ cls: ['herdr-native-empty', 'herdr-native-sizer'] });
		}
		this.emptyEl.setText(text);
	}

	/**
	 * What the agent is doing between blocks (#94). herdr's `agent_status`, not
	 * anything guessed from the transcript: a turn that has stopped writing and
	 * a turn that is thinking look identical in the file.
	 */
	private updateStatus(): void {
		const root = this.rootEl;
		if (!root) return;
		const status = this.model?.agentStatus ?? 'unknown';
		// What the box may do is the same status this line reports (#97), and
		// `blocked` is where the waiting card takes its place (#99).
		this.promptBox?.setStatus(status);
		this.updateWaiting(status);
		const text = workingLine(status);
		if (!text) {
			this.statusEl?.remove();
			this.statusEl = null;
			return;
		}
		if (!this.statusEl) {
			this.statusEl = root.createDiv({ cls: ['herdr-native-status', 'herdr-native-sizer'] });
		}
		this.statusEl.setText(text);
	}

	/**
	 * The waiting card (#99), which is what a `blocked` agent gets instead of
	 * the prompt box: only `blocked` refuses a prompt, and the card is the way
	 * past it. The box is hidden rather than dropped, so the draft in it
	 * survives the block.
	 */
	private updateWaiting(status: AgentStatus): void {
		const root = this.rootEl;
		if (!root) return;
		if (status !== 'blocked') {
			this.clearWaiting();
			// The block is over: the next one is an answer of its own.
			this.trustSent = false;
			this.promptBox?.setHidden(false);
			return;
		}
		const card = waitingCard({
			// No transcript at all is the workspace trust prompt: a freshly
			// started Claude writes no file until its first turn (ADR-0003).
			hasTranscript: this.model?.path != null,
			turns: this.model?.state.turns ?? [],
			vaultPath: this.options.vaultPath(),
		});
		this.renderWaiting(root, card);
		this.promptBox?.setHidden(true);
		this.autoTrust(card);
	}

	/** Drops the card and its listeners. Safe to call when there is none. */
	private clearWaiting(): void {
		this.waitingComponent?.unload();
		this.waitingComponent = null;
		this.waitingEl?.remove();
		this.waitingEl = null;
	}

	/**
	 * Draws the card: what the block is, and the one or two things to do about
	 * it.
	 *
	 * **The startup prompt is the one block with a button of its own.** A
	 * permission is Claude's to decide, through its permission mode, and a
	 * question and a plan are the user's; all three get "Open in terminal"
	 * alone. The workspace trust prompt is what stands between a fresh Claude
	 * in a new directory and a session that can be used from this view at all,
	 * so it gets "Trust this folder". Measured 2026-09-15
	 * (`docs/architecture.md`, "What a bare Enter selects on each of Claude's
	 * blocking dialogs"): the cursor sits on the first option, which here is
	 * "No, exit", so the keys are `Down Enter` and never a bare Enter.
	 */
	private renderWaiting(root: HTMLElement, card: WaitingCardModel): void {
		this.clearWaiting();
		const component = new Component();
		component.load();
		this.waitingComponent = component;
		const el = root.createDiv({ cls: ['herdr-native-waiting', 'herdr-native-sizer'] });
		this.waitingEl = el;
		el.createDiv({ cls: 'herdr-native-waiting-title', text: card.title });
		if (card.body) el.createDiv({ cls: 'herdr-native-waiting-body', text: card.body });
		for (const option of card.options) {
			el.createDiv({ cls: 'herdr-native-waiting-option', text: option });
		}
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		// The startup kind is "no transcript at all", which is what a Claude
		// sitting at its trust prompt looks like: it has written no file yet
		// (ADR-0003). Every other kind is read out of a transcript, so it is a
		// session that is already running and past this prompt.
		if (card.kind === 'startup') {
			const trustEl = actions.createEl('button', {
				cls: ['herdr-native-waiting-action', 'herdr-native-waiting-trust', 'mod-cta'],
				text: 'Trust this folder',
			});
			component.registerDomEvent(trustEl, 'click', () => {
				void this.trust();
			});
		}
		const terminalEl = actions.createEl('button', {
			cls: ['herdr-native-waiting-action', 'herdr-native-waiting-terminal'],
			text: 'Open in terminal',
		});
		component.registerDomEvent(terminalEl, 'click', () => this.options.openInTerminal());
	}

	/**
	 * Answers the trust prompt when the setting says to, once (#99). The kind is
	 * checked here as well as where the button is drawn, because this is the
	 * path with nobody looking at it: every other block stays on screen,
	 * whatever the setting says.
	 */
	private autoTrust(card: WaitingCardModel): void {
		if (card.kind !== 'startup') return;
		if (!this.options.autoTrustFolders()) return;
		// One answer per block for the pane, not one per view: the claim is the
		// model's, which is the thing two tabs on one pane share (ADR-0003). It
		// is also what makes this once per block at all, since the card is drawn
		// again for every change that lands under it. The startup block names no
		// call, so the claim it is made under is the empty one.
		if (this.model?.claimBlock(card.toolUseId) !== true) return;
		void this.trust();
	}

	/**
	 * Trust: `Down Enter` in the pane's agent, which moves off the trust
	 * prompt's first option — "No, exit", which would quit Claude — onto the one
	 * that trusts the folder (`docs/architecture.md`, measured 2026-09-15).
	 * Only ever called for the startup block.
	 *
	 * One answer per block, whoever asks and however often. A second press —
	 * two clicks before the status moves, or a click on a card the setting has
	 * already answered — would land on whatever Claude showed next. The guard is
	 * dropped when the agent leaves `blocked`.
	 */
	private async trust(): Promise<void> {
		if (this.trustSent) return;
		this.trustSent = true;
		try {
			await this.options.keySender.sendKeys(this.identity.paneId, ['Down', 'Enter']);
		} catch (error) {
			this.notify(trustFailureMessage(error));
		}
	}

	/** How a failure reaches the user; a Notice, as a failed send is (#97). */
	private notify(message: string): void {
		if (this.options.notify) {
			this.options.notify(message);
			return;
		}
		new Notice(message);
	}

	private report(): void {
		const paneId = this.identity.paneId;
		const session = this.model?.agentSession ?? '';
		this.options.onStatus({
			text: paneId
				? `Native view of ${paneId}.${session ? '' : ' No session yet.'}`
				: 'Native view. No pane.',
			warning: false,
			detail: null,
		});
	}
}
