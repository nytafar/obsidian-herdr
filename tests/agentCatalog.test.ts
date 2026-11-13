/**
 * The agent CLI catalog (issue #125): the merge of built-ins, hc templates
 * and user entries per runtime kind, the per-runtime default, the
 * `defaultAgentKind` migration, the probe commands and their parsing, the
 * per-connection cache, and the kinds' own probes.
 *
 * Nothing here invokes ssh or starts a CLI: every runner, filesystem and
 * requester is a fake that records what it was asked.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	buildCatalog,
	defaultEntry,
	herdrAcceptsKind,
	kindIssue,
	launchOf,
	migrateDefaultAgents,
	normalizeUserProfiles,
	programsToProbe,
	userProfile,
	type AgentCatalogSettings,
	type AgentProbe,
	type UserAgentProfile,
} from '../src/agents/catalog';
import {
	parseProbeOutput,
	parseTemplates,
	PROBE_SCRIPT,
	probeLocal,
	probeOverHc,
	probeOverSsh,
	shimManagerOf,
	sshProbeArgs,
} from '../src/agents/probe';
import { AgentCatalogs, PROBE_WAIT_NOTICE_MS } from '../src/agents/catalogs';
import { startButtonLabel, startMenuItems } from '../src/views/startMenu';
import { agentLaunchLine, HcActions } from '../src/hc/actions';
import { HerdrActions, type ActionHost } from '../src/actions';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { ConnectionCoordinator, endpointOf, type Connection } from '../src/connection';
import { defaultLocalRuntime, foreignRuntimeRefs, newRuntime, type RuntimeConfig } from '../src/runtimes';
import type { DiscoveryDeps } from '../src/herdr/binary';
import type { RunCommand } from '../src/herdr/ssh';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import HerdrPlugin from '../src/main';

const HOME = '/home/test';

function settingsOf(overrides: Partial<AgentCatalogSettings> = {}): AgentCatalogSettings {
	return { agentProfiles: [], hiddenAgents: [], defaultAgents: {}, ...overrides };
}

function user(overrides: Partial<UserAgentProfile> = {}): UserAgentProfile {
	return { id: 'user-a', name: '', agent: 'codex', command: '', args: [], ...overrides };
}

const LOCAL_HERDR: RuntimeConfig = defaultLocalRuntime();
const SSH_HERDR: RuntimeConfig = { ...newRuntime('herdr', 'ssh', []), id: 'xl', host: 'lasse@xl' };
const LOCAL_HC: RuntimeConfig = { ...newRuntime('herdr-core', 'local', []), id: 'hc' };
const SSH_HC: RuntimeConfig = { ...newRuntime('herdr-core', 'ssh', []), id: 'asher', host: 'asher' };
const CLAUDE: RuntimeConfig = { ...newRuntime('claude', 'local', []), id: 'cl' };

function probe(found: string[], extra: Partial<AgentProbe> = {}): AgentProbe {
	return { found: new Set(found), herdrVersion: '0.9.5', ...extra };
}

/** Lets every microtask queued so far run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const ids = (entries: { profile: { id: string } }[]): string[] => entries.map((entry) => entry.profile.id);

describe('buildCatalog', () => {
	it('lists only the built-ins the probe found, the default first', () => {
		const catalog = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe(['codex', 'claude']) });
		expect(ids(catalog)).toEqual(['claude', 'codex']);
		expect(catalog[0]?.isDefault).toBe(true);
		expect(catalog.every((entry) => entry.available && entry.found === true)).toBe(true);
	});

	it('gates herdr kinds on the server version, not the protocol', () => {
		const found = ['claude', 'muse', 'letta'];
		expect(ids(buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe(found, { herdrVersion: '0.8.2' }) }))).toEqual([
			'claude',
		]);
		expect(ids(buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe(found, { herdrVersion: '0.9.0' }) }))).toEqual([
			'claude',
			'muse',
		]);
		expect(ids(buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe(found, { herdrVersion: '0.9.5' }) }))).toEqual([
			'claude',
			'muse',
			'letta',
		]);
		// herdr-core runs any program, so no version applies there.
		expect(ids(buildCatalog({ runtime: LOCAL_HC, settings: settingsOf(), probe: probe(found, { herdrVersion: null }) }))).toEqual([
			'claude',
			'muse',
			'letta',
		]);
		expect(herdrAcceptsKind('my-own-kind', null)).toBe(true);
	});

	it('offers Claude alone on Claude, run by Obsidian, and greys user entries there', () => {
		const settings = settingsOf({ agentProfiles: [user({ agent: 'claude', args: ['--model', 'opus'] })] });
		const catalog = buildCatalog({ runtime: CLAUDE, settings, probe: null });
		expect(ids(catalog)).toEqual(['claude', 'user-a']);
		expect(catalog[1]?.available).toBe(false);
		expect(catalog[1]?.reason).toContain('Claude Code only');
		expect(programsToProbe('claude', settings)).toEqual([]);
	});

	it('adds hc templates on herdr-core, greying one hc cannot use', () => {
		const catalog = buildCatalog({
			runtime: SSH_HC,
			settings: settingsOf(),
			probe: probe(['claude'], { templates: [{ name: 'reviewer' }, { name: 'broken', error: 'no command line' }] }),
		});
		expect(ids(catalog)).toEqual(['claude', 'template:reviewer', 'template:broken']);
		expect(catalog[2]?.available).toBe(false);
		expect(catalog[2]?.reason).toContain('no command line');
		expect(buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe([], { templates: [{ name: 'x' }] }) })).toEqual([]);
	});

	it('always shows a user entry: found, not found with the reason, or not startable on herdr', () => {
		const settings = settingsOf({
			agentProfiles: [
				user({ id: 'user-a', name: 'Work codex', args: ['--profile', 'work'] }),
				user({ id: 'user-b', name: 'Wrapper', agent: 'claude', command: '~/bin/my-claude' }),
				user({ id: 'user-c', name: 'Bad', args: ['a b'] }),
			],
		});
		const herdr = buildCatalog({ runtime: SSH_HERDR, settings, probe: probe(['claude']) });
		const byId = new Map(herdr.map((entry) => [entry.profile.id, entry]));
		// Not found is not unstartable: the probe may have looked on another PATH.
		expect(byId.get('user-a')).toMatchObject({
			available: true,
			found: false,
			reason: 'codex was not found on lasse@xl; it may still start',
		});
		expect(byId.get('user-b')?.reason).toContain('clear the command');
		expect(byId.get('user-c')?.reason).toBe('not a plain argument: a b');

		const core = buildCatalog({ runtime: SSH_HC, settings, probe: probe(['codex', '~/bin/my-claude']) });
		const coreById = new Map(core.map((entry) => [entry.profile.id, entry]));
		expect(coreById.get('user-a')).toMatchObject({ available: true, found: true });
		expect(coreById.get('user-b')).toMatchObject({ available: true, found: true });
	});

	it('lists every built-in unverified while no probe ran, and says why after a failed one', () => {
		const unverified = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: null });
		expect(unverified.length).toBeGreaterThan(20);
		expect(unverified.every((entry) => entry.available && entry.found === null && entry.reason === null)).toBe(true);
		const failed = buildCatalog({ runtime: SSH_HERDR, settings: settingsOf(), probe: { found: null, error: 'ssh lasse@xl did not answer' } });
		expect(failed[0]?.reason).toBe('could not check what is installed: ssh lasse@xl did not answer');
	});

	it('keeps the stored default while it can start, else the first available entry not hidden', () => {
		const found = probe(['claude', 'codex', 'gemini']);
		const chosen = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf({ defaultAgents: { local: 'gemini' } }), probe: found });
		expect(ids(chosen)).toEqual(['gemini', 'claude', 'codex']);
		expect(defaultEntry(chosen)?.profile.id).toBe('gemini');

		const missing = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf({ defaultAgents: { local: 'amp' } }), probe: found });
		expect(defaultEntry(missing)?.profile.id).toBe('claude');

		const hidden = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf({ hiddenAgents: ['claude'] }), probe: found });
		expect(defaultEntry(hidden)?.profile.id).toBe('codex');
		expect(hidden.find((entry) => entry.profile.id === 'claude')?.hidden).toBe(true);

		// Another runtime's default is not this one's.
		const other = buildCatalog({ runtime: SSH_HERDR, settings: settingsOf({ defaultAgents: { local: 'gemini' } }), probe: found });
		expect(defaultEntry(other)?.profile.id).toBe('claude');

		expect(defaultEntry(buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe([]) }))).toBeNull();
	});

	it('falls back to a found entry before a user entry the probe missed, and starts that one only when nothing was found', () => {
		const settings = settingsOf({ agentProfiles: [user({ id: 'user-a', name: 'Mine', agent: 'codex' })] });
		const both = buildCatalog({ runtime: SSH_HERDR, settings, probe: probe(['claude']) });
		expect(defaultEntry(both)?.profile.id).toBe('claude');
		const nothing = buildCatalog({ runtime: SSH_HERDR, settings, probe: probe([]) });
		expect(defaultEntry(nothing)?.profile.id).toBe('user-a');
		const chosen = buildCatalog({ runtime: SSH_HERDR, settings: { ...settings, defaultAgents: { xl: 'user-a' } }, probe: probe(['claude']) });
		expect(defaultEntry(chosen)?.profile.id).toBe('user-a');
	});

	it('treats a program the probe was not asked about as unverified, not missing', () => {
		const settings = settingsOf({ agentProfiles: [user({ id: 'user-a', name: 'New', agent: 'claude', command: '/opt/new' })] });
		const landed = probe(['claude'], { checked: new Set(['claude', 'codex']) });
		const entry = buildCatalog({ runtime: SSH_HC, settings, probe: landed }).find((e) => e.profile.id === 'user-a');
		expect(entry).toMatchObject({ available: true, found: null, reason: null });
		const all = probe(['claude'], { checked: new Set(programsToProbe('herdr-core', settingsOf())) });
		expect(ids(buildCatalog({ runtime: SSH_HC, settings: settingsOf(), probe: all }))).toEqual(['claude']);
	});
});

describe('profiles and launches', () => {
	it('starts a built-in by its kind, a user entry with its arguments, a wrapper by its command, a template by name', () => {
		const builtin = buildCatalog({ runtime: LOCAL_HERDR, settings: settingsOf(), probe: probe(['cursor-agent']) })[0];
		expect(builtin && launchOf(builtin.profile)).toEqual({ kind: 'cursor', label: 'Cursor' });
		expect(launchOf(userProfile(user({ args: ['--profile', 'work'] })))).toEqual({
			kind: 'codex',
			args: ['--profile', 'work'],
			label: 'codex --profile work',
		});
		expect(launchOf(userProfile(user({ name: 'Mine', agent: 'claude', command: '~/bin/c' })))).toEqual({
			kind: 'claude',
			command: '~/bin/c',
			label: 'Mine',
		});
		const template = buildCatalog({ runtime: LOCAL_HC, settings: settingsOf(), probe: probe([], { templates: [{ name: 'rev' }] }) })[0];
		expect(template && launchOf(template.profile)).toEqual({ kind: 'rev', template: 'rev', label: 'rev' });
	});

	it('says which kinds can start a profile', () => {
		const wrapper = userProfile(user({ command: '/opt/bin/codex-work' }));
		expect(kindIssue(wrapper, 'herdr')).toContain('own program');
		expect(kindIssue(wrapper, 'herdr-core')).toBeNull();
		expect(kindIssue(userProfile(user({ command: '-x' })), 'herdr-core')).toBe('not a plain command: -x');
	});

	it('reads stored user entries defensively', () => {
		expect(
			normalizeUserProfiles([
				{ id: 'user-a', name: 'A', agent: 'codex', command: 'x', args: ['--y', 3, ''] },
				{ id: 'user-a', name: 'dupe' },
				{ name: 'no id' },
				'junk',
				{ id: 'user-b' },
			]),
		).toEqual([
			{ id: 'user-a', name: 'A', agent: 'codex', command: 'x', args: ['--y'] },
			{ id: 'user-b', name: '', agent: 'claude', command: '', args: [] },
		]);
		expect(normalizeUserProfiles(null)).toEqual([]);
	});

	it('probes each program once, built-ins then user commands', () => {
		const programs = programsToProbe('herdr', settingsOf({ agentProfiles: [user(), user({ id: 'user-b', command: '~/bin/x' })] }));
		expect(programs[0]).toBe('claude');
		expect(programs).toContain('cursor-agent');
		expect(programs.filter((program) => program === 'codex')).toHaveLength(1);
		expect(programs.at(-1)).toBe('~/bin/x');
	});
});

describe('migrateDefaultAgents', () => {
	const runtimes = [LOCAL_HERDR, SSH_HC, CLAUDE];

	it('gives the old global kind to every herdr and herdr-core runtime, and asks for a save', () => {
		expect(migrateDefaultAgents({ defaultAgentKind: 'codex' }, runtimes)).toEqual({
			defaultAgents: { local: 'codex', asher: 'codex' },
			migrated: true,
		});
	});

	it('gives it to a newer build’s runtime kept aside too, by its id', () => {
		const foreign = foreignRuntimeRefs([
			{ id: 'future', kind: 'herdr-cloud', target: 'local' },
			{ id: 'ok', kind: 'herdr', target: 'local' },
			'junk',
		]);
		expect(foreign).toEqual([{ id: 'future', kind: 'herdr-cloud' }]);
		expect(migrateDefaultAgents({ defaultAgentKind: 'codex' }, [LOCAL_HERDR, ...foreign]).defaultAgents).toEqual({
			local: 'codex',
			future: 'codex',
		});
	});

	it('writes no default for the old default, claude, but still drops the key', () => {
		expect(migrateDefaultAgents({ defaultAgentKind: 'claude' }, runtimes)).toEqual({ defaultAgents: {}, migrated: true });
	});

	it('leaves a file without the old key alone, and keeps a stored map over the old key', () => {
		expect(migrateDefaultAgents({ defaultAgents: { local: 'amp' } }, runtimes)).toEqual({
			defaultAgents: { local: 'amp' },
			migrated: false,
		});
		expect(migrateDefaultAgents({ defaultAgentKind: 'codex', defaultAgents: { local: 'amp' } }, runtimes)).toEqual({
			defaultAgents: { local: 'amp' },
			migrated: true,
		});
		expect(migrateDefaultAgents(null, runtimes)).toEqual({ defaultAgents: {}, migrated: false });
	});

	it('keeps the choice through the plugin’s load path and drops the old key on the one save', async () => {
		const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin & Record<string, unknown>;
		const saved: Record<string, unknown>[] = [];
		plugin.loadData = () => Promise.resolve({ defaultAgentKind: 'gemini', runtimes: [LOCAL_HERDR], activeRuntime: 'local' });
		plugin.saveData = (data: unknown) => {
			saved.push(structuredClone(data) as Record<string, unknown>);
			return Promise.resolve();
		};
		await plugin.loadSettings();
		expect(plugin.settings.defaultAgents).toEqual({ local: 'gemini' });
		expect(saved).toHaveLength(1);
		expect(saved[0]).not.toHaveProperty('defaultAgentKind');
		expect(saved[0]?.defaultAgents).toEqual({ local: 'gemini' });
	});
});

describe('the + menu', () => {
	it('checks the default, greys what cannot start with the reason, and leaves out hidden entries', () => {
		const catalog = buildCatalog({
			runtime: LOCAL_HERDR,
			settings: settingsOf({
				hiddenAgents: ['codex'],
				agentProfiles: [
					user({ name: 'Gone', command: '', agent: 'amp' }),
					user({ id: 'user-b', name: 'Wrapper', command: '~/bin/w' }),
				],
			}),
			probe: probe(['claude', 'codex']),
		});
		const items = startMenuItems(catalog);
		expect(items.map((item) => item.title)).toEqual([
			'Claude Code',
			'Gone (not found)',
			'Wrapper (herdr starts codex with its own program; clear the command to use it here)',
		]);
		expect(items[0]).toMatchObject({ checked: true, disabled: false, launch: { kind: 'claude', label: 'Claude Code' } });
		expect(items[1]).toMatchObject({ checked: false, disabled: false, launch: { kind: 'amp', label: 'Gone' } });
		expect(items[2]).toMatchObject({ checked: false, disabled: true, launch: null });
		expect(startButtonLabel(catalog)).toBe('Start Claude Code in the vault. Right-click to choose another.');
	});

	it('says so when nothing is installed', () => {
		expect(startMenuItems([])).toEqual([
			{ title: 'No agent CLI found', icon: 'bot', checked: false, disabled: true, launch: null },
		]);
		expect(startButtonLabel([])).toBe('Start agent in the vault. Right-click to choose another.');
	});
});

describe('the probe commands', () => {
	it('parses indices back to programs, and an answer without ok as a failure', () => {
		expect(parseProbeOutput('1\n3\nok\n', ['a', 'b', '~/c'])).toEqual(new Set(['a', '~/c']));
		expect(parseProbeOutput('ok', ['a'])).toEqual(new Set());
		expect(parseProbeOutput('1\n', ['a'])).toBeNull();
		expect(parseProbeOutput('', ['a'])).toBeNull();
		expect(parseProbeOutput('9\nx\nok', ['a'])).toEqual(new Set());
	});

	it('keeps the script readable by fish and nu: no single quote, no backslash', () => {
		expect(PROBE_SCRIPT).not.toMatch(/['\\]/);
	});

	it('asks the SSH host in one non-interactive ssh, in remoteHerdrCommand’s shape', async () => {
		const asked: { file: string; args: string[]; timeoutMs: number }[] = [];
		const run: RunCommand = (file, args, options) => {
			asked.push({ file, args, timeoutMs: options.timeoutMs });
			return Promise.resolve('2\nok');
		};
		const result = await probeOverSsh(' lasse@xl ', ['claude', '~/bin/x'], run);
		expect(result).toEqual({ found: new Set(['~/bin/x']) });
		expect(asked).toHaveLength(1);
		expect(asked[0]?.file).toBe('ssh');
		expect(asked[0]?.args).toEqual(sshProbeArgs('lasse@xl', ['claude', '~/bin/x']));
		expect(asked[0]?.args.slice(0, 6)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'lasse@xl']);
		expect(asked[0]?.args[6]).toBe(`sh -c '${PROBE_SCRIPT}' sh '' claude '~/bin/x'`);
	});

	it('reports an ssh that did not answer, and asks nothing without programs or a host', async () => {
		let calls = 0;
		const run: RunCommand = () => {
			calls++;
			return Promise.resolve('');
		};
		expect(await probeOverSsh('xl', ['claude'], run)).toEqual({ found: null, error: 'ssh xl did not answer' });
		expect(await probeOverSsh('xl', [], run)).toEqual({ found: new Set() });
		expect(await probeOverSsh('  ', ['claude'], run)).toEqual({ found: null, error: 'the runtime has no SSH host' });
		expect(calls).toBe(1);
	});

	it('searches this machine like herdr discovery, asking the login shell once and only when needed', async () => {
		const shells: string[][] = [];
		const executable = new Set(['/usr/local/bin/claude', `${HOME}/.local/bin/codex`, '/opt/extra/amp', '/nix/bin/gemini', `${HOME}/bin/w`]);
		const deps: DiscoveryDeps = {
			isExecutable: (path) => executable.has(path),
			run: (file, args) => {
				shells.push([file, ...args]);
				return Promise.resolve({ stdout: '/nix/bin:/usr/bin', stderr: '', code: 0 });
			},
			env: { SHELL: '/bin/zsh' },
			home: HOME,
		};
		const result = await probeLocal(['claude', 'codex', 'amp', 'gemini', 'pi', '~/bin/w'], { extraPath: '/opt/extra' }, deps);
		expect(result.found).toEqual(new Set(['claude', 'codex', 'amp', 'gemini', '~/bin/w']));
		expect(shells).toEqual([['/bin/zsh', '-lic', 'printf %s "$PATH"']]);

		shells.length = 0;
		await probeLocal(['claude'], {}, deps);
		expect(shells).toEqual([]);
	});

	it('asks herdr-core in one machine.exec, and reads its templates', async () => {
		const asked: { method: string; params: unknown }[] = [];
		const requester = {
			request: <T,>(method: string, params: unknown): Promise<T> => {
				asked.push({ method, params });
				return Promise.resolve({ code: 0, stdout: Buffer.from('1\nok\n').toString('base64') } as T);
			},
		};
		expect(await probeOverHc(requester, ['claude', 'codex'])).toEqual({ found: new Set(['claude']) });
		expect(asked).toEqual([
			{ method: 'machine.exec', params: { argv: ['sh', '-c', PROBE_SCRIPT, 'sh', '', 'claude', 'codex'], timeout: 15 } },
		]);
		const failing = { request: <T,>(): Promise<T> => Promise.reject(new Error('machine_unknown')) };
		expect(await probeOverHc(failing, ['claude'])).toEqual({ found: null, error: 'machine_unknown' });
		expect(
			parseTemplates({ templates: [{ name: 'rev', description: 'Review', command: 'claude' }, { name: '' }, { name: 'b', error: 'bad' }] }),
		).toEqual([{ name: 'rev', description: 'Review' }, { name: 'b', error: 'bad' }]);
		expect(parseTemplates(null)).toEqual([]);
	});

	it('passes the vault root to the remote script as $1, over ssh and machine.exec', async () => {
		const asked: string[][] = [];
		const run: RunCommand = (file, args) => {
			asked.push(args);
			return Promise.resolve('ok');
		};
		await probeOverSsh('xl', ['kimi'], run, { vaultRoot: '~/hvelv' });
		expect(asked[0]?.[6]).toBe(`sh -c '${PROBE_SCRIPT}' sh '~/hvelv' kimi`);
		const params: unknown[] = [];
		const requester = {
			request: <T,>(_method: string, value: unknown): Promise<T> => {
				params.push(value);
				return Promise.resolve({ stdout: Buffer.from('ok').toString('base64') } as T);
			},
		};
		await probeOverHc(requester, ['kimi'], ' /Users/lasse/Vaults/hvelv ');
		expect(params).toEqual([{ argv: ['sh', '-c', PROBE_SCRIPT, 'sh', '/Users/lasse/Vaults/hvelv', 'kimi'], timeout: 15 }]);
	});

	it('recognises mise and asdf shims by where they live and what they point at', () => {
		expect(shimManagerOf(`${HOME}/.local/share/mise/shims/kimi`, '/usr/bin/mise')).toBe('mise');
		expect(shimManagerOf('/opt/m/shims/kimi', '/opt/homebrew/Cellar/mise/2026.10.25/bin/mise')).toBe('mise');
		expect(shimManagerOf('/usr/bin/mise', '/usr/bin/mise')).toBeNull();
		expect(shimManagerOf(`${HOME}/.asdf/shims/qwen`, null)).toBe('asdf');
		expect(shimManagerOf('/data/asdf/shims/qwen', null, { ASDF_DATA_DIR: '/data/asdf' })).toBe('asdf');
		expect(shimManagerOf('/usr/local/bin/claude', '/usr/local/lib/claude/cli.js')).toBeNull();
	});

	it('counts a local shim only when its manager resolves it from the vault root, without a shell', async () => {
		const shims = `${HOME}/.local/share/mise/shims`;
		const executable = new Set([
			`${shims}/kimi`,
			`${shims}/codex`,
			`${shims}/amp`,
			`${HOME}/.asdf/shims/qwen`,
			`${HOME}/.asdf/shims/muse`,
			`${HOME}/.asdf/bin/asdf`,
			'/usr/local/bin/claude',
		]);
		const calls: { file: string; args: string[]; cwd?: string }[] = [];
		const deps: DiscoveryDeps = {
			isExecutable: (path) => executable.has(path),
			realPath: (path) => (path.startsWith(shims) ? '/usr/bin/mise' : path),
			run: (file, args, options) => {
				if (args[0] !== 'which') return Promise.resolve({ stdout: `${shims}:${HOME}/.asdf/shims`, stderr: '', code: 0 });
				calls.push({ file, args, cwd: options.cwd });
				const name = args[1];
				if (name === 'codex' || name === 'qwen') return Promise.resolve({ stdout: '/x\n', stderr: '', code: 0 });
				// mise answered nothing in time: unverified, so the file counts.
				if (name === 'amp') return Promise.resolve({ stdout: '', stderr: '', code: 1, failed: true });
				return Promise.resolve({ stdout: '', stderr: 'mise ERROR kimi is a mise bin however it is not currently active', code: 1 });
			},
			env: { SHELL: '/bin/zsh' },
			home: HOME,
		};
		const result = await probeLocal(['claude', 'kimi', 'codex', 'amp', 'qwen', 'muse'], { vaultRoot: '/vault' }, deps);
		expect(result.found).toEqual(new Set(['claude', 'codex', 'amp', 'qwen']));
		expect(calls.sort((a, b) => (a.args[1] ?? '').localeCompare(b.args[1] ?? ''))).toEqual([
			{ file: '/usr/bin/mise', args: ['which', 'amp'], cwd: '/vault' },
			{ file: '/usr/bin/mise', args: ['which', 'codex'], cwd: '/vault' },
			{ file: '/usr/bin/mise', args: ['which', 'kimi'], cwd: '/vault' },
			{ file: `${HOME}/.asdf/bin/asdf`, args: ['which', 'muse'], cwd: '/vault' },
			{ file: `${HOME}/.asdf/bin/asdf`, args: ['which', 'qwen'], cwd: '/vault' },
		]);
	});

	it('counts a local shim as before when its manager cannot be found', async () => {
		const deps: DiscoveryDeps = {
			isExecutable: (path) => path === `${HOME}/.asdf/shims/qwen`,
			run: () => Promise.resolve({ stdout: `${HOME}/.asdf/shims`, stderr: '', code: 0 }),
			env: { SHELL: '/bin/sh' },
			home: HOME,
		};
		expect((await probeLocal(['qwen'], {}, deps)).found).toEqual(new Set(['qwen']));
	});

	it('runs the remote script under sh: shims resolved from the vault root, fallbacks counted', () => {
		const home = mkdtempSync(join(tmpdir(), 'oh-probe-'));
		try {
			const bin = join(home, 'bin');
			const shims = join(home, '.local/share/mise/shims');
			const asdfShims = join(home, '.asdf/shims');
			for (const dir of [bin, shims, asdfShims, join(home, 'vault')]) mkdirSync(dir, { recursive: true });
			const script = (path: string, body: string): void => {
				writeFileSync(path, `#!/bin/sh\n${body}\n`);
				chmodSync(path, 0o755);
			};
			// A fake mise: records where it was asked, answers by name.
			script(
				join(bin, 'mise'),
				'pwd >> "$HOME/asked"\ncase "$2" in on|on2) exit 0 ;; stuck) exit 124 ;; *) exit 1 ;; esac',
			);
			for (const name of ['on', 'off', 'stuck', 'off2', 'on2']) symlinkSync(join(bin, 'mise'), join(shims, name));
			// asdf is found but cannot run: the shim counts.
			script(join(bin, 'asdf'), 'exit 126');
			script(join(asdfShims, 'aq'), 'exit 0');
			script(join(bin, 'plain'), 'exit 0');
			const programs = ['plain', 'off', 'on', 'aq', 'nothere', 'stuck', 'off2'];
			const stdout = execFileSync('/bin/sh', ['-c', PROBE_SCRIPT, 'sh', '~/vault', ...programs], {
				env: { HOME: home, PATH: `${bin}:${shims}:${asdfShims}:/usr/bin:/bin` },
				encoding: 'utf8',
			});
			// After mise timed out once, off2 is no longer asked, and counts.
			expect(parseProbeOutput(stdout, programs)).toEqual(new Set(['plain', 'on', 'aq', 'stuck', 'off2']));
			const asked = readFileSync(join(home, 'asked'), 'utf8').trim().split('\n');
			expect(asked).toEqual([join(home, 'vault'), join(home, 'vault'), join(home, 'vault')]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

/** A published connection as far as the catalog reads one. */
function connectionOf(runtime: RuntimeConfig, client: unknown = { ping: () => Promise.resolve() }): Connection {
	return { endpoint: endpointOf(runtime), client } as unknown as Connection;
}

