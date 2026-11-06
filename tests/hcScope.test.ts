/**
 * herdr-core's model and scope (ADR-0005): the reducer, the status mapping,
 * what counts as an agent, the scope order, and the rows and events the
 * agent list reads.
 */
import { describe, expect, it } from 'vitest';
import {
	agentKindOf,
	hcAgentStatus,
	parseSpaces,
	parseTerminal,
	resolveHcScope,
	spaceTabLabels,
	TerminalStore,
	type HcTerminal,
} from '../src/hc/model';
import { HcScope } from '../src/hc/scope';
import { HcTabLabels } from '../src/hc/tabLabels';

const SPACE = 'sp98766016402902b74461b6dcbed63cc7';

/** Shaped like the live `t2` record of 2026-11-05 ([[herdr-core-api]] §5). */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		address: 't2',
		argv: ['/usr/bin/bash'],
		cols: 191,
		rows: 42,
		created_ms: 1,
		cwd: '/home/lasse',
		foreground: { argv: ['/home/lasse/.local/share/mise/installs/claude/latest/claude'], cwd: '/home/lasse/hvelv', name: 'claude', pid: 57315 },
		keep: true,
		labels: { 'herdr.seen': '7', 'herdr.space': SPACE, 'herdr.tab': 'tb1', where: 'hvelv / 1' },
		name: null,
		reported: true,
		screen: 'exact',
		state: 'live',
		status: { app: 'claude-code', state: 'done' },
		title: '✳ Herdr machine tabs',
		turn: 7,
		...overrides,
	};
}

function terminal(overrides: Record<string, unknown> = {}): HcTerminal {
	const parsed = parseTerminal(record(overrides));
	if (!parsed) throw new Error('bad record');
	return parsed;
}

const DOC = {
	spaces: [
		{ id: 'sp-other', name: 'sysadmin', folder: '/home/lasse', tabs: [] },
		{
			id: SPACE,
			name: 'hvelv',
			folder: '/home/lasse/hvelv',
			tabs: [
				{ id: 'tb1', name: '', root: {} },
				{ id: 'tb2', name: 'Claude Code', root: {} },
			],
		},
	],
};

/**
 * Shaped like the Mac's `doc.get {name: "herdr-app"}` of 2026-11-06: three
 * spaces, every one `name: ""` and `folder: "/Users/lasse"`; Herdr UI shows
 * the second as "hvelv" after its first terminal, `t13`.
 */
const MAC_DOC = {
	spaces: [
		{ id: 'sp-mac-1', name: '', folder: '/Users/lasse', tabs: [{ id: 'tb-m1', name: '', root: { id: 'tb-m1', type: 'row', children: [{ id: 'p4', type: 'block', content: { terminal: 't4' } }] } }] },
		{
			id: 'sp-mac-2',
			name: '',
			folder: '/Users/lasse',
			tabs: [
				{ id: 'tb-m2', name: '', root: { id: 'tb-m2', type: 'row', children: [{ id: 'p13', type: 'block', content: { terminal: 't13' } }, { id: 'p14', type: 'block', content: { terminal: 't14' } }] } },
				{ id: 'tb-m3', name: '', root: { id: 'tb-m3', type: 'row', children: [{ id: 'p15', type: 'block', content: { terminal: 't15' } }] } },
			],
		},
		{ id: 'sp-mac-3', name: '', folder: '/Users/lasse', tabs: [{ id: 'tb-m4', name: '', root: { id: 'tb-m4', type: 'row', children: [] } }] },
	],
};

describe('status mapping', () => {
	const cases: [string | null, number, string | undefined, string][] = [
		['working', 3, '1', 'working'],
		['blocked', 3, '3', 'blocked'],
		['error', 0, undefined, 'blocked'],
		['done', 7, '7', 'idle'],
		['done', 8, '7', 'done'],
		['idle', 8, '7', 'done'],
		['idle', 7, '7', 'idle'],
		// No `herdr.seen`: as reported. A missing label is not 0.
		['done', 7, undefined, 'done'],
		['idle', 7, undefined, 'idle'],
		[null, 0, undefined, 'unknown'],
		['clear', 0, undefined, 'unknown'],
	];
	for (const [state, turn, seen, expected] of cases) {
		it(`${state ?? 'never reported'}, turn ${turn}, seen ${seen ?? 'missing'} is ${expected}`, () => {
			const labels: Record<string, string> = seen === undefined ? {} : { 'herdr.seen': seen };
			expect(hcAgentStatus({ status: state ? { state, app: 'x' } : null, turn, labels })).toBe(expected);
		});
	}
});

