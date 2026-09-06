import { describe, expect, it } from 'vitest';

import {
	DEFAULT_KEY_ENCODING_OPTIONS,
	LEGACY_LINE_BREAK,
	encodeKey,
	encodeKittyKey,
	kittyActive,
	kittyKeyCode,
	kittyModifiers,
	IME_PROCESSING_KEY_CODE,
	isComposingKey,
	type KeyEventLike,
} from '../../src/views/input/keyEncoder';
import {
	DEFAULT_MODE_STATE,
	KITTY_DISAMBIGUATE,
	type TerminalModeState,
} from '../../src/views/input/modeTracker';

function key(overrides: Partial<KeyEventLike> & { key: string }): KeyEventLike {
	return {
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...overrides,
	};
}

const kittyState: TerminalModeState = { ...DEFAULT_MODE_STATE, kittyFlags: KITTY_DISAMBIGUATE };

describe('kittyModifiers', () => {
	it('is 1 for an unmodified key', () => {
		expect(kittyModifiers(key({ key: 'a' }))).toBe(1);
	});

	it('is the bitfield plus one', () => {
		expect(kittyModifiers(key({ key: 'Enter', shiftKey: true }))).toBe(2);
		expect(kittyModifiers(key({ key: 'Enter', altKey: true }))).toBe(3);
		expect(kittyModifiers(key({ key: 'Enter', ctrlKey: true }))).toBe(5);
		expect(kittyModifiers(key({ key: 'Enter', metaKey: true }))).toBe(9);
		expect(kittyModifiers(key({ key: 'a', shiftKey: true, ctrlKey: true }))).toBe(6);
	});
});

describe('kittyKeyCode', () => {
	it('maps the functional keys that keep a codepoint', () => {
		expect(kittyKeyCode('Enter')).toBe(13);
		expect(kittyKeyCode('Tab')).toBe(9);
		expect(kittyKeyCode('Backspace')).toBe(127);
		expect(kittyKeyCode('Escape')).toBe(27);
		expect(kittyKeyCode(' ')).toBe(32);
	});

	it('reports a printable key unshifted', () => {
		expect(kittyKeyCode('a')).toBe(97);
		expect(kittyKeyCode('A')).toBe(97);
		expect(kittyKeyCode('ø')).toBe('ø'.codePointAt(0));
	});

	it('leaves keys with their own CSI form to the renderer', () => {
		expect(kittyKeyCode('ArrowUp')).toBeNull();
		expect(kittyKeyCode('F5')).toBeNull();
		expect(kittyKeyCode('Home')).toBeNull();
	});
});

