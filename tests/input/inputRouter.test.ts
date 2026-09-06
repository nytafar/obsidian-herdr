import { describe, expect, it } from 'vitest';

import { InputRouter, type WheelToScroll } from '../../src/views/input/inputRouter';
import { DEFAULT_MODE_STATE } from '../../src/views/input/modeTracker';
import { LEGACY_LINE_BREAK } from '../../src/views/input/keyEncoder';

const encoder = new TextEncoder();

/** The same maths `wheelToScroll` in terminalView.ts does, minus the clamping. */
const wheelToScroll: WheelToScroll = (deltaY, deltaMode, rows) => {
	if (deltaY === 0) return null;
	const page = Math.max(1, rows);
	const magnitude = Math.abs(deltaY);
	const raw = deltaMode === 2 ? magnitude * page : deltaMode === 1 ? magnitude : magnitude / 24;
	return { direction: deltaY < 0 ? 'up' : 'down', lines: Math.max(1, Math.round(raw)) };
};

function router(options?: ConstructorParameters<typeof InputRouter>[1]): InputRouter {
	return new InputRouter({ wheelToScroll }, options);
}

function feed(instance: InputRouter, text: string, seq?: number): void {
	instance.observeFrame(encoder.encode(text), seq);
}

const keyEvent = {
	key: 'Enter',
	shiftKey: true,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
};

describe('mode observation', () => {
	it('starts in the defaults', () => {
		expect(router().modes).toEqual(DEFAULT_MODE_STATE);
		expect(router().mouseReporting).toBe(false);
	});

	it('picks up modes from frame bytes', () => {
		const instance = router();
		feed(instance, '\x1b[?1002h\x1b[?1006h');
		expect(instance.mouseReporting).toBe(true);
		expect(instance.modes.mouseEncoding).toBe('sgr');
	});

	it('resets on the first frame of a new bridge process', () => {
		const instance = router();
		feed(instance, '\x1b[?1002h\x1b[?1006h', 7);
		expect(instance.mouseReporting).toBe(true);
		feed(instance, 'first frame of the next attach', 1);
		expect(instance.modes).toEqual(DEFAULT_MODE_STATE);
	});

	it('does not reset on a later frame', () => {
		const instance = router();
		feed(instance, '\x1b[?1002h', 4);
		feed(instance, 'more output', 5);
		expect(instance.mouseReporting).toBe(true);
	});

	it('resets on demand', () => {
		const instance = router();
		feed(instance, '\x1b[?1003h');
		instance.reset();
		expect(instance.modes).toEqual(DEFAULT_MODE_STATE);
	});
});

describe('routeKey', () => {
	it('encodes nothing with the shipped options (#17)', () => {
		const instance = router();
		feed(instance, '\x1b[>1u');
		expect(instance.routeKey(keyEvent)).toBeNull();
	});

	it('honours the options #18 will pass', () => {
		const instance = router({ key: { shiftEnterLineBreak: true, kittyModifiedKeys: false } });
		expect(instance.routeKey(keyEvent)).toBe(LEGACY_LINE_BREAK);
		expect(instance.routeKey({ ...keyEvent, shiftKey: false })).toBeNull();
	});
});

describe('routeWheel', () => {
	it('routes to terminal.scroll for a pane with no mouse reporting', () => {
		expect(router().routeWheel({ deltaY: 120, deltaMode: 0, rows: 24 })).toEqual({
			kind: 'scroll',
			direction: 'down',
			lines: 5,
			source: 'wheel',
		});
		expect(router().routeWheel({ deltaY: -48, deltaMode: 0, rows: 24 })).toEqual({
			kind: 'scroll',
			direction: 'up',
			lines: 2,
			source: 'wheel',
		});
	});

	it('is null for a delta that rounds to nothing', () => {
		expect(router().routeWheel({ deltaY: 0, deltaMode: 0, rows: 24 })).toBeNull();
	});

	it('still scrolls a mouse-reporting pane when no cell position is known', () => {
		const instance = router();
		feed(instance, '\x1b[?1002h\x1b[?1006h');
		expect(instance.routeWheel({ deltaY: 24, deltaMode: 0, rows: 24 })).toEqual({
			kind: 'scroll',
			direction: 'down',
			lines: 1,
			source: 'wheel',
		});
	});

	it('reports the wheel to a mouse-reporting pane once #25 supplies the cell', () => {
		const instance = router();
		feed(instance, '\x1b[?1002h\x1b[?1006h');
		expect(
			instance.routeWheel({
				deltaY: -100,
				deltaMode: 0,
				rows: 24,
				position: { column: 10, row: 4 },
				ctrlKey: true,
			}),
		).toEqual({ kind: 'input', data: '\x1b[<80;11;5M' });
	});

	it('keeps scrolling a pane that never asked for the mouse', () => {
		const instance = router();
		feed(instance, '\x1b[?1006h');
		expect(
			instance.routeWheel({ deltaY: 24, deltaMode: 0, rows: 24, position: { column: 0, row: 0 } }),
		).toMatchObject({ kind: 'scroll' });
	});
});

describe('routeMouseButton', () => {
	it('is null while the pane wants no reports, so selection keeps working', () => {
		expect(
			router().routeMouseButton({ button: 'left', position: { column: 0, row: 0 } }),
		).toBeNull();
	});

	it('builds a press and a release for a mouse-reporting pane', () => {
		const instance = router();
		feed(instance, '\x1b[?1000h\x1b[?1006h');
		expect(instance.routeMouseButton({ button: 'left', position: { column: 3, row: 1 } })).toBe(
			'\x1b[<0;4;2M',
		);
		expect(
			instance.routeMouseButton({
				button: 'left',
				position: { column: 3, row: 1 },
				release: true,
			}),
		).toBe('\x1b[<0;4;2m');
	});
});
