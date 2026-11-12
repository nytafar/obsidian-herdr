/**
 * Settings-side pure bits: the remote vault path check both the folder actions
 * and the status ask, and the status itself: the root's one line
 * (`connectionSummary`) and the active runtime's Status group
 * (`connectionDetails`), both plain lines, no DOM needed.
 */

import { describe, expect, it } from 'vitest';
import {
	clampPanesPerTab,
	cursorOptions,
	clampScrollbackMb,
	DEFAULT_PANES_PER_TAB,
	DEFAULT_SCROLLBACK_MB,
	DEFAULT_SETTINGS,
	MAX_PANES_PER_TAB,
	MAX_SCROLLBACK_MB,
	MIN_PANES_PER_TAB,
	MIN_SCROLLBACK_MB,
	normalizeTerminalPlacement,
	normalizeTerminalTab,
	normalizeTerminalTitleSource,
	isPanePinned,
	normalizePinnedPanes,
	pinnedPaneIds,
	migrateRenderMode,
	withoutRemovedSettings,
	connectionDetails,
	connectionSummary,
	renderStatusLines,
	togglePanePin,
	SCROLLBACK_BYTES_PER_MB,
	scrollbackBytes,
	type ConnectionStatus,
} from '../src/settings';
import {
	defaultLocalRuntime,
	newRuntime,
	remoteVaultPathIssue,
	type RuntimeConfig,
} from '../src/runtimes';

/** The local herdr, or an SSH herdr runtime with these fields. */
function runtime(ssh?: Partial<RuntimeConfig>): RuntimeConfig {
	if (!ssh) return defaultLocalRuntime();
	return { ...newRuntime('herdr', 'ssh', [], () => 0.25), ...ssh };
}

function status(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
	return {
		runtime: defaultLocalRuntime(),
		unavailable: null,
		details: null,
		discovery: null,
		mismatch: false,
		error: null,
		state: 'connected',
		...overrides,
	};
}

/** The Status group's lines for this runtime and state. */
function render(rt: RuntimeConfig, st: ConnectionStatus): { text: string; warning: boolean }[] {
	return connectionDetails({ ...st, runtime: rt });
}

describe('remoteVaultPathIssue (S5, M19)', () => {
	it('is silent for a local runtime', () => {
		expect(remoteVaultPathIssue(runtime())).toBeNull();
	});

	it('flags an SSH runtime without a remote vault path', () => {
		expect(remoteVaultPathIssue(runtime({ remoteVaultPath: '  ' }))).toMatch(/remote vault path/);
		expect(remoteVaultPathIssue(runtime({ remoteVaultPath: '/home/lasse/hvelv' }))).toBeNull();
	});
});

describe('connectionSummary', () => {
	it('names the active runtime and says it is connected', () => {
		expect(connectionSummary(status({ runtime: runtime({ host: 'xl', name: 'XL' }) }))).toEqual({
			text: 'Active runtime: XL · connected',
			warning: false,
		});
	});

	it('warns while connecting, and when not connected', () => {
		expect(connectionSummary(status({ state: 'connecting' }))).toEqual({
			text: 'Active runtime: Local · connecting',
			warning: true,
		});
		expect(connectionSummary(status({ state: 'not connected', error: 'refused' }))).toEqual({
			text: 'Active runtime: Local · not connected',
			warning: true,
		});
	});

	it('warns for an error or a protocol mismatch on a live connection', () => {
		expect(connectionSummary(status({ error: 'stream dropped' })).warning).toBe(true);
		expect(connectionSummary(status({ mismatch: true })).warning).toBe(true);
	});

	it('says a runtime of an unavailable kind is not connected, whatever the state says', () => {
		expect(connectionSummary(status({ state: 'connecting', unavailable: 'not in this build' }))).toEqual({
			text: 'Active runtime: Local · not connected',
			warning: true,
		});
	});
});

describe('renderStatusLines', () => {
	it('draws a paragraph per line, warnings marked', () => {
		const drawn: { tag: string; cls: string; text: string }[] = [];
		const el = {
			createEl: (tag: string, options: { cls: string; text: string }) => drawn.push({ tag, ...options }),
		};
		renderStatusLines(el as unknown as HTMLElement, [
			{ text: 'Socket: /tmp/herdr.sock', warning: false },
			{ text: 'Workspace: none', warning: true },
		]);
		expect(drawn).toEqual([
			{ tag: 'p', cls: 'herdr-status-text', text: 'Socket: /tmp/herdr.sock' },
			{ tag: 'p', cls: 'herdr-status-text mod-warning', text: 'Workspace: none' },
		]);
	});
});

