/**
 * The `/` catalog of a herdr-core runtime over SSH (#98, ADR-0006).
 *
 * The script is run for real: the fake core answers `machine.exec` by running
 * its argv with `sh` on this machine (`machineExec` in `./fixtures/fakeHc.ts`),
 * over a temp tree with every awkward thing a remote may have in it. What it
 * reads must be what the local walk reads of the same tree, entry for entry,
 * since both are one walk over two filesystems. The fallbacks are what a
 * remote that does not answer, answers wrong or answers late gives: the
 * built-ins, never this machine's commands.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HcClient, type HcTimers } from '../src/hc/client';
import {
	CATALOG_DEADLINE_MS,
	HcCommandCatalog,
	parseCatalogSnapshot,
	readRemoteCatalog,
	type HcExecRequester,
} from '../src/hc/commandCatalog';
import { builtinCatalog, CATALOG_TTL_MS, loadCommandCatalog, type CatalogEntry } from '../src/native/commandCatalog';
import { fakeSpawner, machineExec, RpcError, settle } from './fixtures/fakeHc';

let root = '';
let home = '';
let config = '';
let repo = '';
let cwd = '';

function write(path: string, body: string | Buffer): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, body);
}

function commandFile(description: string, hint?: string): string {
	return `---\ndescription: ${description}\n${hint === undefined ? '' : `argument-hint: ${hint}\n`}---\n\nDo it.\n`;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-remote-catalog-')));
	home = join(root, 'home with space');
	config = join(root, 'other config');
	repo = join(root, 'work', "it's a repo");
	cwd = join(repo, 'src', 'deep');
	mkdirSync(cwd, { recursive: true });
	write(join(repo, '.git'), 'gitdir: elsewhere\n');
	const user = join(home, '.claude');

	write(join(user, 'commands', 'plain.md'), commandFile('plain', '<n>'));
	write(join(user, 'commands', 'with space.md'), commandFile('a "quoted" one'));
	write(join(user, 'commands', 'quote\'s "both".md'), commandFile("it's"));
	write(join(user, 'commands', 'new\nline.md'), commandFile('a newline in the name'));
	write(join(user, 'commands', 'ns dir', 'deep.md'), commandFile('namespaced'));
	write(join(user, 'commands', 'a', 'b', 'c', 'd', 'e', 'f', 'too-deep.md'), commandFile('past the depth'));
	write(join(user, 'commands', '.hidden.md'), commandFile('hidden'));
	write(join(user, 'commands', 'empty.md'), '');
	write(join(user, 'commands', 'no-front.md'), 'Just a prompt.\n');
	write(join(user, 'commands', 'crlf.md'), '---\r\ndescription: windows\r\n---\r\n');
	write(join(user, 'commands', 'nul.md'), Buffer.from('---\ndescription: has\0nul\x01soh\n---\n'));
	write(join(user, 'commands', 'unclosed.md'), '---\ndescription: never closed\nmore: lines\n');
	write(join(user, 'commands', 'notes.txt'), 'not a command');
	symlinkSync(join(root, 'nowhere.md'), join(user, 'commands', 'dangling.md'));
	write(join(root, 'elsewhere', 'target.md'), commandFile('through a link'));
	symlinkSync(join(root, 'elsewhere', 'target.md'), join(user, 'commands', 'linked.md'));
	// A link back up: walked once by the local walk's visited set.
	symlinkSync(join(user, 'commands'), join(user, 'commands', 'loop'));

	write(join(user, 'skills', 'skill one', 'SKILL.md'), commandFile('a skill'));
	write(join(root, 'elsewhere', 'linked-skill', 'SKILL.md'), commandFile('a linked skill'));
	symlinkSync(join(root, 'elsewhere', 'linked-skill'), join(user, 'skills', 'linked-skill'));
	symlinkSync(join(root, 'gone'), join(user, 'skills', 'broken-skill'));
	mkdirSync(join(user, 'skills', 'no-skill-file'), { recursive: true });

	write(join(repo, '.claude', 'commands', 'plain.md'), commandFile('the project copy'));
	write(join(repo, 'src', '.claude', 'skills', 'near', 'SKILL.md'), commandFile('nearer'));
	write(join(root, 'work', '.claude', 'commands', 'above.md'), commandFile('above the repo'));

	const plugin = join(root, 'plugins', 'say "hi"');
	write(join(plugin, 'commands', 'plugged.md'), commandFile('from a plugin'));
	write(join(plugin, 'skills', 'plug-skill', 'SKILL.md'), commandFile('a plugin skill'));
	write(join(root, 'plugins', 'second', 'commands', 'second.md'), commandFile('second plugin'));
	write(
		join(user, 'plugins', 'installed_plugins.json'),
		JSON.stringify(
			{
				version: 2,
				plugins: {
					'a@m': [{ scope: 'user', installPath: plugin }],
					'b@m': [{ scope: 'user', installPath: join(root, 'plugins', 'second') }],
				},
			},
			null,
			2,
		),
	);

	write(join(config, 'commands', 'from-config.md'), commandFile('the config dir'));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Entries but `nul.md`, whose NUL and \001 bytes the remote strips by design
 * (they frame its answer); that one is checked on its own.
 */
