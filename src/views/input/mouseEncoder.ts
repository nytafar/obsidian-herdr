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

export interface MouseModifiers {
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
}

export function mouseModifierBits(modifiers: MouseModifiers | undefined): number {
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
	modifiers?: MouseModifiers;
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
	modifiers?: MouseModifiers,
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
	modifiers?: MouseModifiers;
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
		...(event.release === undefined ? {} : { release: event.release }),
		...(event.modifiers === undefined ? {} : { modifiers: event.modifiers }),
	});
}

/** The wheel half of the same gate. */
export function encodeWheelReport(
	state: TerminalModeState,
	direction: WheelDirection,
	position: CellPosition,
	modifiers?: MouseModifiers,
): string | null {
	if (!mouseReportingEnabled(state) || state.mouseEncoding !== 'sgr') return null;
	return encodeSgrWheel(direction, position, modifiers);
}

function cellToWire(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.trunc(value) + 1);
}
