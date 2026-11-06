/**
 * The runtime registry (ADR-0004): the migration from the pre-registry
 * `data.json`, the normalisation of a stored registry, and the decisions over
 * it — names, validation, the switcher by count and removal.
 *
 * The fixtures are `data.json` files as 0.4.0 wrote them: no remote, a remote
 * configured but off, a remote on. What the migration must keep is the ids:
 * saved terminal tabs persist `endpointId` and `pinnedPanes` is keyed by it,
 * and neither store is rewritten.
 */

import { describe, expect, it } from 'vitest';
import {
	activeRuntimeOf,
	DEFAULT_HERDR_SOCKET,
	defaultLocalRuntime,
	LEGACY_REMOTE_HERDR_BINARY,
	issueSentence,
	LOCAL_RUNTIME_ID,
	migrateRuntimes,
	newRuntime,
	newRuntimeId,
	normalizeRuntime,
	removeRuntime,
	runtimeDisplayName,
	withLiveName,
	runtimeIssues,
	runtimeSwitcher,
	type RuntimeConfig,
} from '../src/runtimes';
import { parseTerminalState } from '../src/views/terminalView';
import { normalizePinnedPanes, pinnedPaneIds, withoutRemovedSettings } from '../src/settings';

/** A 0.4.0 `data.json` with no remote ever configured. */
const NO_REMOTE = {
	socketPath: '~/.config/herdr/herdr.sock',
	herdrBinary: '/usr/bin/herdr',
	workspaceId: '',
	remote: {
		enabled: false,
		host: '',
		remoteSocketPath: '~/.config/herdr/herdr.sock',
		remoteBinary: '~/.local/bin/herdr',
		remoteVaultPath: '',
	},
	pinnedPanes: { local: ['w1:p2'] },
	agentListSort: 'priority',
};

/** A remote configured, but the list switched back to local. */
const REMOTE_OFF = {
	socketPath: '/run/herdr.sock',
	herdrBinary: '',
	workspaceId: 'w7',
	remote: {
		enabled: false,
		host: 'lasse@xl',
		remoteSocketPath: '~/.config/herdr/herdr.sock',
		remoteBinary: '/home/lasse/.local/bin/herdr',
		remoteVaultPath: '/home/lasse/hvelv',
	},
	pinnedPanes: {
		local: ['w1:p1'],
		'ssh:lasse@xl:~/.config/herdr/herdr.sock': ['w4:p3', 'w4:p1'],
	},
};

/** The remote on. */
const REMOTE_ON = {
	...REMOTE_OFF,
	remote: { ...REMOTE_OFF.remote, enabled: true },
};

const XL_ID = 'ssh:lasse@xl:~/.config/herdr/herdr.sock';

