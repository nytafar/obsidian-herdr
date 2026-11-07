/**
 * Where a herdr pane's Claude keeps its files (issue #132).
 *
 * herdr reports the pane's cwd as the shell said it, through any symlink, and
 * the session id without the transcript path; Claude files the session under
 * the real path and its own `CLAUDE_CONFIG_DIR`. The resolver reads both off
 * the pane's Claude process (`pane.process_info`, then its environment). No
 * live herdr: the process info is written out in the shape 0.9.5 answers
 * with, and the symlink case runs on a real temp directory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	claudeProcessOf,
	configDirInEnviron,
	configDirInPsLine,
	HerdrCommandCatalog,
	PANE_CLAUDE_HIT_MS,
	PANE_CLAUDE_MISS_MS,
	PaneClaudeResolver,
	type EnvironmentRead,
	type PaneClaudeDeps,
} from '../src/herdr/paneClaude';
import { herdrSessionWatcher, type WatchableScope } from '../src/herdr/sessionWatcher';
import type { PaneState } from '../src/herdr/scope';
import type { PaneInfo, PaneProcessInfo } from '../src/herdr/types.gen';
import type { HerdrEvent } from '../src/herdr/client';
import { encodeProjectDir } from '../src/agents/claude/paths';

/** `pane.process_info` as herdr 0.9.5 answered it for a Claude pane on 2026-11-06. */
function processInfo(cwd: string, pid = 4298): PaneProcessInfo {
	return {
		pane_id: 'w1:p1',
		shell_pid: 3961,
		foreground_process_group_id: pid,
		foreground_processes: [
			{
				argv: ['/home/lasse/.local/share/mise/installs/claude/latest/claude', '--resume', 'abc'],
				cmdline: '/home/lasse/.local/share/mise/installs/claude/latest/claude --resume abc',
				cwd,
				name: 'claude',
				pid,
			},
			{ argv: ['/home/lasse/.local/bin/gridcraft-cli', 'mcp'], cwd, name: 'gridcraft-cli', pid: 21167 },
		],
	};
}

/** Deps over fixed answers, with a clock the test moves. */
function fakeDeps(options: {
	info?: PaneProcessInfo | null;
	env?: EnvironmentRead;
	realpath?: (path: string) => Promise<string>;
}): PaneClaudeDeps & { clock: { now: number }; calls: { info: number; env: number } } {
	const clock = { now: 1000 };
	const calls = { info: 0, env: 0 };
	return {
		clock,
		calls,
		processInfo: () => {
			calls.info++;
			return Promise.resolve(options.info ?? null);
		},
		environment: () => {
			calls.env++;
			return Promise.resolve(options.env === undefined ? { value: undefined } : options.env);
		},
		realpath: options.realpath ?? ((path) => Promise.resolve(path)),
		home: '/home/lasse',
		now: () => clock.now,
	};
}

describe('claudeProcessOf: the Claude among a pane’s foreground processes', () => {
	it('picks the process called claude, not the MCP server beside it', () => {
		expect(claudeProcessOf(processInfo('/srv'))?.pid).toBe(4298);
	});

	it('knows Claude by its program’s file name when the process is named otherwise', () => {
		const info: PaneProcessInfo = {
			pane_id: 'p',
			foreground_process_group_id: 1,
			foreground_processes: [
				{ name: 'wrapper', pid: 1, argv: ['/usr/bin/wrapper'] },
				{ name: 'node', pid: 2, argv: ['/opt/bin/claude'] },
			],
		};
		expect(claudeProcessOf(info)?.pid).toBe(2);
	});

	it('falls back to the foreground job’s leader, and to none', () => {
		const info: PaneProcessInfo = {
			pane_id: 'p',
			foreground_process_group_id: 7,
			foreground_processes: [
				{ name: 'cswap', pid: 7 },
				{ name: 'other', pid: 8 },
			],
		};
		expect(claudeProcessOf(info)?.pid).toBe(7);
		expect(claudeProcessOf({ pane_id: 'p', foreground_processes: [] })).toBeNull();
		expect(claudeProcessOf(null)).toBeNull();
	});
});