describe('what counts as an agent', () => {
	it('is a reported status.app, mapped onto the plugin’s kinds', () => {
		expect(agentKindOf(terminal())).toBe('claude');
		expect(agentKindOf(terminal({ status: { app: 'cursor-agent', state: 'idle' } }))).toBe('cursor');
		expect(agentKindOf(terminal({ status: { app: 'brand-new', state: 'idle' } }))).toBe('brand-new');
	});

	it('or a known agent in the foreground when it never reported', () => {
		// asher/t8: `env … cswap run …` in argv, claude in the foreground, no status.
		const t8 = terminal({ status: null, reported: false, argv: ['env', 'CONTAINER=1', 'cswap'], foreground: { name: 'claude', argv: ['/usr/local/bin/claude'], cwd: '/srv', pid: 1 } });
		expect(agentKindOf(t8)).toBe('claude');
		const gemini = terminal({ status: null, foreground: { name: 'node', argv: ['node', '/usr/lib/node_modules/@google/gemini-cli/dist/gemini.js'], cwd: '/', pid: 1 } });
		expect(agentKindOf(gemini)).toBe('gemini');
	});

	it('or a known agent as the process title: node retitled to pi (Mac hc, 2026-11-06)', () => {
		const pi = terminal({ status: null, foreground: { name: 'node', argv: ['pi', ''], cwd: '/', pid: 1 } });
		expect(agentKindOf(pi)).toBe('pi');
		const path = terminal({ status: null, foreground: { name: 'node', argv: ['/opt/homebrew/bin/codex'], cwd: '/', pid: 1 } });
		expect(agentKindOf(path)).toBe('codex');
	});

	it('or the kind the plugin started it as, when the foreground says nothing known', () => {
		const started = { 'obsidian-herdr.agent': 'pi' };
		expect(agentKindOf(terminal({ status: null, labels: started, foreground: { name: 'node', argv: ['node', ''], cwd: '/', pid: 1 } }))).toBe('pi');
		expect(agentKindOf(terminal({ status: null, labels: started, foreground: null }))).toBe('pi');
		// What the terminal reports or runs still wins over the label.
		expect(agentKindOf(terminal({ status: { app: 'codex', state: 'idle' }, labels: started }))).toBe('codex');
		expect(agentKindOf(terminal({ status: null, labels: started, foreground: { name: 'claude', argv: ['claude'], cwd: '/', pid: 1 } }))).toBe('claude');
		expect(agentKindOf(terminal({ status: null, labels: { 'obsidian-herdr.agent': ' ' }, foreground: null }))).toBeNull();
	});

	it('and not a shell or an ordinary program', () => {
		expect(agentKindOf(terminal({ status: null, foreground: { name: 'bash', argv: ['bash'], cwd: '/', pid: 1 } }))).toBeNull();
		expect(agentKindOf(terminal({ status: null, foreground: { name: 'node', argv: ['node', 'server.js'], cwd: '/', pid: 1 } }))).toBeNull();
		expect(agentKindOf(terminal({ status: null, foreground: null }))).toBeNull();
	});
});

