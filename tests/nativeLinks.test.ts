/**
 * Links in the native view open beside it (issue #114).
 *
 * The surface against a fake workspace: a note leaf and the native view's own
 * leaf in two tab groups, the way a terminal placed beside its note leaves
 * them. What is asserted is which leaf a click opens the note in — never the
 * view's own — and what the prose's `obsidian://` URIs turn into on the way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer, TFile } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import { HOVER_LINK_SOURCE } from '../src/native/noteLinks';
import { emptyTranscript, type TranscriptState } from '../src/agents/claude/transcript';
import type { Turn } from '../src/native/conversation';
import type {
	BlockKind,
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App, WorkspaceLeaf } from 'obsidian';

class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = '/transcript.jsonl';
	loaded = true;
	agentSession = 's1';
	agentStatus: AgentStatus = 'idle';
	blockKind: BlockKind | null = null;
	connected = true;
	private readonly listeners = new Set<(change: SessionChange) => void>();
	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	claimBlock(): boolean {
		return true;
	}
	push(turns: Turn[]): void {
		this.state = { ...this.state, turns };
		const change = { changedTurnIds: turns.map((turn) => turn.id), reset: false };
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	constructor(readonly model: FakeModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

const VAULT = '/home/lasse/hvelv';
const NOTE = 'registry/clients/my/Prøver.md';
const URI = 'obsidian://open?vault=hvelv&file=registry%2Fclients%2Fmy%2FPr%C3%B8ver';

function file(path: string): TFile {
	return Object.assign(new TFile(), { path });
}

/** A leaf: which group it is in, what it shows, and what was opened in it. */
class FakeLeaf {
	readonly opened: { path: string; state: unknown }[] = [];
	constructor(
		readonly name: string,
		readonly parent: object,
		public file: string | null,
		readonly type = 'markdown',
		readonly root: object = MAIN,
		public pinned = false,
	) {}
	getViewState(): { type: string; state: Record<string, unknown>; pinned: boolean } {
		return { type: this.type, state: this.file ? { file: this.file } : {}, pinned: this.pinned };
	}
	getRoot(): object {
		return this.root;
	}
	async openFile(target: TFile, state?: unknown): Promise<void> {
		this.opened.push({ path: target.path, state });
		this.file = target.path;
	}
}

const MAIN = { split: 'main' };
const LEFT = { split: 'left' };
const RIGHT = { split: 'right' };

/** The workspace, as far as opening a link reaches into it. */
class FakeWorkspace {
	readonly leftSplit = LEFT;
	readonly rightSplit = RIGHT;
	readonly leaves: FakeLeaf[] = [];
	activeFile: string | null = null;
	readonly openLinkText = vi.fn(async () => {});
	readonly revealLeaf = vi.fn(async () => {});
	readonly setActiveLeaf = vi.fn();
	readonly trigger = vi.fn();
	readonly splits: { from: string; direction: string; before: boolean }[] = [];
	readonly tabs: FakeLeaf[] = [];

	iterateAllLeaves(callback: (leaf: FakeLeaf) => void): void {
		for (const leaf of this.leaves) callback(leaf);
	}
	getActiveFile(): TFile | null {
		return this.activeFile ? file(this.activeFile) : null;
	}
	createLeafBySplit(from: FakeLeaf, direction: string, before: boolean): FakeLeaf {
		this.splits.push({ from: from.name, direction, before });
		const leaf = new FakeLeaf('split', {}, null);
		this.leaves.push(leaf);
		return leaf;
	}
	getLeaf(kind: string): FakeLeaf {
		const leaf = new FakeLeaf(`new ${kind}`, {}, null);
		this.tabs.push(leaf);
		this.leaves.push(leaf);
		return leaf;
	}
}

/** The vault: its name, its files, and the setting the surface watches. */
class FakeVault {
	constructor(readonly files: string[]) {}
	getName(): string {
		return 'hvelv';
	}
	getAbstractFileByPath(path: string): TFile | null {
		return this.files.includes(path) ? file(path) : null;
	}
	getConfig(): unknown {
		return true;
	}
	on(_name: string, callback: unknown): unknown {
		return callback;
	}
	offref(): void {}
}

interface Harness {
	surface: NativePaneSurface;
	el: FakeElement;
	host: HTMLElement;
	model: FakeModel;
	workspace: FakeWorkspace;
	own: FakeLeaf;
	note: FakeLeaf;
	notify: ReturnType<typeof vi.fn>;
}

/**
 * The native view in a group of its own, right of a note in another: where
 * the default placement puts a terminal opened from a note.
 */
