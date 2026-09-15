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

import { Component, Keymap, MarkdownRenderer, type App } from 'obsidian';
import type { PaneIdentity, StatusLine, TerminalEffect } from '../views/paneTerminal';
import {
	engineForRenderMode,
	NATIVE_RENDER_MODE,
	type RenderMode,
} from './renderMode';
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
import { PromptBox } from './promptBox';
import type { PromptSender } from './promptSender';
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
	/** The view's own app, never the global one (Obsidian guidelines). */
	app: App;
	identity: PaneIdentity;
	/** The strip under the view, so native mode says what it is doing too. */
	onStatus: (line: StatusLine) => void;
	/** The plugin's session models; one is held for as long as this is attached. */
	models: SessionModels;
	/** How a typed prompt reaches the pane's agent (#97, `./promptSender.ts`). */
	sender: PromptSender;
	/**
	 * Called with the prompt box's text area once it exists, so the view can
	 * hang an autocomplete on it (#98). Left out by tests that only render.
	 */
	onPromptInput?: (inputEl: HTMLTextAreaElement) => void;
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

	constructor(options: NativePaneSurfaceOptions) {
		this.options = options;
		this.identity = options.identity;
	}

	async attach(hostEl: HTMLElement): Promise<void> {
		this.rootEl?.remove();
		const root = hostEl.createDiv({ cls: 'herdr-native-view' });
		// `markdown-preview-view` is what gives the view the reading-mode
		// typography the user has set, which is the appearance the native view
		// is meant to have (native-view-design.md).
		root.addClass('markdown-preview-view');
		this.turnsEl = root.createDiv({ cls: 'herdr-native-turns' });
		this.rootEl = root;
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
		this.promptBox?.destroy();
		this.promptBox = null;
		this.rootEl?.remove();
		this.rootEl = null;
		this.turnsEl = null;
		this.emptyEl = null;
		this.statusEl = null;
	}

	/**
	 * Nothing to hand back: there is no child process and no canvas here, so a
	 * hidden tab keeps its session model and its subscription and is simply up
	 * to date when it is revealed (#94, ADR-0003).
	 */
	async setVisible(_visible: boolean): Promise<void> {}

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

	/** Takes the pane's session model and draws what it already holds. */
	private bind(): void {
		if (!this.rootEl) return;
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
			this.renderAll();
		} else {
			const turns = this.model?.state.turns ?? [];
			for (const id of change.changedTurnIds) {
				const turn = turns.find((candidate) => candidate.id === id);
				if (turn) this.renderTurn(turn);
			}
			this.updateEmpty();
		}
		this.updateStatus();
		this.report();
	}

	private renderAll(): void {
		this.clearTurns();
		for (const turn of this.model?.state.turns ?? []) this.renderTurn(turn);
		this.updateEmpty();
		this.updateStatus();
	}

	/** Drops every turn element and the components that went with them. */
	private clearTurns(): void {
		for (const component of this.turnComponents.values()) component.unload();
		this.turnComponents.clear();
		this.turnEls.clear();
		this.turnsEl?.empty();
	}

	/**
	 * Draws one turn into its own element, which is created on first sight and
	 * reused afterwards: a turn that grows while Claude writes keeps its place
	 * in the view, and the turns around it are not touched.
	 */
	private renderTurn(turn: Turn): void {
		const turnsEl = this.turnsEl;
		if (!turnsEl) return;
		let turnEl = this.turnEls.get(turn.id);
		if (!turnEl) {
			turnEl = turnsEl.createDiv({ cls: 'herdr-native-turn' });
			this.turnEls.set(turn.id, turnEl);
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
		// Obsidian's own renderer, so the vault's links, callouts and embeds
		// come out exactly as they do in a note. It resolves relative links
		// against `sourcePath`; a transcript is not a note in the vault, so
		// that is the vault root.
		void MarkdownRenderer.render(this.options.app, entry.text, blockEl, '', component);
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
		void MarkdownRenderer.render(this.options.app, entry.text, bodyEl, '', component);
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
		void MarkdownRenderer.render(this.options.app, report, blockEl, '', component);
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
		if (!this.emptyEl) this.emptyEl = root.createDiv({ cls: 'herdr-native-empty' });
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
		// What the box may do is the same status this line reports (#97).
		this.promptBox?.setStatus(status);
		const text = workingLine(status);
		if (!text) {
			this.statusEl?.remove();
			this.statusEl = null;
			return;
		}
		if (!this.statusEl) this.statusEl = root.createDiv({ cls: 'herdr-native-status' });
		this.statusEl.setText(text);
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
