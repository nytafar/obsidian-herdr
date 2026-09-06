import { describe, expect, it } from 'vitest';
import {
	AGENT_NAME_RE,
	AGENT_START_RETRY_MS,
	HerdrActions,
	buildAgentName,
	chooseSplitTarget,
	folderName,
	normalizePosixPath,
	resolveFolderPath,
	sanitizeAgentName,
	type ActionHost,
	type AgentPaneSummary,
} from '../src/actions';
import { HerdrError } from '../src/herdr/client';
import type { HerdrSettings } from '../src/settings';
import type { PaneInfo } from '../src/herdr/types.gen';

const VAULT = '/Users/lasse/Vaults/hvelv';

function settings(overrides: Partial<HerdrSettings> = {}): HerdrSettings {
	return {
		socketPath: '~/.config/herdr/herdr.sock',
		herdrBinary: '',
		workspaceId: '',
		agentListSort: 'priority',
		agentListGroupBy: 'tab',
		remote: {
			enabled: false,
			host: '',
			remoteSocketPath: '',
			remoteBinary: '',
			remoteVaultPath: '',
		},
		notifications: {
			statusBar: true,
			blocked: { notice: true, os: true },
			done: { notice: true, os: false },
		},
		defaultAgentKind: 'claude',
		agentNamePattern: '{folder}',
		terminalFontFamily: '',
		terminalTheme: 'obsidian',
		terminalEngine: 'ghostty-web',
		terminalCursorStyle: 'block',
		terminalCursorBlink: true,
		terminalFontSize: 0,
		terminalScrollbackMb: 10,
		openTerminalAfterStart: true,
		splitIntoFolderTab: true,
		panesPerTab: 2,
		folderHoverButton: true,
		extraPath: '',
		defaultAttachMode: 'control',
		terminalPlacement: 'split-right',
		terminalTab: 'per-agent',
		agentListRowClick: 'terminal',
		...overrides,
	};
}

function pane(overrides: Partial<PaneInfo> & { pane_id: string }): PaneInfo {
	return {
		terminal_id: `term_${overrides.pane_id}`,
		workspace_id: 'w4',
		tab_id: 'w4:t9',
		focused: false,
		agent_status: 'idle',
		revision: 1,
		...overrides,
	};
}

interface Fake {
	host: ActionHost;
	actions: HerdrActions;
	calls: { method: string; params: unknown }[];
	notices: string[];
	opened: string[];
	responses: Map<string, unknown>;
	taken: Set<string>;
	clock: { now: number };
}

function fake(options: {
	settings?: HerdrSettings;
	workspaceId?: string | null;
	responses?: Record<string, unknown>;
	/** Agent panes the scope would report, for the split choice (issue #29). */
	agentPanes?: AgentPaneSummary[];
} = {}): Fake {
	const calls: { method: string; params: unknown }[] = [];
	const notices: string[] = [];
	const opened: string[] = [];
	const taken = new Set<string>();
	const clock = { now: 0 };
	const responses = new Map<string, unknown>(
		Object.entries(options.responses ?? {}),
	);
	const host: ActionHost = {
		settings: () => options.settings ?? settings(),
		workspaceId: () => (options.workspaceId === undefined ? 'w4' : options.workspaceId),
		request: async <T,>(method: string, params: unknown): Promise<T> => {
			calls.push({ method, params });
			const entry = responses.get(method);
			const value = typeof entry === 'function' ? (entry as () => unknown)() : entry;
			if (value instanceof Error) throw value;
			return value as T;
		},
		takenAgentNames: () => new Set(taken),
		agentPanes: () => options.agentPanes ?? [],
		vaultName: () => 'hvelv',
		notice: (message) => notices.push(message),
		openTerminal: async (paneId) => {
			opened.push(paneId);
		},
		sleep: async (ms) => {
			clock.now += ms;
		},
		now: () => clock.now,
	};
	return { host, actions: new HerdrActions(host), calls, notices, opened, responses, taken, clock };
}

