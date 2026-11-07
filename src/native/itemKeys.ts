/**
 * Stable names for the things a turn draws (issue #127).
 *
 * A turn is redrawn every time Claude appends to it, and what it draws is
 * recomputed from its entries each time (`turnItems`, `./toolCalls.ts`). For
 * the redraw to touch only what changed, and for a tool group the reader
 * opened to stay open, every item needs a name that is the same from one draw
 * to the next even though the item itself is a fresh object.
 *
 * Most items are one entry and take that entry's id. A tool group is the hard
 * one: its calls are a run, and a run can grow, split (an empty text block
 * between two calls fills in, an asynchronous subagent's report lands) or
 * merge. A group keeps the name of the group its calls were in when the turn
 * was last drawn, so its fold goes with it. The rules: the first run to claim
 * an old name keeps it, and only a
 * run with no name left to claim gets a new one, which never takes a name an
 * item already has.
 *
 * Pure and DOM-free.
 */

import type { TurnItem } from './toolCalls';

/**
 * The name an item would have on its own: its kind and the id of the entry it
 * draws — a tool call's id, or a message's for prose and thoughts. An entry
 * with neither, such as a steer, is named by its place among the turn's items
 * of its kind, which only ever append. A group's base is its first call's id,
 * the name it gets when it has none to keep.
 *
 * Nothing here lists the kinds: a kind added to `TurnItem` later is named by
 * the same rule without a change to this file.
 */
function baseKey(item: TurnItem, ordinal: number): string {
	if (item.kind === 'group') return `group:${item.tools[0]?.id ?? ''}`;
	const entry = ('entry' in item ? item.entry : undefined) as
		| { id?: unknown; messageId?: unknown }
		| undefined;
	if (typeof entry?.id === 'string') return `${item.kind}:${entry.id}`;
	if (typeof entry?.messageId === 'string') return `${item.kind}:${entry.messageId}`;
	return `${item.kind}#${ordinal}`;
}

/** The names of one draw, and what the next draw needs to keep them. */
export interface ItemNames {
	/** One key per item, in the items' order, unique within the turn. */
	keys: string[];
	/** Every tool call's id to the name of the group it is in now. */
	members: Map<string, string>;
	/**
	 * A group whose calls were in other groups when last drawn — split off from
	 * one, or merged with them — to those groups' names, so it can open as the
	 * reader left them. Only on the draw where the split or merge happens; the
	 * next one finds every call already under this group's name.
	 */
	related: Map<string, string[]>;
}

/**
 * Names a turn's items for this draw.
 *
 * `previous` maps each tool call's id to the name its group had last time
 * (the {@link ItemNames.members} of the last draw). Groups claim old names
 * first, in order, each taking the first one among its calls that no earlier
 * group took; only then are the groups left over named, by their first call,
 * so a new name never shadows one being kept.
 */
export function nameTurnItems(
	items: readonly TurnItem[],
	previous: ReadonlyMap<string, string>,
): ItemNames {
	const keys: (string | undefined)[] = items.map(() => undefined);
	const used = new Set<string>();
	const unique = (name: string): string => {
		let key = name;
		while (used.has(key)) key += '+';
		used.add(key);
		return key;
	};

	// Everything but a group is named by its entry and claims first: those
	// names are fixed, and a group's minted name must step around them.
	const ordinals = new Map<string, number>();
	items.forEach((item, index) => {
		if (item.kind === 'group') return;
		const ordinal = (ordinals.get(item.kind) ?? 0) + 1;
		ordinals.set(item.kind, ordinal);
		keys[index] = unique(baseKey(item, ordinal));
	});

	// Groups keep the name their calls had, the earliest group first.
	items.forEach((item, index) => {
		if (item.kind !== 'group') return;
		for (const tool of item.tools) {
			const name = previous.get(tool.id);
			if (name !== undefined && !used.has(name)) {
				used.add(name);
				keys[index] = name;
				return;
			}
		}
	});

	// The rest are new, or split off from a group that kept its name.
	items.forEach((item, index) => {
		if (keys[index] === undefined) keys[index] = unique(baseKey(item, 0));
	});

	const members = new Map<string, string>();
	const related = new Map<string, string[]>();
	items.forEach((item, index) => {
		if (item.kind !== 'group') return;
		const key = keys[index] ?? '';
		const others = new Set<string>();
		for (const tool of item.tools) {
			members.set(tool.id, key);
			const name = previous.get(tool.id);
			if (name !== undefined && name !== key) others.add(name);
		}
		if (others.size > 0) related.set(key, [...others]);
	});
	return { keys: keys.map((key) => key ?? ''), members, related };
}