async function harness(
	options: { files?: string[]; ownRoot?: object; withNote?: boolean; sourcePath?: string } = {},
): Promise<Harness> {
	const files = options.files ?? [NOTE, 'today.md', 'design.md', 'repos/x/local.md'];
	const workspace = new FakeWorkspace();
	const own = new FakeLeaf('native', { group: 'right' }, null, 'herdr-terminal', options.ownRoot);
	const note = new FakeLeaf('note', { group: 'left' }, 'today.md');
	if (options.withNote !== false) {
		workspace.leaves.push(note);
		workspace.activeFile = 'today.md';
	}
	workspace.leaves.push(own);
	const vault = new FakeVault(files);
	const metadataCache = {
		getFirstLinkpathDest: (linkpath: string, sourcePath: string): TFile | null => {
			const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
			const found =
				files.find((path) => path === `${dir}${linkpath}.md`) ??
				files.find((path) => path === linkpath || path === `${linkpath}.md`);
			return found ? file(found) : null;
		},
	};
	const app = { workspace, vault, metadataCache } as unknown as App;
	const model = new FakeModel();
	const notify = vi.fn();
	const { el, host } = hostEl();
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new FakeModels(model),
		sender: { send: async () => {} },
		keySender: { sendKeys: async () => {} },
		notify,
		openInTerminal: () => {},
		autoTrustFolders: () => false,
		presentation: () => 'highlight',
		vaultPath: () => VAULT,
		leaf: () => own as unknown as WorkspaceLeaf,
		noteSplitBefore: () => true,
		linkSourcePath: () => options.sourcePath ?? '',
	});
	await surface.attach(host);
	return { surface, el, host, model, workspace, own, note, notify };
}

function turn(id: string, prompt: string, prose?: string): Turn {
	return {
		id,
		prompt,
		entries: prose === undefined ? [] : [{ kind: 'text', messageId: `m-${id}`, text: prose }],
		headings: [],
	};
}

