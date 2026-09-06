/**
 * Settings-side pure bits: the remote-profile check both the folder actions and
 * the status block ask, and the status block itself. `renderConnectionStatus`
 * only ever calls `createEl`, so a two-line stand-in for the container is enough
 * to assert what it says — no DOM needed.
 */

import { describe, expect, it } from 'vitest';
import {
	clampPanesPerTab,
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
	remoteVaultPathIssue,
	renderConnectionStatus,
	SCROLLBACK_BYTES_PER_MB,
	scrollbackBytes,
	type ConnectionStatus,
	type HerdrSettings,
} from '../src/settings';

function settings(remote: Partial<HerdrSettings['remote']> = {}): HerdrSettings {
	return {
		...DEFAULT_SETTINGS,
		remote: { ...DEFAULT_SETTINGS.remote, ...remote },
	};
}

function status(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
	return {
		discovery: {
			binary: { path: '/opt/homebrew/bin/herdr', source: 'homebrew' },
			socketPath: '/tmp/herdr.sock',
			status: { status: 'running', version: '0.8.0', protocol: 19 },
			error: null,
		} as unknown as ConnectionStatus['discovery'],
		socketPath: '/tmp/herdr.sock',
		tunnel: null,
		mismatch: null,
		workspace: { id: 'w4', label: 'hvelv', method: 'label', agentCount: 3 },
		error: null,
		...overrides,
	};
}

/** Collects the text of every line the renderer emits, plus its warning flag. */
function render(s: HerdrSettings, st: ConnectionStatus): { text: string; warning: boolean }[] {
	const lines: { text: string; warning: boolean }[] = [];
	const el = {
		createEl: (_tag: string, options: { cls: string; text: string }) => {
			lines.push({ text: options.text, warning: options.cls.includes('mod-warning') });
			return el;
		},
	};
	renderConnectionStatus(el as unknown as HTMLElement, s, st);
	return lines;
}

describe('remoteVaultPathIssue (S5, M19)', () => {
	it('is silent while the remote profile is off', () => {
		expect(remoteVaultPathIssue(settings({ enabled: false, remoteVaultPath: '' }))).toBeNull();
	});

	it('flags an enabled remote profile without a remote vault path', () => {
		expect(remoteVaultPathIssue(settings({ enabled: true, remoteVaultPath: '  ' }))).toMatch(
			/remote vault path/,
		);
		expect(
			remoteVaultPathIssue(settings({ enabled: true, remoteVaultPath: '/home/lasse/hvelv' })),
		).toBeNull();
	});
});

describe('renderConnectionStatus', () => {
	it('says nothing but "not connected" before discovery ran', () => {
		expect(render(settings(), status({ discovery: null }))).toEqual([
			{ text: 'Not connected yet.', warning: false },
		]);
	});

	it('reports binary, socket, server and workspace', () => {
		const text = render(settings(), status())
			.map((line) => line.text)
			.join('\n');
		expect(text).toContain('/opt/homebrew/bin/herdr');
		expect(text).toContain('Socket: /tmp/herdr.sock');
		expect(text).toContain('protocol 19');
		expect(text).toContain('Workspace: hvelv (w4, matched by label), 3 agent panes');
	});

	it('warns that folder actions are off without a remote vault path', () => {
		const lines = render(
			settings({ enabled: true, host: 'lasse@xl', remoteVaultPath: '' }),
			status(),
		);
		const warning = lines.find((line) => line.text.startsWith('Folder actions are off'));
		expect(warning?.warning).toBe(true);
	});

	it('drops the warning once the remote vault path is set', () => {
		const lines = render(
			settings({ enabled: true, host: 'lasse@xl', remoteVaultPath: '/home/lasse/hvelv' }),
			status(),
		);
		expect(lines.some((line) => line.text.startsWith('Folder actions are off'))).toBe(false);
	});

	it('warns when no workspace matches the vault', () => {
		const lines = render(settings(), status({ workspace: null }));
		expect(lines.at(-1)).toEqual({
			text: 'Workspace: no herdr workspace matches this vault yet.',
			warning: true,
		});
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
		expect(scrollbackBytes(settings())).toBe(DEFAULT_SCROLLBACK_MB * SCROLLBACK_BYTES_PER_MB);
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

describe('panes per tab (issue #29)', () => {
	it('defaults to two, so the second agent in a folder splits its tab', () => {
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

describe('agent list defaults (issue #20)', () => {
	it('sorts by herdr’s priority and groups by herdr tab, which is today’s look', () => {
		expect(DEFAULT_SETTINGS.agentListSort).toBe('priority');
		expect(DEFAULT_SETTINGS.agentListGroupBy).toBe('tab');
	});
});