describe('migrateRuntimes: a pre-registry data.json (ADR-0004)', () => {
	it('makes the local herdr runtime `local` from a file with no remote', () => {
		const migration = migrateRuntimes(NO_REMOTE);
		expect(migration.migrated).toBe(true);
		expect(migration.activeRuntime).toBe(LOCAL_RUNTIME_ID);
		expect(migration.runtimes).toEqual([
			{
				id: 'local',
				name: 'Local',
				kind: 'herdr',
				target: 'local',
				host: '',
				binary: '/usr/bin/herdr',
				socketPath: '~/.config/herdr/herdr.sock',
				remoteVaultPath: '',
				workspace: '',
			},
		]);
	});

	it('keeps a configured remote that was off, and stays on local', () => {
		const migration = migrateRuntimes(REMOTE_OFF);
		expect(migration.activeRuntime).toBe(LOCAL_RUNTIME_ID);
		expect(migration.runtimes.map((runtime) => runtime.id)).toEqual(['local', XL_ID]);
		const [local, xl] = migration.runtimes;
		expect(local?.socketPath).toBe('/run/herdr.sock');
		expect(xl).toEqual({
			id: XL_ID,
			name: 'lasse@xl',
			kind: 'herdr',
			target: 'ssh',
			host: 'lasse@xl',
			binary: '/home/lasse/.local/bin/herdr',
			socketPath: '~/.config/herdr/herdr.sock',
			remoteVaultPath: '/home/lasse/hvelv',
			workspace: 'w7',
		});
	});

	it('makes the remote the active runtime when it was on', () => {
		const migration = migrateRuntimes(REMOTE_ON);
		expect(migration.activeRuntime).toBe(XL_ID);
		expect(activeRuntimeOf(migration).target).toBe('ssh');
	});

	it('gives the old global workspace to both, as it applied to whichever was connected', () => {
		const migration = migrateRuntimes(REMOTE_ON);
		expect(migration.runtimes.map((runtime) => runtime.workspace)).toEqual(['w7', 'w7']);
	});

	it('derives the id from the socket the old load defaulted when none was stored', () => {
		const migration = migrateRuntimes({ remote: { enabled: true, host: ' xl ' } });
		expect(migration.activeRuntime).toBe(`ssh:xl:${DEFAULT_HERDR_SOCKET}`);
		const xl = migration.runtimes[1];
		// No binary stored: the remote host is searched.
		expect(xl?.binary).toBe('');
		expect(xl?.host).toBe('xl');
	});

	it('reads a remote binary left at the old default as the search, and keeps a chosen one', () => {
		const old = migrateRuntimes({
			remote: { enabled: true, host: 'mac', remoteBinary: LEGACY_REMOTE_HERDR_BINARY },
		});
		expect(old.runtimes[1]?.binary).toBe('');
		const chosen = migrateRuntimes({
			remote: { enabled: true, host: 'mac', remoteBinary: '~/bin/herdr' },
		});
		expect(chosen.runtimes[1]?.binary).toBe('~/bin/herdr');
	});

	it('drops an enabled remote without a host, which could never connect', () => {
		const migration = migrateRuntimes({ remote: { enabled: true, host: '   ' } });
		expect(migration.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		expect(migration.activeRuntime).toBe('local');
	});

	it('reads an empty or unreadable file as a fresh install', () => {
		for (const stored of [null, undefined, 42, 'x', {}, { agentListSort: 'priority' }]) {
			const migration = migrateRuntimes(stored);
			expect(migration.runtimes).toEqual([defaultLocalRuntime()]);
			expect(migration.activeRuntime).toBe('local');
			// Nothing to carry over, so nothing to write back.
			expect(migration.migrated).toBe(false);
		}
	});

	it('leaves pins and saved tabs naming the same runtimes', () => {
		for (const stored of [NO_REMOTE, REMOTE_OFF, REMOTE_ON]) {
			const migration = migrateRuntimes(stored);
			const ids = new Set(migration.runtimes.map((runtime) => runtime.id));
			// Every pin key is a runtime of the registry, untouched.
			const pins = normalizePinnedPanes(stored.pinnedPanes);
			for (const key of Object.keys(pins)) expect(ids.has(key)).toBe(true);
			expect(pinnedPaneIds({ pinnedPanes: pins }, 'local')).toEqual(
				stored.pinnedPanes.local,
			);
		}
		// A tab saved on the remote, and one saved before endpoints existed.
		const ids = new Set(migrateRuntimes(REMOTE_OFF).runtimes.map((runtime) => runtime.id));
		const remoteTab = parseTerminalState({ paneId: 'w4:p3', mode: 'control', endpointId: XL_ID });
		const oldTab = parseTerminalState({ paneId: 'w1:p1', mode: 'observe' });
		expect(ids.has(remoteTab?.endpointId ?? '')).toBe(true);
		expect(ids.has(oldTab?.endpointId ?? '')).toBe(true);
	});

	it('drops the legacy keys once they are read', () => {
		const kept = withoutRemovedSettings(REMOTE_ON) as Record<string, unknown>;
		for (const key of ['remote', 'workspaceId', 'socketPath', 'herdrBinary']) {
			expect(key in kept).toBe(false);
		}
		expect(kept.pinnedPanes).toEqual(REMOTE_ON.pinnedPanes);
	});
});

describe('migrateRuntimes: a stored registry', () => {
	const extra: RuntimeConfig = {
		id: 'rt-abc',
		name: 'Core here',
		kind: 'herdr-core',
		target: 'local',
		host: '',
		binary: '',
		socketPath: '',
		remoteVaultPath: '',
		workspace: '',
	};

	it('is read as it is and not migrated again', () => {
		const stored = { runtimes: [defaultLocalRuntime(), extra], activeRuntime: 'rt-abc' };
		const migration = migrateRuntimes(stored);
		expect(migration.migrated).toBe(false);
		expect(migration.runtimes).toEqual(stored.runtimes);
		expect(migration.activeRuntime).toBe('rt-abc');
	});

	it('imports a legacy remote beside a registry as an extra, inactive runtime', () => {
		// A downgraded build wrote `remote` again; nothing configured there is lost.
		const migration = migrateRuntimes({ ...REMOTE_ON, runtimes: [extra], activeRuntime: 'rt-abc' });
		expect(migration.runtimes.map((runtime) => runtime.id)).toEqual(['rt-abc', XL_ID]);
		expect(migration.runtimes[1]).toMatchObject({ kind: 'herdr', target: 'ssh', host: 'lasse@xl' });
		expect(migration.activeRuntime).toBe('rt-abc');
		// Written back once, so the legacy keys go.
		expect(migration.migrated).toBe(true);
	});

	it('keeps the registry’s own entry when the legacy remote is already in it', () => {
		const listed = { ...extra, id: XL_ID, kind: 'herdr' as const, target: 'ssh' as const, host: 'lasse@xl', binary: '/mine' };
		const migration = migrateRuntimes({ ...REMOTE_ON, runtimes: [listed], activeRuntime: XL_ID });
		expect(migration.runtimes).toEqual([listed]);
	});

	it('keeps entries of an unknown kind or target aside, for the next save', () => {
		const future = { id: 'rt-future', kind: 'tmux', target: 'local', name: 'Later' };
		const moon = { id: 'rt-moon', kind: 'herdr', target: 'moon' };
		const migration = migrateRuntimes({ runtimes: [future, extra, moon], activeRuntime: 'rt-abc' });
		expect(migration.runtimes).toEqual([extra]);
		expect(migration.foreign).toEqual([future, moon]);
		expect(migration.migrated).toBe(false);
	});

	it('drops unusable entries and duplicate ids, keeping the first', () => {
		const migration = migrateRuntimes({
			runtimes: [
				null,
				{ id: '', kind: 'herdr', target: 'local' },
				{ id: 'x', kind: 'tmux', target: 'local' },
				{ id: 'y', kind: 'herdr', target: 'moon' },
				extra,
				{ ...extra, name: 'second' },
			],
			activeRuntime: 'rt-abc',
		});
		expect(migration.runtimes).toEqual([extra]);
		// The unknown kind and target are kept aside, not dropped.
		expect(migration.foreign).toEqual([
			{ id: 'x', kind: 'tmux', target: 'local' },
			{ id: 'y', kind: 'herdr', target: 'moon' },
		]);
	});

	it('falls back to the first runtime when the active id names none', () => {
		const migration = migrateRuntimes({ runtimes: [extra, defaultLocalRuntime()], activeRuntime: 'gone' });
		expect(migration.activeRuntime).toBe('rt-abc');
	});

	it('falls back to the local herdr when the list ends up empty', () => {
		const migration = migrateRuntimes({ runtimes: [], activeRuntime: 'x' });
		expect(migration.runtimes).toEqual([defaultLocalRuntime()]);
		expect(migration.activeRuntime).toBe('local');
	});

	it('fills missing fields with the kind and target defaults', () => {
		expect(normalizeRuntime({ id: 'r', kind: 'herdr', target: 'ssh' })).toMatchObject({
			name: '',
			binary: '',
			socketPath: DEFAULT_HERDR_SOCKET,
		});
		expect(normalizeRuntime({ id: 'r', kind: 'herdr-core', target: 'ssh' })).toMatchObject({
			binary: '',
			socketPath: '',
		});
	});

	it('reads a stored SSH herdr binary left at the old default as the remote search', () => {
		const stored = (kind: string, target: string, binary: string) =>
			normalizeRuntime({ id: 'r', kind, target, binary })?.binary;
		expect(stored('herdr', 'ssh', LEGACY_REMOTE_HERDR_BINARY)).toBe('');
		expect(stored('herdr', 'ssh', ` ${LEGACY_REMOTE_HERDR_BINARY} `)).toBe('');
		// A path the user chose, and the same path on another kind or target, stay.
		expect(stored('herdr', 'ssh', '/opt/homebrew/bin/herdr')).toBe('/opt/homebrew/bin/herdr');
		expect(stored('herdr', 'ssh', '/home/lasse/.local/bin/herdr')).toBe('/home/lasse/.local/bin/herdr');
		expect(stored('herdr', 'local', LEGACY_REMOTE_HERDR_BINARY)).toBe(LEGACY_REMOTE_HERDR_BINARY);
		expect(stored('herdr-core', 'ssh', LEGACY_REMOTE_HERDR_BINARY)).toBe(LEGACY_REMOTE_HERDR_BINARY);
	});
});

describe('new runtimes', () => {
	it('get an opaque id that collides with nothing', () => {
		let calls = 0;
		// The first draw collides, the second does not.
		const random = () => (calls++ === 0 ? 0 : 0.5);
		const taken = [newRuntimeId([], () => 0)];
		const id = newRuntimeId(taken, random);
		expect(id).toMatch(/^rt-[0-9a-z]{8}$/);
		expect(taken).not.toContain(id);
	});

	it('start from the defaults of their kind and target', () => {
		const ssh = newRuntime('herdr', 'ssh', ['local']);
		expect(ssh).toMatchObject({
			name: '',
			kind: 'herdr',
			target: 'ssh',
			binary: '',
			socketPath: DEFAULT_HERDR_SOCKET,
		});
		expect(newRuntime('herdr-core', 'local', [])).toMatchObject({ binary: '', socketPath: '' });
	});
});

describe('names and validation', () => {
	it('shows the own name, else one derived from kind and target', () => {
		expect(runtimeDisplayName({ ...defaultLocalRuntime(), name: '  ' })).toBe('Local herdr');
		const core = newRuntime('herdr-core', 'ssh', []);
		expect(runtimeDisplayName(core)).toBe('herdr-core over SSH');
		expect(runtimeDisplayName({ ...core, host: 'xl' })).toBe('herdr-core on xl');
		expect(runtimeDisplayName({ ...core, name: 'Asher' })).toBe('Asher');
	});

	it('asks nothing of a local runtime', () => {
		expect(runtimeIssues(defaultLocalRuntime())).toEqual([]);
	});

	it('names everything an SSH herdr runtime lacks, in the old messages', () => {
		// An empty binary is not one of them: the remote host is searched.
		const empty = { ...newRuntime('herdr', 'ssh', []), binary: ' ', socketPath: '' };
		expect(runtimeIssues(empty)).toEqual([
			'the runtime has no SSH host',
			'the runtime has no remote socket path',
			'the runtime has no remote vault path, so folder paths cannot be resolved on the remote host',
		]);
		const ready = { ...newRuntime('herdr', 'ssh', []), host: 'xl', remoteVaultPath: '/v' };
		expect(runtimeIssues(ready)).toEqual([]);
	});

	it('needs neither socket nor binary for herdr-core over SSH', () => {
		const core = { ...newRuntime('herdr-core', 'ssh', []), host: 'xl', remoteVaultPath: '/v' };
		expect(runtimeIssues(core)).toEqual([]);
	});

	it('turns a clause into a sentence for the settings tab', () => {
		expect(issueSentence('the runtime has no SSH host')).toBe('The runtime has no SSH host.');
		expect(issueSentence('Already one.')).toBe('Already one.');
	});
});

describe('runtimeSwitcher: by count (ADR-0004)', () => {
	const local = defaultLocalRuntime();
	const xl = migrateRuntimes(REMOTE_ON).runtimes[1] as RuntimeConfig;
	const core: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.1), name: 'Core' };

	it('is hidden with one runtime', () => {
		expect(runtimeSwitcher({ runtimes: [local], activeRuntime: 'local' }).mode).toBe('hidden');
	});

	it('toggles to the other one with two, naming it', () => {
		const onLocal = runtimeSwitcher({ runtimes: [local, xl], activeRuntime: 'local' });
		expect(onLocal).toMatchObject({
			mode: 'toggle',
			icon: 'laptop',
			remote: false,
			label: 'Switch to lasse@xl',
		});
		expect(onLocal.next?.id).toBe(XL_ID);
		const onRemote = runtimeSwitcher({ runtimes: [local, xl], activeRuntime: XL_ID });
		expect(onRemote).toMatchObject({ icon: 'server', remote: true, label: 'Switch to Local' });
		expect(onRemote.next?.id).toBe('local');
	});

	it('opens a menu of all of them with three or more, the active one checked', () => {
		const switcher = runtimeSwitcher({ runtimes: [local, xl, core], activeRuntime: core.id });
		expect(switcher.mode).toBe('menu');
		expect(switcher.next).toBeNull();
		expect(switcher.entries).toEqual([
			{ id: 'local', name: 'Local', checked: false },
			{ id: XL_ID, name: 'lasse@xl', checked: false },
			{ id: core.id, name: 'Core', checked: true },
		]);
		expect(switcher.label).toBe('Switch runtime (now Core)');
	});
});