describe('reading CLAUDE_CONFIG_DIR out of an environment', () => {
	it('reads it from /proc’s NUL-separated environ, the last one winning', () => {
		expect(configDirInEnviron('HOME=/home/lasse\0CLAUDE_CONFIG_DIR=/home/lasse/.claude-keng\0PWD=/x\0')).toBe(
			'/home/lasse/.claude-keng',
		);
		expect(configDirInEnviron('A=1\0CLAUDE_CONFIG_DIR=/a\0CLAUDE_CONFIG_DIR=/b\0')).toBe('/b');
		expect(configDirInEnviron('HOME=/home/lasse\0NOT_CLAUDE_CONFIG_DIR=/x\0')).toBeUndefined();
	});

	it('reads it from a `ps -E` line, up to the next assignment', () => {
		expect(
			configDirInPsLine('/opt/claude --resume x HOME=/Users/l CLAUDE_CONFIG_DIR=/Users/l/My Claude TERM=xterm'),
		).toBe('/Users/l/My Claude');
		expect(configDirInPsLine('/opt/claude HOME=/Users/l CLAUDE_CONFIG_DIR=/Users/l/.c')).toBe('/Users/l/.c');
		expect(configDirInPsLine('/opt/claude HOME=/Users/l')).toBeUndefined();
	});
});

describe('PaneClaudeResolver', () => {
	it('takes the real cwd from the Claude process and the config dir from its environment', async () => {
		// The pane says the link; the process, as the kernel reports it, the target.
		const deps = fakeDeps({
			info: processInfo('/home/lasse/real/project'),
			env: { value: '/home/lasse/.claude-keng' },
		});
		const resolver = new PaneClaudeResolver(deps);
		expect(await resolver.resolve('w1:p1', 's1', '/home/lasse/link/project')).toEqual({
			configDir: '/home/lasse/.claude-keng',
			realCwd: '/home/lasse/real/project',
		});
	});

	it('takes a relative CLAUDE_CONFIG_DIR from Claude’s cwd, and none as ~/.claude', async () => {
		const relative = new PaneClaudeResolver(fakeDeps({ info: processInfo('/srv/app'), env: { value: 'conf' } }));
		expect((await relative.resolve('p', 's', '/srv/app')).configDir).toBe('/srv/app/conf');
		const unset = new PaneClaudeResolver(fakeDeps({ info: processInfo('/srv/app') }));
		expect((await unset.resolve('p', 's', '/srv/app')).configDir).toBe('/home/lasse/.claude');
	});

	it('resolves the pane’s cwd itself when herdr gives no process, and assumes ~/.claude', async () => {
		const deps = fakeDeps({
			info: null,
			realpath: (path) => Promise.resolve(path.replace('/link/', '/real/')),
		});
		const resolver = new PaneClaudeResolver(deps);
		expect(await resolver.resolve('p', 's', '/home/lasse/link/project')).toEqual({
			configDir: '/home/lasse/.claude',
			realCwd: '/home/lasse/real/project',
		});
	});

	it('keeps the cwd as herdr said it when it cannot be resolved either', async () => {
		const deps = fakeDeps({ info: null, realpath: () => Promise.reject(new Error('ENOENT')) });
		expect((await new PaneClaudeResolver(deps).resolve('p', 's', '/gone')).realCwd).toBe('/gone');
	});

	it('assumes ~/.claude when the environment cannot be read', async () => {
		const deps = fakeDeps({ info: processInfo('/srv'), env: null });
		expect((await new PaneClaudeResolver(deps).resolve('p', 's', '/srv')).configDir).toBe('/home/lasse/.claude');
	});

	it('keeps a full answer 30 s and a fallback 2 s, per session', async () => {
		const full = fakeDeps({ info: processInfo('/srv'), env: { value: '/c' } });
		const resolver = new PaneClaudeResolver(full);
		await resolver.resolve('p', 's', '/srv');
		await resolver.resolve('p', 's', '/srv');
		expect(full.calls.info).toBe(1);
		expect(resolver.stale('p', 's', '/srv')).toBe(false);
		full.clock.now += PANE_CLAUDE_HIT_MS;
		expect(resolver.stale('p', 's', '/srv')).toBe(true);
		// A new session may be a new Claude with another environment.
		expect(resolver.stale('p', 's2', '/srv')).toBe(true);
		expect(resolver.known('p', 's2', '/srv')).toBeNull();

		const missing = fakeDeps({ info: null });
		const fallback = new PaneClaudeResolver(missing);
		await fallback.resolve('p', 's', '/srv');
		missing.clock.now += PANE_CLAUDE_MISS_MS - 1;
		expect(fallback.stale('p', 's', '/srv')).toBe(false);
		missing.clock.now += 1;
		expect(fallback.stale('p', 's', '/srv')).toBe(true);
	});

	it('asks herdr once for concurrent reads of the same pane', async () => {
		const deps = fakeDeps({ info: processInfo('/srv') });
		const resolver = new PaneClaudeResolver(deps);
		await Promise.all([resolver.resolve('p', 's', '/srv'), resolver.resolve('p', 's', '/srv')]);
		expect(deps.calls.info).toBe(1);
	});

	it('never rejects, whatever herdr or the environment does', async () => {
		const deps: PaneClaudeDeps = {
			...fakeDeps({}),
			processInfo: () => Promise.reject(new Error('socket closed')),
		};
		expect((await new PaneClaudeResolver(deps).resolve('p', 's', '/srv')).configDir).toBe('/home/lasse/.claude');
	});
});

