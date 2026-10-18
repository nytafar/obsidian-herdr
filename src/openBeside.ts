/**
 * Opening something beside a herdr panel (issue #114).
 *
 * A link clicked inside a panel must not open in the panel's own leaf, which
 * would replace the agent with the note, and must not open nowhere. It opens
 * in the leaf next to the panel: the one already showing that file, else the
 * front tab of the tab group nearest the panel, else a fresh split beside it.
 *
 * The choice is {@link chooseLeafBeside}, pure and generic over the leaf type
 * like `chooseNoteLeaf` in `terminalPlacement.ts`, so it is unit tested without
 * a workspace. {@link leafBeside} gathers what it needs from the real one and
 * turns the answer into a leaf; {@link openLinkBeside} opens a link text there.
 * The native view's link clicks are the first caller; an `obsidian://herdr`
 * protocol handler (#115) is meant to be the second, which is why none of this
 * knows about the native view.
 *
 * Everything is read off public API and the persisted view state (PRD N1): a
 * leaf's file is `state.file`, its kind is `type`, and whether it may be
 * navigated away is `pinned` plus the view's own `navigation` flag, which is
 * what Obsidian's `getLeaf(false)` asks too.
 */

import {
	parseLinktext,
	type App,
	type PaneType,
	type Workspace,
	type WorkspaceLeaf,
} from 'obsidian';
import { leafOnScreen } from './leafOnScreen';

/** One leaf the choice can land on, as {@link chooseLeafBeside} sees it. */
export interface BesideSlot<T> {
	leaf: T;
	/** The tab group it sits in (`leaf.parent`), compared by identity only. */
	group: unknown;
	/** `state.file` of the leaf, or null for a view that shows no file. */
	file: string | null;
	/**
	 * Whether a file may be opened in it: not pinned, not another panel, and a
	 * view that is meant to be navigated away from.
	 */
	usable: boolean;
	/** Whether it is the tab its group shows, so navigating it is visible. */
	front: boolean;
}

/**
 * Where the open lands: a leaf already showing the file, the front tab of a
 * neighbouring group, or a split that still has to be made beside the panel.
 */
export type BesideChoice<T> =
	| { kind: 'existing'; leaf: T }
	| { kind: 'neighbour'; leaf: T }
	| { kind: 'split' };

/**
 * Picks the leaf beside `panel`, given the leaves of the area it lives in, in
 * layout order.
 *
 * Nothing in the panel's own tab group is ever chosen: bringing a tab of that
 * group forward hides the panel, which is the one thing "beside" rules out.
 * Outside it, a leaf already showing the file wins, pinned or not, because
 * revealing it navigates nothing. Otherwise the groups are tried nearest
 * first — the one after the panel's before the one before it, so a panel split
 * to the left of a note finds that note — and the first group whose front tab
 * is usable is the answer. A front tab that is another panel or pinned is
 * passed over rather than replaced, and when no group qualifies the caller
 * splits the panel.
 */
export function chooseLeafBeside<T>(input: {
	panel: T;
	/** The vault path of the file being opened, or null when it is unknown. */
	file: string | null;
	slots: readonly BesideSlot<T>[];
}): BesideChoice<T> {
	const panelGroup = input.slots.find((slot) => slot.leaf === input.panel)?.group;
	const others = input.slots.filter(
		(slot) => slot.leaf !== input.panel && (panelGroup === undefined || slot.group !== panelGroup),
	);

	const file = input.file;
	const showing = file ? others.find((slot) => slot.file === file) : undefined;
	if (showing) return { kind: 'existing', leaf: showing.leaf };

	// Groups in layout order, the panel's own included so distances count it.
	const groups: unknown[] = [];
	for (const slot of input.slots) if (!groups.includes(slot.group)) groups.push(slot.group);
	const at = panelGroup === undefined ? -1 : groups.indexOf(panelGroup);
	const nearest = groups
		.map((group, index) => ({ group, index }))
		.filter(({ group }) => group !== panelGroup)
		.sort((a, b) => {
			const distance = Math.abs(a.index - at) - Math.abs(b.index - at);
			// Equal distance: the group after the panel first.
			return distance !== 0 ? distance : b.index - a.index;
		});
	for (const { group } of nearest) {
		const members = others.filter((slot) => slot.group === group);
		const front = members.find((slot) => slot.front) ?? members[0];
		if (front?.usable) return { kind: 'neighbour', leaf: front.leaf };
	}
	return { kind: 'split' };
}

/**
 * The leaf to open `file` in beside `panel`, created when it has to be.
 *
 * The leaves considered are those under the panel's own root, so a panel in a
 * pop-out window opens beside itself there and one in the main area never
 * reaches into a pop-out. A panel in a sidebar has no neighbour to speak of:
 * a leaf already showing the file is still reused, and anything else goes
 * where Obsidian would send a link clicked in a sidebar, `getLeaf(false)`,
 * rather than a split that would put a note in the sidebar.
 *
 * `file` is a vault path, or null for a link that resolves to nothing yet; the
 * choice then simply finds no existing leaf.
 */
