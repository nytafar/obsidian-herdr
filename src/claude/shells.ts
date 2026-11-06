/**
 * Shell tabs of the `claude` kind (ADR-0007's D2, ADR-0008): a plain shell
 * in a folder, on the same pty as an agent's TUI (`script(1)` under the fd-3
 * watchdog, `./pty.ts`), in a terminal tab of its own.
 *
 * - A shell is not an agent: no row in the agent list, no session, no native
 *   view. Its id (`sh-` and eight base-36 digits) is the tab's pane id.
 * - It starts when its first tab attaches, at that tab's grid, in the user's
 *   `SHELL` (`/bin/sh` without one). An initial command, given when the
 *   shell is opened (D3's "run the installer in a terminal tab"), runs first
 *   through `/bin/sh -c`, in plain view, and the shell starts after it, so the
 *   user can read the output and keep typing.
 * - Like a TUI it outlives a hidden or closed tab within one Obsidian run,
 *   until the last tab that shows it is closed for good ({@link close}). A
 *   shell that ends (`exit`) starts again in the same folder, without the
 *   initial command, when its tab reconnects.
 * - Shells are not stored: after a restart a restored tab says the shell
 *   ended with Obsidian.
 *
 * No Obsidian.
 */

import type { ClaudeTimers } from './process';
import { shellQuote, type PtyPlatform, type PtySpawn, type PtyTools } from './pty';
import { SharedPty, type PtyAttachment, type PtyViewer } from './sharedPty';

/** Said by a restored tab whose shell belonged to an earlier run. */
export const SHELL_GONE = 'this shell ended when Obsidian closed';
/** Said by a tab whose shell ended. */
export const SHELL_ENDED = 'the shell ended; reconnect to start a new one here';

/** Whether a pane id is a shell tab's. */
export function isShellId(paneId: string): boolean {
	return /^sh-[0-9a-z]{8}$/.test(paneId);
}

/** A shell id not in `taken`. */
export function newShellId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		const id = `sh-${Math.floor(random() * 36 ** 8)
			.toString(36)
			.padStart(8, '0')}`;
		if (!taken.has(id)) return id;
	}
}

export interface ClaudeShellsHost {
	/** The environment a shell starts with. */
	env(): NodeJS.ProcessEnv;
	platform: PtyPlatform;
	spawn: PtySpawn;
	tools: PtyTools;
	timers: ClaudeTimers;
	replayLimit?: number;
	newId?(taken: ReadonlySet<string>): string;
}

interface ShellEntry {
	id: string;
	cwd: string;
	/** Run before the first shell only. */
	command: string | null;
	pty: SharedPty | null;
	/** Why the last shell ended, for a start that failed at once. */
	error: string;
}

/** The program for a shell tab: the user's shell, or `/bin/sh`. */
export function shellProgram(env: NodeJS.ProcessEnv): string[] {
	return [env.SHELL?.trim() || '/bin/sh'];
}

/** What a shell tab prints before its initial command, so the user sees what runs. */
export function announce(command: string): string {
	return `printf '\\033[1m$ %s\\033[0m\\n' ${shellQuote(command)}; ${command}`;
}

/** Said by a tab that attaches once the plugin is unloading. */
export const SHELLS_UNLOADING = 'the plugin is unloading';

export class ClaudeShells {
	private readonly entries = new Map<string, ShellEntry>();
	/** Every shell started that has not exited, its id forgotten or not: unload ends them all. */
	private readonly live = new Set<SharedPty>();
	private disposed = false;

	constructor(private readonly host: ClaudeShellsHost) {}

	/**
	 * A new shell in `cwd` (absolute), with an optional command run first.
	 * Returns its id; nothing starts until a tab attaches to it.
	 */
	open(cwd: string, command?: string): string {
		const taken = new Set(this.entries.keys());
		const id = this.host.newId?.(taken) ?? newShellId(taken);
		this.entries.set(id, { id, cwd, command: command?.trim() || null, pty: null, error: '' });
		return id;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	/** The folder a shell runs in, or null. */
	cwd(id: string): string | null {
		return this.entries.get(id)?.cwd ?? null;
	}

	/** Whether the shell's program runs now. */
	running(id: string): boolean {
		return this.entries.get(id)?.pty?.alive === true;
	}

	/** A tab attaches: the running shell, or a new one in the folder. */
	attach(id: string, viewer: PtyViewer): PtyAttachment {
		if (this.disposed) throw new Error(SHELLS_UNLOADING);
		const entry = this.entries.get(id);
		if (!entry) throw new Error(SHELL_GONE);
		if (!entry.pty?.alive || entry.pty.isStopping) this.start(entry, viewer.size() ?? { cols: 80, rows: 24 });
		const pty = entry.pty;
		if (!pty) throw new Error(`the shell could not be started: ${entry.error}`);
		return pty.attach(viewer);
	}

	/** The last tab showing the shell closed: it ends, and the id is forgotten. */
	async close(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		await entry.pty?.stop();
	}

	/** Every shell ends, a closing one too, and none starts again: the plugin is unloading. */
	async stopAll(): Promise<void> {
		this.disposed = true;
		this.entries.clear();
		await Promise.all([...this.live].map((pty) => pty.stop()));
	}

	private start(entry: ShellEntry, size: { cols: number; rows: number }): void {
		const env = this.host.env();
		const command = entry.command;
		entry.command = null;
		const pty: SharedPty = new SharedPty({
			program: shellProgram(env),
			...(command ? { before: announce(command) } : {}),
			cwd: entry.cwd,
			env,
			cols: size.cols,
			rows: size.rows,
			platform: this.host.platform,
			// An interactive shell ignores SIGTERM; a hangup is what ends it.
			stopSignal: 'SIGHUP',
			spawn: this.host.spawn,
			tools: this.host.tools,
			timers: this.host.timers,
			...(this.host.replayLimit ? { replayLimit: this.host.replayLimit } : {}),
			onExit: (info) => {
				this.live.delete(pty);
				if (entry.pty !== pty) return;
				entry.pty = null;
				entry.error = info.error;
				pty.close(info.stopping ? 'the shell was closed' : SHELL_ENDED);
			},
		});
		entry.pty = pty;
		pty.start();
		if (pty.alive) this.live.add(pty);
	}
}
