/**
 * The prompt-cache badge (issue #23), and the one question the scope asks about
 * it: did the *displayed* badge change?
 *
 * It lives here, next to the scope, rather than in `views/rowModel.ts` where the
 * rest of the row model lives, because both sides need it and the dependency
 * only goes one way: `rowModel.ts` imports `herdr/scope.ts`, so the scope may
 * not import the row model back. This module imports nothing at all.
 *
 * Why the scope cares: a herdr plugin republishes the pane's token map about
 * once a second, and `cache_sort` is a seconds counter, so a plain map
 * comparison calls every idle pane "changed" every second and the sidebar
 * rebuilds its whole list at 1 Hz — the churn PRD N4 exists to stop. The badge
 * itself only ever says minutes, so {@link sameCacheBadge} moves at most once a
 * minute.
 */

/** How a badge is coloured: green while there is time, amber, then red. */
export type BadgeTone = 'ok' | 'warn' | 'crit';

/** One short marker at the end of a row's first line. */
export interface RowBadge {
	text: string;
	tone: BadgeTone;
}

/** Token key → badge tone, in the order a row prefers them (issue #23). */
const CACHE_TOKENS: readonly (readonly [key: string, tone: BadgeTone])[] = [
	['cache_crit', 'crit'],
	['cache_warn', 'warn'],
	['cache_ok', 'ok'],
];

/**
 * The prompt-cache countdown as a badge, or null (issue #23). A herdr plugin
 * publishes exactly one of `cache_ok` / `cache_warn` / `cache_crit` into the
 * pane's token map with a label such as `8m`; the key carries the tone.
 *
 * An expired cache reports `cache_crit: "0m"`, and nearly every idle pane sits
 * expired, so a wall of red zeros would be pure noise: only a counting cache
 * gets a badge. Panes with no cache tokens — any harness the plugin does not
 * track — get none either, and the plugin's other keys (`cache_sort`) are not
 * for display.
 */
export function cacheBadge(tokens: Readonly<Record<string, string>>): RowBadge | null {
	for (const [key, tone] of CACHE_TOKENS) {
		const text = tokens[key]?.trim();
		if (!text) continue;
		// "0m" is expired, not "zero minutes left to show". Any all-zero label
		// counts, so a plugin that says "0s" or "0h 0m" is silent too.
		const digits = text.replace(/\D/g, '');
		if (digits.length > 0 && !/[1-9]/.test(digits)) return null;
		return { text, tone };
	}
	return null;
}

/**
 * True when two token maps produce the same badge — the same text and the same
 * tone, or none on both sides. Everything else in the map is deliberately
 * ignored: it is either not displayed (`cache_sort`) or not read at all.
 */
export function sameCacheBadge(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): boolean {
	const left = cacheBadge(a);
	const right = cacheBadge(b);
	if (left === null || right === null) return left === right;
	return left.text === right.text && left.tone === right.tone;
}