describe('removeRuntime', () => {
	const settings = () => {
		const migration = migrateRuntimes(REMOTE_ON);
		return {
			runtimes: migration.runtimes,
			activeRuntime: migration.activeRuntime,
			pinnedPanes: normalizePinnedPanes(REMOTE_ON.pinnedPanes),
		};
	};

	it('drops the runtime and its pins, and moves the active one to the first', () => {
		const s = settings();
		expect(removeRuntime(s, XL_ID)).toEqual({ removed: true, activeChanged: true });
		expect(s.runtimes.map((runtime) => runtime.id)).toEqual(['local']);
		expect(s.activeRuntime).toBe('local');
		expect(s.pinnedPanes).toEqual({ local: ['w1:p1'] });
	});

	it('leaves the active one alone when another goes', () => {
		const s = settings();
		s.activeRuntime = 'local';
		expect(removeRuntime(s, XL_ID)).toEqual({ removed: true, activeChanged: false });
	});

	it('refuses the last runtime and an unknown id', () => {
		const s = settings();
		expect(removeRuntime(s, 'nope').removed).toBe(false);
		removeRuntime(s, XL_ID);
		expect(removeRuntime(s, 'local')).toEqual({ removed: false, activeChanged: false });
		expect(s.runtimes).toHaveLength(1);
	});
});

describe('withLiveName: a rename shows before the next reconnect', () => {
	it('takes the name the settings give the snapshot’s runtime now', () => {
		const snapshot = { ...defaultLocalRuntime(), name: 'Local', socketPath: '/old.sock' };
		const settings = {
			runtimes: [{ ...defaultLocalRuntime(), name: 'Laptop', socketPath: '/new.sock' }],
			activeRuntime: 'local',
		};
		const live = withLiveName(settings, snapshot);
		expect(runtimeDisplayName(live)).toBe('Laptop');
		// Only the name: what the connection runs on stays the snapshot's.
		expect(live.socketPath).toBe('/old.sock');
		// Cleared, it falls back to the derived name.
		settings.runtimes[0]!.name = '';
		expect(runtimeDisplayName(withLiveName(settings, snapshot))).toBe('Local herdr');
	});

	it('keeps the snapshot’s name for a runtime no longer in the settings', () => {
		const snapshot = { ...defaultLocalRuntime(), id: 'rt-gone', name: 'Gone' };
		expect(withLiveName({ runtimes: [], activeRuntime: '' }, snapshot).name).toBe('Gone');
	});
});
