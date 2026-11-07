/**
 * Live equals cold (issue #138): every fixture transcript, folded in random
 * batches the way a tail delivers it, ends where folding the whole file at
 * once ends, and every batch says exactly which turns it changed and removed.
 * A preview of the next line over any point leaves the state alone and shows
 * what folding that line will.
 *
 * Every Claude fixture goes through Claude's parser; every Codex recording
 * through the seam's stub parser (`fixtures/codexParser.ts`), which folds and
 * forks the way any format does. The splits are random but seeded, so a
 * failure names the seed and the split, and comes back the same.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeParser } from '../src/agents/claude/transcript';
import {
	earlierTurnCount,
	previewTail,
	turnWindow,
	type ConversationParser,
	type ConversationState,
	type Turn,
	type TurnPage,
} from '../src/native/conversation';
import { codexParser } from './fixtures/codexParser';

/** How many random splits each fixture is folded in. */
const SPLITS = 25;

function fixtures(folder: string): { name: string; lines: string[] }[] {
	const dir = join(__dirname, 'fixtures', folder);
	return readdirSync(dir)
		.filter((name) => name.endsWith('.jsonl'))
		.sort()
		.map((name) => ({ name, lines: readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) }));
}

const CASES: { parser: ConversationParser; name: string; lines: string[] }[] = [
	...fixtures('transcripts').map((fixture) => ({ parser: claudeParser, ...fixture })),
	...fixtures('codex').map((fixture) => ({ parser: codexParser, ...fixture })),
];

/** A small seeded generator (mulberry32), so a split can be told and replayed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Where to cut `count` lines: sorted, with repeats, so a batch may be empty. */
function cuts(count: number, next: () => number): number[] {
	const how = Math.floor(next() * Math.min(count + 1, 12));
	const at = Array.from({ length: how }, () => Math.floor(next() * (count + 1)));
	return [0, ...at.sort((a, b) => a - b), count];
}

/** A deep copy of the turns, by id: what a batch's changes are checked against. */
function byId(turns: readonly Turn[]): Map<string, Turn> {
	return new Map(turns.map((turn) => [turn.id, structuredClone(turn)]));
}

/**
 * The windows a session is folded through besides none (#152): small enough
 * that every fixture with more than a turn or two drops some, by count, by
 * bytes, or by both, and a rewind reaches back past what is held.
 */
const WINDOWS: { name: string; page: TurnPage | null }[] = [
	{ name: 'every turn', page: null },
	{ name: 'one turn', page: { turns: 1, bytes: Infinity } },
	{ name: 'two turns, 3 kB', page: { turns: 2, bytes: 3000 } },
	{ name: '3 kB', page: { turns: Infinity, bytes: 3000 } },
];

/** An empty state for `parser`, held in `page` when one is given. */
function start(parser: ConversationParser, page: TurnPage | null, pages = 1): ConversationState {
	const state = parser.empty();
	if (page) state.window = turnWindow(pages, page);
	return state;
}

function fold(parser: ConversationParser, lines: string[], page: TurnPage | null = null, pages = 1): ConversationState {
	return parser.reduce(start(parser, page, pages), lines).state;
}

