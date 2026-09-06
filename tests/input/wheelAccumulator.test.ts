import { describe, expect, it } from 'vitest';

import {
	MAX_SCROLL_LINES,
	MOUSE_NOTCH_PIXELS,
	MOUSE_SCROLL_LINES,
	WHEEL_PIXELS_PER_LINE,
	WHEEL_QUIET_GAP_MS,
	WheelAccumulator,
} from '../../src/views/input/wheelAccumulator';

/** A fake clock, so the quiet-gap reset is tested without timers (#65). */
function clock(): { now: () => number; advance: (ms: number) => void } {
	let t = 1000;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

function accumulator(options: Partial<ConstructorParameters<typeof WheelAccumulator>[0]> = {}): {
	wheel: WheelAccumulator;
	advance: (ms: number) => void;
} {
	const time = clock();
	return { wheel: new WheelAccumulator({ now: time.now, ...options }), advance: time.advance };
}

describe('WheelAccumulator pixel mode', () => {
	it('carries a fraction instead of scrolling a line per event', () => {
		const { wheel } = accumulator({ pixelsPerLine: 20 });
		expect(wheel.push(5, 0, 24)).toBeNull();
		expect(wheel.push(5, 0, 24)).toBeNull();
		expect(wheel.push(5, 0, 24)).toBeNull();
		// 20 px of a 20 px line: exactly one line, and nothing before it.
		expect(wheel.push(5, 0, 24)).toEqual({ direction: 'down', lines: 1 });
	});

	it('keeps the remainder for the next events of the same drag', () => {
		const { wheel } = accumulator({ pixelsPerLine: 10 });
		expect(wheel.push(-14, 0, 24)).toEqual({ direction: 'up', lines: 1 });
		wheel.take();
		// 0.4 carried, so 7 px is enough for the next line.
		expect(wheel.push(-7, 0, 24)).toEqual({ direction: 'up', lines: 1 });
	});

	it('drops the carry when the direction flips', () => {
		const { wheel } = accumulator({ pixelsPerLine: 10 });
		expect(wheel.push(9, 0, 24)).toBeNull();
		// Without the reset the leftover 0.9 would make this reversal jump a line.
		expect(wheel.push(-9, 0, 24)).toBeNull();
		expect(wheel.push(-1, 0, 24)).toEqual({ direction: 'up', lines: 1 });
	});

	it('drops the carry after a quiet gap', () => {
		const { wheel, advance } = accumulator({ pixelsPerLine: 10 });
		expect(wheel.push(9, 0, 24)).toBeNull();
		advance(WHEEL_QUIET_GAP_MS);
		expect(wheel.push(9, 0, 24)).toBeNull();
		// A gesture shorter than the gap keeps accumulating.
		advance(WHEEL_QUIET_GAP_MS - 1);
		expect(wheel.push(1, 0, 24)).toEqual({ direction: 'down', lines: 1 });
	});

	it('uses the renderer cell height once it is measured', () => {
		const { wheel } = accumulator();
		expect(wheel.pixelsPerLine).toBe(WHEEL_PIXELS_PER_LINE);
		wheel.setPixelsPerLine(0);
		wheel.setPixelsPerLine(Number.NaN);
		expect(wheel.pixelsPerLine).toBe(WHEEL_PIXELS_PER_LINE);
		wheel.setPixelsPerLine(16);
		expect(wheel.pixelsPerLine).toBe(16);
		expect(wheel.push(16, 0, 24)).toEqual({ direction: 'down', lines: 1 });
	});

	it('scales pixel deltas by the speed multiplier', () => {
		const { wheel } = accumulator({ pixelsPerLine: 20, speed: 2 });
		expect(wheel.push(10, 0, 24)).toEqual({ direction: 'down', lines: 1 });
	});

	it('clamps a fling and forgets its carry', () => {
		const { wheel } = accumulator({ pixelsPerLine: 1 });
		expect(wheel.push(100000, 0, 24)?.lines).toBe(MAX_SCROLL_LINES);
		wheel.take();
		expect(wheel.push(0.5, 0, 24)).toBeNull();
	});

	it('ignores a zero or broken delta', () => {
		const { wheel } = accumulator();
		expect(wheel.push(0, 0, 24)).toBeNull();
		expect(wheel.push(Number.NaN, 0, 24)).toBeNull();
	});
});

describe('WheelAccumulator mouse notch', () => {
	it('moves herdr mouse_scroll_lines per notch', () => {
		const { wheel } = accumulator({ pixelsPerLine: 17 });
		expect(wheel.push(MOUSE_NOTCH_PIXELS, 0, 24)).toEqual({
			direction: 'down',
			lines: MOUSE_SCROLL_LINES,
		});
		wheel.take();
		expect(wheel.push(-MOUSE_NOTCH_PIXELS * 2, 0, 24)).toEqual({
			direction: 'up',
			lines: MOUSE_SCROLL_LINES * 2,
		});
	});
});

describe('WheelAccumulator line and page modes', () => {
	it('passes whole units through unchanged', () => {
		const { wheel } = accumulator();
		expect(wheel.push(-4, 1, 24)?.lines).toBe(4);
		wheel.take();
		expect(wheel.push(2, 2, 30)?.lines).toBe(60);
		wheel.take();
		expect(wheel.push(1, 2, 0)?.lines).toBe(24);
	});
});

describe('WheelAccumulator frame coalescing', () => {
	it('merges everything pushed before the frame takes it', () => {
		const { wheel } = accumulator({ pixelsPerLine: 10 });
		expect(wheel.push(10, 0, 24)?.lines).toBe(1);
		expect(wheel.push(20, 0, 24)?.lines).toBe(3);
		expect(wheel.pending).toEqual({ direction: 'down', lines: 3 });
		expect(wheel.take()).toEqual({ direction: 'down', lines: 3 });
		expect(wheel.take()).toBeNull();
	});

	it('does not merge across a direction flip', () => {
		const { wheel } = accumulator({ pixelsPerLine: 10 });
		expect(wheel.push(10, 0, 24)?.lines).toBe(1);
		expect(wheel.push(-10, 0, 24)).toEqual({ direction: 'up', lines: 1 });
		expect(wheel.pending).toEqual({ direction: 'up', lines: 1 });
	});

	it('caps a merged burst at the maximum', () => {
		const { wheel } = accumulator({ pixelsPerLine: 1, maxLines: 5 });
		wheel.push(4, 0, 24);
		expect(wheel.push(4, 0, 24)?.lines).toBe(5);
	});

	it('reset drops both the carry and the held lines', () => {
		const { wheel } = accumulator({ pixelsPerLine: 10 });
		wheel.push(15, 0, 24);
		wheel.reset();
		expect(wheel.pending).toBeNull();
		expect(wheel.push(5, 0, 24)).toBeNull();
	});
});
