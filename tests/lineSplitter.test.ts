import { describe, expect, it } from 'vitest';

import { LineSplitter } from '../src/herdr/lineSplitter';

function overflowSizes(splitter: LineSplitter, chunk: Buffer): { lines: string[]; overflows: number[] } {
	const overflows: number[] = [];
	const lines = splitter.push(chunk, (bytes) => overflows.push(bytes));
	return { lines, overflows };
}

describe('LineSplitter', () => {
	it('accepts a line exactly at the budget', () => {
		const splitter = new LineSplitter(16);
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${'x'.repeat(16)}\n`));
		expect(lines).toEqual(['x'.repeat(16)]);
		expect(overflows).toEqual([]);
	});

	it('rejects a complete line one byte over the budget', () => {
		const splitter = new LineSplitter(16);
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${'x'.repeat(17)}\n`));
		expect(lines).toEqual([]);
		expect(overflows).toEqual([17]);
	});

	it('rejects an oversized line delivered as a single whole chunk', () => {
		const splitter = new LineSplitter(16);
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${'x'.repeat(100)}\n`));
		expect(lines).toEqual([]);
		expect(overflows).toEqual([100]);
	});

	it('rejects a buffered prefix plus an oversized completing chunk', () => {
		const splitter = new LineSplitter(16);
		const first = overflowSizes(splitter, Buffer.from('x'.repeat(15)));
		expect(first.lines).toEqual([]);
		expect(first.overflows).toEqual([]);

		const second = overflowSizes(splitter, Buffer.from(`${'x'.repeat(100)}\n`));
		expect(second.lines).toEqual([]);
		expect(second.overflows).toEqual([115]);
	});

	it('accounts multibyte UTF-8 bytes, not string length, against the budget', () => {
		// Each snowman is 3 bytes in UTF-8; 6 of them is 18 bytes, over a 16 byte budget,
		// even though the JS string length is only 6 code units.
		const splitter = new LineSplitter(16);
		const snowmen = '☃'.repeat(6);
		expect(Buffer.byteLength(snowmen)).toBe(18);
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${snowmen}\n`));
		expect(lines).toEqual([]);
		expect(overflows).toEqual([18]);
	});

	it('accepts a multibyte line that fits the budget', () => {
		const splitter = new LineSplitter(16);
		const snowmen = '☃'.repeat(5); // 15 bytes
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${snowmen}\n`));
		expect(lines).toEqual([snowmen]);
		expect(overflows).toEqual([]);
	});

	it('resynchronises on the next newline after an oversized record, across pushes', () => {
		const splitter = new LineSplitter(16);
		const first = overflowSizes(splitter, Buffer.from('x'.repeat(17)));
		expect(first.lines).toEqual([]);
		expect(first.overflows).toEqual([17]);

		// The rest of the oversized record's payload (no newline yet) must not
		// surface as a record of its own once a newline finally appears.
		const second = overflowSizes(splitter, Buffer.from('suffix\nok\n'));
		expect(second.lines).toEqual(['ok']);
		expect(second.overflows).toEqual([]);
	});

	it('resynchronises within a single chunk that contains both the oversized record and a valid one', () => {
		const splitter = new LineSplitter(16);
		const { lines, overflows } = overflowSizes(splitter, Buffer.from(`${'x'.repeat(100)}\nok\n`));
		expect(lines).toEqual(['ok']);
		expect(overflows).toEqual([100]);
	});

	it('does not throw; oversized records are reported only via the callback', () => {
		const splitter = new LineSplitter(16);
		expect(() => splitter.push(Buffer.from(`${'x'.repeat(100)}\n`))).not.toThrow();
	});

	it('handles a normal split across chunks with no newline in the first', () => {
		const splitter = new LineSplitter(1024);
		const first = overflowSizes(splitter, Buffer.from('hello '));
		expect(first.lines).toEqual([]);
		const second = overflowSizes(splitter, Buffer.from('world\n'));
		expect(second.lines).toEqual(['hello world']);
	});

	it('strips a trailing carriage return', () => {
		const splitter = new LineSplitter(1024);
		const { lines } = overflowSizes(splitter, Buffer.from('hi\r\n'));
		expect(lines).toEqual(['hi']);
	});

	it('flush returns nothing when the buffer is empty', () => {
		const splitter = new LineSplitter(1024);
		expect(splitter.flush()).toBeNull();
	});

	it('flush returns the buffered tail once the stream ends', () => {
		const splitter = new LineSplitter(1024);
		splitter.push(Buffer.from('trailing'));
		expect(splitter.flush()).toBe('trailing');
	});

	it('flush returns nothing while mid-discard of a rejected record', () => {
		const splitter = new LineSplitter(16);
		splitter.push(Buffer.from('x'.repeat(17)), () => {});
		expect(splitter.flush()).toBeNull();
	});

	it('reset clears buffered state and any discard state', () => {
		const splitter = new LineSplitter(16);
		splitter.push(Buffer.from('x'.repeat(17)), () => {});
		splitter.reset();
		const { lines, overflows } = overflowSizes(splitter, Buffer.from('ok\n'));
		expect(lines).toEqual(['ok']);
		expect(overflows).toEqual([]);
	});

	it('handles multiple complete lines in one chunk', () => {
		const splitter = new LineSplitter(1024);
		const { lines } = overflowSizes(splitter, Buffer.from('a\nb\nc\n'));
		expect(lines).toEqual(['a', 'b', 'c']);
	});
});