describe('connectionDetails', () => {
	it('says nothing but "not connected" before discovery ran', () => {
		expect(render(runtime(), status({ discovery: null }))).toEqual([
			{ text: 'Not connected yet.', warning: false },
		]);
	});

	it('says a runtime of an unavailable kind is not connected, whatever the state says', () => {
		expect(connectionSummary(status({ state: 'connecting', unavailable: 'not in this build' }))).toEqual({
			text: 'Active runtime: Local · not connected',
			warning: true,
		});
	});
});

describe('renderStatusLines', () => {
	it('draws a paragraph per line, warnings marked', () => {
		const drawn: { tag: string; cls: string; text: string }[] = [];
		const el = {
			createEl: (tag: string, options: { cls: string; text: string }) => drawn.push({ tag, ...options }),
		};
		renderStatusLines(el as unknown as HTMLElement, [
			{ text: 'Socket: /tmp/herdr.sock', warning: false },
			{ text: 'Workspace: none', warning: true },
		]);
		expect(drawn).toEqual([
			{ tag: 'p', cls: 'herdr-status-text', text: 'Socket: /tmp/herdr.sock' },
			{ tag: 'p', cls: 'herdr-status-text mod-warning', text: 'Workspace: none' },
		]);
	});
});

describe('connectionDetails', () => {
	it('says nothing but "not connected" before discovery ran', () => {
		expect(render(runtime(), status({ discovery: null }))).toEqual([
			{ text: 'Not connected yet.', warning: false },
		]);
	});

	it('does not name the runtime: the page is its own', () => {
		const text = render(runtime({ host: 'xl', name: 'XL' }), status()).map((line) => line.text);
		expect(text.some((line) => line.startsWith('Runtime: '))).toBe(false);
	});

	it('says a runtime of an unavailable kind is not connected, and leaves the reason to Problems', () => {
		const core = { ...newRuntime('herdr-core', 'local', [], () => 0.5), name: 'Core' };
		expect(
			render(
				core,
				status({
					discovery: null,
					unavailable: 'herdr-core runtimes are not available yet',
					error: 'herdr-core runtimes are not available yet',
				}),
			),
		).toEqual([{ text: 'Not connected. Problems, below, says why.', warning: true }]);
	});

	it('reports a failure that came before discovery', () => {
		expect(render(runtime(), status({ discovery: null, error: 'the runtime has no SSH host' }))).toEqual([
			{ text: 'The runtime has no SSH host.', warning: true },
		]);
	});

	it('passes a kind’s own lines through, the last error among them, and adds nothing', () => {
		const details = [{ text: 'Transport: hc connect' }, { text: 'Refused.', warning: true }];
		expect(render(runtime(), status({ details, error: 'refused' }))).toEqual([
			{ text: 'Transport: hc connect', warning: false },
			{ text: 'Refused.', warning: true },
		]);
	});

	it('shows the discovery layout for a kind with nothing of its own yet, as it always has (#185)', () => {
		const core = { ...newRuntime('herdr-core', 'local', [], () => 0.5), name: 'Core' };
		const discovery = {
			binary: { path: '/usr/bin/hc', source: 'directory' },
			socketPath: '',
			status: null,
			error: null,
		} as unknown as ConnectionStatus['discovery'];
		const text = render(core, status({ discovery })).map((line) => line.text);
		expect(text).toContain('Binary: /usr/bin/hc (directory)');
		expect(text).toContain('Workspace: no herdr workspace matches this vault yet.');
	});
});

