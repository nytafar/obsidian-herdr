/**
 * Mouse encoding (#17, unlocks #25). Pure builders for SGR mouse reports:
 * `CSI < <button> ; <column> ; <row> M` for a press or a wheel notch and the
 * same with a trailing `m` for a release. Columns and rows are 1-based on the
 * wire; this module takes 0-based cell coordinates, which is what a renderer
 * hands out.
 *
 * Only the SGR encoding (DEC mode 1006) is built. The X10 encoding it replaced
 * cannot express a column past 223 and has no release button, and every TUI we
 * care about negotiates 1006; `encodeMouseReport` therefore returns null when
 * the pane is in the legacy encoding rather than sending something wrong. #25
 * decides whether that is worth implementing.
 *
 * Nothing here is wired to a click yet — that is #25. `InputRouter.routeWheel`
 * is the one caller, and only for a pane that enabled mouse reporting.
 *
 * Worth knowing before #25 wires clicks: herdr already performs the same fork
 * server-side for the wheel. A `terminal.scroll` with `column`/`row`/`modifiers`
 * is turned into an SGR wheel report by the server when the pane's application
 * has mouse reporting on (`server/pane_input.rs::apply_scroll`), and into a
 * viewport scroll otherwise. So for the wheel there is a choice of who encodes;
 * for clicks there is no server-side path at all and these builders are it.
 */

import { mouseReportingEnabled, type TerminalModeState } from './modeTracker';

/** 0-based cell coordinates, as a renderer reports them. */
export interface CellPosition {
	column: number;
	row: number;
}

export type MouseButton = 'left' | 'middle' | 'right';
export type WheelDirection = 'up' | 'down';

/** SGR button numbers. */
export const SGR_BUTTON_LEFT = 0;
export const SGR_BUTTON_MIDDLE = 1;
export const SGR_BUTTON_RIGHT = 2;
export const SGR_BUTTON_WHEEL_UP = 64;
export const SGR_BUTTON_WHEEL_DOWN = 65;

/** Modifier bits xterm ORs into the button number. */
export const SGR_MOD_SHIFT = 4;
export const SGR_MOD_ALT = 8;
export const SGR_MOD_CTRL = 16;

/**
 * The four modifier flags every DOM key, mouse and wheel event carries, in one
 * shape. Both bitfields below and everything in `inputRouter.ts` speak this;
 * before it, each call site rebuilt the same four optional fields by hand.
 *
 * `metaKey` is Command on macOS, the Windows key elsewhere. Only herdr's
 * bitfield carries it — xterm's has no bit for it.
 */
export interface ModifierKeys {
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

/**
 * The modifiers of a DOM event (or of anything shaped like one), with the flags
 * it does not set read as false. This is the one place a `MouseEvent`, a
 * `KeyboardEvent` or a `WheelEvent` turns into {@link ModifierKeys}.
 */
export function pickModifiers(event: Partial<ModifierKeys>): ModifierKeys {
	return {
		shiftKey: event.shiftKey === true,
		altKey: event.altKey === true,
		ctrlKey: event.ctrlKey === true,
		metaKey: event.metaKey === true,
	};
}

/**
 * herdr's `modifiers` field on `terminal.scroll` is a **crossterm
 * `KeyModifiers`** bitfield, not the xterm one: `apply_scroll` reads it with
 * `KeyModifiers::from_bits_truncate(modifiers)` (`server/pane_input.rs`) before
 * handing it to its own SGR encoder, and crossterm 0.29 numbers the bits
 * SHIFT 1, CONTROL 2, ALT 4, SUPER 8, HYPER 16, META 32 (`crossterm/src/event.rs`).
 *
 * Note how thoroughly this differs from `SGR_MOD_*` below, which are the bits
 * xterm ORs into the button number (shift 4, alt 8, ctrl 16): sending one where
 * the other is expected turns a ctrl+wheel into a shift+wheel. Unknown bits are
 * truncated away by herdr, so anything above SUPER is simply not sent.
 */
export const HERDR_MOD_SHIFT = 1;
export const HERDR_MOD_CTRL = 2;
export const HERDR_MOD_ALT = 4;
export const HERDR_MOD_SUPER = 8;

/** The crossterm bitfield for a DOM event's modifier flags. */
export function herdrModifierBits(modifiers: Partial<ModifierKeys> | undefined): number {
	if (!modifiers) return 0;
	let bits = 0;
	if (modifiers.shiftKey) bits |= HERDR_MOD_SHIFT;
	if (modifiers.ctrlKey) bits |= HERDR_MOD_CTRL;
	if (modifiers.altKey) bits |= HERDR_MOD_ALT;
	if (modifiers.metaKey) bits |= HERDR_MOD_SUPER;
	return bits;
}

export function mouseModifierBits(modifiers: Partial<ModifierKeys> | undefined): number {
	if (!modifiers) return 0;
	let bits = 0;
	if (modifiers.shiftKey) bits |= SGR_MOD_SHIFT;
	if (modifiers.altKey) bits |= SGR_MOD_ALT;
	if (modifiers.ctrlKey) bits |= SGR_MOD_CTRL;
	return bits;
}

export function sgrButtonCode(button: MouseButton): number {
	switch (button) {
		case 'middle':
			return SGR_BUTTON_MIDDLE;
		case 'right':
			return SGR_BUTTON_RIGHT;
		default:
			return SGR_BUTTON_LEFT;
	}
}

export interface SgrReport {
	/** Button number *before* modifier bits are ORed in. */
	button: number;
	position: CellPosition;
	/** A release is the same report with `m` instead of `M`. */
	release?: boolean;
	modifiers?: Partial<ModifierKeys>;
}

/** `CSI < b ; x ; y M|m`, with 1-based coordinates clamped to the grid origin. */
export function encodeSgrMouse(report: SgrReport): string {
	const button = report.button | mouseModifierBits(report.modifiers);
	const column = cellToWire(report.position.column);
	const row = cellToWire(report.position.row);
	return `\x1b[<${button};${column};${row}${report.release ? 'm' : 'M'}`;
}

/** A wheel notch. The wheel has no release, so it is always a press report. */
export function encodeSgrWheel(
	direction: WheelDirection,
	position: CellPosition,
	modifiers?: Partial<ModifierKeys>,
): string {
	return encodeSgrMouse({
		button: direction === 'up' ? SGR_BUTTON_WHEEL_UP : SGR_BUTTON_WHEEL_DOWN,
		position,
		modifiers,
	});
}

export interface MouseButtonEvent {
	button: MouseButton;
	position: CellPosition;
	release?: boolean;
	modifiers?: Partial<ModifierKeys>;
}

/**
 * A press/release report for a pane that asked for one, else null: no mouse
 * reporting means the user is selecting text and must keep being able to (#25),
 * and the legacy encoding is not implemented.
 */
export function encodeMouseReport(
	state: TerminalModeState,
	event: MouseButtonEvent,
): string | null {
	if (!mouseReportingEnabled(state) || state.mouseEncoding !== 'sgr') return null;
	return encodeSgrMouse({
		button: sgrButtonCode(event.button),
		position: event.position,
		release: event.release,
		modifiers: event.modifiers,
	});
}

/** The wheel half of the same gate. */
export function encodeWheelReport(
	state: TerminalModeState,
	direction: WheelDirection,
	position: CellPosition,
	modifiers?: Partial<ModifierKeys>,
): string | null {
	if (!mouseReportingEnabled(state) || state.mouseEncoding !== 'sgr') return null;
	return encodeSgrWheel(direction, position, modifiers);
}

function cellToWire(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.trunc(value) + 1);
}
