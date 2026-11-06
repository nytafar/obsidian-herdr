/**
 * The native surface (issues #92, #93, ADR-0002): a pane's agent session as
 * Obsidian Markdown, the second adapter of the pane surface seam
 * (`./paneSurface.ts`).
 *
 * This file is composition. Each job has a module of its own:
 *
 * - `./turnRenderer.ts` draws the turns and keeps the heading anchors (#118);
 * - `./scrollFollower.ts` follows the end of the session (#106);
 * - `./waitingCardView.ts` draws the waiting card and answers it (#99);
 * - `./sessionLines.ts` holds the empty line and the status line;
 * - `./viewLinks.ts` opens and previews the links in the view (#114);
 * - `./promptBox.ts` is the prompt box under the transcript (#97).
 *
 * What stays here is the session model binding — which turns a change names,
 * when everything is drawn again — and the strip under the view.
 */

import { Component, MarkdownRenderer, Notice, type App, type HoverParent, type HoverPopover, type WorkspaceLeaf } from 'obsidian';
import type { PaneIdentity, StatusLine } from '../views/paneTerminal';
import type { PaneSurface } from './paneSurface';
import type { ToolGroupPresentation } from './toolCalls';
import { PromptBox, type PromptInputAttachment } from './promptBox';
import type { KeySender, PromptSender } from './promptSender';
import type { WaitingResponder } from './pendingRequest';
import { linkVaultUris } from './noteLinks';
import { resolveObsidianUri, vaultLookup } from './obsidianUri';
import { READABLE_WIDTH_CLASS, readableLineWidth, watchReadableLineWidth } from './readableWidth';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from './sessionModel';
import { ScrollFollower } from './scrollFollower';
import { TurnRenderer } from './turnRenderer';
import { WaitingCardView } from './waitingCardView';
import { SessionLines } from './sessionLines';
import { registerViewLinks } from './viewLinks';

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
	/**
	 * How the waiting card answers a request the runtime itself is waiting on
	 * (ADR-0007): only a kind that owns its agents' dialogs has one. Without it
	 * such a card is described like any other block.
	 */
	responder?: WaitingResponder;
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
	/**
	 * The leaf this view sits in, so a link opens beside it and never in it
	 * (#114). Read on every click; null, or left out by a test that does not
	 * click, opens links in a new tab instead of a split.
	 */
	leaf?: () => WorkspaceLeaf | null;
	/**
	 * Whether a note split off beside this view goes before (left of) it, which
	 * mirrors the terminal placement setting: a terminal placed right of its
	 * note gets its links on the left (#114). Defaults to false.
	 */
	noteSplitBefore?: () => boolean;
	/**
	 * What links in the prose and prompts resolve against: a path in the pane's
	 * cwd when that is inside the vault (`./noteLinks.ts`, `linkSourcePath`),
	 * else the vault root. Defaults to the vault root.
	 */
	linkSourcePath?: () => string;
}

/**
 * The native surface: binds the pane's session model and composes the
 * modules that draw it.
 *
 * It owns no content of its own. The session model (`./sessionModel.ts`) holds
 * the reduced transcript and says which turns moved; this has those turns
 * drawn and nothing else, which is what keeps a long history cheap to keep up
 * to date.
 *
 * Guidelines: no `innerHTML`, no inline styles (everything is in `styles.css`),
 * `this.app` comes in from the view rather than the global, and every DOM
 * listener and every rendered Markdown child hangs off a `Component` that is
 * unloaded when its turn is redrawn or the surface detaches.
 */