const comparable = (entries: CatalogEntry[]): CatalogEntry[] => entries.filter((e) => e.name !== 'nul');

/** Entries without their paths, for a readable diff before the exact compare. */
const names = (entries: CatalogEntry[]): string[] => entries.map((e) => `${e.scope} ${e.name}`);

async function overFakeCore(env: Record<string, string | undefined>, at = cwd): Promise<CatalogEntry[]> {
	const { spawn } = fakeSpawner((core) => core.handlers.set('machine.exec', machineExec(env)));
	const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers: handTimers().timers });
	try {
		await client.ping();
		return await readRemoteCatalog(client, at);
	} finally {
		client.dispose();
	}
}

describe('readRemoteCatalog: one machine.exec, the local walk over its answer', () => {
	it('reads what the local walk reads of the same home and cwd', async () => {
		const remote = await overFakeCore({ HOME: home, CLAUDE_CONFIG_DIR: undefined });
		const local = loadCommandCatalog({ home, cwd });

		expect(names(remote)).toEqual(names(local));
		expect(comparable(remote)).toEqual(comparable(local));
	});

	it('keeps odd names, namespaces, links and frontmatter as the walk does', async () => {
		const remote = await overFakeCore({ HOME: home, CLAUDE_CONFIG_DIR: undefined });
		const byName = new Map(remote.map((entry) => [entry.name, entry]));

		expect(byName.get('with space')?.description).toBe('a "quoted" one');
		expect(byName.get('new\nline')?.description).toBe('a newline in the name');
		expect(byName.get('ns dir:deep')?.description).toBe('namespaced');
		expect(byName.get('linked')?.path).toBe(join(root, 'elsewhere', 'target.md'));
		expect(byName.get('linked-skill')?.path).toBe(join(root, 'elsewhere', 'linked-skill', 'SKILL.md'));
		expect(byName.get('crlf')?.description).toBe('windows');
		// Locally 'has\0nul\x01soh'; the bytes that frame the answer are dropped.
		expect(byName.get('nul')?.description).toBe('hasnulsoh');
		expect(byName.get('empty')?.description).toBe('');
		expect(byName.get('plain')?.scope).toBe('project');
		expect(byName.get('near')?.scope).toBe('project');
		expect(byName.get('plugged')?.scope).toBe('plugin');
		expect(byName.get('second')?.scope).toBe('plugin');
		for (const absent of ['dangling', 'broken-skill', 'no-skill-file', 'above', 'notes.txt']) {
			expect(byName.has(absent)).toBe(false);
		}
	});

	it('reads the user scope from CLAUDE_CONFIG_DIR when the core has it', async () => {
		const remote = await overFakeCore({ HOME: home, CLAUDE_CONFIG_DIR: config });

		expect(remote).toEqual(loadCommandCatalog({ configDir: config, cwd }));
		expect(names(remote)).toContain('user from-config');
		expect(names(remote)).not.toContain('user with space');
	});

	it('has no project scope without a cwd, and no user scope without a home', async () => {
		const remote = await overFakeCore({ HOME: '', CLAUDE_CONFIG_DIR: undefined }, '');

		expect(remote).toEqual(builtinCatalog());
	});

	it('walks from a cwd that is not there, as the local walk does', async () => {
		const missing = join(repo, 'gone', 'deeper');
		const remote = await overFakeCore({ HOME: home, CLAUDE_CONFIG_DIR: undefined }, missing);

		expect(comparable(remote)).toEqual(comparable(loadCommandCatalog({ home, cwd: missing })));
	});
});

describe('parseCatalogSnapshot', () => {
	const record = (...fields: string[]): string => fields.map((field) => `${field}\0`).join('');

	it('refuses a stream that was cut short', () => {
		const whole = record('H', '/h', '/h/.claude') + record('d', '/h/.claude/commands', '/h/.claude/commands');
		expect(parseCatalogSnapshot(Buffer.from(whole))).toBeNull();
		expect(parseCatalogSnapshot(Buffer.from(whole + record('E')))).not.toBeNull();
	});

	it('refuses a record it does not know, and a text of no batch', () => {
		expect(parseCatalogSnapshot(Buffer.from(record('H', '/h', '') + record('Q', 'x') + record('E')))).toBeNull();
		expect(parseCatalogSnapshot(Buffer.from(record('H', '/h', '') + record('T', '1', 'x') + record('E')))).toBeNull();
	});
});

