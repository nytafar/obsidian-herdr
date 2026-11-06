/**
 * Claude's own status from its TUI: OSC 7501 (finding `herdr-core-api` §6).
 *
 * Claude Code 2.1.295 and later reports its status to a terminal that
 * answers the support probe `ESC ] 7501 ; ? ST`. Under `script` the probe
 * reaches the plugin as output, the plugin answers it on the pty's input
 * with {@link PROGRAM_STATUS_REPLY}, and from then on Claude writes
 * `ESC ] 7501 ; state=<idle|working|done|blocked|error|clear>[:kind=…] ST`
 * (measured on 2.1.318: `idle` at start, `working` and `done` around a turn,
 * `clear` on exit). That is what the agent list shows for an agent in its
 * terminal view; there is no `can_use_tool` in TUI mode, so a blocked agent
 * is answered in the terminal itself.
 *
 * The scanner reads raw pty bytes in chunks, so a sequence split across two
 * chunks is held until its terminator arrives. Pure.
 */

import type { BlockKind } from '../native/sessionWatcher';

/** What the plugin answers the probe with: the states and kinds it understands, as herdr-core does. */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

/** A state as reported. `clear` withdraws the report (the program is ending). */
export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';

const STATES = new Set<ProgramState>(['idle', 'working', 'done', 'blocked', 'error', 'clear']);

/** One root report (records with an `id` are a program's sub-tasks and are skipped). */
export interface ProgramStatusReport {
	state: ProgramState;
	/** While blocked: what on, when the program said. */
	kind: BlockKind | null;
}

export interface ProgramStatusScan {
	/** The program asked whether the terminal understands OSC 7501. */
	probe: boolean;
	reports: ProgramStatusReport[];
}

// eslint-disable-next-line no-control-regex -- escape sequences are the point
const SEQUENCE = /\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const START = '\x1b]7501;';
/** A held, unterminated sequence longer than this is not one. */
const MAX_HELD = 1024;

/** One report's fields (`state=working:kind=…`), or null when it is not a root report. */
export function parseProgramStatus(body: string): ProgramStatusReport | null {
	const fields = new Map<string, string>();
	for (const part of body.split(':')) {
		const eq = part.indexOf('=');
		if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
	}
	if (fields.has('id')) return null;
	const state = fields.get('state') as ProgramState | undefined;
	if (!state || !STATES.has(state)) return null;
	const kind = fields.get('kind');
	return {
		state,
		kind: kind === 'permission' || kind === 'question' || kind === 'auth' ? kind : null,
	};
}

export class ProgramStatusScanner {
	private held = '';

	push(bytes: Uint8Array): ProgramStatusScan {
		const result: ProgramStatusScan = { probe: false, reports: [] };
		let text = this.held;
		for (const byte of bytes) text += String.fromCharCode(byte);
		this.held = '';
		let end = 0;
		for (const match of text.matchAll(SEQUENCE)) {
			end = match.index + match[0].length;
			const body = match[1] ?? '';
			if (body === '?' || body.startsWith('?:')) {
				result.probe = true;
				continue;
			}
			const report = parseProgramStatus(body);
			if (report) result.reports.push(report);
		}
		// An unterminated sequence, or the first bytes of one, waits for the rest.
		const start = text.lastIndexOf(START);
		if (start >= end && start >= 0) {
			if (text.length - start <= MAX_HELD) this.held = text.slice(start);
		} else {
			for (let n = Math.min(START.length - 1, text.length - end); n > 0; n--) {
				if (START.startsWith(text.slice(-n))) {
					this.held = text.slice(-n);
					break;
				}
			}
		}
		return result;
	}
}