describe('AgentCatalogs', () => {
	function catalogs(current: { connection: Connection | null }, answer: () => AgentProbe = () => probe(['codex'])) {
		const settings = { ...settingsOf() };
		let probes = 0;
		const subject = new AgentCatalogs({
			connection: () => current.connection,
			endpoint: () => endpointOf(LOCAL_HERDR),
			settings: () => settings,
			probe: () => {
				probes++;
				return Promise.resolve(answer());
			},
		});
		return { subject, settings, count: () => probes };
	}

	it('probes once per connection, and again on a new one', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject, count } = catalogs(current);
		expect(subject.cachedCatalog().length).toBeGreaterThan(20);
		await subject.catalog();
		await subject.catalog();
		await subject.defaultLaunch();
		expect(count()).toBe(1);
		expect(ids(subject.cachedCatalog())).toEqual(['codex']);
		expect(await subject.defaultLaunch()).toEqual({ kind: 'codex', label: 'Codex' });

		current.connection = connectionOf(LOCAL_HERDR);
		await subject.catalog();
		expect(count()).toBe(2);
		expect(await subject.refresh('local', true)).toBe(true);
		expect(count()).toBe(3);
	});

	it('shares the published connection’s probe with its own machine only', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject, count } = catalogs(current);
		expect(subject.liveProbeOn('ssh:xl')).toBeNull();
		const live = subject.liveProbeOn('local');
		expect((await live)?.found).toEqual(new Set(['codex']));
		await subject.catalog();
		expect(count()).toBe(1);
		current.connection = null;
		expect(subject.liveProbeOn('local')).toBeNull();
	});

	it('probes again on the same connection only for a new program list', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject, settings, count } = catalogs(current);
		await subject.catalog();
		settings.agentProfiles = [user({ command: '/opt/x' })];
		// What landed serves at once; the new list is probed behind it, once.
		expect(ids(await subject.catalog())).toContain('codex');
		await subject.catalog();
		await settle();
		expect(count()).toBe(2);
		await subject.catalog();
		expect(count()).toBe(2);
	});

	it('keeps one probe per connection, not one per program list it was ever asked for', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject, settings, count } = catalogs(current);
		await subject.refresh('local');
		// Typing a command, one keystroke at a time, probes nothing by itself.
		for (const command of ['/', '/o', '/op', '/opt']) {
			settings.agentProfiles = [user({ command })];
			subject.cachedCatalog();
			subject.cachedProbeFor('local');
		}
		expect(count()).toBe(1);
		expect(await subject.refresh('local')).toBe(true);
		expect(count()).toBe(2);
		expect(await subject.refresh('local')).toBe(false);
		expect(count()).toBe(2);
		// Back to an earlier list is a new probe too: earlier lists are not kept.
		settings.agentProfiles = [];
		expect(await subject.refresh('local')).toBe(true);
		expect(count()).toBe(3);
	});

	it('does not draw the settings again for another runtime’s connection, and so never loops', async () => {
		const current = { connection: connectionOf(SSH_HERDR) as Connection | null };
		const { subject, count } = catalogs(current);
		expect(await subject.refresh('local')).toBe(false);
		expect(subject.cachedProbeFor('local')).toBeNull();
		expect(count()).toBe(0);
		expect(await subject.refresh('xl')).toBe(true);
		expect(await subject.refresh('xl')).toBe(false);
		expect(count()).toBe(1);
	});

	it('tells the host once a probe of the published connection landed', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		let changed = 0;
		const subject = new AgentCatalogs({
			connection: () => current.connection,
			endpoint: () => endpointOf(LOCAL_HERDR),
			settings: () => settingsOf(),
			probe: () => Promise.resolve(probe(['codex'])),
			changed: () => changed++,
		});
		const connection = current.connection;
		if (!connection) throw new Error('no connection');
		subject.connected(connection);
		subject.connected(connection);
		await settle();
		expect(changed).toBe(1);
		expect(ids(subject.cachedCatalog())).toEqual(['codex']);
	});

	it('probes again on a reconnect edge only when what landed was a failure', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		let fail = true;
		const { subject, count } = catalogs(current, () => (fail ? { found: null, error: 'down' } : probe(['codex'])));
		const connection = current.connection;
		if (!connection) throw new Error('no connection');
		subject.connected(connection);
		await settle();
		expect(count()).toBe(1);
		fail = false;
		subject.connected(connection);
		await settle();
		expect(count()).toBe(2);
		subject.connected(connection);
		await settle();
		expect(count()).toBe(2);
		expect(ids(subject.cachedCatalog())).toEqual(['codex']);
	});

	it('starts the default at once when it is known, and waits, saying so, only for the first installed', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const notices: string[] = [];
		let answer: (value: AgentProbe) => void = () => undefined;
		let probes = 0;
		const settings = settingsOf();
		const subject = new AgentCatalogs({
			connection: () => current.connection,
			endpoint: () => endpointOf(LOCAL_HERDR),
			settings: () => settings,
			probe: () => {
				probes++;
				return new Promise<AgentProbe>((resolve) => {
					answer = resolve;
				});
			},
			notice: (message) => notices.push(message),
		});
		// A default of the runtime's own goes without waiting for the probe.
		settings.defaultAgents = { local: 'muse' };
		expect(await subject.defaultLaunch()).toEqual({ kind: 'muse', label: 'Muse' });
		expect(probes).toBe(0);

		// "First installed" waits, and says so when that takes a moment.
		settings.defaultAgents = {};
		const launch = subject.defaultLaunch();
		await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_NOTICE_MS + 50));
		expect(notices).toEqual(['Gjetr: checking which agent CLIs are installed on this machine…']);
		answer(probe(['codex']));
		expect(await launch).toEqual({ kind: 'codex', label: 'Codex' });
		// Landed: at once from now on, and no second notice.
		expect(await subject.defaultLaunch()).toEqual({ kind: 'codex', label: 'Codex' });
		expect(notices).toHaveLength(1);
		expect(probes).toBe(1);
	});

	it('has no probe without a connection, and serves the probe only to its runtime', async () => {
		const current = { connection: null as Connection | null };
		const { subject, count } = catalogs(current);
		expect(await subject.refresh('local')).toBe(false);
		expect((await subject.catalog()).length).toBeGreaterThan(20);
		expect(count()).toBe(0);
		current.connection = connectionOf(LOCAL_HERDR);
		await subject.refresh('local');
		expect(subject.cachedProbeFor('local')).not.toBeNull();
		expect(subject.cachedProbeFor('xl')).toBeNull();
	});

	it('turns a rejected probe into an unverified catalog', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject } = catalogs(current, () => {
			throw new Error('boom');
		});
		const catalog = await subject.catalog();
		expect(catalog[0]?.reason).toBe('could not check what is installed: boom');
	});
});