describe('a folder reached through a symlink, on a real filesystem', () => {
	let root = '';
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'oh-paneclaude-')));
		mkdirSync(join(root, 'real', 'project'), { recursive: true });
		symlinkSync(join(root, 'real'), join(root, 'link'));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('files the session under the link’s target', async () => {
		const deps: PaneClaudeDeps = { ...fakeDeps({ info: null }), realpath: (path) => realpath(path) };
		const claude = await new PaneClaudeResolver(deps).resolve('p', 's', join(root, 'link', 'project'));
		expect(claude.realCwd).toBe(join(root, 'real', 'project'));
	});
});

/** A scope with one pane and the session herdr reports for it. */
function oneSessionScope(cwd: string, session: () => string): WatchableScope {
	return {
		get: (paneId: string) =>
			paneId === 'w1:p1' ? ({ paneId, cwd, agentStatus: 'idle' } as PaneState) : undefined,
		paneInfo: (paneId: string) =>
			paneId === 'w1:p1'
				? ({
						pane_id: paneId,
						agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: session() },
					} as PaneInfo)
				: undefined,
		on: () => () => {},
	};
}

/** Lets every pending promise and microtask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('herdrSessionWatcher with a resolver: the transcript path herdr does not give', () => {
	it('names the transcript under the config dir and real cwd once known, and says so', async () => {
		let pushed: { handler: ((event: HerdrEvent) => void) | null } = { handler: null };
		const client = {
			on: (_type: 'pane_updated', handler: (event: HerdrEvent) => void) => {
				pushed = { handler };
				return () => {};
			},
		};
		const scope = oneSessionScope('/home/lasse/link/project', () => 'session-1');
		const resolver = new PaneClaudeResolver(
			fakeDeps({ info: processInfo('/home/lasse/real/project'), env: { value: '/home/lasse/.claude-keng' } }),
		);
		const watcher = herdrSessionWatcher({ scope, client }, resolver);
		const seen: [string, string, string | undefined][] = [];
		watcher?.onSession((paneId, session, path) => seen.push([paneId, session, path]));

		// Not known yet: no path, so the model derives the old one meanwhile.
		expect(watcher?.snapshot('w1:p1')?.transcriptPath).toBeUndefined();
		await settle();

		const expected = `/home/lasse/.claude-keng/projects/${encodeProjectDir('/home/lasse/real/project')}/session-1.jsonl`;
		expect(seen).toEqual([['w1:p1', 'session-1', expected]]);
		expect(watcher?.snapshot('w1:p1')?.transcriptPath).toBe(expected);

		// Every later update carries the same path, so the model's dedupe holds.
		pushed.handler?.({
			event: 'pane_updated',
			data: { pane: { pane_id: 'w1:p1', agent_session: { value: 'session-1' } } },
		});
		await settle();
		expect(seen).toEqual([
			['w1:p1', 'session-1', expected],
			['w1:p1', 'session-1', expected],
		]);
	});

	it('reads no Claude process for a pane running another agent, and names no path for it', async () => {
		// The pane-Claude reader is a herdr × Claude pair: a path it works out
		// is a Claude transcript's, and would win over the pane's own format.
		const scope: WatchableScope = {
			get: (paneId: string) =>
				paneId === 'w1:p1' ? ({ paneId, cwd: '/srv', agent: 'codex', agentStatus: 'idle' } as PaneState) : undefined,
			paneInfo: (paneId: string) =>
				paneId === 'w1:p1'
					? ({
							pane_id: paneId,
							agent: 'codex',
							agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: '019a-thread' },
						} as PaneInfo)
					: undefined,
			on: () => () => {},
		};
		const deps = fakeDeps({ info: processInfo('/srv') });
		const watcher = herdrSessionWatcher({ scope, client: { on: () => () => {} } }, new PaneClaudeResolver(deps));

		expect(watcher?.snapshot('w1:p1')?.transcriptPath).toBeUndefined();
		await settle();
		expect(watcher?.snapshot('w1:p1')?.transcriptPath).toBeUndefined();
		expect(deps.calls.info).toBe(0);
	});

	it('pushes nothing for an answer that came back after the session moved on', async () => {
		let session = 'session-1';
		const scope = oneSessionScope('/srv', () => session);
		const resolver = new PaneClaudeResolver(fakeDeps({ info: processInfo('/srv') }));
		const watcher = herdrSessionWatcher({ scope, client: { on: () => () => {} } }, resolver);
		const seen: string[] = [];
		watcher?.onSession((_paneId, s) => seen.push(s));

		watcher?.snapshot('w1:p1');
		session = 'session-2';
		await settle();

		expect(seen).toEqual([]);
	});
});

describe('HerdrCommandCatalog: the user scope of the pane’s own Claude', () => {
	let root = '';
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'oh-panecatalog-')));
		mkdirSync(join(root, 'project', '.git'), { recursive: true });
		mkdirSync(join(root, 'keng', 'commands'), { recursive: true });
		writeFileSync(join(root, 'keng', 'commands', 'only-in-keng.md'), '---\ndescription: Keng\n---\nGo.\n');
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('offers the commands in the pane’s CLAUDE_CONFIG_DIR', async () => {
		const cwd = join(root, 'project');
		const resolver = new PaneClaudeResolver(
			fakeDeps({ info: processInfo(cwd), env: { value: join(root, 'keng') } }),
		);
		const catalog = new HerdrCommandCatalog(resolver, () => 'session-1');

		// Not known yet: read once the pane's Claude is.
		const first = catalog.catalog(cwd, 'w1:p1');
		expect(Array.isArray(first)).toBe(false);
		expect((await first).some((entry) => entry.name === 'only-in-keng' && entry.scope === 'user')).toBe(true);
		// Known now: at once.
		const second = catalog.catalog(cwd, 'w1:p1');
		expect(Array.isArray(second) && second.some((entry) => entry.name === 'only-in-keng')).toBe(true);
	});

	it('reads ~/.claude for a pane with no session, as before', () => {
		const resolver = new PaneClaudeResolver(fakeDeps({ info: processInfo(root) }));
		const entries = new HerdrCommandCatalog(resolver, () => '').catalog(join(root, 'project'), 'w1:p1');
		expect(Array.isArray(entries)).toBe(true);
	});
});
