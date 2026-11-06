/**
 * Splits what an engine emits into what a person did and what the emulator
 * answered by itself (`TerminalRenderer.onReply`). herdr-core wants the two
 * apart: a reply goes as AUTOMATIC_INPUT, which neither takes the shared
 * terminal's size nor holds back a `terminal.send` the way typing does
 * ([[herdr-core-api]] §3).
 *
 * Each engine tells them apart its own way:
 *
 * - **ghostty-web** answers inside `write()`: its `write` runs the WASM
 *   parser and then `processTerminalResponses`, which fires `onData`
 *   synchronously. Anything emitted while a write is on the stack is a reply;
 *   typing arrives from DOM events, never from inside a write.
 * - **xterm.js** parses later, off a write buffer, so a write scope says
 *   nothing. Its core fires `onUserInput` right before every `onData` that
 *   came from the keyboard, a paste or the mouse (`triggerDataEvent(…, true)`)
 *   and not before a reply. That event is internal, so the router only
 *   classifies once it has been wired; without it everything is input, which
 *   is what the plugin did before.
 *
 * With no reply listener everything goes to the data listeners.
 */

export type DataListener = (data: string) => void;

export type ReplySignal = 'write-scope' | 'user-input';

export class DataRouter {
	readonly data = new Set<DataListener>();
	readonly replies = new Set<DataListener>();
	private writes = 0;
	private userInput = false;
	private userSignal = false;

	constructor(private readonly signal: ReplySignal) {}

	/** Runs an engine write; data emitted inside it is a reply ('write-scope'). */
	write(run: () => void): void {
		this.writes++;
		try {
			run();
		} finally {
			this.writes--;
		}
	}

	/** The engine's "the next data is a person's" signal ('user-input'). */
	markUserInput(): void {
		this.userSignal = true;
		this.userInput = true;
	}

	/** The engine has the 'user-input' signal wired at all. */
	enableUserSignal(): void {
		this.userSignal = true;
	}

	/** One `onData` from the engine. */
	dispatch(data: string): void {
		let reply: boolean;
		if (this.signal === 'write-scope') {
			reply = this.writes > 0;
		} else {
			reply = this.userSignal && !this.userInput;
			this.userInput = false;
		}
		const targets = reply && this.replies.size > 0 ? this.replies : this.data;
		for (const listener of [...targets]) listener(data);
	}

	clear(): void {
		this.data.clear();
		this.replies.clear();
	}
}
