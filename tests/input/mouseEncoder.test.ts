import { describe, expect, it } from 'vitest';

import {
	SGR_BUTTON_WHEEL_DOWN,
	SGR_BUTTON_WHEEL_UP,
	encodeMouseReport,
	encodeSgrMouse,
	encodeSgrWheel,
	encodeWheelReport,
	mouseModifierBits,
	sgrButtonCode,
} from '../../src/views/input/mouseEncoder';
import { DEFAULT_MODE_STATE, type TerminalModeState } from '../../src/views/input/modeTracker';

const reporting: TerminalModeState = {
	...DEFAULT_MODE_STATE,
	mouseTracking: 'button',
	mouseEncoding: 'sgr',
};

describe('mouseModifierBits', () => {
	it('is zero without modifiers', () => {
		expect(mouseModifierBits(undefined)).toBe(0);
		expect(mouseModifierBits({})).toBe(0);
	});

	it('uses xterm bits: shift 4, alt 8, ctrl 16', () => {
		expect(mouseModifierBits({ shiftKey: true })).toBe(4);
		expect(mouseModifierBits({ altKey: true })).toBe(8);
		expect(mouseModifierBits({ ctrlKey: true })).toBe(16);
		expect(mouseModifierBits({ shiftKey: true, ctrlKey: true })).toBe(20);
	});
});

describe('encodeSgrMouse', () => {
	it('makes coordinates 1-based', () => {
		expect(encodeSgrMouse({ button: 0, position: { column: 0, row: 0 } })).toBe('\x1b[<0;1;1M');
		expect(encodeSgrMouse({ button: 0, position: { column: 79, row: 23 } })).toBe(
			'\x1b[<0;80;24M',
		);
	});

	it('ends a release with m', () => {
		expect(encodeSgrMouse({ button: 2, position: { column: 4, row: 2 }, release: true })).toBe(
			'\x1b[<2;5;3m',
		);
	});

	it('ors the modifier bits into the button', () => {
		expect(
			encodeSgrMouse({
				button: sgrButtonCode('middle'),
				position: { column: 1, row: 1 },
				modifiers: { ctrlKey: true },
			}),
		).toBe('\x1b[<17;2;2M');
	});

	it('clamps a coordinate that cannot exist', () => {
		expect(encodeSgrMouse({ button: 0, position: { column: -5, row: Number.NaN } })).toBe(
			'\x1b[<0;1;1M',
		);
	});
});

describe('encodeSgrWheel', () => {
	it('uses button 64 up and 65 down', () => {
		expect(encodeSgrWheel('up', { column: 9, row: 4 })).toBe(
			`\x1b[<${SGR_BUTTON_WHEEL_UP};10;5M`,
		);
		expect(encodeSgrWheel('down', { column: 9, row: 4 })).toBe(
			`\x1b[<${SGR_BUTTON_WHEEL_DOWN};10;5M`,
		);
	});

	it('reports a wheel notch as a press, never a release', () => {
		expect(encodeSgrWheel('down', { column: 0, row: 0 })).toMatch(/M$/);
	});
});

describe('gating on the pane modes', () => {
	it('reports nothing when the application did not ask for the mouse', () => {
		expect(
			encodeMouseReport(DEFAULT_MODE_STATE, { button: 'left', position: { column: 0, row: 0 } }),
		).toBeNull();
		expect(encodeWheelReport(DEFAULT_MODE_STATE, 'up', { column: 0, row: 0 })).toBeNull();
	});

	it('reports nothing in the legacy encoding, which we do not build', () => {
		const legacy: TerminalModeState = { ...reporting, mouseEncoding: 'legacy' };
		expect(
			encodeMouseReport(legacy, { button: 'left', position: { column: 0, row: 0 } }),
		).toBeNull();
		expect(encodeWheelReport(legacy, 'down', { column: 0, row: 0 })).toBeNull();
	});

	it('reports when the pane asked for SGR mouse reporting', () => {
		expect(
			encodeMouseReport(reporting, {
				button: 'right',
				position: { column: 2, row: 3 },
				modifiers: { shiftKey: true },
			}),
		).toBe('\x1b[<6;3;4M');
		expect(encodeWheelReport(reporting, 'up', { column: 2, row: 3 })).toBe('\x1b[<64;3;4M');
	});
});