/** Lets the stub renderer land and the view's pass over what it rendered run. */
async function rendered(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Clicks and waits for the open to land. */
async function click(link: FakeElement | undefined, event: Record<string, unknown> = {}) {
	if (!link) throw new Error('no link to click');
	const dispatched = link.dispatch('click', { button: 0, ...event });
	await rendered();
	return dispatched;
}

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('NativePaneSurface: a link opens beside the view (#114)', () => {
	it('opens a prompt wikilink in the split beside the view, not the view', async () => {
		const { el, model, workspace, own, note } = await harness();
		model.push([turn('u1', 'Read [[design]] first')]);

		const event = await click(el.find('herdr-native-prompt').find('internal-link'));

		expect(event.defaultPrevented).toBe(true);
		expect(note.opened.map((open) => open.path)).toEqual(['design.md']);
		expect(own.opened).toEqual([]);
		expect(workspace.splits).toEqual([]);
		expect(workspace.openLinkText).not.toHaveBeenCalled();
	});

	it('opens a wikilink in the prose the same way', async () => {
		const { el, model, own, note } = await harness();
		model.push([turn('u1', 'Where?', 'It is in [[design|the design note]].')]);
		await rendered();

		const link = el.find('herdr-native-block').find('internal-link');
		expect(link.textContent).toBe('the design note');
		await click(link);

		expect(note.opened.map((open) => open.path)).toEqual(['design.md']);
		expect(own.opened).toEqual([]);
	});

	it('reveals a leaf beside the view that already shows the note', async () => {
		const { el, model, workspace, note } = await harness();
		const shown = new FakeLeaf('shown', { group: 'left' }, 'design.md');
		workspace.leaves.push(shown);
		model.push([turn('u1', 'Read [[design]]')]);

		await click(el.find('internal-link'));

		expect(shown.opened.map((open) => open.path)).toEqual(['design.md']);
		expect(workspace.revealLeaf).toHaveBeenCalledWith(shown);
		expect(note.opened).toEqual([]);
	});

	it('splits off the view when nothing is beside it, never opening in its own leaf', async () => {
		const { el, model, workspace, own } = await harness({ withNote: false });
		model.push([turn('u1', 'Read [[design]]')]);

		await click(el.find('internal-link'));

		expect(workspace.splits).toEqual([{ from: 'native', direction: 'vertical', before: true }]);
		const split = workspace.leaves.find((leaf) => leaf.name === 'split');
		expect(split?.opened.map((open) => open.path)).toEqual(['design.md']);
		expect(own.opened).toEqual([]);
	});

	it('opens a new tab from a view in the sidebar', async () => {
		const { el, model, workspace } = await harness({ withNote: false, ownRoot: RIGHT });
		model.push([turn('u1', 'Read [[design]]')]);

		await click(el.find('internal-link'));

		expect(workspace.splits).toEqual([]);
		expect(workspace.tabs[0]?.opened.map((open) => open.path)).toEqual(['design.md']);
	});

	it('leaves a mod-click and a middle click to Obsidian, in a new tab', async () => {
		const { el, model, workspace, note } = await harness();
		model.push([turn('u1', 'Read [[design]]')]);
		const link = el.find('internal-link');

		await click(link, { ctrlKey: true });
		link.dispatch('auxclick', { button: 1 });
		await rendered();

		expect(workspace.openLinkText.mock.calls).toEqual([
			['design', '', true],
			['design', '', 'tab'],
		]);
		expect(note.opened).toEqual([]);
	});

	it('hands a note that does not exist to Obsidian, in the leaf beside the view', async () => {
		const { el, model, workspace, note } = await harness();
		model.push([turn('u1', 'Write [[new idea]]')]);

		await click(el.find('internal-link'));

		expect(workspace.setActiveLeaf).toHaveBeenCalledWith(note, { focus: true });
		expect(workspace.openLinkText).toHaveBeenCalledWith('new idea', '', false);
	});

	it('resolves links against the pane’s folder in the vault', async () => {
		const { el, model, note } = await harness({ sourcePath: 'repos/x/' });
		model.push([turn('u1', 'Read [[local]]')]);

		await click(el.find('internal-link'));

		expect(note.opened.map((open) => open.path)).toEqual(['repos/x/local.md']);
		expect(MarkdownRenderer.calls.map((call) => call.sourcePath)).toEqual([]);
		model.push([turn('u1', 'Read', 'prose')]);
		expect(MarkdownRenderer.calls.map((call) => call.sourcePath)).toEqual(['repos/x/']);
	});
});

describe('NativePaneSurface: obsidian:// links (#114)', () => {
	it('shows a bare URI in the prose as the note’s path and opens it beside the view', async () => {
		const { el, model, own, note, workspace } = await harness();
		model.push([turn('u1', 'Where?', `Saved it to ${URI}.`)]);
		await rendered();

		const block = el.find('herdr-native-block');
		expect(block.textContent).toBe(`Saved it to ${NOTE}.`);
		const event = await click(block.find('internal-link'));

		// Prevented: the operating system's protocol handler never sees it.
		expect(event.defaultPrevented).toBe(true);
		expect(note.opened.map((open) => open.path)).toEqual([NOTE]);
		expect(own.opened).toEqual([]);
		expect(workspace.openLinkText).not.toHaveBeenCalled();
	});

	it('links a URI in inline code, a list and an autolink, and leaves a fenced block alone', async () => {
		const { el, model } = await harness();
		const prose = [`- \`${URI}\``, `- <${URI}>`, '```', URI, '```'].join('\n');
		model.push([turn('u1', 'Where?', prose)]);
		await rendered();

		const block = el.find('herdr-native-block');
		expect(block.findAll('internal-link').map((link) => link.textContent)).toEqual([NOTE, NOTE]);
		// The inline code became the link; the fenced block is still code.
		expect(block.querySelectorAll('code').map((code) => code.textContent)).toEqual([URI]);
		expect(block.querySelectorAll('pre')).toHaveLength(1);
	});

	it('keeps a Markdown link’s label and puts the path in its tooltip', async () => {
		const { el, model } = await harness();
		model.push([turn('u1', 'Where?', `See [The samples](${URI}).`)]);
		await rendered();

		const link = el.find('herdr-native-block').find('internal-link');
		expect(link.textContent).toBe('The samples');
		expect(link.attrs['aria-label']).toBe(NOTE);
	});

	it('leaves a URI for another vault an external link, with no handler of ours', async () => {
		const { el, model, note, workspace } = await harness();
		const other = 'obsidian://open?vault=work&file=a';
		model.push([turn('u1', 'Where?', `Over in ${other}`)]);
		await rendered();

		const block = el.find('herdr-native-block');
		expect(block.textContent).toBe(`Over in ${other}`);
		const event = await click(block.find('external-link'));

		expect(event.defaultPrevented).toBe(false);
		expect(note.opened).toEqual([]);
		expect(workspace.openLinkText).not.toHaveBeenCalled();
	});

	it('links a URI in the user’s own prompt, beside its wikilinks', async () => {
		const { el, model, note } = await harness();
		model.push([turn('u1', `Compare ${URI} with [[design]]`)]);

		const prompt = el.find('herdr-native-prompt');
		expect(prompt.textContent).toBe(`Compare ${NOTE} with design`);
		await click(prompt.findAll('internal-link')[0]);

		expect(note.opened.map((open) => open.path)).toEqual([NOTE]);
	});

	it('asks for a page preview of a hovered link', async () => {
		const { el, model, surface, workspace } = await harness();
		model.push([turn('u1', `Compare ${URI}`)]);
		const link = el.find('internal-link');

		link.dispatch('mouseover');

		expect(workspace.trigger).toHaveBeenCalledWith(
			'hover-link',
			expect.objectContaining({
				source: HOVER_LINK_SOURCE,
				hoverParent: surface,
				targetEl: link,
				linktext: NOTE,
				sourcePath: '',
			}),
		);
	});
});