describe('live equals cold (#138)', () => {
	it('covers every fixture there is', () => {
		expect(CASES.filter((c) => c.parser === codexParser).length).toBe(
			readdirSync(join(__dirname, 'fixtures', 'codex')).filter((name) => name.endsWith('.jsonl')).length,
		);
		expect(CASES.length).toBeGreaterThan(30);
	});

	it.each(
		CASES.flatMap((c) => WINDOWS.map((window) => [`${c.name}, held: ${window.name},`, c, window.page] as const)),
	)('%s folds the same in any batches', (_name, { parser, lines }, page) => {
		const cold = fold(parser, lines, page);
		for (let seed = 1; seed <= SPLITS; seed++) {
			const split = cuts(lines.length, random(seed));
			let state = start(parser, page);
			for (let i = 0; i + 1 < split.length; i++) {
				const batch = lines.slice(split[i], split[i + 1]);
				const before = byId(state.turns);
				const order = state.turns.map((turn) => turn.id);
				const result = parser.reduce(state, batch);
				const where = `seed ${seed}, split ${split.join(',')}, batch ${i}`;
				expect(result.state, where).toBe(state);
				state = result.state;
				const after = new Set(state.turns.map((turn) => turn.id));

				// Removed: exactly the turns the batch found and no longer holds, in their old order.
				expect(result.removedTurnIds, where).toEqual(order.filter((id, at) => !after.has(id) && order.indexOf(id) === at));
				// Changed: each once, every one still here, and every turn that is new or differs among them.
				const changed = new Set(result.changedTurnIds);
				expect(changed.size, where).toBe(result.changedTurnIds.length);
				for (const id of changed) expect(after.has(id), where).toBe(true);
				for (const turn of state.turns) {
					const was = before.get(turn.id);
					if (was && JSON.stringify(was) === JSON.stringify(turn)) continue;
					expect(changed.has(turn.id), `${where}: turn ${turn.id} moved unreported`).toBe(true);
				}
			}
			expect(state, `seed ${seed}, split ${split.join(',')}`).toEqual(cold);
		}
	});

	it.each(CASES.map((c) => [c.name, c] as const))(
		'%s previews each next line without changing the state, as folding it will',
		(_name, { parser, lines }) => {
			const state = parser.empty();
			for (let at = 0; at < lines.length; at++) {
				const line = lines[at] as string;
				const kept = structuredClone(state);
				const preview = previewTail(parser, state, line);
				expect(state, `line ${at}`).toEqual(kept);
				// Half a record is never a preview.
				expect(previewTail(parser, state, line.slice(0, -1)), `line ${at}`).toBeNull();
				const folded = parser.reduce(state, [line]);
				if (!preview) continue;
				// A preview never takes a turn away, and shows what the line does.
				expect(folded.removedTurnIds, `line ${at}`).toEqual([]);
				expect(preview.state.turns, `line ${at}`).toEqual(folded.state.turns);
				expect(preview.changedTurnIds, `line ${at}`).toEqual(folded.changedTurnIds);
			}
			expect(state).toEqual(fold(parser, lines));
		},
	);
});

describe('a session held in a window (#152)', () => {
	const CLAUDE = CASES.filter((c) => c.parser === claudeParser);
	const HELD = WINDOWS.filter((window) => window.page !== null);

	it('drops turns from some fixture in every window, and reaches back past them in a rewind', () => {
		for (const { page } of HELD) {
			expect(CLAUDE.some((c) => earlierTurnCount(fold(claudeParser, c.lines, page)) > 0)).toBe(true);
		}
		// A rewind past what one turn holds: the rewind fixture still drops what it left behind.
		const rewind = CLAUDE.find((c) => c.name === 'rewind-fork.jsonl');
		expect(rewind).toBeDefined();
		const all = fold(claudeParser, rewind?.lines ?? []);
		const one = fold(claudeParser, rewind?.lines ?? [], { turns: 1, bytes: Infinity });
		expect([...(one.window?.earlier ?? []), ...one.turns.map((turn) => turn.id)]).toEqual(
			all.turns.map((turn) => turn.id),
		);
	});

	it.each(CLAUDE.flatMap((c) => HELD.map((window) => [`${c.name}, held: ${window.name},`, c, window.page] as const)))(
		'%s holds the newest turns of the whole read, exactly, and more of them a page later',
		(_name, { lines }, page) => {
			const all = fold(claudeParser, lines);
			const allIds = all.turns.map((turn) => turn.id);
			let held = 0;
			for (let pages = 1; pages <= 3; pages++) {
				const state = fold(claudeParser, lines, page, pages);
				const earlier = state.window?.earlier ?? [];
				// Not held and held are the session's turns, in order.
				expect([...earlier, ...state.turns.map((turn) => turn.id)]).toEqual(allIds);
				// What is held is what the whole read says of those turns.
				expect(state.turns).toEqual(all.turns.slice(earlier.length));
				expect(state.turns.length).toBeGreaterThanOrEqual(Math.min(1, allIds.length));
				expect(state.turns.length).toBeGreaterThanOrEqual(held);
				held = state.turns.length;
			}
		},
	);

	it.each(CASES.flatMap((c) => HELD.map((window) => [`${c.name}, held: ${window.name},`, c, window.page] as const)))(
		'%s previews without dropping a turn, and the line then drops the same',
		(_name, { parser, lines }, page) => {
			const state = start(parser, page);
			for (let at = 0; at < lines.length; at++) {
				const line = lines[at] as string;
				const kept = structuredClone(state);
				const preview = previewTail(parser, state, line);
				expect(state, `line ${at}`).toEqual(kept);
				const folded = parser.reduce(state, [line]);
				if (!preview) continue;
				// The preview holds what folding holds, and the turns folding let go before it.
				const ids = preview.state.turns.map((turn) => turn.id);
				expect(ids.slice(ids.length - folded.state.turns.length), `line ${at}`).toEqual(
					folded.state.turns.map((turn) => turn.id),
				);
				expect(preview.state.turns.slice(ids.length - folded.state.turns.length), `line ${at}`).toEqual(
					folded.state.turns,
				);
			}
		},
	);
});
