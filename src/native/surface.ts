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
 * - `./promptBox.ts` is the prompt box under the transcript (#97);
 * - `./sessionBar.ts` is the model, effort and mode pickers and the context
 *   readout under the prompt box (#161), whose click shows the context
 *   breakdown (#171).
 *
 * What stays here is the session model binding — which turns a change names,
 * when everything is drawn again — and the strip under the view.
 */

import { Component, MarkdownRenderer, Notice, type App, type HoverParent, type HoverPopover, type WorkspaceLeaf } from 'obsidian';
import type { PaneIdentity, StatusLine } from '../views/paneTerminal';
import type { PaneSurface } from './paneSurface';
import { subagentLabel, TodoIndex, turnActivity, type LatestTodo, type ToolGroupPresentation } from './toolCalls';
import { TodoChip } from './todoList';
import { earlierTurnCount, type ToolEntry, type Turn } from './conversation';
import { PromptBox, type PromptInputAttachment } from './promptBox';
import type { KeySender, PromptSender } from './promptSender';
import { SessionBar } from './sessionBar';
import type { SessionSettingsSender } from './sessionSettings';
import type { ContextUsageReader } from './contextBreakdown';
import type { WaitingResponder } from './pendingRequest';
import type { ScreenAnswering } from './screenAnswerers';
import { linkVaultUris } from './noteLinks';
import { resolveObsidianUri, vaultLookup } from './obsidianUri';
import { READABLE_WIDTH_CLASS, readableLineWidth, watchReadableLineWidth } from './readableWidth';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from './sessionModel';
import { FoldMemory } from './foldMemory';
import { ScrollFollower } from './scrollFollower';
import { TurnRenderer, type ShownImage } from './turnRenderer';
import { ImageModal } from './imageModal';
import { SubagentModal } from './subagentModal';
import type { SubagentTranscript } from './subagents';
import { WaitingCardView } from './waitingCardView';
import { SessionLines } from './sessionLines';
import { registerViewLinks } from './viewLinks';
import { ConversationFindModal, highlightMatch, locateMatch, type FindHit } from './conversationFind';
import { EarlierTurnsBar } from './earlierTurns';

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
	/**
	 * How the waiting card reads the pane's dialog off its screen and answers
	 * it with keys (ADR-0009): herdr and herdr-core, read per block. Null, or
	 * left out, for a kind with no screen (the `claude` kind answers through
	 * {@link responder}).
	 */
	screen?: () => ScreenAnswering | null;
	/**
	 * How the session bar's pickers change the model, effort and mode (#161),
	 * read per draw: the tab's runtime may change under it. Null, or left
	 * out, for a kind that cannot change them yet; the pickers then show the
	 * values, disabled, with the reason.
	 */
	sessionSettings?: () => SessionSettingsSender | null;
	/**
	 * How the context readout's breakdown is asked for without writing to the
	 * conversation (#171), read per click. Null, or left out, for a kind whose
	 * agent is asked through the prompt (the format's `contextCommand`).
	 */
	contextUsage?: () => ContextUsageReader | null;
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
	/**
	 * Shows a prompt's image full size (#144). Defaults to a modal; a test
	 * passes its own.
	 */
	openImage?: (image: ShownImage) => void;
	/**
	 * Shows a subagent's transcript, held for as long as it is shown (#147).
	 * Defaults to a modal; a test passes its own.
	 */
	openSubagent?: (title: string, transcript: SubagentTranscript) => void;
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
	/** The current to-do list under the turns (#143); null while detached. */
	private todo: TodoChip | null = null;
	/** The waiting card (#99), kept across attaches for its answer guards. */
	private readonly waiting: WaitingCardView;
	/** The prompt box under the transcript (#97); null while detached. */
	private promptBox: PromptBox | null = null;
	/** The session bar under the prompt box (#161); null while detached. */
	private sessionBar: SessionBar | null = null;
	/** What the model does not hold, above the first turn (#152); null while detached. */
	private earlierBar: EarlierTurnsBar | null = null;
	/** The surface's own listeners: the scroll, the links, the line width. */
	private readonly component = new Component();
	/**
	 * What the reader opened and closed in the turns (#127). Here, not in the
	 * turn renderer: that is rebuilt on every attach and its turns on every
	 * full draw, and a reader's choice must outlive both. Not in the session
	 * model either, which every tab on the pane shares.
	 */
	private readonly folds = new FoldMemory();
	/** The turn last drawn as the latest, which settles when another arrives (#128). */
	private activeTurnId: string | null = null;
	/** Each turn's own to-do list, read once per change of that turn (#143). */
	private readonly todos = new TodoIndex();
	/** The session's newest to-do list as last drawn: its update is the open one. */
	private latestTodo: LatestTodo | null = null;
	/** Takes the last find's highlight off (#145); null when nothing is marked. */
	private clearFindMark: (() => void) | null = null;
	/** Whether the tab is shown; a hidden one follows no subagent (#147). */
	private visible = true;
	/** Lets go of the session's subagents, while this shows them (#147). */
	private subagentHold: (() => void) | null = null;

	constructor(options: NativePaneSurfaceOptions) {
		this.options = options;
		this.identity = options.identity;
		this.waiting = new WaitingCardView({
			model: () => this.model,
			paneId: () => this.identity.paneId,
			keySender: options.keySender,
			responder: options.responder,
			screen: options.screen,
			// A misfire's "Show in the conversation" (ADR-0009 §4).
			revealTurn: (turnId) => {
				const turnEl = this.turns?.turnEl(turnId);
				if (turnEl) this.follower?.scrollTo(turnEl);
			},
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
			folds: this.folds,
			latestTodoId: () => this.latestTodo?.entryId ?? null,
			copier: { write: (text) => navigator.clipboard.writeText(text), notify: (message) => this.notify(message) },
			onTurnCreated: (turnEl) => follower.watchTurn(turnEl),
			// A prompt's images, read from the transcript as they come into view
			// and shown full size on a click (#144).
			readImage: (image) => this.model?.readImage?.(image) ?? Promise.resolve(null),
			// What each call is shown as is the session's format's (ADR-0010).
			toolTable: () => this.model?.format,
			openImage: (image) =>
				this.options.openImage ? this.options.openImage(image) : new ImageModal(this.options.app, image).open(),
			openSubagent: (call) => this.openSubagent(call),
		});
		this.todo = new TodoChip(root);
		this.lines = new SessionLines(root, {
			component: this.component,
			onRetry: () => this.model?.retryRead?.(),
		});
		this.rootEl = root;
		this.component.load();
		// First in the sizer, before any turn is drawn, and never cleared with them.
		this.earlierBar = new EarlierTurnsBar(sizerEl, {
			component: this.component,
			onLoad: () => this.model?.loadEarlier?.(),
			cls: 'herdr-native-earlier-view',
		});
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
		// Its own row, not the box's: the waiting card hides the box and the
		// bar stays, disabled (#161).
		this.sessionBar = new SessionBar({
			paneId: () => this.identity.paneId,
			sender: () => this.options.sessionSettings?.() ?? null,
			contextUsage: () => this.options.contextUsage?.() ?? null,
			// `/context` on herdr and herdr-core: the prompt's own path (#171).
			sendCommand: (paneId, text) => this.options.sender.send(paneId, text),
			notify: (message) => this.notify(message),
		});
		this.sessionBar.mount(root);
		this.bind();
	}

	async detach(): Promise<void> {
		this.unbind();
		this.waiting.detach();
		this.promptBox?.destroy();
		this.promptBox = null;
		this.sessionBar?.destroy();
		this.sessionBar = null;
		this.follower?.dispose();
		this.follower = null;
		this.component.unload();
		this.rootEl?.remove();
		this.rootEl = null;
		this.turns = null;
		this.lines = null;
		this.todo = null;
		this.earlierBar = null;
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
		this.visible = visible;
		this.holdSubagents();
		if (visible) this.follower?.pin();
	}

	/**
	 * Says to the model that this shows its subagents while the tab is
	 * attached and shown, and stops saying so otherwise (#147): a hidden tab
	 * keeps its model, not the subagents' tails.
	 */
	private holdSubagents(): void {
		const model = this.handle?.model;
		const wanted = !!model && this.visible && this.rootEl !== null;
		if (wanted && !this.subagentHold) this.subagentHold = model?.showSubagents?.() ?? null;
		else if (!wanted && this.subagentHold) {
			this.subagentHold();
			this.subagentHold = null;
		}
	}

	/** Opens the transcript of the subagent working under `call` (#147). */
	private openSubagent(call: ToolEntry): void {
		const transcript = this.model?.subagentTranscript?.(call.id) ?? null;
		if (!transcript) {
			this.notify('This subagent’s transcript cannot be read from here.');
			return;
		}
		const title = `Subagent: ${subagentLabel(call)}`;
		if (this.options.openSubagent) {
			this.options.openSubagent(title, transcript);
			return;
		}
		new SubagentModal(this.options.app, title, transcript, {
			presentation: this.options.presentation,
			vaultPath: this.options.vaultPath,
			// Not the view's renderer: nothing here moves the view's scroll.
			renderMarkdown: (markdown, el, component) =>
				MarkdownRenderer.render(this.options.app, markdown, el, this.sourcePath(), component).then(() =>
					linkVaultUris(el, (uri) => this.resolveUri(uri)),
				),
			resolveUri: (uri) => this.resolveUri(uri),
			toolTable: () => this.model?.format,
			copier: { write: (text) => navigator.clipboard.writeText(text), notify: (message) => this.notify(message) },
		}).open();
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
		this.folds.clear();
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
	 * The index is the heading's place in `Turn.headings`, which the parser
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
	 * Puts the cursor in the prompt box (#145), and says whether there was one
	 * to take it: hidden behind the waiting card, or not mounted, it cannot.
	 */
	focusPrompt(): boolean {
		return this.promptBox?.focus() ?? false;
	}

	/** Whether {@link focusPrompt} would take, for the command's check. */
	canFocusPrompt(): boolean {
		return this.promptBox?.canFocus() ?? false;
	}

	/** Brings the next or the previous turn into view (#145). */
	stepTurn(direction: 1 | -1): void {
		const turns = this.turns;
		const follower = this.follower;
		if (!turns || !follower) return;
		const turnEls: HTMLElement[] = [];
		for (const turn of this.model?.state.turns ?? []) {
			const el = turns.turnEl(turn.id);
			if (el) turnEls.push(el);
		}
		follower.stepTurn(turnEls, direction);
	}

	/**
	 * Opens the find picker over this session (#145); a pick brings its turn
	 * into view with the match highlighted until the next find.
	 */
	findInConversation(): void {
		if (!this.rootEl) return;
		const state = this.model?.state;
		new ConversationFindModal(
			this.options.app,
			() => this.model?.state.turns ?? [],
			(hit, query) => this.revealMatch(hit, query),
			// What it cannot search, and where its turns count from (#152).
			state ? earlierTurnCount(state) : 0,
		).open();
	}

	/** Scrolls to a find's match and marks it, or to its turn when the drawing lacks it. */
	private revealMatch(hit: FindHit, query: string): void {
		this.clearFind();
		const turnEl = this.turns?.turnEl(hit.turnId);
		if (!turnEl || !this.follower) return;
		const match = locateMatch(turnEl, query, hit.occurrence);
		if (!match) {
			this.follower.scrollTo(turnEl);
			return;
		}
		this.clearFindMark = highlightMatch(match);
		this.follower.scrollTo(match.node.parentElement ?? turnEl, 'center');
	}

	/** Takes the last find's mark off, if there is one. */
	private clearFind(): void {
		this.clearFindMark?.();
		this.clearFindMark = null;
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
		this.holdSubagents();
		this.renderAll();
		this.report();
	}

	/** Gives the model back. Safe to call when nothing is held. */
	private unbind(): void {
		this.subagentHold?.();
		this.subagentHold = null;
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
		if (change.reset && change.earlier) {
			// The same session with earlier turns loaded (#152): drawn above the
			// turn the reader had first, which stays where they saw it.
			const anchorId = this.turns?.firstTurnId() ?? null;
			const anchorEl = anchorId ? this.turns?.turnEl(anchorId) : undefined;
			const offset = anchorEl ? (this.follower?.offsetOf(anchorEl) ?? 0) : 0;
			this.renderAll();
			const nowEl = anchorId ? this.turns?.turnEl(anchorId) : undefined;
			if (nowEl) this.follower?.keepAt(nowEl, offset);
		} else if (change.reset) {
			// Another session (`/clear`, `--resume`): its latest turn is what to
			// show, whatever the reader was reading in the one that is gone.
			this.follower?.follow();
			this.renderAll();
		} else {
			const turns = this.model?.state.turns ?? [];
			// What a rewind left behind goes first (#131): a turn the new branch
			// opens is drawn after the ones that stay.
			for (const id of change.removedTurnIds ?? []) {
				this.turns?.remove(id);
				this.todos.forget(id);
			}
			// The latest turn too, whatever moved: its tool groups say whether the
			// agent is working or waiting in them (#128), and the status moves
			// without a line. And the turn that was latest, which has settled.
			const ids = new Set(change.changedTurnIds);
			const latest = turns.at(-1)?.id;
			if (latest) ids.add(latest);
			if (this.activeTurnId && this.activeTurnId !== latest) ids.add(this.activeTurnId);
			// The turn whose to-do update was open and the one whose is now, when
			// the newest list moved (#143): either may be a turn nothing else names.
			const todo = this.todos.latest(turns, this.model?.format);
			if (todo?.entryId !== this.latestTodo?.entryId) {
				if (this.latestTodo) ids.add(this.latestTodo.turnId);
				if (todo) ids.add(todo.turnId);
			}
			this.latestTodo = todo;
			for (const id of ids) {
				const turn = turns.find((candidate) => candidate.id === id);
				if (turn) this.renderTurn(turn, turn.id === latest);
			}
			this.activeTurnId = latest ?? null;
			this.todo?.update(todo?.items ?? null);
			this.updateEmpty();
			this.updateEarlier();
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
		const turns = this.model?.state.turns ?? [];
		// What the reader opened in turns the model no longer has — gone with a
		// rotation, or dropped while this tab was detached and heard nothing —
		// is never asked for again (#127).
		this.folds.retain(turns.map((turn) => turn.id));
		this.todos.clear();
		this.latestTodo = this.todos.latest(turns, this.model?.format);
		turns.forEach((turn, index) => this.renderTurn(turn, index === turns.length - 1));
		this.activeTurnId = turns.at(-1)?.id ?? null;
		this.todo?.update(this.latestTodo?.items ?? null);
		this.updateEmpty();
		this.updateEarlier();
		this.updateStatus();
		this.follower?.settle();
	}

	/** How many earlier turns the model does not hold, and whether they are loading (#152). */
	private updateEarlier(): void {
		const model = this.model;
		this.earlierBar?.update(model ? earlierTurnCount(model.state) : 0, model?.loadingEarlier ?? false);
	}

	/**
	 * Draws one turn. Only the session's latest turn shows what the agent is
	 * doing (#128): herdr's status is the pane's, and every turn before the
	 * latest has finished, whatever its calls still say.
	 */
	private renderTurn(turn: Turn, latest: boolean): void {
		const activity = latest ? turnActivity(this.model?.agentStatus ?? 'unknown') : null;
		this.turns?.render(turn, activity);
	}

	/** Drops every turn element and stops watching the one being written. */
	private clearTurns(): void {
		this.clearFind();
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
		this.updateSessionBar(status);
	}

	/**
	 * The session bar, in place (#161): every change reaches it, a reply's
	 * usage, a `/model` line and a compaction alike, and none redraws it.
	 */
	private updateSessionBar(status = this.model?.agentStatus ?? 'unknown'): void {
		const model = this.model;
		this.sessionBar?.update({
			info: model?.sessionInfo ?? {},
			status,
			connected: model?.connected ?? false,
			format: model?.format,
		});
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
