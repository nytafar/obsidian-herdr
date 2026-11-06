/**
 * The agent CLI catalog (issue #125): the merge of built-ins, hc templates
 * and user entries per runtime kind, the per-runtime default, the
 * `defaultAgentKind` migration, the probe commands and their parsing, the
 * per-connection cache, and the kinds' own probes.
 *
 * Nothing here invokes ssh or starts a CLI: every runner, filesystem and
 * requester is a fake that records what it was asked.
 */

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
	sshProbeArgs,
} from '../src/agents/probe';
import { AgentCatalogs } from '../src/agents/catalogs';
import { startButtonLabel, startMenuItems } from '../src/views/startMenu';
import { agentLaunchLine, HcActions } from '../src/hc/actions';
import { HerdrActions, type ActionHost } from '../src/actions';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { endpointOf, type Connection } from '../src/connection';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig } from '../src/runtimes';
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
		expect(byId.get('user-a')).toMatchObject({ available: false, found: false, reason: 'codex not found on lasse@xl' });
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
			settings: settingsOf({ hiddenAgents: ['codex'], agentProfiles: [user({ name: 'Gone', command: '' , agent: 'amp' })] }),
			probe: probe(['claude', 'codex']),
		});
		const items = startMenuItems(catalog);
		expect(items.map((item) => item.title)).toEqual(['Claude Code', 'Gone (amp not found on this machine)']);
		expect(items[0]).toMatchObject({ checked: true, disabled: false, launch: { kind: 'claude', label: 'Claude Code' } });
		expect(items[1]).toMatchObject({ checked: false, disabled: true, launch: null });
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
		expect(asked[0]?.args[6]).toBe(`sh -c '${PROBE_SCRIPT}' sh claude '~/bin/x'`);
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
			{ method: 'machine.exec', params: { argv: ['sh', '-c', PROBE_SCRIPT, 'sh', 'claude', 'codex'], timeout: 15 } },
		]);
		const failing = { request: <T,>(): Promise<T> => Promise.reject(new Error('machine_unknown')) };
		expect(await probeOverHc(failing, ['claude'])).toEqual({ found: null, error: 'machine_unknown' });
		expect(
			parseTemplates({ templates: [{ name: 'rev', description: 'Review', command: 'claude' }, { name: '' }, { name: 'b', error: 'bad' }] }),
		).toEqual([{ name: 'rev', description: 'Review' }, { name: 'b', error: 'bad' }]);
		expect(parseTemplates(null)).toEqual([]);
	});
});

/** A published connection as far as the catalog reads one. */
function connectionOf(runtime: RuntimeConfig, client: unknown = {}): Connection {
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
		await subject.check(true);
		expect(count()).toBe(3);
	});

	it('probes again on the same connection only for a new program list', async () => {
		const current = { connection: connectionOf(LOCAL_HERDR) as Connection | null };
		const { subject, settings, count } = catalogs(current);
		await subject.catalog();
		settings.agentProfiles = [user({ command: '/opt/x' })];
		await subject.catalog();
		await subject.catalog();
		expect(count()).toBe(2);
	});

	it('has no probe without a connection, and serves the probe only to its runtime', async () => {
		const current = { connection: null as Connection | null };
		const { subject, count } = catalogs(current);
		expect(await subject.check()).toBe(false);
		expect((await subject.catalog()).length).toBeGreaterThan(20);
		expect(count()).toBe(0);
		current.connection = connectionOf(LOCAL_HERDR);
		await subject.check();
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
			onProtocolMismatch: () => undefined,
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const remote = await kind.probeAgents?.(connectionOf(SSH_HERDR, { serverVersion: '0.9.0' }) as never, ['codex', 'claude']);
		expect(remote).toEqual({ found: new Set(['codex']), herdrVersion: '0.9.0' });
		expect(asked).toHaveLength(1);
		expect(asked[0]?.slice(0, 7)).toEqual(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'lasse@xl']);

		const local = await kind.probeAgents?.(connectionOf(LOCAL_HERDR, { serverVersion: '0.9.5' }) as never, ['codex', 'claude']);
		expect(local?.found).toEqual(new Set(['claude']));
		expect(asked).toHaveLength(1);
	});

	it('herdr-core: machine.exec over the connection on SSH, the binary search here, templates on both', async () => {
		const methods: string[] = [];
		const client = {
			request: (method: string) => {
				methods.push(method);
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
		const remote = await kind.probeAgents?.(connectionOf(SSH_HC, client) as never, ['claude', 'codex']);
		expect(remote).toEqual({ found: new Set(['codex']), templates: [{ name: 'rev' }] });
		expect(methods.sort()).toEqual(['machine.exec', 'templates.list']);

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
		expect(requests.at(-1)).toEqual({ method: 'notice', params: 'Herdr: started Codex agent "notes" in notes' });

		requests.length = 0;
		await actions.startAgentHere('/vault/notes', { kind: 'claude', command: '~/bin/c', label: 'Mine' });
		expect(requests.map((r) => r.method)).toEqual(['notice']);
	});

	it('says so, and makes nothing, when the catalog has nothing to start', async () => {
		const requests: { method: string; params: unknown }[] = [];
		await new HerdrActions(host(requests, () => Promise.resolve(null))).startAgentHere('/vault/notes');
		expect(requests).toEqual([
			{ method: 'notice', params: 'Herdr: no agent CLI was found on this machine. Add one under Settings → Herdr → Agents.' },
		]);
	});

	it('herdr-core runs a wrapper in the user’s shell and a template as hc’s argv', async () => {
		const requests: { method: string; params: unknown }[] = [];
		const actions = new HcActions(host(requests), () => null);
		await actions.startAgentHere('/vault', { kind: 'claude', command: '~/bin/my-claude', args: ['--model', 'opus'] });
		expect(requests[0]?.params).toMatchObject({ line: agentLaunchLine('claude', ['--model', 'opus'], '~/bin/my-claude') });
		expect(agentLaunchLine('claude', ['--model', 'opus'], '~/bin/my-claude')).toContain(`-ic '~/bin/my-claude --model opus;`);

		requests.length = 0;
		await actions.startAgentHere('/vault', { kind: 'rev', template: 'rev', label: 'rev' });
		expect(requests[0]?.params).toMatchObject({ argv: ['rev'] });
		expect(requests[0]?.params).not.toHaveProperty('line');
		expect(() => agentLaunchLine('claude', [], 'rm -rf')).toThrow('not a plain command');
	});
});
