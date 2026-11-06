/**
 * The `claude` kind in the registry and in `data.json` (ADR-0007): a runtime
 * of the new kind is added, normalised and removed like the others and stays
 * local; a file written before the kind existed still loads, with the
 * foreign-entry passthrough intact; and the stored sessions are read
 * defensively and go with their runtime.
 */

import { describe, expect, it } from 'vitest';
import { claudeConfigDir, normalizeClaudeSessions, startupFallback } from '../src/claude/agents';
import {
	defaultLocalRuntime,
	kindTargets,
	migrateRuntimes,
	newRuntime,
	normalizePermissionMode,
	normalizeRuntime,
	removeRuntime,
	runtimeDisplayName,
	runtimeIssues,
	runtimeSummary,
} from '../src/runtimes';
import { endpointOf } from '../src/connection';

const SESSION = '3b3ad50c-0000-4000-8000-000000000001';

describe('a claude runtime', () => {
	it('is created local, with the default permission mode, no socket and an empty binary', () => {
		const runtime = newRuntime('claude', 'ssh', [], () => 0.5);
		expect(runtime).toMatchObject({ kind: 'claude', target: 'local', socketPath: '', binary: '', permissionMode: 'default' });
		expect(runtimeDisplayName(runtime)).toBe('Claude, run by Obsidian');
		expect(runtimeSummary(runtime)).toBe('Claude, run by Obsidian on this machine');
		expect(runtimeIssues(runtime)).toEqual([]);
		expect(kindTargets('claude')).toEqual(['local']);
	});

	it('is read back local whatever target a hand edit gave it, with a known permission mode', () => {
		expect(normalizeRuntime({ id: 'rt-c', kind: 'claude', target: 'ssh', permissionMode: 'bypassPermissions' })).toMatchObject({
			kind: 'claude',
			target: 'local',
			permissionMode: 'default',
		});
		expect(normalizeRuntime({ id: 'rt-c', kind: 'claude', target: 'local', permissionMode: 'acceptEdits' })?.permissionMode).toBe(
			'acceptEdits',
		);
		expect(normalizePermissionMode('plan')).toBe('plan');
		expect(normalizePermissionMode(7)).toBe('default');
	});

	it('carries its permission mode into the endpoint snapshot, and other kinds carry none', () => {
		expect(endpointOf(newRuntime('claude', 'local', [])).runtime.permissionMode).toBe('default');
		expect(endpointOf(defaultLocalRuntime()).runtime).not.toHaveProperty('permissionMode');
	});
});

describe('data.json across the new kind', () => {
	it('loads a file written before the kind existed exactly as before', () => {
		const stored = {
			runtimes: [defaultLocalRuntime(), { id: 'rt-future', kind: 'tmux', target: 'local' }],
			activeRuntime: 'local',
			pinnedPanes: { local: ['w1:p1'] },
		};
		const migration = migrateRuntimes(stored);
		expect(migration.runtimes).toEqual([defaultLocalRuntime()]);
		expect(migration.foreign).toEqual([{ id: 'rt-future', kind: 'tmux', target: 'local' }]);
		expect(migration.migrated).toBe(false);
		expect(normalizeClaudeSessions((stored as { claudeSessions?: unknown }).claudeSessions)).toEqual({});
	});

	it('reads a claude runtime as a known one, not as foreign', () => {
		const claude = { id: 'rt-c', name: '', kind: 'claude', target: 'local', host: '', binary: '', socketPath: '', remoteVaultPath: '', workspace: '', permissionMode: 'default' };
		const migration = migrateRuntimes({ runtimes: [claude, { id: 'rt-x', kind: 'future', target: 'local' }], activeRuntime: 'rt-c' });
		expect(migration.runtimes).toEqual([claude]);
		expect(migration.activeRuntime).toBe('rt-c');
		expect(migration.foreign).toEqual([{ id: 'rt-x', kind: 'future', target: 'local' }]);
	});

	it('keeps only stored sessions that can be resumed', () => {
		expect(
			normalizeClaudeSessions({
				'rt-c': [
					{ id: 'cl-1', sessionId: SESSION, cwd: '/vault/notes', name: 'notes' },
					{ id: 'cl-1', sessionId: SESSION, cwd: '/vault/dup', name: 'dup' },
					{ id: 'cl-2', sessionId: 'not-a-uuid', cwd: '/vault', name: 'x' },
					{ id: 'cl-3', sessionId: SESSION, cwd: 'relative', name: 'x' },
					{ id: 'cl-4', sessionId: SESSION, cwd: '/vault' },
					'junk',
				],
				'rt-empty': [],
				'rt-bad': 'x',
			}),
		).toEqual({
			'rt-c': [
				{ id: 'cl-1', sessionId: SESSION, cwd: '/vault/notes', name: 'notes' },
				{ id: 'cl-4', sessionId: SESSION, cwd: '/vault', name: '' },
			],
		});
		expect(normalizeClaudeSessions(null)).toEqual({});
		expect(normalizeClaudeSessions([])).toEqual({});
	});

	it('keeps whether a session has started, and only a real true', () => {
		expect(
			normalizeClaudeSessions({
				'rt-c': [
					{ id: 'cl-1', sessionId: SESSION, cwd: '/vault', name: 'a', started: true },
					{ id: 'cl-2', sessionId: SESSION, cwd: '/vault', name: 'b', started: 'yes' },
				],
			})['rt-c'],
		).toEqual([
			{ id: 'cl-1', sessionId: SESSION, cwd: '/vault', name: 'a', started: true },
			{ id: 'cl-2', sessionId: SESSION, cwd: '/vault', name: 'b' },
		]);
	});

	it('reads the transcripts’ folder as Claude does: CLAUDE_CONFIG_DIR, else ~/.claude', () => {
		expect(claudeConfigDir({}, '/home/u', '/vault')).toBe('/home/u/.claude');
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/u', '/vault')).toBe('/home/u/.claude');
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/etc/claude' }, '/home/u', '/vault')).toBe('/etc/claude');
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'cfg' }, '/home/u', '/vault')).toBe('/vault/cfg');
	});

	it('starts the other way only on the two startup refusals Claude prints', () => {
		const id = '5a22df93-5f1c-4e27-96e8-5f87a38e27fe';
		expect(startupFallback('session-id', `Error: Session ID ${id} is already in use.`)).toBe('resume');
		expect(startupFallback('resume', `No conversation found with session ID: ${id}`)).toBe('session-id');
		expect(startupFallback('resume', `Error: Session ID ${id} is already in use.`)).toBeNull();
		expect(startupFallback('session-id', `No conversation found with session ID: ${id}`)).toBeNull();
		expect(startupFallback('session-id', 'exited with code 1')).toBeNull();
	});

	it('drops a removed runtime’s sessions with its pins', () => {
		const claude = newRuntime('claude', 'local', ['local']);
		const settings = {
			runtimes: [defaultLocalRuntime(), claude],
			activeRuntime: claude.id,
			pinnedPanes: { [claude.id]: ['cl-1'] },
			claudeSessions: { [claude.id]: [{ id: 'cl-1', sessionId: SESSION, cwd: '/v', name: 'v' }], other: [] },
		};
		expect(removeRuntime(settings, claude.id)).toEqual({ removed: true, activeChanged: true });
		expect(settings.claudeSessions).toEqual({ other: [] });
		expect(settings.pinnedPanes).toEqual({});
	});
});