/**
 * The order the coordinator really runs a connect in (src/connection.ts):
 * the connection is published (`onReplaced`) before its first ping answers,
 * the stream's `connected` edge then primes it (`onPrimed`). The client here
 * acts like the real ones before that ping: herdr's has no server version,
 * herdr-core's rejects every request with "not connected to herdr-core".
 */
describe('the probe in the order a connect really runs', () => {
	class OrderClient {
		live = false;
		readonly handlers = new Map<string, (() => void)[]>();
		private answer: () => void = () => undefined;
		private readonly pinged = new Promise<void>((resolve) => {
			this.answer = resolve;
		});
		constructor(private readonly answers: (method: string) => unknown) {}
		get serverVersion(): string | null {
			return this.live ? '0.9.5' : null;
		}
		/** What the test does when the server answers the first round trip. */
		answerPing(): void {
			this.live = true;
			this.answer();
		}
		ping(): Promise<unknown> {
			return this.pinged;
		}
		request<T>(method: string): Promise<T> {
			if (!this.live) return Promise.reject(new Error('not connected to herdr-core'));
			return Promise.resolve(this.answers(method) as T);
		}
		on(type: string, handler: () => void): void {
			this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
		}
		emit(type: string): void {
			for (const handler of this.handlers.get(type) ?? []) handler();
		}
		setSocketPath(): void {}
		dispose(): void {}
	}

	const emptyScope = {
		workspaceId: null,
		workspaceLabel: null,
		method: 'none',
		size: 0,
		list: () => [],
		get: () => undefined,
		on: () => () => undefined,
		forget: () => undefined,
		refresh: () => Promise.resolve(),
		agentNames: () => new Set<string>(),
	};

	function connecting(
		runtime: RuntimeConfig,
		kindProbe: (connection: Connection, programs: readonly string[]) => Promise<AgentProbe> | null,
		answers: (method: string) => unknown = () => ({}),
		settings: AgentCatalogSettings = settingsOf(),
	) {
		const clients: OrderClient[] = [];
		const asked: { version: string | null; live: boolean }[] = [];
		let catalogs: AgentCatalogs | null = null;
		const coordinator: ConnectionCoordinator<OrderClient, never, never> = new ConnectionCoordinator<OrderClient, never, never>({
			endpoint: () => endpointOf(runtime),
			driver: () => ({
				discover: () => Promise.resolve({ binary: null, status: null, identity: null, socketPath: '/x.sock', error: null }),
				discoveryIssue: () => null,
				createTunnel: () => null,
				createClient: () => {
					const client = new OrderClient(answers);
					clients.push(client);
					return client;
				},
				createScope: () => emptyScope as never,
				prime: () => Promise.resolve(),
				start: (client) => client.emit('connected'),
			}),
			notice: () => undefined,
			setError: () => undefined,
			// As main.ts: nothing is probed at publish, the `connected` edge probes.
			onReplaced: () => undefined,
			onPrimed: () => {
				const current = coordinator.current;
				if (current) catalogs?.connected(current);
			},
		});
		catalogs = new AgentCatalogs({
			connection: () => coordinator.current,
			endpoint: () => endpointOf(runtime),
			settings: () => settings,
			probe: (connection, programs) => {
				const client = connection.client as unknown as OrderClient;
				asked.push({ version: client.serverVersion, live: client.live });
				return kindProbe(connection, programs);
			},
		});
		return { coordinator, catalogs, clients, asked };
	}

	const herdrKind = createHerdrKind({
		extraPath: () => '',
		vaultPath: () => '/vault',
		discoveryDeps: {
			isExecutable: (path) => ['/usr/local/bin/claude', '/usr/local/bin/muse'].includes(path),
			run: () => Promise.resolve({ stdout: '', stderr: '', code: 1 }),
			env: {},
			home: HOME,
		},
		sshRun: () => Promise.reject(new Error('no ssh in tests')),
		onUnsupportedMethod: () => undefined,
		isPublished: () => true,
	});

	it('says a runtime has the native view only where its transcripts can be read, as the view does (ADR-0010)', () => {
		// The runtime half (`EndpointResolver.nativeReachable`) is asserted in
		// `endpointResolver.test.ts`; here, what the catalog does with false.
		const sshHerdr: RuntimeConfig = { ...newRuntime('herdr', 'ssh', []), host: 'xl' };
		const settings = settingsOf();
		const catalogs = new AgentCatalogs({
			connection: () => null,
			endpoint: () => endpointOf(sshHerdr),
			settings: () => settings,
			probe: () => null,
			nativeReachable: (runtime) => !(runtime.kind === 'herdr' && runtime.target === 'ssh'),
		});
		expect(catalogs.cachedCatalog().find((entry) => entry.profile.id === 'claude')?.native).toBe(false);
	});

	it('herdr: a menu opened right at publish still gets the server version, and muse stays the default', async () => {
		const settings = settingsOf({ defaultAgents: { local: 'muse' } });
		const h = connecting(LOCAL_HERDR, (c, p) => herdrKind.probeAgents?.(c as never, p) ?? null, undefined, settings);
		const connect = h.coordinator.connect();
		await settle();
		// Published, not pinged yet: someone opens the + menu now.
		expect(h.coordinator.current).not.toBeNull();
		const menu = h.catalogs.catalog();
		await settle();
		expect(h.asked).toEqual([]);
		h.clients[0]?.answerPing();
		await connect;
		await settle();
		const catalog = await menu;
		expect(h.asked).toEqual([{ version: '0.9.5', live: true }]);
		expect(h.catalogs.cachedProbe()?.herdrVersion).toBe('0.9.5');
		expect(ids(catalog)).toEqual(['muse', 'claude']);
		expect(await h.catalogs.defaultLaunch()).toEqual({ kind: 'muse', label: 'Muse' });
	});

	it('herdr-core: the connected edge probes once it is live, so templates and the probe come through', async () => {
		const coreKind = createHerdrCoreKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/vault',
			vaultName: () => 'vault',
			onMismatch: () => undefined,
			currentScope: () => null,
		});
		const h = connecting(
			SSH_HC,
			(c, p) => coreKind.probeAgents?.(c as never, p) ?? null,
			(method) =>
				method === 'templates.list'
					? { templates: [{ name: 'rev' }] }
					: { code: 0, stdout: Buffer.from('2\nok').toString('base64') },
		);
		const connect = h.coordinator.connect();
		await settle();
		// Even asked at publish, as 2fcdb7c did, it waits for hc's `hello`.
		h.catalogs.connected(h.coordinator.current as unknown as Connection);
		await settle();
		expect(h.asked).toEqual([]);
		h.clients[0]?.answerPing();
		await connect;
		await settle();
		expect(h.asked).toEqual([{ version: '0.9.5', live: true }]);
		const probed = h.catalogs.cachedProbe();
		expect(probed?.error).toBeUndefined();
		expect(probed?.templates).toEqual([{ name: 'rev' }]);
		expect(ids(h.catalogs.cachedCatalog())).toEqual(['codex', 'template:rev']);
	});
});

