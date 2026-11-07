/**
 * Where a herdr pane's Claude keeps its files (issue #132).
 *
 * Claude files a session under its configuration folder (`CLAUDE_CONFIG_DIR`,
 * else `~/.claude`) and the cwd as it sees it, which is the real path: a
 * session started in a symlinked folder is filed under the link's target. herdr
 * says neither. Its pane `cwd` is the one the shell last reported (OSC 7, the
 * logical path) and its `agent_session` carries the session id only: the
 * Claude hook sends `transcript_path` along, and herdr 0.9.5 drops it for every
 * agent but pi and omp (docs/architecture.md, "A pane's Claude process").
 *
 * What herdr does give is the pane's foreground processes (`pane.process_info`):
 * pid, name, argv and the process's own cwd, which the kernel reports resolved.
 * The Claude among them is read for its environment on this machine:
 * `/proc/<pid>/environ` on Linux, `ps -E` on macOS. Anything that cannot be
 * read falls back to the pane's cwd resolved here and `~/.claude`, which is
 * what the plugin assumed before.
 *
 * Local only: an SSH herdr has no transcript adapter (`runtime/herdrKind.ts`),
 * so nothing here runs for one.
 */

import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { claudeConfigDir } from '../claude/agents';
import type { CatalogEntry, CommandCatalogSource } from '../native/commandCatalog';
import { LocalCommandCatalog } from '../agents/claude/commands';
import type { PaneProcessInfo, PaneProcessInfoProcess } from './types.gen';

/** What a pane's Claude says about where its files are. */
export interface PaneClaude {
	/** Claude's configuration folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
	configDir: string;
	/** The cwd as Claude sees it, which names its project folder. */
	realCwd: string;
}

/**
 * The Claude among a pane's foreground processes: one called `claude`, by
 * name or by its program's file name, else the foreground job's leader (a
 * wrapper that started it shares its environment as a rule), else none.
 */
export function claudeProcessOf(info: PaneProcessInfo | null | undefined): PaneProcessInfoProcess | null {
	const processes = info?.foreground_processes ?? [];
	const named = processes.find((process) => {
		if (process.name === 'claude') return true;
		const program = process.argv0 ?? process.argv?.[0];
		return typeof program === 'string' && basename(program) === 'claude';
	});
	if (named) return named;
	const leader = info?.foreground_process_group_id;
	return processes.find((process) => process.pid === leader) ?? null;
}

/**
 * What an environment says of `CLAUDE_CONFIG_DIR`: its value, or undefined
 * when it is not set. `environ` is `/proc/<pid>/environ`, NUL-separated.
 */
export function configDirInEnviron(environ: string): string | undefined {
	let found: string | undefined;
	for (const entry of environ.split('\0')) {
		if (entry.startsWith('CLAUDE_CONFIG_DIR=')) found = entry.slice('CLAUDE_CONFIG_DIR='.length);
	}
	return found;
}

/**
 * The `CLAUDE_CONFIG_DIR` in one `ps -E -o command=` line: the last
 * assignment, to the next `NAME=`. `ps` cannot tell an argument or a value
 * containing ` NAME=` from an assignment.
 *
 * From Ovis (`server/claude-store.ts`, `configDirInPsLine`), MIT License,
 * Copyright (c) 2026 devswha.
 */
export function configDirInPsLine(text: string): string | undefined {
	const matches = [...text.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)];
	return matches.at(-1)?.[1] || undefined;
}

/**
 * A process's `CLAUDE_CONFIG_DIR` as read: `{ value }` (undefined when it is
 * not set) or null when the environment could not be read at all.
 */
export type EnvironmentRead = { value: string | undefined } | null;

/** What the resolver reads; the real machine by default, fakes in tests. */
export interface PaneClaudeDeps {
	/** herdr's `pane.process_info`, or null when it cannot be had. */
	processInfo(paneId: string): Promise<PaneProcessInfo | null>;
	environment(pid: number): Promise<EnvironmentRead>;
	realpath(path: string): Promise<string>;
	home: string;
	now(): number;
}

/** A process's environment does not change: a full answer is kept this long. */
export const PANE_CLAUDE_HIT_MS = 30_000;
/** An answer that had to fall back is kept only this long, then asked again. */
export const PANE_CLAUDE_MISS_MS = 2_000;

/** Reads a process's `CLAUDE_CONFIG_DIR` on this machine. */
export function readProcessConfigDir(pid: number, platform: NodeJS.Platform = process.platform): Promise<EnvironmentRead> {
	if (platform === 'linux') {
		return readFile(`/proc/${pid}/environ`, 'utf8').then(
			// Empty is a process gone or not ours, not one without the variable.
			(environ) => (environ ? { value: configDirInEnviron(environ) } : null),
			() => null,
		);
	}
	if (platform === 'darwin') {
		return new Promise((resolve) => {
			execFile(
				'ps',
				['-wwE', '-o', 'command=', '-p', String(pid)],
				{ timeout: 2000, windowsHide: true },
				(error, stdout) => {
					const line = String(stdout ?? '').trim();
					resolve(error || !line ? null : { value: configDirInPsLine(line) });
				},
			);
		});
	}
	return Promise.resolve(null);
}