describe('the reducer', () => {
	it('applies events above the snapshot’s seq and ignores older ones', () => {
		const store = new TerminalStore();
		store.reset(100, [record()]);
		expect(store.apply({ seq: 99, type: 'title', terminal: 't2', data: { title: 'old' } })).toBe(false);
		expect(store.apply({ seq: 101, type: 'title', terminal: 't2', data: { title: 'new' } })).toBe(true);
		expect(store.get('t2')?.title).toBe('new');
		store.apply({ seq: 102, type: 'status', terminal: 't2', data: { status: { state: 'working', app: 'claude-code' }, records: {}, reported: true } });
		store.apply({ seq: 103, type: 'turn', terminal: 't2', data: { turn: 8, state: 'done' } });
		expect(store.get('t2')).toMatchObject({ status: { state: 'working' }, turn: 8 });
		store.apply({ seq: 104, type: 'labels', terminal: 't2', data: { labels: { 'herdr.pinned': '1' } } });
		expect(store.get('t2')?.labels).toEqual({ 'herdr.pinned': '1' });
		store.apply({ seq: 105, type: 'created', terminal: 't9', data: record({ address: 't9' }) });
		store.apply({ seq: 106, type: 'finished', terminal: 't9', data: { reason: 'exited' } });
		expect(store.get('t9')).toMatchObject({ state: 'finished', foreground: null, status: null });
		store.apply({ seq: 107, type: 'removed', terminal: 't9', data: {} });
		expect(store.get('t9')).toBeUndefined();
	});

	it('replaces everything on `missed`', () => {
		const store = new TerminalStore();
		store.reset(10, [record(), record({ address: 't4' })]);
		store.reset(500, [record({ address: 't5' })]);
		expect(store.all().map((t) => t.address)).toEqual(['t5']);
		expect(store.lastSeq).toBe(500);
	});
});

describe('scope resolution', () => {
	const spaces = parseSpaces(DOC);

	it('takes the override first, by id or by name', () => {
		expect(resolveHcScope(spaces, { space: 'sysadmin', vaultName: 'hvelv', root: '/v' })).toMatchObject({ kind: 'space', id: 'sp-other', method: 'setting' });
		expect(resolveHcScope(spaces, { space: SPACE, vaultName: 'x', root: '/v' })).toMatchObject({ id: SPACE, name: 'hvelv' });
		// An id herdr-app has not written yet is still what the user asked for.
		expect(resolveHcScope(spaces, { space: 'sp-new', vaultName: 'x', root: '/v' })).toMatchObject({ id: 'sp-new', method: 'setting' });
	});

	it('then the space named like the vault, then cwd under the root', () => {
		expect(resolveHcScope(spaces, { vaultName: 'HVELV', root: '/v' })).toMatchObject({ id: SPACE, method: 'label' });
		expect(resolveHcScope(spaces, { vaultName: 'notes', root: '/v' })).toEqual({ kind: 'cwd', root: '/v', method: 'cwd' });
		expect(resolveHcScope([], { vaultName: '', root: '' })).toEqual({ kind: 'none', method: 'none' });
	});

	it('finds each space’s first terminal in its tabs’ layout, as herdr-app walks it', () => {
		const first = parseSpaces(MAC_DOC).map((space) => space.firstTerminal);
		expect(first).toEqual(['t4', 't13', null]);
		// Node before children, children in order, across tabs in order.
		const nested = parseSpaces({
			spaces: [{ id: 's', name: '', folder: '/', tabs: [
				{ id: 'a', name: '', root: { id: 'a', type: 'row', children: [] } },
				{ id: 'b', name: '', root: { id: 'b', type: 'column', children: [
					{ id: 'x', type: 'stack', children: [{ id: 'y', type: 'block', content: { mod: 'files' } }, { id: 'z', type: 'block', content: { terminal: 't8' } }] },
					{ id: 'w', type: 'block', content: { terminal: 't9' } },
				] } },
			] }],
		});
		expect(nested[0]?.firstTerminal).toBe('t8');
	});

	it('then an unnamed space whose first terminal runs in the vault (Mac hc, 2026-11-06)', () => {
		const mac = parseSpaces(MAC_DOC);
		const cwds: Record<string, string> = { t4: '/Users/lasse/code/x', t13: '/Users/lasse/Vaults/hvelv' };
		const options = { vaultName: 'hvelv', root: '/Users/lasse/Vaults/hvelv', terminalCwd: (a: string) => cwds[a] };
		expect(resolveHcScope(mac, options)).toEqual({ kind: 'space', id: 'sp-mac-2', name: 'hvelv', method: 'label' });
		// Inside the vault counts too: git top is not on the wire, the cwd is.
		cwds.t13 = '/Users/lasse/Vaults/hvelv/notes';
		expect(resolveHcScope(mac, options)).toMatchObject({ id: 'sp-mac-2' });
		// Several qualify: the first in document order.
		cwds.t4 = '/Users/lasse/Vaults/hvelv';
		expect(resolveHcScope(mac, options)).toMatchObject({ id: 'sp-mac-1' });
		// Out of the vault, or not listed: the space's folder (here home), so cwd mode.
		expect(resolveHcScope(mac, { ...options, terminalCwd: () => undefined })).toEqual({ kind: 'cwd', root: '/Users/lasse/Vaults/hvelv', method: 'cwd' });
		expect(resolveHcScope(mac, { ...options, terminalCwd: () => '/Users/lasse/Vaults/hvelv2' })).toMatchObject({ kind: 'cwd' });
		// A space with no terminal is named after its folder.
		const empty = parseSpaces({ spaces: [{ id: 'sp-e', name: '', folder: '/Users/lasse/Vaults/hvelv', tabs: [] }] });
		expect(resolveHcScope(empty, options)).toMatchObject({ id: 'sp-e', method: 'label' });
		// A stored name still wins, and a named space is never matched by its terminal.
		const named = parseSpaces({ spaces: [{ ...MAC_DOC.spaces[1], name: 'work' }, { id: 'sp-h', name: 'hvelv', folder: '/', tabs: [] }] });
		expect(resolveHcScope(named, options)).toMatchObject({ id: 'sp-h' });
		expect(resolveHcScope(named.slice(0, 1), options)).toMatchObject({ kind: 'cwd' });
	});

	it('labels tabs by name, or by position like herdr-app’s `where`', () => {
		expect([...spaceTabLabels(spaces[1] ?? null)]).toEqual([
			['tb1', '1'],
			['tb2', 'Claude Code'],
		]);
	});
});