/** A requester whose answers the test hands out. */
function controlled() {
	const calls: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
	const requester: HcExecRequester = {
		request: <T>() =>
			new Promise<T>((resolve, reject) => {
				calls.push({ resolve: resolve as (value: unknown) => void, reject });
			}),
	};
	return { requester, calls };
}

/** Timers fired by hand, as `HcTimers` (`set`/`clear`) wants them. */
function handTimers() {
	const pending = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	const timers: HcTimers = {
		set: (callback, ms) => {
			pending.set(next, { callback, ms });
			return next++;
		},
		clear: (handle) => pending.delete(handle as number),
	};
	const fire = (ms: number): void => {
		for (const [id, entry] of [...pending]) {
			if (entry.ms !== ms) continue;
			pending.delete(id);
			entry.callback();
		}
	};
	return { timers, fire };
}

/** A whole snapshot with one user command, as the script would print it. */
function snapshotWith(name: string): { code: number; stdout: string } {
	const fields = [
		'H', '/h', '/h/.claude',
		'd', '/h/.claude/commands', '/h/.claude/commands',
		'c', '/h/.claude/commands', `${name}.md`, 'f',
		'B',
		'f', `/h/.claude/commands/${name}.md`, `/h/.claude/commands/${name}.md`,
		'R', `/h/.claude/commands/${name}.md`,
		'T', '1', '---\ndescription: remote\n---\n',
		'E',
	];
	return { code: 0, stdout: Buffer.from(fields.map((f) => `${f}\0`).join('')).toString('base64') };
}

describe('HcCommandCatalog: cache and fallback', () => {
	it('falls back to the built-ins when the core says no, and remembers that for the TTL', async () => {
		const { spawn, cores } = fakeSpawner((core) =>
			core.handlers.set('machine.exec', () => {
				throw new RpcError('unavailable', '16 execs are running already');
			}),
		);
		const client = new HcClient({ argv: ['hc', 'connect'], spawn, timers: handTimers().timers });
		await client.ping();
		const catalog = new HcCommandCatalog(client);

		expect(await catalog.catalog('/repo')).toEqual(builtinCatalog());
		expect(catalog.catalog('/repo')).toEqual(builtinCatalog());
		await settle();
		expect(cores[0]?.calls.filter((call) => call.method === 'machine.exec')).toHaveLength(1);
		client.dispose();
	});

	it('falls back to the built-ins on an answer that was cut short', async () => {
		const { requester, calls } = controlled();
		const catalog = new HcCommandCatalog(requester);
		const answer = catalog.catalog('/repo');
		calls[0]?.resolve({ ...snapshotWith('x'), truncated: true });

		expect(await answer).toEqual(builtinCatalog());
	});

	it('gives the built-ins to a slow read, and its own answer once it lands', async () => {
		const { requester, calls } = controlled();
		const { timers, fire } = handTimers();
		let now = 0;
		const catalog = new HcCommandCatalog(requester, { timers, now: () => now });

		const first = catalog.catalog('/repo');
		fire(CATALOG_DEADLINE_MS);
		expect(await first).toEqual(builtinCatalog());

		// Still in flight: asking again reads nothing more.
		const second = catalog.catalog('/repo');
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(snapshotWith('remote-only'));
		const entries = await second;
		expect(entries.map((entry) => entry.name)).toContain('remote-only');

		// Known now, synchronously, until the TTL runs out.
		now += CATALOG_TTL_MS - 1;
		expect(catalog.catalog('/repo')).toBe(entries);
		now += 1;
		const stale = catalog.catalog('/repo');
		expect(calls).toHaveLength(2);
		// A slow refresh keeps what this cwd had: the remote's, not the built-ins.
		fire(CATALOG_DEADLINE_MS);
		expect(await stale).toBe(entries);
	});

	it('keeps one catalog per cwd', async () => {
		const { requester, calls } = controlled();
		const catalog = new HcCommandCatalog(requester);
		const a = catalog.catalog('/a');
		const b = catalog.catalog('/b/');
		expect(calls).toHaveLength(2);
		calls[0]?.resolve(snapshotWith('in-a'));
		calls[1]?.resolve(snapshotWith('in-b'));

		expect((await a).map((entry) => entry.name)).toContain('in-a');
		expect((await b).map((entry) => entry.name)).toContain('in-b');
		expect(catalog.catalog('/b')).toEqual(await b);
	});
});