interface Entry {
	session: string;
	cwd: string;
	value: PaneClaude;
	at: number;
	ttl: number;
}

/**
 * Resolves and remembers each pane's {@link PaneClaude}, per agent session: a
 * new session may be a new Claude, started with another environment.
 */
export class PaneClaudeResolver {
	private readonly entries = new Map<string, Entry>();
	private readonly inflight = new Map<string, Promise<PaneClaude>>();

	constructor(private readonly deps: PaneClaudeDeps) {}

	/** The answer known for this pane and session, fresh or not, or null. */
	known(paneId: string, session: string, cwd: string): PaneClaude | null {
		const entry = this.entries.get(paneId);
		return entry && entry.session === session && entry.cwd === cwd ? entry.value : null;
	}

	/** Whether the known answer is missing or older than its keep time. */
	stale(paneId: string, session: string, cwd: string): boolean {
		const entry = this.entries.get(paneId);
		if (!entry || entry.session !== session || entry.cwd !== cwd) return true;
		return this.deps.now() - entry.at >= entry.ttl;
	}

	/** Whether this pane has been asked about at all. */
	tracked(paneId: string): boolean {
		return this.entries.has(paneId) || this.inflight.has(paneId);
	}

	/** Forgets a pane, as when it leaves the scope. */
	forget(paneId: string): void {
		this.entries.delete(paneId);
	}

	/**
	 * The pane's answer, read again when it is stale. Never rejects: whatever
	 * cannot be read falls back to the pane's cwd resolved here and
	 * `~/.claude`.
	 */
	resolve(paneId: string, session: string, cwd: string): Promise<PaneClaude> {
		const known = this.known(paneId, session, cwd);
		if (known && !this.stale(paneId, session, cwd)) return Promise.resolve(known);
		const key = `${paneId}\0${session}\0${cwd}`;
		const running = this.inflight.get(key);
		if (running) return running;
		const read = this.read(paneId, cwd).then(
			({ value, complete }) => {
				this.inflight.delete(key);
				this.entries.set(paneId, {
					session,
					cwd,
					value,
					at: this.deps.now(),
					ttl: complete ? PANE_CLAUDE_HIT_MS : PANE_CLAUDE_MISS_MS,
				});
				return value;
			},
		);
		this.inflight.set(key, read);
		return read;
	}

	private async read(paneId: string, cwd: string): Promise<{ value: PaneClaude; complete: boolean }> {
		const { deps } = this;
		const info = await deps.processInfo(paneId).catch(() => null);
		const claude = claudeProcessOf(info);
		// The kernel reports a process's cwd resolved; the pane's own is the
		// shell's report and may run through a link.
		const realCwd =
			claude?.cwd && isAbsolute(claude.cwd) ? claude.cwd : await deps.realpath(cwd).catch(() => cwd);
		const fallback = join(deps.home, '.claude');
		if (!claude) return { value: { configDir: fallback, realCwd }, complete: false };
		const environment = await deps.environment(claude.pid).catch(() => null);
		if (!environment) return { value: { configDir: fallback, realCwd }, complete: false };
		const env = environment.value === undefined ? {} : { CLAUDE_CONFIG_DIR: environment.value };
		return { value: { configDir: claudeConfigDir(env, deps.home, realCwd), realCwd }, complete: true };
	}
}

/** The deps for this machine, over a client that answers `pane.process_info`. */
export function localPaneClaudeDeps(
	processInfo: (paneId: string) => Promise<PaneProcessInfo | null>,
	home: string,
): PaneClaudeDeps {
	return {
		processInfo,
		environment: (pid) => readProcessConfigDir(pid),
		realpath: (path) => realpath(path),
		home,
		now: () => Date.now(),
	};
}

/**
 * A local herdr pane's `/` list (#98, #132): this machine's files, with the
 * user scope and plugins read from the pane's own Claude's configuration
 * folder. A pane not known yet is read once its Claude is; anything that
 * cannot be read is `~/.claude`, as before.
 */
export class HerdrCommandCatalog implements CommandCatalogSource {
	private readonly local = new LocalCommandCatalog();

	constructor(
		private readonly resolver: PaneClaudeResolver,
		/** The agent session herdr reports for a pane, empty when none. */
		private readonly sessionOf: (paneId: string) => string,
	) {}

	catalog(cwd: string, paneId?: string): CatalogEntry[] | Promise<CatalogEntry[]> {
		const session = paneId ? this.sessionOf(paneId) : '';
		if (!paneId || !session || !cwd) return this.local.catalogIn(cwd);
		const known = this.resolver.known(paneId, session, cwd);
		if (known) {
			// A stale answer still serves this `/`; the next one gets the fresh one.
			if (this.resolver.stale(paneId, session, cwd)) void this.resolver.resolve(paneId, session, cwd);
			return this.local.catalogIn(cwd, known.configDir);
		}
		return this.resolver
			.resolve(paneId, session, cwd)
			.then((claude) => this.local.catalogIn(cwd, claude.configDir));
	}
}