describe('normalizePosixPath', () => {
	it('collapses slashes, dots and parents', () => {
		expect(normalizePosixPath('/a//b/./c')).toBe('/a/b/c');
		expect(normalizePosixPath('/a/b/../c')).toBe('/a/c');
		expect(normalizePosixPath('/..')).toBe('/');
		expect(normalizePosixPath('a/b/')).toBe('a/b');
		expect(normalizePosixPath('')).toBe('.');
	});
});

describe('resolveFolderPath', () => {
	it('resolves vault-relative paths against the vault base path', () => {
		expect(resolveFolderPath('projects/herdr', { basePath: VAULT })).toBe(
			`${VAULT}/projects/herdr`,
		);
	});

	it('maps the vault root itself', () => {
		expect(resolveFolderPath('', { basePath: VAULT })).toBe(VAULT);
		expect(resolveFolderPath('/', { basePath: VAULT })).toBe('/');
		expect(resolveFolderPath('.', { basePath: VAULT })).toBe(VAULT);
	});

	it('prefers the remote vault path when a remote profile is on', () => {
		expect(
			resolveFolderPath('notes', { basePath: VAULT, remoteVaultPath: '/home/lasse/hvelv' }),
		).toBe('/home/lasse/hvelv/notes');
	});

	it('ignores an empty remote path and a trailing slash on the root', () => {
		expect(resolveFolderPath('notes', { basePath: `${VAULT}/`, remoteVaultPath: '  ' })).toBe(
			`${VAULT}/notes`,
		);
	});

	it('passes an absolute path through', () => {
		expect(resolveFolderPath('/tmp/x', { basePath: VAULT })).toBe('/tmp/x');
	});

	// Came from the deleted ssh.ts `resolveCwd`, which this helper replaces.
	it('normalises leading dots and trailing slashes', () => {
		const roots = { basePath: VAULT, remoteVaultPath: '/home/lasse/hvelv/' };
		expect(resolveFolderPath('./notes/', roots)).toBe('/home/lasse/hvelv/notes');
		expect(resolveFolderPath('.', roots)).toBe('/home/lasse/hvelv');
	});

	it('handles spaces and unicode in folder names', () => {
		expect(resolveFolderPath('Møter og notater/2026', { basePath: VAULT })).toBe(
			`${VAULT}/Møter og notater/2026`,
		);
	});
});

describe('folderName', () => {
	it('takes the last segment', () => {
		expect(folderName('/a/b/c')).toBe('c');
		expect(folderName('/a/b/c/')).toBe('c');
		expect(folderName('/')).toBe('/');
	});
});

describe('sanitizeAgentName', () => {
	const cases: [string, string][] = [
		['notes', 'notes'],
		['My Notes', 'my-notes'],
		['Møter og notater', 'm-ter-og-notater'],
		['2026-planning', 'a-2026-planning'],
		['---', 'agent'],
		['', 'agent'],
		['__weird__', 'weird'],
		['UPPER_CASE-1', 'upper_case-1'],
	];

	for (const [input, expected] of cases) {
		it(`turns ${JSON.stringify(input)} into ${expected}`, () => {
			expect(sanitizeAgentName(input)).toBe(expected);
		});
	}

	it('always produces a name herdr accepts', () => {
		const inputs = ['x'.repeat(80), '漢字', '1', 'a b  c', 'trailing-', '.hidden'];
		for (const input of inputs) {
			expect(sanitizeAgentName(input)).toMatch(AGENT_NAME_RE);
		}
	});
});