describe('encodeKittyKey', () => {
	it('builds CSI unicode-key-code ; modifiers u', () => {
		expect(encodeKittyKey(key({ key: 'Enter', shiftKey: true }))).toBe('\x1b[13;2u');
		expect(encodeKittyKey(key({ key: 'Tab', shiftKey: true }))).toBe('\x1b[9;2u');
		expect(encodeKittyKey(key({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe('\x1b[99;6u');
	});

	it('leaves an unmodified key to be typed', () => {
		expect(encodeKittyKey(key({ key: 'Enter' }))).toBeNull();
		expect(encodeKittyKey(key({ key: 'a' }))).toBeNull();
	});

	it('is null for a key with no unicode-key-code', () => {
		expect(encodeKittyKey(key({ key: 'ArrowUp', shiftKey: true }))).toBeNull();
	});
});

describe('kittyActive', () => {
	it('follows the disambiguate flag', () => {
		expect(kittyActive(DEFAULT_MODE_STATE)).toBe(false);
		expect(kittyActive(kittyState)).toBe(true);
		expect(kittyActive({ ...DEFAULT_MODE_STATE, kittyFlags: 2 })).toBe(false);
	});
});

describe('encodeKey with the shipped options', () => {
	// This is the acceptance criterion of #17: the layer exists and encodes
	// nothing, so typing goes down the renderer's own path exactly as before.
	const cases: KeyEventLike[] = [
		key({ key: 'a' }),
		key({ key: 'Enter' }),
		key({ key: 'Enter', shiftKey: true }),
		key({ key: 'Enter', altKey: true }),
		key({ key: 'Tab', shiftKey: true }),
		key({ key: 'c', ctrlKey: true }),
		key({ key: 'ArrowUp' }),
	];

	it('returns null for every key', () => {
		for (const event of cases) {
			expect(encodeKey(event, DEFAULT_MODE_STATE), event.key).toBeNull();
			expect(encodeKey(event, kittyState), event.key).toBeNull();
			expect(encodeKey(event, kittyState, DEFAULT_KEY_ENCODING_OPTIONS)).toBeNull();
		}
	});
});

describe('encodeKey once #18 turns shiftEnterLineBreak on', () => {
	const options = { ...DEFAULT_KEY_ENCODING_OPTIONS, shiftEnterLineBreak: true };

	it('sends the legacy line break on a pane with no kitty protocol', () => {
		expect(encodeKey(key({ key: 'Enter', shiftKey: true }), DEFAULT_MODE_STATE, options)).toBe(
			LEGACY_LINE_BREAK,
		);
		expect(encodeKey(key({ key: 'Enter', altKey: true }), DEFAULT_MODE_STATE, options)).toBe(
			LEGACY_LINE_BREAK,
		);
	});

	it('sends CSI 13 ; 2 u when the pane negotiated kitty', () => {
		expect(encodeKey(key({ key: 'Enter', shiftKey: true }), kittyState, options)).toBe(
			'\x1b[13;2u',
		);
	});

	it('leaves plain enter alone so it still submits', () => {
		expect(encodeKey(key({ key: 'Enter' }), DEFAULT_MODE_STATE, options)).toBeNull();
		expect(encodeKey(key({ key: 'Enter' }), kittyState, options)).toBeNull();
	});

	it('leaves ctrl+enter and cmd+enter to the harness', () => {
		expect(encodeKey(key({ key: 'Enter', ctrlKey: true }), DEFAULT_MODE_STATE, options)).toBeNull();
		expect(encodeKey(key({ key: 'Enter', metaKey: true }), DEFAULT_MODE_STATE, options)).toBeNull();
	});

	it('touches no other key', () => {
		expect(encodeKey(key({ key: 'a', shiftKey: true }), kittyState, options)).toBeNull();
		expect(encodeKey(key({ key: 'Tab', shiftKey: true }), kittyState, options)).toBeNull();
	});
});

describe('encodeKey with kittyModifiedKeys on', () => {
	const options = { ...DEFAULT_KEY_ENCODING_OPTIONS, kittyModifiedKeys: true };

	it('encodes modified keys only when the pane negotiated kitty', () => {
		expect(encodeKey(key({ key: 'Tab', shiftKey: true }), kittyState, options)).toBe('\x1b[9;2u');
		expect(encodeKey(key({ key: 'Tab', shiftKey: true }), DEFAULT_MODE_STATE, options)).toBeNull();
	});

	it('still leaves unmodified keys to be typed', () => {
		expect(encodeKey(key({ key: 'a' }), kittyState, options)).toBeNull();
	});
});

describe('IME composition guard (#49)', () => {
	const lineBreak = { ...DEFAULT_KEY_ENCODING_OPTIONS, shiftEnterLineBreak: true };

	it('recognises both composing signals', () => {
		expect(isComposingKey(key({ key: 'Enter', isComposing: true }))).toBe(true);
		expect(isComposingKey(key({ key: 'Enter', keyCode: IME_PROCESSING_KEY_CODE }))).toBe(true);
		expect(isComposingKey(key({ key: 'Enter' }))).toBe(false);
		expect(isComposingKey(key({ key: 'Enter', isComposing: false, keyCode: 13 }))).toBe(false);
	});

	it('leaves a composing shift+enter to the input method', () => {
		const composing = key({ key: 'Enter', shiftKey: true, isComposing: true });
		expect(encodeKey(composing, DEFAULT_MODE_STATE, lineBreak)).toBeNull();
		const legacy = key({ key: 'Enter', shiftKey: true, keyCode: IME_PROCESSING_KEY_CODE });
		expect(encodeKey(legacy, DEFAULT_MODE_STATE, lineBreak)).toBeNull();
	});

	it('leaves a composing key alone under the kitty rule too', () => {
		const kitty = { ...DEFAULT_KEY_ENCODING_OPTIONS, kittyModifiedKeys: true };
		const composing = key({ key: 'Tab', shiftKey: true, isComposing: true });
		expect(encodeKey(composing, kittyState, kitty)).toBeNull();
	});

	it('still encodes shift+enter once the composition is over', () => {
		const done = key({ key: 'Enter', shiftKey: true, isComposing: false });
		expect(encodeKey(done, DEFAULT_MODE_STATE, lineBreak)).toBe(LEGACY_LINE_BREAK);
	});
});