function scope(options: Partial<ConstructorParameters<typeof HcScope>[0]> = {}) {
	const s = new HcScope({ space: '', vaultPath: '/home/lasse/hvelv', vaultName: 'hvelv', ...options });
	const events: string[] = [];
	s.on('added', (pane) => events.push(`added ${pane.paneId}`));
	s.on('removed', (pane) => events.push(`removed ${pane.paneId}`));
	s.on('changed', (paneId, _prev, next) => events.push(`changed ${paneId} ${next.agentStatus}`));
	s.on('workspaceResolved', (id, method) => events.push(`resolved ${id} ${method}`));
	return { s, events };
}

describe('HcScope', () => {
	it('stays unresolved until the spaces are read, then lists the space’s agents', () => {
		const { s, events } = scope();
		s.reset(1, [record(), record({ address: 't3', labels: { 'herdr.space': 'sp-other' } }), record({ address: 't6', status: null, foreground: { name: 'bash', argv: [], cwd: '/', pid: 1 } })]);
		expect(s.workspaceId).toBeNull();
		expect(s.list()).toEqual([]);
		s.setSpaces(parseSpaces(DOC));
		expect(events).toEqual([`resolved ${SPACE} label`, 'added t2']);
		expect(s.get('t2')).toMatchObject({ agent: 'claude', agentStatus: 'idle', tabId: 'tb1', title: 'Herdr machine tabs', cwd: '/home/lasse/hvelv', pinned: false });
		expect(s.space).toEqual({ id: SPACE, name: 'hvelv' });
	});

	it('falls back to terminals under the vault when no space matches', () => {
		const { s } = scope({ vaultName: 'notes' });
		s.reset(1, [record({ labels: {} }), record({ address: 't7', labels: {}, foreground: { name: 'claude', argv: [], cwd: '/home/lasse/elsewhere', pid: 1 } })]);
		s.setSpaces([]);
		expect(s.method).toBe('cwd');
		expect(s.list().map((row) => row.paneId)).toEqual(['t2']);
		expect(s.space).toBeNull();
	});

	it('resolves the unnamed space Herdr UI calls after the vault, from its first terminal’s cwd', () => {
		const { s, events } = scope({ vaultPath: '/Users/lasse/Vaults/hvelv' });
		const t13 = record({ address: 't13', cwd: '/Users/lasse', foreground: { name: 'claude', argv: ['claude'], cwd: '/Users/lasse/Vaults/hvelv', pid: 9 }, labels: { 'herdr.space': 'sp-mac-2', 'herdr.tab': 'tb-m2' } });
		s.reset(1, [record({ address: 't4', cwd: '/Users/lasse', foreground: null, labels: { 'herdr.space': 'sp-mac-1' } }), t13]);
		s.setSpaces(parseSpaces(MAC_DOC));
		expect(events).toEqual(['resolved sp-mac-2 label', 'added t13']);
		expect(s.space).toEqual({ id: 'sp-mac-2', name: 'hvelv' });
		expect(s.workspaceLabel).toBe('hvelv');
	});

	it('leaves federated machine/tN terminals out (ADR-0004)', () => {
		const { s } = scope({ vaultName: 'notes' });
		s.reset(1, [record({ address: 'asher/t1', labels: {} })]);
		s.setSpaces([]);
		expect(s.list()).toEqual([]);
	});

	it('emits only renderable changes, and stamps status transitions', () => {
		const { s, events } = scope();
		s.reset(1, [record()]);
		s.setSpaces(parseSpaces(DOC));
		events.length = 0;
		s.ingest({ seq: 2, type: 'foreground', terminal: 't2', data: { name: 'claude', argv: [], cwd: '/home/lasse/hvelv', pid: 57315 } });
		s.ingest({ seq: 3, type: 'size', terminal: 't2', data: { cols: 80, rows: 24 } });
		expect(events).toEqual([]);
		s.ingest({ seq: 4, type: 'status', terminal: 't2', data: { status: { state: 'working', app: 'claude-code' }, reported: true } });
		s.ingest({ seq: 5, type: 'status', terminal: 't2', data: { status: { state: 'done', app: 'claude-code' }, reported: true } });
		s.ingest({ seq: 6, type: 'turn', terminal: 't2', data: { turn: 8, state: 'done' } });
		expect(events).toEqual(['changed t2 working', 'changed t2 idle', 'changed t2 done']);
		expect(s.get('t2')?.statusChangedSeq).toBe(3);
	});

	it('repaints a pin set anywhere, through the shared label', () => {
		const { s, events } = scope();
		s.reset(1, [record()]);
		s.setSpaces(parseSpaces(DOC));
		events.length = 0;
		s.ingest({ seq: 2, type: 'labels', terminal: 't2', data: { labels: { ...record().labels as object, 'herdr.pinned': '1' } } });
		expect(events).toEqual(['changed t2 idle']);
		expect(s.pinnedPaneIds()).toEqual(['t2']);
	});

	it('drops a row on finish and on `missed` without it, and re-reads the document on its event', () => {
		const { s, events } = scope();
		let docReads = 0;
		s.onDocChanged(() => docReads++);
		s.reset(1, [record(), record({ address: 't4' })]);
		s.setSpaces(parseSpaces(DOC));
		events.length = 0;
		s.ingest({ seq: 2, type: 'finished', terminal: 't4', data: {} });
		s.reset(50, []);
		expect(events).toEqual(['removed t4', 'removed t2']);
		s.ingest({ seq: 51, type: 'doc', data: { name: 'herdr-app', version: 6 } });
		s.ingest({ seq: 52, type: 'doc', data: { name: 'something-else', version: 1 } });
		expect(docReads).toBe(1);
	});

	it('knows every live name on the core, for a new agent’s name', () => {
		const { s } = scope();
		s.reset(1, [record({ name: 'vault-maintenance', labels: {} }), record({ address: 't3', name: 'gone', state: 'finished' })]);
		expect([...s.agentNames()]).toEqual(['vault-maintenance']);
	});

	it('gives tab labels from the resolved space', () => {
		const { s } = scope();
		const labels = new HcTabLabels(s);
		let told = 0;
		labels.subscribe(() => told++);
		s.reset(1, [record()]);
		s.setSpaces(parseSpaces(DOC));
		expect(labels.get('tb2')).toBe('Claude Code');
		expect(told).toBeGreaterThan(0);
		labels.dispose();
	});
});