describe('scrollback budget (#15 item 2)', () => {
	it('keeps a sane value untouched, as a whole number of megabytes', () => {
		expect(clampScrollbackMb(1)).toBe(MIN_SCROLLBACK_MB);
		expect(clampScrollbackMb(10)).toBe(10);
		expect(clampScrollbackMb(64)).toBe(MAX_SCROLLBACK_MB);
		expect(clampScrollbackMb(10.4)).toBe(10);
	});

	it('clamps a hand-edited data.json into range — 0 would mean unlimited', () => {
		expect(clampScrollbackMb(0)).toBe(MIN_SCROLLBACK_MB);
		expect(clampScrollbackMb(-5)).toBe(MIN_SCROLLBACK_MB);
		expect(clampScrollbackMb(4096)).toBe(MAX_SCROLLBACK_MB);
	});

	it('falls back to the default for anything that is not a finite number', () => {
		expect(clampScrollbackMb(undefined)).toBe(DEFAULT_SCROLLBACK_MB);
		expect(clampScrollbackMb('10')).toBe(DEFAULT_SCROLLBACK_MB);
		expect(clampScrollbackMb(Number.NaN)).toBe(DEFAULT_SCROLLBACK_MB);
		expect(clampScrollbackMb(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SCROLLBACK_MB);
		expect(DEFAULT_SETTINGS.terminalScrollbackMb).toBe(DEFAULT_SCROLLBACK_MB);
	});

	it('hands the renderer bytes, never a line count and never zero', () => {
		expect(scrollbackBytes({ ...DEFAULT_SETTINGS })).toBe(DEFAULT_SCROLLBACK_MB * SCROLLBACK_BYTES_PER_MB);
		expect(
			scrollbackBytes({ ...DEFAULT_SETTINGS, terminalScrollbackMb: 0 }),
		).toBe(MIN_SCROLLBACK_MB * SCROLLBACK_BYTES_PER_MB);
	});
});

describe('terminalPlacement (issue #28)', () => {
	it('defaults to splitting to the right', () => {
		expect(DEFAULT_SETTINGS.terminalPlacement).toBe('split-right');
	});

	it('passes every placement it knows through', () => {
		expect(normalizeTerminalPlacement('split-right')).toBe('split-right');
		expect(normalizeTerminalPlacement('split-left')).toBe('split-left');
		expect(normalizeTerminalPlacement('tab')).toBe('tab');
	});

	it('falls back to the default for anything else', () => {
		// A hand-edited `data.json`, or a value from a version that knows more
		// placements than this one. Before this, anything but 'tab' split.
		expect(normalizeTerminalPlacement('split-below')).toBe('split-right');
		expect(normalizeTerminalPlacement('')).toBe('split-right');
		expect(normalizeTerminalPlacement(undefined)).toBe('split-right');
		expect(normalizeTerminalPlacement(null)).toBe('split-right');
		expect(normalizeTerminalPlacement(3)).toBe('split-right');
	});
});

describe('terminalTab (issue #38)', () => {
	it('defaults to one tab per agent, the behaviour before the setting', () => {
		expect(DEFAULT_SETTINGS.terminalTab).toBe('per-agent');
	});

	it('passes both modes through and rejects anything else', () => {
		expect(normalizeTerminalTab('per-agent')).toBe('per-agent');
		expect(normalizeTerminalTab('reuse')).toBe('reuse');
		expect(normalizeTerminalTab('single')).toBe('per-agent');
		expect(normalizeTerminalTab(undefined)).toBe('per-agent');
		expect(normalizeTerminalTab(null)).toBe('per-agent');
		expect(normalizeTerminalTab(1)).toBe('per-agent');
	});
});

describe('terminalTitleSource (issue #43)', () => {
	it('defaults to the agent name, the behaviour before the setting', () => {
		expect(DEFAULT_SETTINGS.terminalTitleSource).toBe('agent');
		expect(normalizeTerminalTitleSource(undefined)).toBe('agent');
	});

	it('passes both sources through and rejects anything else', () => {
		expect(normalizeTerminalTitleSource('agent')).toBe('agent');
		expect(normalizeTerminalTitleSource('tab')).toBe('tab');
		expect(normalizeTerminalTitleSource('label')).toBe('agent');
		expect(normalizeTerminalTitleSource(7)).toBe('agent');
		expect(normalizeTerminalTitleSource(null)).toBe('agent');
	});
});

describe('panes per tab (issue #29)', () => {
	it('defaults to two, so the second agent in a folder splits its tab', () => {
		expect(DEFAULT_SETTINGS.splitIntoFolderTab).toBe(true);
		expect(DEFAULT_SETTINGS.panesPerTab).toBe(2);
		expect(DEFAULT_PANES_PER_TAB).toBe(2);
	});

	it('keeps a value inside the range as a whole number', () => {
		expect(clampPanesPerTab(1)).toBe(MIN_PANES_PER_TAB);
		expect(clampPanesPerTab(3)).toBe(3);
		expect(clampPanesPerTab(4)).toBe(MAX_PANES_PER_TAB);
		expect(clampPanesPerTab(2.4)).toBe(2);
	});

	it('clamps a hand-edited data.json into range', () => {
		expect(clampPanesPerTab(0)).toBe(MIN_PANES_PER_TAB);
		expect(clampPanesPerTab(-3)).toBe(MIN_PANES_PER_TAB);
		expect(clampPanesPerTab(99)).toBe(MAX_PANES_PER_TAB);
	});

	it('falls back to the default for anything that is not a finite number', () => {
		expect(clampPanesPerTab(undefined)).toBe(DEFAULT_PANES_PER_TAB);
		expect(clampPanesPerTab('2')).toBe(DEFAULT_PANES_PER_TAB);
		expect(clampPanesPerTab(Number.NaN)).toBe(DEFAULT_PANES_PER_TAB);
	});
});

describe('cursor settings (issue #52)', () => {
	it('defaults to a blinking block, which is what the engines already did', () => {
		expect(DEFAULT_SETTINGS.terminalCursorStyle).toBe('block');
		expect(DEFAULT_SETTINGS.terminalCursorBlink).toBe(true);
	});

	it('hands the renderer a normalised pair', () => {
		expect(cursorOptions(DEFAULT_SETTINGS)).toEqual({
			cursorStyle: 'block',
			cursorBlink: true,
		});
		expect(
			cursorOptions({
				...DEFAULT_SETTINGS,
				terminalCursorStyle: 'bar',
				terminalCursorBlink: false,
			}),
		).toEqual({ cursorStyle: 'bar', cursorBlink: false });
	});

	it('survives a data.json written by another build', () => {
		const odd = {
			...DEFAULT_SETTINGS,
			terminalCursorStyle: 'beam',
		} as unknown as typeof DEFAULT_SETTINGS;
		expect(cursorOptions(odd).cursorStyle).toBe('block');
	});
});

describe('agent list defaults (issue #20)', () => {
	it('sorts by herdr’s priority and groups by herdr tab, which is today’s look', () => {
		expect(DEFAULT_SETTINGS.agentListSort).toBe('priority');
		expect(DEFAULT_SETTINGS.agentListGroupBy).toBe('tab');
	});
});

describe('pinned panes (issue #35)', () => {
	it('pins nothing by default', () => {
		expect(DEFAULT_SETTINGS.pinnedPanes).toEqual({});
		expect(pinnedPaneIds(DEFAULT_SETTINGS, 'local')).toEqual([]);
	});

	it('keeps pins per endpoint', () => {
		const settings = { pinnedPanes: {} as Record<string, string[]> };
		expect(togglePanePin(settings, 'local', 'w4:p1')).toBe(true);
		expect(togglePanePin(settings, 'ssh:xl:/tmp/h.sock', 'w4:p1')).toBe(true);
		expect(togglePanePin(settings, 'local', 'w4:p2')).toBe(true);
		expect(pinnedPaneIds(settings, 'local')).toEqual(['w4:p1', 'w4:p2']);
		expect(pinnedPaneIds(settings, 'ssh:xl:/tmp/h.sock')).toEqual(['w4:p1']);
		expect(isPanePinned(settings, 'local', 'w4:p1')).toBe(true);
		expect(isPanePinned(settings, 'ssh:other:/x', 'w4:p1')).toBe(false);
	});

	it('unpins on the second toggle and drops an endpoint left empty', () => {
		const settings = { pinnedPanes: { local: ['w4:p1'] } };
		expect(togglePanePin(settings, 'local', 'w4:p1')).toBe(false);
		expect(isPanePinned(settings, 'local', 'w4:p1')).toBe(false);
		expect(settings.pinnedPanes).toEqual({});
	});

	it('normalises whatever data.json holds', () => {
		expect(normalizePinnedPanes(undefined)).toEqual({});
		expect(normalizePinnedPanes('nope')).toEqual({});
		expect(normalizePinnedPanes(['w4:p1'])).toEqual({});
		expect(
			normalizePinnedPanes({
				local: ['w4:p1', 3, '', 'w4:p1', 'w4:p2'],
				remote: 'w4:p1',
				empty: [],
			}),
		).toEqual({ local: ['w4:p1', 'w4:p2'] });
	});
});

describe('migrateRenderMode (issue #104)', () => {
	/**
	 * Every value `data.json` can hold for the old single render mode, and the
	 * two fields it becomes. The expected pairs come from the ticket, not from
	 * re-running the split: `native` is the native view on the default engine,
	 * an engine name is a terminal on that engine, and anything else is the
	 * default pair, which since 0.4.0 is the native view; a file that chose an
	 * engine before the split keeps its terminal (migrated, written back once).
	 */
	const table: [string, unknown, { defaultView: string; terminalEngine: string; migrated: boolean }][] =
		[
			[
				'the v1 default engine',
				{ terminalEngine: 'ghostty-web' },
				{ defaultView: 'terminal', terminalEngine: 'ghostty-web', migrated: true },
			],
			[
				'the other engine',
				{ terminalEngine: 'xterm.js' },
				{ defaultView: 'terminal', terminalEngine: 'xterm.js', migrated: true },
			],
			[
				'the native render mode',
				{ terminalEngine: 'native' },
				{ defaultView: 'native', terminalEngine: 'ghostty-web', migrated: true },
			],
			[
				'a value no build ever wrote',
				{ terminalEngine: 'nonsense' },
				{ defaultView: 'native', terminalEngine: 'ghostty-web', migrated: false },
			],
			[
				'a settings file without the key',
				{},
				{ defaultView: 'native', terminalEngine: 'ghostty-web', migrated: false },
			],
			[
				'no settings file at all',
				null,
				{ defaultView: 'native', terminalEngine: 'ghostty-web', migrated: false },
			],
			[
				'a file this build already split',
				{ defaultView: 'native', terminalEngine: 'xterm.js' },
				{ defaultView: 'native', terminalEngine: 'xterm.js', migrated: false },
			],
			[
				'an unreadable view beside a readable engine',
				{ defaultView: 'nonsense', terminalEngine: 'xterm.js' },
				{ defaultView: 'native', terminalEngine: 'xterm.js', migrated: false },
			],
			[
				'a hand-edited file with both the old and the new key',
				{ defaultView: 'terminal', terminalEngine: 'native' },
				{ defaultView: 'native', terminalEngine: 'ghostty-web', migrated: true },
			],
		];

	for (const [what, stored, expected] of table) {
		it(`splits ${what}`, () => {
			expect(migrateRenderMode(stored)).toEqual(expected);
		});
	}

	it('never throws on a value of the wrong type', () => {
		expect(migrateRenderMode({ terminalEngine: 7, defaultView: [] })).toEqual({
			defaultView: 'native',
			terminalEngine: 'ghostty-web',
			migrated: false,
		});
		expect(migrateRenderMode('not a settings object')).toEqual({
			defaultView: 'native',
			terminalEngine: 'ghostty-web',
			migrated: false,
		});
	});

	it('leaves the defaults agreeing with the split it produces', () => {
		expect(DEFAULT_SETTINGS.defaultView).toBe('native');
		expect(DEFAULT_SETTINGS.terminalEngine).toBe('ghostty-web');
	});
});

describe('withoutRemovedSettings (#99)', () => {
	it('drops a stored auto-accept permissions switch', () => {
		// The waiting card never answers a tool permission any more: Claude does
		// that itself, through its permission modes. A vault that stored the old
		// switch loads without it, and without a word about it.
		expect(
			withoutRemovedSettings({ nativeAutoAcceptPermissions: true, nativeToolGroups: 'collapse' }),
		).toEqual({ nativeToolGroups: 'collapse' });
	});

	it('leaves a stored file that never had it alone', () => {
		const stored = { defaultView: 'native', terminalEngine: 'xterm.js' };
		expect(withoutRemovedSettings(stored)).toEqual(stored);
	});

	it('never throws on what data.json may hold', () => {
		expect(withoutRemovedSettings(null)).toEqual({});
		expect(withoutRemovedSettings('not a settings object')).toEqual({});
	});

	it('has no auto-accept setting left to default', () => {
		expect('nativeAutoAcceptPermissions' in DEFAULT_SETTINGS).toBe(false);
		// Trusting a new folder is off until it is asked for.
		expect(DEFAULT_SETTINGS.nativeAutoTrustFolders).toBe(false);
	});
});
