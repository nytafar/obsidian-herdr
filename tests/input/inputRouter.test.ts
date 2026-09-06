import { describe, expect, it } from 'vitest';

import { InputRouter, type WheelToScroll } from '../../src/views/input/inputRouter';
import {
	HERDR_MOD_ALT,
	HERDR_MOD_CTRL,
	HERDR_MOD_SHIFT,
	HERDR_MOD_SUPER,
} from '../../src/views/input/mouseEncoder';
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
	it('sends shift+enter as the legacy line break with the shipped options (#18)', () => {
		expect(router().routeKey(keyEvent)).toBe(LEGACY_LINE_BREAK);
	});

	it('sends alt+enter the same way, and leaves plain enter to the renderer', () => {
		const instance = router();
		expect(instance.routeKey({ ...keyEvent, shiftKey: false, altKey: true })).toBe(
			LEGACY_LINE_BREAK,
		);
		expect(instance.routeKey({ ...keyEvent, shiftKey: false })).toBeNull();
	});

	it('leaves ctrl+enter, cmd+enter and ordinary typing to the renderer', () => {
		const instance = router();
		expect(instance.routeKey({ ...keyEvent, shiftKey: false, ctrlKey: true })).toBeNull();
		expect(instance.routeKey({ ...keyEvent, shiftKey: false, metaKey: true })).toBeNull();
		expect(instance.routeKey({ ...keyEvent, key: 'a' })).toBeNull();
	});

	it('prefers the kitty encoding if a pane ever reports the protocol', () => {
		const instance = router();
		feed(instance, '\x1b[>1u');
		expect(instance.routeKey(keyEvent)).toBe('\x1b[13;2u');
	});

	it('can be switched off, and then encodes nothing at all', () => {
		const instance = router({ key: { shiftEnterLineBreak: false, kittyModifiedKeys: false } });
		feed(instance, '\x1b[>1u');
		expect(instance.routeKey(keyEvent)).toBeNull();
		expect(instance.routeKey({ ...keyEvent, shiftKey: false, altKey: true })).toBeNull();
	});
});

describe('routeWheel', () => {
	it('always asks for terminal.scroll: herdr owns the report/scroll fork', () => {
		expect(router().routeWheel({ deltaY: 120, deltaMode: 0, rows: 24 })).toEqual({
			kind: 'scroll',
			direction: 'down',
			lines: 5,
			source: 'wheel',
			modifiers: 0,
		});
		expect(router().routeWheel({ deltaY: -48, deltaMode: 0, rows: 24 })).toEqual({
			kind: 'scroll',
			direction: 'up',
			lines: 2,
			source: 'wheel',
			modifiers: 0,
		});
	});

	it('is null for a delta that rounds to nothing', () => {
		expect(router().routeWheel({ deltaY: 0, deltaMode: 0, rows: 24 })).toBeNull();
	});

	it('carries the cell under the pointer, so the report does not land on (0, 0)', () => {
		expect(
			router().routeWheel({
				deltaY: 24,
				deltaMode: 0,
				rows: 24,
				position: { column: 10, row: 4 },
			}),
		).toEqual({
			kind: 'scroll',
			direction: 'down',
			lines: 1,
			source: 'wheel',
			column: 10,
			row: 4,
			modifiers: 0,
		});
	});

	it('carries herdr modifier bits, not xterm ones', () => {
		const withMods = (mods: Partial<Parameters<InputRouter['routeWheel']>[0]>): number =>
			router().routeWheel({ deltaY: 24, deltaMode: 0, rows: 24, ...mods })?.modifiers ?? -1;
		expect(withMods({ shiftKey: true })).toBe(HERDR_MOD_SHIFT);
		expect(withMods({ ctrlKey: true })).toBe(HERDR_MOD_CTRL);
		expect(withMods({ altKey: true })).toBe(HERDR_MOD_ALT);
		expect(withMods({ metaKey: true })).toBe(HERDR_MOD_SUPER);
		expect(withMods({ ctrlKey: true, shiftKey: true })).toBe(HERDR_MOD_CTRL | HERDR_MOD_SHIFT);
	});

	it('does not encode a report itself, even for a pane seen enabling the mouse', () => {
		// herdr's apply_scroll would then send a second report for the same notch.
		const instance = router();
		feed(instance, '\x1b[?1002h\x1b[?1006h');
		expect(instance.mouseReporting).toBe(true);
		expect(
			instance.routeWheel({
				deltaY: -100,
				deltaMode: 0,
				rows: 24,
				position: { column: 10, row: 4 },
				ctrlKey: true,
			}),
		).toEqual({
			kind: 'scroll',
			direction: 'up',
			lines: 4,
			source: 'wheel',
			column: 10,
			row: 4,
			modifiers: HERDR_MOD_CTRL,
		});
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

describe('InputRouter composition flag (#49)', () => {
	const shiftEnter = {
		key: 'Enter',
		shiftKey: true,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
	};

	it('starts not composing', () => {
		expect(router().isComposing).toBe(false);
	});

	it('routes nothing while the element reports a composition', () => {
		const instance = router();
		expect(instance.routeKey(shiftEnter)).toBe(LEGACY_LINE_BREAK);
		instance.setComposing(true);
		expect(instance.isComposing).toBe(true);
		expect(instance.routeKey(shiftEnter)).toBeNull();
		expect(instance.routeKey({ ...shiftEnter, shiftKey: false })).toBeNull();
		instance.setComposing(false);
		expect(instance.routeKey(shiftEnter)).toBe(LEGACY_LINE_BREAK);
	});

	it('honours the event flags even when nothing told it (ghostty-web)', () => {
		const instance = router();
		expect(instance.routeKey({ ...shiftEnter, isComposing: true })).toBeNull();
		expect(instance.routeKey({ ...shiftEnter, keyCode: 229 })).toBeNull();
	});
});
