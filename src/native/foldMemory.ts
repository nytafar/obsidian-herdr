/**
 * What a reader opened and closed in one native view (issue #127).
 *
 * A tool group or a thought is a `<details>`, and the browser keeps its open
 * state on the element. The element is not what lasts: an item is drawn again
 * whenever what it shows changes, and every turn is drawn again when the tool
 * group setting moves or the session is reloaded. So the reader's choice is
 * kept here, by turn and by the item's stable name (`./itemKeys.ts`), and an
 * item drawn again opens as the reader left it.
 *
 * Only a choice the reader made is stored, never a default, so a default that
 * moves — a running group folds once its turn settles (#128) — still moves for
 * every group the reader did not touch. The surface owns one for as long as it
 * lives, which is as long as the tab shows this pane in the native view: the
 * turn renderer is rebuilt on every attach and is the wrong place for it, and
 * the session model is shared by every tab on the pane, whose readers fold
 * things differently.
 *
 * It holds the turns the session model still has, no more: a turn a rewind
 * dropped is forgotten as it goes, and on every full draw — an attach, a
 * `/clear` or `--resume`, a setting change — whatever the model no longer
 * holds is let go ({@link FoldMemory.retain}), which also covers a turn
 * dropped while the tab was detached and heard nothing of it.
 *
 * The same holds the names each turn's groups had when last drawn, which is
 * what lets a group keep its name, and so its fold, across a split or a merge.
 */

/** One turn's share: its groups' names and the reader's choices. */
export interface TurnFolds {
	/** Every tool call's id to the name of the group it was last drawn in. */
	names: Map<string, string>;
	/** An item's name to whether the reader left it open. */
	open: Map<string, boolean>;
}

export class FoldMemory {
	private readonly turns = new Map<string, TurnFolds>();

	/** How many turns it holds anything for. */
	get size(): number {
		return this.turns.size;
	}

	/** The memory of one turn, made the first time it is asked for. */
	turn(turnId: string): TurnFolds {
		let folds = this.turns.get(turnId);
		if (!folds) {
			folds = { names: new Map(), open: new Map() };
			this.turns.set(turnId, folds);
		}
		return folds;
	}

	/** Whether it holds anything for one turn. */
	has(turnId: string): boolean {
		return this.turns.has(turnId);
	}

	/** Forgets one turn: a rewind dropped it, and it is not coming back (#131). */
	forget(turnId: string): void {
		this.turns.delete(turnId);
	}

	/** Forgets every turn but these: the turns the session model still has. */
	retain(turnIds: Iterable<string>): void {
		const kept = new Set(turnIds);
		for (const turnId of [...this.turns.keys()]) {
			if (!kept.has(turnId)) this.turns.delete(turnId);
		}
	}

	/** Forgets everything: another pane is another session's turns. */
	clear(): void {
		this.turns.clear();
	}
}
