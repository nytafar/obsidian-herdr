/**
 * Prompt times and turn durations (#139): labelled by calendar day, short
 * enough for a narrow sidebar, the full date and time for the hover.
 */

import { describe, expect, it } from 'vitest';
import { turnTime, workDuration, workSpan } from '../src/native/turnTime';

/** Noon on 6 November 2026, local time. */
const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();

function local(year: number, month: number, day: number, hour: number, minute: number): string {
	return new Date(year, month - 1, day, hour, minute, 7).toISOString();
}

describe('turnTime', () => {
	it('shows the time alone today, says yesterday, and dates anything older', () => {
		expect(turnTime(local(2026, 11, 6, 9, 5), NOW, 'en-GB')?.label).toBe('09:05');
		expect(turnTime(local(2026, 11, 5, 23, 59), NOW, 'en-GB')?.label).toBe('Yesterday, 23:59');
		expect(turnTime(local(2026, 11, 2, 14, 30), NOW, 'en-GB')?.label).toBe('2 Nov, 14:30');
		expect(turnTime(local(2025, 12, 31, 8, 0), NOW, 'en-GB')?.label).toBe('31 Dec 2025, 08:00');
	});

	it('goes by the calendar day, not the last 24 hours', () => {
		// Ten minutes before midnight yesterday is yesterday, though under a day ago.
		const late = new Date(2026, 10, 6, 0, 5).getTime();
		expect(turnTime(local(2026, 11, 5, 23, 55), late, 'en-GB')?.label).toBe('Yesterday, 23:55');
	});

	it('gives the full date and time for the hover, and the instant for a <time>', () => {
		const ts = local(2026, 11, 6, 9, 5);
		const time = turnTime(ts, NOW, 'en-GB');
		expect(time?.full).toContain('Friday');
		expect(time?.full).toContain('2026');
		expect(time?.full).toContain('09:05:07');
		expect(time?.iso).toBe(ts);
	});

	it('is nothing for a missing or unreadable timestamp', () => {
		expect(turnTime(undefined, NOW)).toBeNull();
		expect(turnTime('', NOW)).toBeNull();
		expect(turnTime('not a time', NOW)).toBeNull();
	});
});

describe('workDuration', () => {
	const at = (seconds: number): string => new Date(Date.UTC(2026, 10, 6, 9, 0, 0) + seconds * 1000).toISOString();

	it('says seconds, minutes and hours the short way', () => {
		const start = at(0);
		expect(workDuration(start, at(0.4))).toBe('<1s');
		expect(workDuration(start, at(7))).toBe('7s');
		expect(workDuration(start, at(72))).toBe('1m 12s');
		expect(workDuration(start, at(120))).toBe('2m');
		expect(workDuration(start, at(3 * 3600 + 5 * 60 + 9))).toBe('3h 5m');
		expect(workDuration(start, at(7200))).toBe('2h');
	});

	it('is nothing when either end is unknown or the span runs backwards', () => {
		expect(workDuration(undefined, at(5))).toBeNull();
		expect(workDuration(at(5), undefined)).toBeNull();
		expect(workDuration(at(5), at(1))).toBeNull();
		expect(workDuration(at(0), 'later')).toBeNull();
	});
});

describe('workSpan', () => {
	it('shows a duration only once the work is over', () => {
		const start = local(2026, 11, 6, 9, 5);
		const end = new Date(Date.parse(start) + 7000).toISOString();
		expect(workSpan(start, end, true, NOW, 'en-GB')).toMatchObject({ duration: '7s' });
		expect(workSpan(start, end, true, NOW, 'en-GB')?.endFull).toContain('09:05:14');
		expect(workSpan(start, end, false, NOW, 'en-GB')).toMatchObject({ duration: null, endFull: '' });
		expect(workSpan(undefined, end, true, NOW)).toBeNull();
	});
});
