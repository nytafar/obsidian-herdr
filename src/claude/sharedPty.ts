/**
 * One program on a pty (`./pty.ts`) and the terminal tabs that show it
 * (ADR-0007's D2): the claude TUI of an agent, or a shell tab.
 *
 * The program is the plugin's, not a tab's. A tab **attaches** and
 * **detaches**; closing it, or Obsidian hiding it past its grace period,
 * leaves the program running, and the next attach repaints from the replay
 * buffer (`./replay.ts`), plus a SIGWINCH when the buffer had to drop output.
 *
 * - **Input.** A controlling tab's keys go to the program's stdin.
 * - **Grid.** The pty has one grid. A controlling tab that resizes, or types
 *   while the grid is someone else's, takes it; the others are told the grid
 *   (`grid`), and an observer only ever follows it.
 * - **Replies** of the renderer (DA, DSR, kitty keyboard answers) go to the
 *   program as input, but from one tab only, the controller that attached
 *   or typed last, so two open tabs do not answer every query twice.
 *
 * No Obsidian.
 */

import { PtyProcess, type PtyProcessOptions } from './pty';
import { ReplayBuffer } from './replay';

/** A terminal tab as a pty sees it. */
export interface PtyViewer {
	/** True for a controlling tab; an observer never writes or resizes. */
	readonly control: boolean;
	/** The grid this tab's renderer measured; null while it has none. */
	size(): { cols: number; rows: number } | null;
	/** Output; `full` is a repaint from scratch (a replay). */
	data(bytes: Uint8Array, full: boolean): void;
	/** The pty's grid, when it is not this tab's own, and again once it is. */
	grid(cols: number, rows: number): void;
	/** The program ended or moved away; why, as a clause. */
	closed(reason: string): void;
	/** Not attached yet, and why (a turn must end first); null once attached. */
	waiting(reason: string | null): void;
}

/** What a tab holds while it views a pty. */
export interface PtyAttachment {
	/** Keys. False when the tab observes or nothing runs. */
	write(data: string | Uint8Array): boolean;
	resize(cols: number, rows: number): boolean;
	/** The renderer's answer to a query of the program. */
	reply(data: string | Uint8Array): boolean;
	/** The renderer was rebuilt under the tab: paint it again. */
	repaint(): void;
	/** Whether a person is in front of the tab. */
	looking(on: boolean): void;
	/** The tab let go. The program keeps running. */
	detach(): void;
}

/** Finds the pty a tab asks for; throws a readable error when there is none. */
export type PtyOpen = (target: string, viewer: PtyViewer, how?: PtyOpenHow) => PtyAttachment;

/** How a tab came to attach. */
export interface PtyOpenHow {
	/** A hidden tab shown again, not a person asking (`TerminalSessionOptions.revealed`). */
	revealed?: boolean;
}

export interface SharedPtyOptions extends Omit<PtyProcessOptions, 'onData' | 'onExit'> {
	replayLimit?: number;
	/** Every chunk of output, before the tabs see it (the TUI's status scanner). */
	onData?(bytes: Uint8Array): void;
	onExit(info: { code: number | null; signal: string | null; stopping: boolean; error: string }): void;
}

interface Entry {
	viewer: PtyViewer;
}

// eslint-disable-next-line no-control-regex -- escape sequences are the point
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export class SharedPty {
	private readonly process: PtyProcess;
	private readonly buffer: ReplayBuffer;
	private readonly viewers = new Set<Entry>();
	/** The one tab whose renderer answers the program's queries. */
	private replier: Entry | null = null;

	constructor(private readonly options: SharedPtyOptions) {
		this.buffer = new ReplayBuffer(options.replayLimit);
		this.process = new PtyProcess({
			...options,
			onData: (bytes) => this.onData(bytes),
			onExit: (info) => options.onExit(info),
		});
	}

	get alive(): boolean {
		return this.process.alive;
	}

	get isStopping(): boolean {
		return this.process.isStopping;
	}

	get size(): { cols: number; rows: number } {
		return this.process.size;
	}

	/** How many tabs are attached. */
	get viewerCount(): number {
		return this.viewers.size;
	}

	start(): void {
		this.process.start();
	}

	/** Bytes from the plugin itself (the status probe's answer). */
	write(data: string | Uint8Array): boolean {
		return this.process.write(data);
	}

	stop(): Promise<void> {
		return this.process.stop();
	}

	/** What the program printed, without escape sequences: how a startup refusal is read. */
	outputText(): string {
		return new TextDecoder().decode(this.buffer.replay()).replace(ANSI, '');
	}

	/** Tells every tab the program is gone and forgets them. */
	close(reason: string): void {
		const viewers = [...this.viewers];
		this.viewers.clear();
		this.replier = null;
		for (const entry of viewers) entry.viewer.closed(reason);
	}

	attach(viewer: PtyViewer): PtyAttachment {
		const entry: Entry = { viewer };
		this.viewers.add(entry);
		if (viewer.control) this.replier = entry;
		viewer.data(this.buffer.replay(), true);
		const own = viewer.size();
		const pty = this.process.size;
		if (viewer.control && own && (own.cols !== pty.cols || own.rows !== pty.rows)) {
			// A resize is a SIGWINCH, so the program paints the whole screen anyway.
			this.takeGrid(entry, own.cols, own.rows);
		} else {
			if (!viewer.control || !own) viewer.grid(pty.cols, pty.rows);
			if (this.buffer.trimmed) this.process.redraw();
		}
		let attached = true;
		const live = (): boolean => attached && this.viewers.has(entry);
		return {
			write: (data) => {
				if (!live() || !viewer.control) return false;
				this.replier = entry;
				const mine = viewer.size();
				const now = this.process.size;
				if (mine && (mine.cols !== now.cols || mine.rows !== now.rows)) this.takeGrid(entry, mine.cols, mine.rows);
				return this.process.write(data);
			},
			resize: (cols, rows) => {
				if (!live() || !viewer.control) return false;
				this.takeGrid(entry, cols, rows);
				return true;
			},
			reply: (data) => {
				if (!live() || this.replier !== entry) return false;
				return this.process.write(data);
			},
			repaint: () => {
				if (!live()) return;
				viewer.data(this.buffer.replay(), true);
				if (this.buffer.trimmed) this.process.redraw();
			},
			looking: () => undefined,
			detach: () => {
				if (!attached) return;
				attached = false;
				this.viewers.delete(entry);
				if (this.replier === entry) {
					this.replier = [...this.viewers].reverse().find((other) => other.viewer.control) ?? null;
				}
			},
		};
	}

	private takeGrid(owner: Entry, cols: number, rows: number): void {
		const before = this.process.size;
		this.process.resize(cols, rows);
		const after = this.process.size;
		if (before.cols === after.cols && before.rows === after.rows) return;
		for (const entry of this.viewers) {
			if (entry !== owner) entry.viewer.grid(after.cols, after.rows);
		}
	}

	private onData(bytes: Uint8Array): void {
		this.buffer.push(bytes);
		try {
			this.options.onData?.(bytes);
		} catch {
			// The status scanner must not stop the output.
		}
		for (const entry of [...this.viewers]) entry.viewer.data(bytes, false);
	}
}