describe('buildAgentName', () => {
	it('expands {folder} and {vault}', () => {
		expect(buildAgentName('{vault}-{folder}', { folder: 'Notes', vault: 'hvelv' })).toBe(
			'hvelv-notes',
		);
	});

	it('adds a suffix when the name is taken', () => {
		const taken = new Set(['notes', 'notes-2']);
		expect(buildAgentName('{folder}', { folder: 'notes', vault: 'hvelv' }, taken)).toBe('notes-3');
	});

	it('uses {n} in place of a suffix when the pattern has one', () => {
		const taken = new Set(['notes-1', 'notes-2']);
		expect(buildAgentName('{folder}-{n}', { folder: 'notes', vault: 'hvelv' }, taken)).toBe(
			'notes-3',
		);
	});

	it('keeps the suffixed name inside the 32-character limit', () => {
		const long = 'a'.repeat(40);
		const taken = new Set([sanitizeAgentName(long)]);
		const name = buildAgentName('{folder}', { folder: long, vault: 'hvelv' }, taken);
		expect(name).toMatch(AGENT_NAME_RE);
		expect(name.length).toBeLessThanOrEqual(32);
	});
});

describe('HerdrActions.newTabHere', () => {
	it('creates a tab in the scoped workspace with cwd and label', async () => {
		const f = fake({
			responses: { 'tab.create': { tab: { tab_id: 'w4:t9', label: 'notes' } } },
		});
		await f.actions.newTabHere(`${VAULT}/notes`);
		expect(f.calls).toEqual([
			{
				method: 'tab.create',
				params: { workspace_id: 'w4', cwd: `${VAULT}/notes`, label: 'notes', focus: true },
			},
		]);
		expect(f.notices[0]).toContain('notes');
	});

	it('does nothing without a scoped workspace', async () => {
		const f = fake({ workspaceId: null });
		await f.actions.newTabHere(`${VAULT}/notes`);
		expect(f.calls).toHaveLength(0);
		expect(f.notices[0]).toContain('no herdr workspace');
	});

	it('refuses when a remote profile has no remote vault path (S5, M19)', async () => {
		const f = fake({
			settings: settings({
				remote: {
					enabled: true,
					host: 'lasse@xl',
					remoteSocketPath: '',
					remoteBinary: '',
					remoteVaultPath: '   ',
				},
			}),
		});
		// A local macOS path would otherwise be sent to the Linux host.
		expect(await f.actions.newTabHere('/Users/lasse/Vaults/hvelv/notes')).toBeNull();
		expect(await f.actions.splitHere('/Users/lasse/Vaults/hvelv/notes')).toBeNull();
		expect(await f.actions.startAgentHere('/Users/lasse/Vaults/hvelv/notes')).toBeNull();
		expect(f.calls).toHaveLength(0);
		expect(f.notices.join(' ')).toMatch(/remote vault path/);
	});

	it('reports a herdr error as a notice', async () => {
		const f = fake({
			responses: { 'tab.create': () => new HerdrError('tab_create_failed', 'no space left') },
		});
		await f.actions.newTabHere(`${VAULT}/notes`);
		expect(f.notices[0]).toContain('tab_create_failed');
	});
});

describe('HerdrActions.splitHere', () => {
	it('splits right in the scoped workspace with the folder as cwd', async () => {
		const f = fake({ responses: { 'pane.split': { pane: pane({ pane_id: 'w4:p5' }) } } });
		const result = await f.actions.splitHere(`${VAULT}/notes`);
		expect(result?.pane_id).toBe('w4:p5');
		expect(f.calls[0]).toEqual({
			method: 'pane.split',
			params: { direction: 'right', workspace_id: 'w4', cwd: `${VAULT}/notes`, focus: true },
		});
	});
});

