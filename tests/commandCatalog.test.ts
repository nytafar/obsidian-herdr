/**
 * The command catalog (issue #98).
 *
 * A real temp directory tree, because what the catalog knows is what is on
 * disk: three scopes, namespaced folders, symlinks that must be followed and
 * resolved, and the walk up to the repository root that decides what "project"
 * means. Nothing here is faked; the tree is built in `beforeAll` and the
 * expected names and scopes are written out by hand.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	BUILTIN_COMMANDS,
	loadCommandCatalog,
	matchCommands,
	projectCommandRoots,
	type CatalogEntry,
} from '../src/native/commandCatalog';

let root = '';
let home = '';
let repo = '';
let cwd = '';
let elsewhere = '';
let worktree = '';

function write(path: string, body: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, body);
}

/** A command file as Claude Code writes them: frontmatter, then the prompt. */
function commandFile(description: string, argumentHint?: string): string {
	const hint = argumentHint === undefined ? '' : `argument-hint: ${argumentHint}\n`;
	return `---\ndescription: ${description}\n${hint}---\n\nDo the thing.\n`;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-catalog-')));
	home = join(root, 'home');
	repo = join(root, 'work', 'repo');
	cwd = join(repo, 'src', 'deep');
	elsewhere = join(root, 'elsewhere');
	worktree = join(root, 'work', 'worktree');
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(repo, '.git'), { recursive: true });
	// A checkout of the same repository as a worktree: its `.git` is a file
	// pointing at the real repository, not a directory. It is a repository root
	// all the same, and the project walk stops there.
	mkdirSync(join(worktree, 'src'), { recursive: true });
	write(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
	write(
		join(worktree, '.claude', 'commands', 'worktree-only.md'),
		commandFile('only this worktree'),
	);

	// User scope.
	write(join(home, '.claude', 'commands', 'shared.md'), commandFile('the user copy'));
	write(join(home, '.claude', 'commands', 'user-only.md'), commandFile('only the user has it'));
	write(join(home, '.claude', 'commands', 'ns', 'deep.md'), commandFile('namespaced'));
	write(
		join(home, '.claude', 'skills', 'user-skill', 'SKILL.md'),
		commandFile('a skill of the user'),
	);

	// A command that is a symlink to a file outside every scope.
	write(join(elsewhere, 'real-command.md'), commandFile('reached through a link'));
	symlinkSync(
		join(elsewhere, 'real-command.md'),
		join(home, '.claude', 'commands', 'linked-command.md'),
	);
	// A skill that is a symlinked directory, as `~/.claude/skills` really has.
	write(join(elsewhere, 'linked-skill', 'SKILL.md'), commandFile('a skill behind a link'));
	symlinkSync(join(elsewhere, 'linked-skill'), join(home, '.claude', 'skills', 'linked-skill'));

	// Project scope, inside the repository.
	write(
		join(repo, '.claude', 'commands', 'shared.md'),
		commandFile('the project copy', '<issue number>'),
	);
	write(join(repo, '.claude', 'commands', 'project-only.md'), commandFile('only this repo'));
	// A nearer directory than the repository root wins inside the project scope.
	write(join(repo, 'src', '.claude', 'commands', 'project-only.md'), commandFile('nearer'));
	// Above the repository root: outside the project, never offered.
	write(join(root, 'work', '.claude', 'commands', 'above-the-repo.md'), commandFile('too far up'));

	// Plugin scope, through the installed-plugins file.
	write(join(root, 'plugins', 'demo', 'commands', 'shared.md'), commandFile('the plugin copy'));
	write(
		join(root, 'plugins', 'demo', 'commands', 'plugin-only.md'),
		commandFile('only the plugin'),
	);
	write(
		join(root, 'plugins', 'demo', 'skills', 'plugin-skill', 'SKILL.md'),
		commandFile('a skill of the plugin'),
	);
	write(
		join(home, '.claude', 'plugins', 'installed_plugins.json'),
		JSON.stringify({
			version: 2,
			plugins: {
				'demo@market': [{ scope: 'user', installPath: join(root, 'plugins', 'demo') }],
			},
		}),
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function catalog(): CatalogEntry[] {
	return loadCommandCatalog({ home, cwd });
}

function named(name: string): CatalogEntry {
	const hits = catalog().filter((entry) => entry.name === name);
	expect(hits).toHaveLength(1);
	return hits[0] as CatalogEntry;
}

describe('projectCommandRoots', () => {
	it('walks up from the cwd to the repository root and no further', () => {
		expect(projectCommandRoots(cwd)).toEqual([
			join(repo, 'src', 'deep', '.claude'),
			join(repo, 'src', '.claude'),
			join(repo, '.claude'),
		]);
	});

	it('has no project scope before the pane has a cwd', () => {
		// A relative walk from '' would read the plugin process's own directory.
		expect(projectCommandRoots('')).toEqual([]);
	});

	it('stops at a worktree root, whose repository marker is a file (#98)', () => {
		expect(projectCommandRoots(join(worktree, 'src'))).toEqual([
			join(worktree, 'src', '.claude'),
			join(worktree, '.claude'),
		]);
	});

	it('offers a worktree no commands from above its root', () => {
		// `work/.claude/commands/above-the-repo.md` sits one directory up.
		const names = loadCommandCatalog({ home, cwd: join(worktree, 'src') }).map(
			(entry) => entry.name,
		);
		expect(names).toContain('worktree-only');
		expect(names).not.toContain('above-the-repo');
	});
});

describe('loadCommandCatalog: the three scopes', () => {
	it('finds commands and skills in each scope', () => {
		expect(named('user-only').scope).toBe('user');
		expect(named('user-only').kind).toBe('command');
		expect(named('user-skill').kind).toBe('skill');
		expect(named('user-skill').scope).toBe('user');
		expect(named('plugin-only').scope).toBe('plugin');
		expect(named('plugin-skill').scope).toBe('plugin');
		expect(named('project-only').scope).toBe('project');
	});

	it('namespaces a command in a folder with a colon', () => {
		expect(named('ns:deep').description).toBe('namespaced');
	});

	it('reads the description and the argument hint out of the frontmatter', () => {
		expect(named('shared').description).toBe('the project copy');
		expect(named('shared').argumentHint).toBe('<issue number>');
		expect(named('user-only').argumentHint).toBe('');
	});

	it('offers nothing from above the repository root', () => {
		expect(catalog().map((entry) => entry.name)).not.toContain('above-the-repo');
	});
});

describe('loadCommandCatalog: precedence', () => {
	it('gives a name to the project, then the user, then the plugin', () => {
		const shared = named('shared');
		expect(shared.scope).toBe('project');
		expect(shared.description).toBe('the project copy');
	});

	it('gives a name to the nearer project directory', () => {
		expect(named('project-only').description).toBe('nearer');
	});

	it('keeps a built-in unless a scope defines the same name', () => {
		expect(named('clear').scope).toBe('builtin');
		expect(BUILTIN_COMMANDS.map((entry) => entry.name)).toContain('clear');
	});
});

describe('loadCommandCatalog: symlinks', () => {
	it('follows a symlinked command file and reports where it really is', () => {
		const linked = named('linked-command');
		expect(linked.description).toBe('reached through a link');
		expect(linked.path).toBe(join(elsewhere, 'real-command.md'));
	});

	it('follows a symlinked skill directory', () => {
		const linked = named('linked-skill');
		expect(linked.description).toBe('a skill behind a link');
		expect(linked.path).toBe(join(elsewhere, 'linked-skill', 'SKILL.md'));
	});
});

describe('matchCommands', () => {
	it('offers everything for an empty query, in name order', () => {
		const names = matchCommands(catalog(), '').map((entry) => entry.name);
		expect(names).toEqual([...names].sort());
		expect(names).toContain('shared');
	});

	it('matches a prefix before a substring, case-insensitively', () => {
		const entries: CatalogEntry[] = [
			{ name: 'un-shared', scope: 'user', kind: 'command', description: '', argumentHint: '', path: null },
			{ name: 'Shared', scope: 'user', kind: 'command', description: '', argumentHint: '', path: null },
		];

		expect(matchCommands(entries, 'sh').map((entry) => entry.name)).toEqual([
			'Shared',
			'un-shared',
		]);
	});

	it('offers nothing that does not contain the query', () => {
		expect(matchCommands(catalog(), 'zzz')).toEqual([]);
	});
});
