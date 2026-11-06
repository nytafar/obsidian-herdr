/**
 * A terminal tab's session on the `claude` kind (ADR-0007's D2), behind the
 * same {@link PaneSession} shape as herdr's NDJSON bridge and herdr-core's
 * attach, so `PaneTerminal` drives it unchanged.
 *
 * It owns no process. `start` attaches the tab to a pty the plugin keeps
 * (`./sharedPty.ts`): an agent's claude TUI, which the agent table starts or
 * switches to (`./agents.ts`), or a shell tab's shell (`./shells.ts`).
 * `dispose` only detaches, so closing a tab, or Obsidian suspending a hidden
 * one, leaves the program running, and the next start repaints it.
 *
 * - Output arrives as raw bytes, the first frame of every attach a `full`
 *   replay; replays are cut into frames of {@link FRAME_BYTES}, since a
 *   renderer takes one large write worse than several.
 * - Keys and the renderer's replies go to the program as input; the wheel is
 *   the renderer's own (there is no scroll request to send).
 * - `waiting` says why nothing is attached yet (the agent's turn has to end
 *   before its process can switch), `closed` why it ended.
 *
 * No Obsidian.
 */

import type {
	FrameMeta,
	TerminalSessionEventMap,
	TerminalSessionMode,
	TerminalSessionOptions,
} from '../bridge/terminalSession';
import type { PaneSession } from '../views/paneTerminal';
import type { PtyAttachment, PtyOpen, PtyViewer } from './sharedPty';

/** The largest frame a replay is cut into. */
export const FRAME_BYTES = 64 * 1024;

type AnyListener = (...args: unknown[]) => void;

export class ClaudeTerminalSession implements PaneSession {
	readonly mode: TerminalSessionMode;
	private own: { cols: number; rows: number };
	private measured: boolean;
	private attachment: PtyAttachment | null = null;
	private readonly listeners = new Map<string, Set<AnyListener>>();
	private seq = 0;
	private disposed = false;
	private grid: { cols: number; rows: number };

	constructor(
		private readonly options: TerminalSessionOptions,
		private readonly open: PtyOpen,
	) {
		this.mode = options.mode;
		this.own = { cols: options.cols, rows: options.rows };
		this.grid = { ...this.own };
		this.measured = options.provisionalSize !== true;
	}

	/** This tab's own grid. */
	get size(): { cols: number; rows: number } {
		return { ...this.own };
	}

	on<K extends keyof TerminalSessionEventMap>(
		event: K,
		listener: (...args: TerminalSessionEventMap[K]) => void,
	): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener as AnyListener);
		return this;
	}

	start(): void {
		if (this.attachment || this.disposed) return;
		try {
			this.attachment = this.open(
				this.options.target,
				this.viewer(),
				this.options.revealed ? { revealed: true } : {},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit('error', new Error(message));
			this.emit('closed', message);
		}
	}

	input(data: string | Uint8Array): boolean {
		if (this.mode !== 'control') return false;
		return this.attachment?.write(data) ?? false;
	}

	reply(data: string | Uint8Array): boolean {
		if (this.mode !== 'control') return false;
		return this.attachment?.reply(data) ?? false;
	}

	resize(cols: number, rows: number): boolean {
		if (this.mode !== 'control') return false;
		this.own = { cols, rows };
		this.measured = true;
		return this.attachment?.resize(cols, rows) ?? false;
	}

	/** No scroll request exists for a pty; the renderer scrolls its own buffer. */
	scroll(): boolean {
		return false;
	}

	repaint(): void {
		this.attachment?.repaint();
	}

	setLooking(looking: boolean): void {
		this.attachment?.looking(looking);
	}

	dispose(): Promise<void> {
		this.disposed = true;
		this.attachment?.detach();
		this.attachment = null;
		this.listeners.clear();
		return Promise.resolve();
	}

	private viewer(): PtyViewer {
		return {
			control: this.mode === 'control',
			size: () => (this.measured ? { ...this.own } : null),
			data: (bytes, full) => this.frames(bytes, full),
			grid: (cols, rows) => {
				this.grid = { cols, rows };
				this.emit('grid', cols, rows);
			},
			closed: (reason) => {
				this.attachment = null;
				this.emit('closed', reason);
			},
			waiting: (reason) => {
				this.emit('waiting', reason);
				if (reason === null) this.emit('reopened');
			},
		};
	}

	private frames(bytes: Uint8Array, full: boolean): void {
		if (full) this.seq = 0;
		for (let at = 0, first = true; first || at < bytes.length; at += FRAME_BYTES, first = false) {
			const meta: FrameMeta = {
				seq: ++this.seq,
				encoding: 'raw',
				width: this.grid.cols,
				height: this.grid.rows,
				full: full && first,
			};
			this.emit('frame', bytes.subarray(at, at + FRAME_BYTES), meta);
		}
	}

	private emit<K extends keyof TerminalSessionEventMap>(event: K, ...args: TerminalSessionEventMap[K]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				listener(...args);
			} catch {
				// One bad subscriber must not stop the others.
			}
		}
	}
}