describe('HerdrActions.startAgentHere', () => {
	it('creates a tab, waits for the pane, then starts the agent', async () => {
		const f = fake({
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': { agent: { name: 'notes' } },
			},
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started).toEqual({ tabId: 'w4:t9', paneId: 'w4:p9', name: 'notes', kind: 'claude' });
		expect(f.calls.map((c) => c.method)).toEqual(['tab.create', 'pane.list', 'agent.start']);
		expect(f.calls.at(2)?.params).toEqual({ name: 'notes', kind: 'claude', pane_id: 'w4:p9' });
		expect(f.opened).toEqual(['w4:p9']);
	});

	it('polls pane.list until the pane appears', async () => {
		let call = 0;
		const f = fake({
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' } },
				'pane.list': () =>
					++call < 3 ? { panes: [] } : { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started?.paneId).toBe('w4:p9');
		expect(call).toBe(3);
	});

	it('gives up when no pane ever appears', async () => {
		const f = fake({
			responses: { 'tab.create': { tab: { tab_id: 'w4:t9' } }, 'pane.list': { panes: [] } },
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started).toBeNull();
		expect(f.notices.at(-1)).toContain('never reported a pane');
		expect(f.calls.some((c) => c.method === 'agent.start')).toBe(false);
	});

	it('retries once with a fresh name when herdr says the name is taken', async () => {
		let attempts = 0;
		const f = fake({
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': () =>
					++attempts === 1 ? new HerdrError('agent_name_taken', 'name in use') : {},
			},
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started?.name).toBe('notes-2');
		expect(attempts).toBe(2);
	});

	it('retries the start while the new pane is still reaching a shell prompt (M20)', async () => {
		let attempts = 0;
		const f = fake({
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': () =>
					++attempts < 3
						? new HerdrError('agent_pane_busy', 'agent target pane w4:p9 is not an available shell')
						: {},
			},
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started?.paneId).toBe('w4:p9');
		expect(attempts).toBe(3);
	});

	it('gives up on a pane that never reaches a prompt, and says why', async () => {
		const f = fake({
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': () => new HerdrError('agent_pane_unavailable', 'no live terminal'),
			},
		});
		expect(await f.actions.startAgentHere(`${VAULT}/notes`)).toBeNull();
		expect(f.notices.at(-1)).toContain('agent_pane_unavailable');
		// The retry window is bounded; the fake clock only moves when we sleep.
		expect(f.clock.now).toBeGreaterThanOrEqual(AGENT_START_RETRY_MS);
	});

	it('does not open the terminal when the setting is off', async () => {
		const f = fake({
			settings: settings({ openTerminalAfterStart: false, defaultAgentKind: 'codex' }),
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(`${VAULT}/notes`);
		expect(started?.kind).toBe('codex');
		expect(f.opened).toHaveLength(0);
	});
});

describe('HerdrActions.focusPane', () => {
	it('calls pane.focus and reports failures', async () => {
		const ok = fake({ responses: { 'pane.focus': { pane: pane({ pane_id: 'w4:p1' }) } } });
		expect(await ok.actions.focusPane('w4:p1')).toBe(true);
		expect(ok.calls[0]).toEqual({ method: 'pane.focus', params: { pane_id: 'w4:p1' } });

		const bad = fake({
			responses: { 'pane.focus': () => new HerdrError('pane_not_found', 'gone') },
		});
		expect(await bad.actions.focusPane('w4:p1')).toBe(false);
		expect(bad.notices[0]).toContain('pane_not_found');
	});
});

/**
 * Issue #29. The choice is pure, so everything about which tab wins is asserted
 * here; the `startAgentHere` cases below only check that the choice is acted on,
 * against the same fake client as the rest of this file.
 */
describe('chooseSplitTarget (issue #29)', () => {
	const NOTES = `${VAULT}/notes`;

	function agentPane(
		paneId: string,
		tabId: string,
		cwd: string,
		statusChangedSeq = 0,
	): AgentPaneSummary {
		return { paneId, tabId, cwd, statusChangedSeq };
	}

	it('opens a new tab when the workspace has no agents at all', () => {
		expect(chooseSplitTarget([], NOTES, 2)).toEqual({ kind: 'new-tab' });
	});

	it('splits the tab of the one agent already in the folder', () => {
		const panes = [agentPane('w4:p1', 'w4:t1', NOTES)];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({
			kind: 'split',
			paneId: 'w4:p1',
			tabId: 'w4:t1',
		});
	});

	it('opens a new tab once the folder’s tab is at the cap', () => {
		const panes = [agentPane('w4:p1', 'w4:t1', NOTES), agentPane('w4:p2', 'w4:t1', NOTES)];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({ kind: 'new-tab' });
		// Raising the cap makes the same tab eligible again.
		expect(chooseSplitTarget(panes, NOTES, 3)).toMatchObject({ kind: 'split', tabId: 'w4:t1' });
	});

	it('never splits at a cap of one, which is the old always-a-new-tab behaviour', () => {
		expect(chooseSplitTarget([agentPane('w4:p1', 'w4:t1', NOTES)], NOTES, 1)).toEqual({
			kind: 'new-tab',
		});
	});

	it('ignores agents in a sibling folder', () => {
		const panes = [agentPane('w4:p1', 'w4:t1', `${VAULT}/journal`)];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({ kind: 'new-tab' });
	});

	it('does not put a subfolder’s agent in the parent folder’s tab, or the reverse', () => {
		const parent = [agentPane('w4:p1', 'w4:t1', VAULT)];
		expect(chooseSplitTarget(parent, NOTES, 2)).toEqual({ kind: 'new-tab' });
		const child = [agentPane('w4:p1', 'w4:t1', `${NOTES}/2026`)];
		expect(chooseSplitTarget(child, NOTES, 2)).toEqual({ kind: 'new-tab' });
	});

	it('skips a tab that mixes the folder with another one', () => {
		const panes = [
			agentPane('w4:p1', 'w4:t1', NOTES),
			agentPane('w4:p2', 'w4:t1', `${VAULT}/journal`),
		];
		expect(chooseSplitTarget(panes, NOTES, 4)).toEqual({ kind: 'new-tab' });
	});

	it('picks the tab still under the cap when the folder spans two tabs', () => {
		const panes = [
			agentPane('w4:p1', 'w4:t1', NOTES),
			agentPane('w4:p2', 'w4:t1', NOTES),
			agentPane('w4:p3', 'w4:t2', NOTES),
		];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({
			kind: 'split',
			paneId: 'w4:p3',
			tabId: 'w4:t2',
		});
	});

	it('prefers the most recently active tab, and the most recent pane in it', () => {
		const panes = [
			agentPane('w4:p1', 'w4:t1', NOTES, 3),
			agentPane('w4:p2', 'w4:t2', NOTES, 7),
			agentPane('w4:p3', 'w4:t3', NOTES, 5),
		];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({
			kind: 'split',
			paneId: 'w4:p2',
			tabId: 'w4:t2',
		});
	});

	it('falls back to the first tab when nothing has a stamp yet', () => {
		const panes = [agentPane('w4:p1', 'w4:t1', NOTES), agentPane('w4:p2', 'w4:t2', NOTES)];
		expect(chooseSplitTarget(panes, NOTES, 2)).toMatchObject({ tabId: 'w4:t1' });
	});

	it('compares paths after normalisation, not as strings', () => {
		const panes = [agentPane('w4:p1', 'w4:t1', `${VAULT}//notes/`)];
		expect(chooseSplitTarget(panes, `${VAULT}/journal/../notes`, 2)).toMatchObject({
			kind: 'split',
			paneId: 'w4:p1',
		});
	});

	it('ignores panes herdr reports without a cwd or a tab', () => {
		const panes = [
			{ paneId: 'w4:p0', tabId: '', cwd: NOTES },
			{ paneId: 'w4:p1', tabId: 'w4:t1', cwd: '' },
		];
		expect(chooseSplitTarget(panes, NOTES, 2)).toEqual({ kind: 'new-tab' });
	});
});

describe('HerdrActions.startAgentHere splitting an existing tab (issue #29)', () => {
	const NOTES = `${VAULT}/notes`;

	function splitting(overrides: Parameters<typeof fake>[0] = {}): Fake {
		return fake({
			agentPanes: [{ paneId: 'w4:p1', tabId: 'w4:t1', cwd: NOTES, statusChangedSeq: 0 }],
			responses: {
				'pane.split': { pane: pane({ pane_id: 'w4:p2', tab_id: 'w4:t1' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p2', tab_id: 'w4:t1' })] },
				'agent.start': {},
			},
			...overrides,
		});
	}

	it('splits the folder’s tab and starts the agent in the new pane', async () => {
		const f = splitting();
		const started = await f.actions.startAgentHere(NOTES);
		expect(started).toEqual({ tabId: 'w4:t1', paneId: 'w4:p2', name: 'notes', kind: 'claude' });
		expect(f.calls.map((c) => c.method)).toEqual(['pane.split', 'pane.list', 'agent.start']);
		expect(f.calls[0]?.params).toEqual({
			direction: 'right',
			target_pane_id: 'w4:p1',
			cwd: NOTES,
			focus: false,
		});
		expect(f.calls.at(2)?.params).toEqual({ name: 'notes', kind: 'claude', pane_id: 'w4:p2' });
	});

	it('creates a tab instead once the cap is reached', async () => {
		const f = fake({
			settings: settings({ panesPerTab: 1 }),
			agentPanes: [{ paneId: 'w4:p1', tabId: 'w4:t1', cwd: NOTES }],
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(NOTES);
		expect(started?.paneId).toBe('w4:p9');
		expect(f.calls.some((c) => c.method === 'pane.split')).toBe(false);
	});

	it('creates a tab when sharing a folder tab is switched off', async () => {
		const f = fake({
			settings: settings({ splitIntoFolderTab: false, panesPerTab: 4 }),
			agentPanes: [{ paneId: 'w4:p1', tabId: 'w4:t1', cwd: NOTES }],
			responses: {
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(NOTES);
		expect(started?.paneId).toBe('w4:p9');
		expect(f.calls.some((c) => c.method === 'pane.split')).toBe(false);
	});

	it('falls back to a new tab when the chosen pane is already gone', async () => {
		const f = splitting({
			responses: {
				'pane.split': () => new HerdrError('pane_not_found', 'pane w4:p1 not found'),
				'tab.create': { tab: { tab_id: 'w4:t9' }, root_pane: pane({ pane_id: 'w4:p9' }) },
				'pane.list': { panes: [pane({ pane_id: 'w4:p9', tab_id: 'w4:t9' })] },
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(NOTES);
		expect(started).toEqual({ tabId: 'w4:t9', paneId: 'w4:p9', name: 'notes', kind: 'claude' });
		expect(f.calls.map((c) => c.method)).toEqual([
			'pane.split',
			'tab.create',
			'pane.list',
			'agent.start',
		]);
		// The stale pane is a race, not something the user has to hear about.
		expect(f.notices.join(' ')).not.toContain('pane_not_found');
	});

	it('waits for the split pane itself, never for a sibling already in the tab', async () => {
		let call = 0;
		const f = splitting({
			responses: {
				'pane.split': { pane: pane({ pane_id: 'w4:p2', tab_id: 'w4:t1' }) },
				'pane.list': () =>
					++call < 2
						? { panes: [pane({ pane_id: 'w4:p1', tab_id: 'w4:t1' })] }
						: {
								panes: [
									pane({ pane_id: 'w4:p1', tab_id: 'w4:t1' }),
									pane({ pane_id: 'w4:p2', tab_id: 'w4:t1' }),
								],
							},
				'agent.start': {},
			},
		});
		const started = await f.actions.startAgentHere(NOTES);
		expect(started?.paneId).toBe('w4:p2');
		expect(call).toBe(2);
	});
});