export function leafBeside(
	workspace: Workspace,
	panel: WorkspaceLeaf,
	file: string | null,
): WorkspaceLeaf {
	return placeBeside(workspace, panel, file).leaf;
}

/** {@link leafBeside}, saying whether the leaf is a split made for this open. */
function placeBeside(
	workspace: Workspace,
	panel: WorkspaceLeaf,
	file: string | null,
): { leaf: WorkspaceLeaf; created: boolean } {
	const root = panel.getRoot();
	const inSidebar = root === workspace.leftSplit || root === workspace.rightSplit;
	const panelType = panel.getViewState().type;

	const leaves: WorkspaceLeaf[] = [];
	if (inSidebar) {
		workspace.iterateRootLeaves((leaf) => leaves.push(leaf));
	} else {
		workspace.iterateAllLeaves((leaf) => {
			if (leaf.getRoot() === root) leaves.push(leaf);
		});
	}

	// The front tab of a group is the one on screen, as the other modules judge
	// it. A group with no leaf on screen (a pop-out not drawn yet, say) falls
	// back to the one Obsidian activated last.
	const shown = new Set(leaves.filter((leaf) => leafOnScreen(workspace, leaf)));
	const recent = new Map<unknown, WorkspaceLeaf | null>();
	const frontOf = (leaf: WorkspaceLeaf): boolean => {
		if (shown.has(leaf)) return true;
		if (leaves.some((other) => other.parent === leaf.parent && shown.has(other))) return false;
		if (!recent.has(leaf.parent)) recent.set(leaf.parent, workspace.getMostRecentLeaf(leaf.parent));
		return recent.get(leaf.parent) === leaf;
	};
	const slots = leaves.map((leaf): BesideSlot<WorkspaceLeaf> => {
		const state = leaf.getViewState();
		const shown = state.state?.file;
		return {
			leaf,
			group: leaf.parent,
			file: typeof shown === 'string' ? shown : null,
			usable: !state.pinned && state.type !== panelType && navigable(leaf),
			front: frontOf(leaf),
		};
	});
	if (!inSidebar && !slots.some((slot) => slot.leaf === panel)) {
		slots.push({ leaf: panel, group: panel.parent, file: null, usable: false, front: true });
	}

	const choice = chooseLeafBeside({ panel, file, slots });
	if (choice.kind === 'existing') return { leaf: choice.leaf, created: false };
	if (inSidebar) return { leaf: workspace.getLeaf(false), created: false };
	if (choice.kind === 'neighbour') return { leaf: choice.leaf, created: false };
	return { leaf: workspace.createLeafBySplit(panel, 'vertical', false), created: true };
}

/**
 * Whether a leaf's view may be navigated away from. A deferred leaf has a
 * placeholder view whose flag says nothing about the real one, so it is
 * judged by its persisted state alone, which the caller already did.
 */
function navigable(leaf: WorkspaceLeaf): boolean {
	if (leaf.isDeferred) return true;
	return leaf.view?.navigation !== false;
}

/**
 * Opens a link text beside `panel`, the way a click on a link in a note opens
 * it, only never in the panel's own leaf.
 *
 * `newLeaf` is `Keymap.isModEvent` of the click: a mod-click is Obsidian's to
 * place, exactly as it is in a note — a new tab, a split or a window — and so
 * is every open when there is no panel to stay beside. A plain click resolves
 * the link against `sourcePath` and opens the file in {@link leafBeside},
 * with the heading or block of the link as its ephemeral state, which is what
 * `openLinkText` itself hands `openFile`.
 *
 * A link that resolves to no file is one Obsidian creates the note for on a
 * click. That stays Obsidian's to do: the chosen leaf is made active first,
 * and `openLinkText` without a new leaf opens into the active leaf when it can
 * be navigated, which a leaf chosen here always can.
 *
 * A split made for the open and still empty when the open fails is closed
 * again, so a failed click leaves no blank pane behind. Only that one: a leaf
 * that was there before is never detached.
 */
export async function openLinkBeside(
	app: App,
	panel: WorkspaceLeaf | null,
	linktext: string,
	sourcePath: string,
	newLeaf: PaneType | boolean,
): Promise<void> {
	const workspace = app.workspace;
	if (newLeaf || !panel) {
		await workspace.openLinkText(linktext, sourcePath, newLeaf);
		return;
	}
	const { path, subpath } = parseLinktext(linktext);
	const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	const { leaf, created } = placeBeside(workspace, panel, file?.path ?? null);
	try {
		if (!file) {
			workspace.setActiveLeaf(leaf, { focus: true });
			await workspace.openLinkText(linktext, sourcePath, false);
			return;
		}
		await leaf.openFile(file, { active: true, ...(subpath ? { eState: { subpath } } : {}) });
	} catch (error) {
		if (created && leaf.getViewState().type === 'empty') leaf.detach();
		throw error;
	}
	await workspace.revealLeaf(leaf);
}
