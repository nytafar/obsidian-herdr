/**
 * Which process an agent of the `claude` kind should run, and when it may
 * change (ADR-0007's D2). Pure: `./agents.ts` asks it after every change.
 *
 * One live process per agent: headless (`stream`, which the native view
 * prompts and whose requests its waiting card answers) or the TUI (`tui`, in
 * a terminal tab). The agent **wants** whichever view asked last:
 *
 * - a terminal tab attaching (opening, revealing, reconnecting) wants `tui`;
 * - a tab switched to the native view, or a prompt sent from one, wants
 *   `stream`.
 *
 * The process changes only between turns. While the agent works, or waits on
 * a request, the switch **waits** for the turn to end, and the tab says so;
 * nothing is asked and nothing is interrupted. A request a headless agent is
 * blocked on is answered in the native view, a blocked TUI in its terminal,
 * and the switch follows once the turn is over. A switch stops the old
 * process in its own stop order and starts the other with `--resume`.
 *
 * A TUI that never reported its status (no OSC 7501) counts as idle: nothing
 * better is known.
 */

import type { ClaudeAgentStatus } from './agents';

/** The process an agent runs: headless, its TUI, or none. */
export type ClaudeProcessMode = 'stream' | 'tui' | 'stopped';

export interface ViewSwitchInput {
	/** What the last view asked for. */
	want: 'stream' | 'tui';
	/** What runs now. */
	mode: ClaudeProcessMode;
	status: ClaudeAgentStatus;
	/** The running process is already stopping (a Stop, or a switch under way). */
	stopping: boolean;
	/** Terminal tabs attached to the agent or waiting for it. */
	viewers: number;
	/** Prompts the native view sent that wait for the headless process. */
	queued: number;
}

export type ViewSwitchStep =
	/** Nothing to do: the agent runs what it should, or nobody needs it to change. */
	| { action: 'stay' }
	/** The switch has to wait; `reason` is what a waiting tab says. */
	| { action: 'wait'; reason: string }
	/** Stop what runs now; the other mode starts once it has exited. */
	| { action: 'switch' }
	/** Nothing runs: start the TUI for the tabs waiting on it. */
	| { action: 'start-tui' }
	/** Nothing runs: start the headless process for the prompts waiting on it. */
	| { action: 'start-stream' };

/** What a terminal tab says while the agent's turn is still running. */
export const WAIT_FOR_TURN = 'waiting for the agent to finish its turn in the native view';
/** The same while the turn waits on a request the native view answers. */
export const WAIT_FOR_ANSWER = 'the agent is waiting for an answer in the native view; it opens here after that';
/** While the process stops for another reason. */
export const WAIT_FOR_STOP = 'waiting for the agent to stop';
/** Said to a native prompt while the TUI is busy. */
export const TUI_BUSY = 'the agent is busy in its terminal view; answer or prompt it there, or wait for its turn to end';

function busy(status: ClaudeAgentStatus): boolean {
	return status === 'working' || status === 'blocked';
}

export function planViewSwitch(input: ViewSwitchInput): ViewSwitchStep {
	if (input.want === 'tui') {
		if (input.mode === 'tui') return { action: 'stay' };
		if (input.viewers === 0) return { action: 'stay' };
		if (input.mode === 'stopped') return { action: 'start-tui' };
		if (input.stopping) return { action: 'wait', reason: WAIT_FOR_STOP };
		if (input.status === 'blocked') return { action: 'wait', reason: WAIT_FOR_ANSWER };
		if (input.status === 'working') return { action: 'wait', reason: WAIT_FOR_TURN };
		return { action: 'switch' };
	}
	if (input.mode === 'stream') return { action: 'stay' };
	if (input.mode === 'stopped') return input.queued > 0 ? { action: 'start-stream' } : { action: 'stay' };
	if (input.stopping || busy(input.status)) return { action: 'stay' };
	return { action: 'switch' };
}
