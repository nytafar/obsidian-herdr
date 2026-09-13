/**
 * Row dispatch (issue #82): what an event on an agent row does.
 *
 * `agentListView.ts` binds three delegated listeners and draws rows; every
 * decision behind a click, a right-click or a key on a row lives here. Given
 * the event, this module finds the row, works out the effect — open or reveal
 * the pane's terminal, focus the pane in herdr, or open the row menu and then
 * pin, rename or close — and performs it through {@link RowDispatchHost}. The
 * host is the only thing that knows about Obsidian, the plugin or herdr, so
 * `tests/rowDispatch.test.ts` drives the whole surface without an `ItemView`.
 *
 * **Every effect is keyed by endpoint and pane.** Pane ids are unique per
 * herdr, not across them (issue #54), so a {@link PaneRef} carries both and a
 * {@link RowTarget} is captured — endpoint id plus the identity of the
 * published connection generation, which is what `EndpointSessions.for()`
 * hands out (issue #81) — before anything is awaited. Rename and close wait on
 * a modal, and the herdr underneath can change while it is open: the endpoint
 * toggle in the toolbar may switch the list to the other host, or a reconnect
 * may replace the connection. Both are revalidated after the modal answers,
 * and a stale answer is dropped with a notice rather than aimed at whatever
 * pane happens to carry that id now.
 *
 * The row behind an event is rebuilt from the two sources the render read —
 * the connection's scope and the pins — rather than scraped back out of the
 * DOM, so the menu says the same thing the row says without the view keeping
 * a map of what it drew.
 *
 * Pure in the same sense as `rowMenu.ts` and `listMenu.ts`: no `obsidian`
 * import, no plugin, and the DOM only through duck-typed `closest`, which is
 * also what makes a pop-out window's elements work (see `dom.ts`).
 */

import { asElement } from './dom';
import { agentDisplayName, isRowClickAction, rowActions, type RowClickAction } from './rowModel';
import {
	closeConfirmation,
	renamePrompt,
	rowMenuItems,
	type CloseConfirmText,
	type RenamePromptText,
	type RowMenuItem,
	type RowMenuRow,
} from './rowMenu';
import type { PaneState } from '../herdr/scope';

/** A pane on one herdr. Both halves travel together; the id alone aliases. */
export interface PaneRef {
	endpointId: string;
	paneId: string;
}

/**
 * Which herdr, and which connection to it, an effect was aimed at.
 *
 * `connection` is compared by identity only: the endpoint session of the
 * published connection generation, or null while none is published. A
 * reconnect to the same endpoint yields a new one, which is the point — the
 * client an action would travel over is not the client it was decided on.
 */
export interface RowTarget {
	endpointId: string;
	connection: unknown;
}

/** What the dispatcher needs of a pane: enough to name it and to rename it. */
export type RowPane = Pick<PaneState, 'paneId' | 'name' | 'title'>;

/** The bit of a mouse event read here. Structural, so a test needs no DOM. */
export interface RowPointerEvent {
	target: unknown;
	preventDefault(): void;
}

/** A key event, which is a pointer event plus the key that was pressed. */
export interface RowKeyEvent extends RowPointerEvent {
	key: string;
}

/**
 * Everything the dispatcher cannot do itself. The agent list implements this
 * against the plugin; a test implements it with recording fakes.
 *
 * Implementations must aim every call at `ref.endpointId`. The dispatcher only
 * ever passes a ref whose endpoint is the published one — that is what the
 * revalidation after a modal buys — so the list's adapter satisfies it by
 * calling the plugin, which acts on the published connection.
 *
 * `E` is the concrete mouse event the host draws a menu at: `MouseEvent` in
 * the view, a fake in tests. It is passed back untouched.
 */
export interface RowDispatchHost<E extends RowPointerEvent = MouseEvent> {
	/** Endpoint and connection identity as they are now (issue #81's lookup). */
	target(): RowTarget;
	/** The pane as the published connection knows it, or null when it does not. */
	pane(paneId: string): RowPane | null;
	/** Which half of the action pair sits on the row body (issue #21). */
	rowClick(): RowClickAction;
	/** Whether the pane is pinned to the top of its group on that endpoint. */
	pinned(ref: PaneRef): boolean;
	/** Writes the pin state and persists it. No repaint: the caller decides. */
	setPinned(ref: PaneRef, pinned: boolean): Promise<void>;
	/** Opens the pane as a terminal in Obsidian, or reveals the open one. */
	openTerminal(ref: PaneRef): void;
	/** `pane.focus`, the one source of truth for "seen" (PRD M9). */
	focusPane(ref: PaneRef): void;
	/** `agent.rename`, with the pane-label fallback; reports its own failures. */
	renameAgent(ref: PaneRef, name: string): Promise<void>;
	/** `pane.close`; true when herdr closed it. Reports its own failures. */
	closePane(ref: PaneRef): Promise<boolean>;
	/** Draws the row menu at the event and calls `choose` for the entry picked. */
	showRowMenu(event: E, items: RowMenuItem[], choose: (item: RowMenuItem) => void): void;
	/** The rename prompt. Resolves null when it was cancelled or dismissed. */
	promptRename(text: RenamePromptText): Promise<string | null>;
	/** The terminate confirmation, drawn as a warning. False on cancel. */
	confirmClose(text: CloseConfirmText): Promise<boolean>;
	/** Repaints every open agent list. */
	refreshList(): void;
	/** Shows a message to the user. */
	notice(message: string): void;
}