describe('the kinds’ own probes', () => {
	const machine = (paths: string[]): DiscoveryDeps => ({
		isExecutable: (path) => paths.includes(path),
		run: () => Promise.resolve({ stdout: '', stderr: '', code: 1 }),
		env: {},
		home: HOME,
	});

	it('herdr: one ssh for an SSH runtime, the binary search here, and the server version', async () => {
		const asked: string[][] = [];
		const kind = createHerdrKind({
			extraPath: () => '',
			vaultPath: () => '/vault',
			discoveryDeps: machine(['/usr/local/bin/claude']),
			sshRun: (file, args) => {
				asked.push([file, ...args]);
				return Promise.resolve('1\nok');
			},
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const remote = await kind.probeAgents?.(
			connectionOf({ ...SSH_HERDR, remoteVaultPath: '~/hvelv' }, { serverVersion: '0.9.0' }) as never,
			['codex', 'claude'],
		);
		expect(remote).toEqual({ found: new Set(['codex']), herdrVersion: '0.9.0' });
		expect(asked).toHaveLength(1);
		expect(asked[0]?.slice(0, 7)).toEqual(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'lasse@xl']);
		// Shims are resolved from the remote vault root.
		expect(asked[0]?.[7]?.endsWith(` sh '~/hvelv' codex claude`)).toBe(true);

		const local = await kind.probeAgents?.(connectionOf(LOCAL_HERDR, { serverVersion: '0.9.5' }) as never, ['codex', 'claude']);
		expect(local?.found).toEqual(new Set(['claude']));
		expect(asked).toHaveLength(1);
	});

	it('herdr-core: machine.exec over the connection on SSH, the binary search here, templates on both', async () => {
		const methods: string[] = [];
		const execs: unknown[] = [];
		const client = {
			request: (method: string, params: unknown) => {
				methods.push(method);
				if (method === 'machine.exec') execs.push(params);
				if (method === 'templates.list') return Promise.resolve({ templates: [{ name: 'rev' }] });
				return Promise.resolve({ code: 0, stdout: Buffer.from('2\nok').toString('base64') });
			},
		};
		const kind = createHerdrCoreKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/vault',
			vaultName: () => 'vault',
			onMismatch: () => undefined,
			currentScope: () => null,
			discoveryDeps: machine([`${HOME}/.local/bin/codex`]),
		});
		const remote = await kind.probeAgents?.(
			connectionOf({ ...SSH_HC, remoteVaultPath: '/Users/lasse/Vaults/hvelv' }, client) as never,
			['claude', 'codex'],
		);
		expect(remote).toEqual({ found: new Set(['codex']), templates: [{ name: 'rev' }] });
		expect(methods.sort()).toEqual(['machine.exec', 'templates.list']);
		expect((execs[0] as { argv: string[] }).argv.slice(3)).toEqual(['sh', '/Users/lasse/Vaults/hvelv', 'claude', 'codex']);

		methods.length = 0;
		const local = await kind.probeAgents?.(connectionOf(LOCAL_HC, client) as never, ['claude', 'codex']);
		expect(local?.found).toEqual(new Set(['codex']));
		expect(methods).toEqual(['templates.list']);
	});
});

