/**
 * Settings-side pure bits: the remote-profile check both the folder actions and
 * the status block ask, and the status block itself. `renderConnectionStatus`
 * only ever calls `createEl`, so a two-line stand-in for the container is enough
 * to assert what it says — no DOM needed.
 */

import { describe, expect, it } from 'vitest';
import {
	clampScrollbackMb,
	DEFAULT_SCROLLBACK_MB,
	DEFAULT_SETTINGS,
	MAX_SCROLLBACK_MB,
	MIN_SCROLLBACK_MB,
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