/** Said when a modal is answered after the herdr under it has changed. */
export const STALE_TARGET_NOTICE =
	'Herdr: the connection changed while the dialog was open, so nothing was done.';

/** Keys that activate a focused row, mirroring what a pointer does. */
const ACTIVATION_KEYS = new Set(['Enter', ' ']);

/** One activation: the pane the event landed on and the half it asks for. */
interface RowActivation {
	paneId: string;
	action: RowClickAction;
}

export class RowDispatcher<E extends RowPointerEvent = MouseEvent> {
	constructor(private readonly host: RowDispatchHost<E>) {}

	/** A click anywhere in the view; only one that lands on a row does anything. */
	click(event: RowPointerEvent): void {
		const activation = this.activationAt(event);
		if (!activation) return;
		event.preventDefault();
		this.activate(activation);
	}

	/**
	 * Keyboard mirrors the pointer, including which half of the pair fires.
	 * `preventDefault` also stops the browser turning Enter on the icon button
	 * into a click, which would run the effect a second time.
	 */
	keyDown(event: RowKeyEvent): void {
		if (!ACTIVATION_KEYS.has(event.key)) return;
		this.click(event);
	}

	/**
	 * Right-click on a row: the row menu (issue #35). Anywhere else in the view
	 * is left to the browser, so the toolbar keeps its default menu — and so
	 * does a row the connection no longer knows, which has nothing to offer.
	 */
	contextMenu(event: E): void {
		const paneId = this.paneIdAt(event);
		if (!paneId) return;
		const pane = this.host.pane(paneId);
		if (!pane) return;
		event.preventDefault();
		const target = this.host.target();
		const ref: PaneRef = { endpointId: target.endpointId, paneId };
		const row: RowMenuRow = {
			paneId,
			displayName: agentDisplayName(pane),
			pinned: this.host.pinned(ref),
			name: pane.name,
		};
		this.host.showRowMenu(event, rowMenuItems(row), (item) => {
			void this.runMenuItem(item, row, target);
		});
	}

	/**
	 * Runs one row menu entry against the herdr the menu was opened on.
	 *
	 * Pin is client-side and keyed by the captured endpoint, so it lands in the
	 * right list whatever the toolbar did meanwhile. Rename and close ask first,
	 * and what they ask over is revalidated once the answer is in.
	 */
	private async runMenuItem(item: RowMenuItem, row: RowMenuRow, target: RowTarget): Promise<void> {
		const ref: PaneRef = { endpointId: target.endpointId, paneId: row.paneId };
		switch (item.action) {
			case 'pin':
			case 'unpin': {
				await this.host.setPinned(ref, item.action === 'pin');
				this.host.refreshList();
				return;
			}
			case 'rename': {
				const name = await this.host.promptRename(renamePrompt(row));
				if (name === null) return;
				if (!this.stillCurrent(target)) return;
				await this.host.renameAgent(ref, name);
				return;
			}
			case 'close': {
				const confirmed = await this.host.confirmClose(closeConfirmation(row));
				if (!confirmed) return;
				if (!this.stillCurrent(target)) return;
				if (!(await this.host.closePane(ref))) return;
				// A closed pane's id is gone for good; keep the pin list honest.
				// Keyed by the captured endpoint, so this is right even if the list
				// has moved on while herdr was closing the pane.
				if (row.pinned) await this.host.setPinned(ref, false);
				return;
			}
		}
	}

	/**
	 * Whether the herdr an action was decided on is still the one underneath:
	 * same endpoint, same connection generation. A no is reported rather than
	 * swallowed — the user asked for something and it is not happening.
	 */
	private stillCurrent(target: RowTarget): boolean {
		const now = this.host.target();
		if (now.endpointId === target.endpointId && now.connection === target.connection) return true;
		this.host.notice(STALE_TARGET_NOTICE);
		return false;
	}

	/** Opens the terminal or focuses the pane, on the endpoint showing the row. */
	private activate({ paneId, action }: RowActivation): void {
		const ref: PaneRef = { endpointId: this.host.target().endpointId, paneId };
		if (action === 'terminal') this.host.openTerminal(ref);
		else this.host.focusPane(ref);
	}

	/**
	 * The pane and the action an event asks for, or null when it missed every
	 * row. The action is the one the clicked element was *drawn* with — the icon
	 * button records its own in the dataset — falling back to the row body's,
	 * so a click does what the tooltip promised even if the setting has changed
	 * since the last repaint (issue #21).
	 */
	private activationAt(event: RowPointerEvent): RowActivation | null {
		const paneId = this.paneIdAt(event);
		if (!paneId) return null;
		const drawn = this.element(event)?.closest<HTMLElement>('[data-herdr-action]')?.dataset
			.herdrAction;
		const action = isRowClickAction(drawn) ? drawn : rowActions(this.host.rowClick()).body;
		return { paneId, action };
	}

	/** The pane id of the row the event landed in, or undefined outside one. */
	private paneIdAt(event: RowPointerEvent): string | undefined {
		return this.element(event)?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId;
	}

	/**
	 * The event's target as an element. Not `instanceof`: a click on the button's
	 * Lucide glyph has an `SVGPathElement` as its target, and a pop-out window
	 * has its own constructors (issue #61). `closest` walks up from either.
	 */
	private element(event: RowPointerEvent): Element | null {
		return asElement(event.target as EventTarget | null);
	}
}