export class NativePaneSurface implements PaneSurface, HoverParent {
	/** The page preview a hovered link opened, as `HoverParent` asks (#114). */
	hoverPopover: HoverPopover | null = null;
	private identity: PaneIdentity;
	private readonly options: NativePaneSurfaceOptions;
	/** The element this surface added to the host; removed again on detach. */
	private rootEl: HTMLElement | null = null;
	/** The model this surface holds, or null while it is detached or has no pane. */
	private handle: SessionHandleOf<SessionModelView> | null = null;
	private unsubscribe: (() => void) | null = null;
	/** The turns, drawn into the reading view's sizer; null while detached. */
	private turns: TurnRenderer | null = null;
	/** The scroll of the turns element (#106); null while detached. */
	private follower: ScrollFollower | null = null;
	/** The empty line and the status line; null while detached. */
	private lines: SessionLines | null = null;
	/** The waiting card (#99), kept across attaches for its answer guards. */
	private readonly waiting: WaitingCardView;
	/** The prompt box under the transcript (#97); null while detached. */
	private promptBox: PromptBox | null = null;
	/** The surface's own listeners: the scroll, the links, the line width. */
	private readonly component = new Component();

	constructor(options: NativePaneSurfaceOptions) {
		this.options = options;
		this.identity = options.identity;
		this.waiting = new WaitingCardView({
			model: () => this.model,
			paneId: () => this.identity.paneId,
			keySender: options.keySender,
			responder: options.responder,
			autoTrustFolders: options.autoTrustFolders,
			openInTerminal: () => this.options.openInTerminal(),
			vaultPath: options.vaultPath,
			renderMarkdown: (markdown, el, component) => this.renderMarkdown(markdown, el, component),
			setPromptHidden: (hidden) => this.promptBox?.setHidden(hidden),
			notify: (message) => this.notify(message),
		});
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
		const turnsEl = root.createDiv({ cls: 'herdr-native-turns' });
		// Inside it, the wrapper the reading view builds (#117): the scroll
		// container keeps the full width of the tab, so the scrollbar stays at
		// its edge, and this is the element `--file-line-width` narrows.
		const sizerEl = turnsEl.createDiv({
			cls: ['herdr-native-sizer', 'markdown-preview-sizer', 'markdown-preview-section'],
		});
		const follower = new ScrollFollower(turnsEl, root);
		this.follower = follower;
		this.turns = new TurnRenderer(sizerEl, {
			presentation: this.options.presentation,
			vaultPath: this.options.vaultPath,
			renderMarkdown: (markdown, el, component) => this.renderMarkdown(markdown, el, component),
			resolveUri: (uri) => this.resolveUri(uri),
			onTurnCreated: (turnEl) => follower.watchTurn(turnEl),
		});
		this.lines = new SessionLines(root, {
			component: this.component,
			onRetry: () => this.model?.retryRead?.(),
		});
		this.rootEl = root;
		this.component.load();
		// The setting is the vault's, and it may move under an open view (#117).
		this.applyReadableWidth();
		this.component.register(
			watchReadableLineWidth(this.options.app, () => this.applyReadableWidth()),
		);
		follower.attach(this.component);
		registerViewLinks(this.component, root, {
			app: this.options.app,
			sourcePath: () => this.sourcePath(),
			leaf: this.options.leaf,
			noteSplitBefore: this.options.noteSplitBefore,
			hoverParent: this,
			notify: (message) => this.notify(message),
		});
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
		this.waiting.clear();
		this.promptBox?.destroy();
		this.promptBox = null;
		this.follower?.dispose();
		this.follower = null;
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.turns = null;
		this.lines = null;
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
		if (visible) this.follower?.pin();
	}

	async setIdentity(identity: PaneIdentity): Promise<void> {
		// The same pane id on another runtime is another pane (ADR-0006).
		const samePane =
			identity.paneId === this.identity.paneId && identity.endpointId === this.identity.endpointId;
		this.identity = identity;
		if (samePane) {
			this.report();
			return;
		}
		// Another pane is another session: let the old model go and start over.
		// The new one is pinned to the identity's runtime, never the published one.
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
		const turnEl = this.turns?.turnEl(turnId);
		if (!turnEl) return;
		this.follower?.scrollTo(turnEl);
	}