describe('starting a catalog entry', () => {
	function host(requests: { method: string; params: unknown }[], defaultAgent?: ActionHost['defaultAgent']): ActionHost {
		const request = <T,>(method: string, params: unknown): Promise<T> => {
			requests.push({ method, params });
			if (method === 'tab.create') return Promise.resolve({ tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: 'w1:p1' } } as T);
			if (method === 'pane.list') return Promise.resolve({ panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] } as T);
			if (method === 'terminal.run') return Promise.resolve({ address: 't3' } as T);
			return Promise.resolve({} as T);
		};
		const settings: HerdrSettings = { ...structuredClone(DEFAULT_SETTINGS), openTerminalAfterStart: false, splitIntoFolderTab: false };
		return {
			settings: () => settings,
			runtime: () => LOCAL_HC,
			workspaceId: () => 'w1',
			request,
			connection: () => request,
			takenAgentNames: () => new Set(),
			agentPanes: () => [],
			vaultName: () => 'vault',
			notice: (message) => requests.push({ method: 'notice', params: message }),
			openTerminal: () => Promise.resolve(),
			detachTerminalLeaves: () => undefined,
			forgetPane: () => undefined,
			sleep: () => Promise.resolve(),
			now: () => 0,
			...(defaultAgent ? { defaultAgent } : {}),
		};
	}

	it('herdr starts the runtime’s default with its arguments, and refuses a wrapper before making a tab', async () => {
		const requests: { method: string; params: unknown }[] = [];
		const actions = new HerdrActions(host(requests, () => Promise.resolve({ kind: 'codex', args: ['--profile', 'w'], label: 'Codex' })));
		await actions.startAgentHere('/vault/notes');
		expect(requests.find((r) => r.method === 'agent.start')?.params).toEqual({
			name: 'notes',
			kind: 'codex',
			pane_id: 'w1:p1',
			args: ['--profile', 'w'],
		});
		expect(requests.at(-1)).toEqual({ method: 'notice', params: 'Gjetr: started Codex agent "notes" in notes' });

		requests.length = 0;
		await actions.startAgentHere('/vault/notes', { kind: 'claude', command: '~/bin/c', label: 'Mine' });
		expect(requests.map((r) => r.method)).toEqual(['notice']);
	});

	it('says so, and makes nothing, when the catalog has nothing to start', async () => {
		const requests: { method: string; params: unknown }[] = [];
		await new HerdrActions(host(requests, () => Promise.resolve(null))).startAgentHere('/vault/notes');
		expect(requests).toEqual([
			{ method: 'notice', params: 'Gjetr: no agent CLI was found on this machine. Add one under Settings → Gjetr → Agents.' },
		]);
	});

	it('herdr-core runs a wrapper in the user’s shell and a template as hc’s argv', async () => {
		const requests: { method: string; params: unknown }[] = [];
		const actions = new HcActions(host(requests), () => null);
		await actions.startAgentHere('/vault', { kind: 'claude', command: '~/bin/my-claude', args: ['--model', 'opus'] });
		expect(requests[0]?.params).toMatchObject({ line: agentLaunchLine('claude', ['--model', 'opus'], '~/bin/my-claude') });
		expect(agentLaunchLine('claude', ['--model', 'opus'], '~/bin/my-claude')).toContain(`-ic '~/bin/my-claude --model opus;`);
		// A wrapper's terminal keeps the kind it was started as.
		expect(requests[0]?.params).toMatchObject({ labels: { 'obsidian-herdr.agent': 'claude' } });

		requests.length = 0;
		await actions.startAgentHere('/vault', { kind: 'rev', template: 'rev', label: 'rev' });
		expect(requests[0]?.params).toMatchObject({ argv: ['rev'] });
		expect(requests[0]?.params).not.toHaveProperty('line');
		// A template names no agent kind, so it gets no fallback.
		expect((requests[0]?.params as { labels: Record<string, string> }).labels).not.toHaveProperty('obsidian-herdr.agent');
		expect(() => agentLaunchLine('claude', [], 'rm -rf')).toThrow('not a plain command');
	});
});
