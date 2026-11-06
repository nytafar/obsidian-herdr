/**
 * When a turn was prompted and how long the agent worked on it, as the turn
 * shows them (issue #139, finding `prior-art-chat-client` §4.13, §4.14).
 *
 * A time is labelled by calendar day, not by a 24-hour window: today's is
 * the time alone, yesterday's says so, an older one carries its date, and the
 * year only once it is not this year's. The full date and time is for the
 * hover. A duration is short ("7s", "1m 12s", "2h 5m"), for a narrow sidebar.
 *
 * Pure: `now` and the locale are the caller's, so a test pins both.
 */

/** A time as a turn shows it. */
export interface TurnTime {
	/** What is shown: "14:02", "Yesterday, 14:02", "6 Nov, 14:02". */
	label: string;
	/** The full date and time, for the hover. */
	full: string;
	/** The ISO timestamp, for a `<time datetime>`. */
	iso: string;
}

const DAY_MS = 86_400_000;

/** The local midnight that starts `date`'s day. */
function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A record's timestamp labelled for a turn, or null when it is missing or unreadable. */
export function turnTime(ts: string | undefined, now: number, locale?: string): TurnTime | null {
	if (!ts) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
	const full = date.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'medium' });
	const today = new Date(now);
	// Rounded, so a day of 23 or 25 hours across a clock change is still one day.
	const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS);
	let label: string;
	if (days <= 0) label = time;
	else if (days === 1) label = `Yesterday, ${time}`;
	else {
		const day = date.toLocaleDateString(
			locale,
			date.getFullYear() === today.getFullYear()
				? { day: 'numeric', month: 'short' }
				: { day: 'numeric', month: 'short', year: 'numeric' },
		);
		label = `${day}, ${time}`;
	}
	return { label, full, iso: date.toISOString() };
}

/** How long from `start` to `end`, "7s" to "2h 5m"; null when either is unknown or the span is not one. */
export function workDuration(start: string | undefined, end: string | undefined): string | null {
	if (!start || !end) return null;
	const ms = Date.parse(end) - Date.parse(start);
	if (!Number.isFinite(ms) || ms < 0) return null;
	const seconds = Math.round(ms / 1000);
	if (seconds === 0) return '<1s';
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** What a stretch of work shows: when it started, and how long it took once it is over. */
export interface WorkSpan {
	time: TurnTime;
	/** "7s", or null while it runs or when its end is unknown. */
	duration: string | null;
	/** The full date and time it ended, for the duration's hover; '' with no duration. */
	endFull: string;
}

/**
 * The span from `start` to `end` as a turn shows it, or null when `start` is
 * unknown. `settled` says the work is over: a running one shows its start alone.
 */
export function workSpan(
	start: string | undefined,
	end: string | undefined,
	settled: boolean,
	now: number,
	locale?: string,
): WorkSpan | null {
	const time = turnTime(start, now, locale);
	if (!time) return null;
	const duration = settled ? workDuration(start, end) : null;
	const endFull = duration ? (turnTime(end, now, locale)?.full ?? '') : '';
	return { time, duration, endFull };
}