	/**
	 * Brings one heading of a turn's prose into view, which is what a click on a
	 * heading in the table of contents does (#118).
	 *
	 * The index is the heading's place in `Turn.headings`, which the reducer
	 * computes by regex, and the elements are what Obsidian's renderer
	 * produced; when they disagree, or the index names no heading, the turn is
	 * what a click can still promise (`TurnRenderer.headingEl`).
	 */
	scrollToHeading(turnId: string, index: number): void {
		const turn = this.model?.state.turns.find((candidate) => candidate.id === turnId);
		const headingEl = this.turns?.headingEl(turnId, index, turn?.headings.length);
		if (!headingEl) {
			this.scrollToTurn(turnId);
			return;
		}
		this.follower?.scrollTo(headingEl);
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
		this.follower?.follow();
		if (this.identity.paneId) {
			this.handle = this.options.models.acquire(this.identity.endpointId, this.identity.paneId);
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
			this.follower?.follow();
			this.renderAll();
		} else {
			const turns = this.model?.state.turns ?? [];
			for (const id of change.changedTurnIds) {
				const turn = turns.find((candidate) => candidate.id === id);
				if (turn) this.turns?.render(turn);
			}
			this.updateEmpty();
			// Written while the reader is away from the end: the jump button
			// says so (#149). A status change alone writes nothing.
			if (change.changedTurnIds.length > 0) this.follower?.arrived();
			this.follower?.settle();
		}
		this.updateStatus();
		this.report();
	}

	private renderAll(): void {
		this.clearTurns();
		for (const turn of this.model?.state.turns ?? []) this.turns?.render(turn);
		this.updateEmpty();
		this.updateStatus();
		this.follower?.settle();
	}

	/** Drops every turn element and stops watching the one being written. */
	private clearTurns(): void {
		this.turns?.clear();
		this.follower?.forgetTurn();
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

	/** The vault path an `obsidian://` URI opens in this vault, or null (#114). */
	private resolveUri(uri: string): string | null {
		return resolveObsidianUri(uri, vaultLookup(this.options.app, this.options.vaultPath()));
	}

	/** What the view's links resolve against (#114). */
	private sourcePath(): string {
		return this.options.linkSourcePath?.() ?? '';
	}

	/**
	 * Markdown through Obsidian's own renderer, so the vault's links, callouts
	 * and embeds come out exactly as they do in a note. It resolves relative
	 * links against `sourcePath`; a transcript is not a note in the vault, so
	 * that is the vault root.
	 *
	 * The render is async, so the draw is finished long before the view has its
	 * real height: the promise goes to the scroll follower, which pins the view
	 * once every render of this draw has landed (#106).
	 */
	private renderMarkdown(
		markdown: string,
		el: HTMLElement,
		component: Component,
	): Promise<void> {
		const rendering = MarkdownRenderer.render(
			this.options.app,
			markdown,
			el,
			this.sourcePath(),
			component,
		).then(() => linkVaultUris(el, (uri) => this.resolveUri(uri)));
		this.follower?.track(rendering);
		return rendering;
	}

	/** The empty line, or why the transcript cannot be read. */
	private updateEmpty(): void {
		this.lines?.updateEmpty({
			hasTurns: (this.turns?.size ?? 0) > 0,
			readProblem: this.model?.readProblem ?? null,
			hasPath: Boolean(this.model?.path),
		});
	}

	/**
	 * What the agent is doing (#94), and everything that follows from it: what
	 * the prompt box may do (#97), and whether the waiting card takes its place
	 * (#99).
	 */
	private updateStatus(): void {
		const root = this.rootEl;
		if (!root) return;
		const status = this.model?.agentStatus ?? 'unknown';
		this.promptBox?.setStatus(status);
		this.waiting.update(root, status);
		this.lines?.updateStatus(status);
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
		// Another runtime is active, or none is: what is on screen is what the
		// session said when this one was last connected (ADR-0006).
		const disconnected = paneId !== '' && this.model?.connected === false;
		const tail = disconnected
			? ' Its runtime is not connected.'
			: session
				? ''
				: ' No session yet.';
		this.options.onStatus({
			text: paneId ? `Native view of ${paneId}.${tail}` : 'Native view. No pane.',
			warning: disconnected,
			detail: null,
		});
	}
}
