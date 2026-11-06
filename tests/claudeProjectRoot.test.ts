/**
 * Which `settings.local.json` Claude Code writes an "Always allow in this
 * project" rule to, and so what the waiting card names (ADR-0007).
 *
 * The rule mirrors Claude Code 2.1.318 (`localSettings` is canonicalised to
 * the repository): measured live under `/tmp/oh-d1f-*` on 2026-11-06 for a
 * git subfolder (the git root), a linked worktree (the main checkout's root),
 * a nested repository (the innermost root), a folder outside git (the folder),
 * a symlinked cwd (its real path), and a git root that is the home directory
 * (the folder). The ownership guard and the missing-uid platforms are read
 * from the same build and pinned through the injected filesystem.
 *
 * The layouts are built by hand (a `.git` folder, or a `.git` file with its
 * `commondir` and `gitdir` the way `git worktree add` writes them), so the
 * tests need no git.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localSettingsTarget, nodeProjectRootEnv, type ProjectRootEnv, type ProjectRootStats } from '../src/claude/projectRoot';

let base = '';

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), 'oh-project-root-')));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
}

/** A repository the way `git init` leaves it: a `.git` folder. */
function repo(...parts: string[]): string {
	const root = dir(...parts);
	mkdirSync(join(root, '.git'), { recursive: true });
	writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	return root;
}

/** A linked worktree of `main`, the way `git worktree add` writes one. */
function worktree(main: string, ...parts: string[]): string {
	const tree = dir(...parts);
	const admin = join(main, '.git', 'worktrees', 'wt');
	mkdirSync(admin, { recursive: true });
	writeFileSync(join(admin, 'commondir'), '../..\n');
	writeFileSync(join(admin, 'gitdir'), `${join(tree, '.git')}\n`);
	writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`);
	return tree;
}

function env(overrides: Partial<ProjectRootEnv> = {}): ProjectRootEnv {
	return { ...nodeProjectRootEnv(), home: dir('home'), ...overrides };
}

/** The same entry, owned by `uid`. */
function ownedAs(stats: ProjectRootStats, uid: number): ProjectRootStats {
	return {
		isDirectory: () => stats.isDirectory(),
		isFile: () => stats.isFile(),
		isSymbolicLink: () => stats.isSymbolicLink(),
		uid,
	};
}

const file = (root: string): string => join(root, '.claude', 'settings.local.json');

describe('the file an "always allow in this project" rule is written to', () => {
	it('is the git root for a folder inside a repository, and the rule covers the whole repository', () => {
		const root = repo('vault');
		const sub = dir('vault', 'notes', 'daily');
		expect(localSettingsTarget(sub, env())).toEqual({ file: file(root), root, scope: 'repository' });
	});

	it('is the folder itself when the folder is the git root', () => {
		const root = repo('vault');
		expect(localSettingsTarget(root, env())).toEqual({ file: file(root), root, scope: 'repository' });
	});

	it('is the main checkout for a linked worktree', () => {
		const main = repo('main');
		worktree(main, 'wt');
		const sub = dir('wt', 'sub');
		expect(localSettingsTarget(sub, env())).toEqual({ file: file(main), root: main, scope: 'repository' });
	});

	it('is the innermost repository for a nested one', () => {
		repo('outer');
		const inner = repo('outer', 'inner');
		expect(localSettingsTarget(dir('outer', 'inner', 'sub'), env())?.root).toBe(inner);
	});

	it('is a submodule its own root: a .git file with no commondir', () => {
		const outer = repo('outer');
		const admin = dir('outer', '.git', 'modules', 'lib');
		const lib = dir('outer', 'lib');
		writeFileSync(join(lib, '.git'), `gitdir: ${admin}\n`);
		expect(localSettingsTarget(lib, env())?.root).toBe(lib);
		expect(localSettingsTarget(lib, env())?.root).not.toBe(outer);
	});

	it('is the folder outside git, and the rule covers that folder only', () => {
		const folder = dir('plain', 'sub');
		expect(localSettingsTarget(folder, env())).toEqual({ file: file(folder), root: folder, scope: 'folder' });
	});

	it('follows a symlinked folder to its real path, as Claude does', () => {
		const root = repo('real');
		const sub = dir('real', 'sub');
		const link = join(base, 'link');
		symlinkSync(sub, link);
		expect(localSettingsTarget(link, env())).toEqual({ file: file(root), root, scope: 'repository' });
		const plain = dir('plain');
		symlinkSync(plain, join(base, 'plain-link'));
		expect(localSettingsTarget(join(base, 'plain-link'), env())?.root).toBe(plain);
	});

	it('stays in the folder when the git root is the home directory', () => {
		const home = repo('home');
		const sub = dir('home', 'sub');
		expect(localSettingsTarget(sub, env({ home }))).toEqual({ file: file(sub), root: sub, scope: 'folder' });
	});

	it('stays in the folder when the root, its .git or its .claude is not the user’s', () => {
		const root = repo('vault');
		mkdirSync(join(root, '.claude'));
		const sub = dir('vault', 'sub');
		const real = nodeProjectRootEnv();
		const owned = (owner: (path: string) => number): ProjectRootEnv =>
			env({
				euid: 1000,
				stat: (path) => ownedAs(real.stat(path), owner(path)),
				lstat: (path) => ownedAs(real.lstat(path), owner(path)),
			});
		expect(localSettingsTarget(sub, owned(() => 1000))?.root).toBe(root);
		expect(localSettingsTarget(sub, owned((path) => (path === root ? 0 : 1000)))?.root).toBe(sub);
		expect(localSettingsTarget(sub, owned((path) => (path.endsWith('.git') ? 0 : 1000)))?.root).toBe(sub);
		expect(localSettingsTarget(sub, owned((path) => (path.endsWith('.claude') ? 0 : 1000)))).toEqual({
			file: file(sub),
			root: sub,
			scope: 'folder',
		});
	});

	it('stays in the folder on a platform with no uid to check ownership with', () => {
		repo('vault');
		const sub = dir('vault', 'sub');
		expect(localSettingsTarget(sub, env({ euid: null }))?.root).toBe(sub);
	});

	it('is unknown when the folder is gone, .git is a link, or a worktree’s common dir is not a .git', () => {
		expect(localSettingsTarget(join(base, 'missing'), env())).toBeNull();
		const linked = dir('linked');
		symlinkSync(dir('elsewhere'), join(linked, '.git'));
		expect(localSettingsTarget(dir('linked', 'sub'), env())).toBeNull();
		// A worktree of a bare repository: its common dir is `bare.git`, not `<root>/.git`.
		const admin = dir('bare.git', 'worktrees', 'wt');
		const tree = dir('wt');
		writeFileSync(join(admin, 'commondir'), '../..\n');
		writeFileSync(join(admin, 'gitdir'), `${join(tree, '.git')}\n`);
		writeFileSync(join(tree, '.git'), `gitdir: ${admin}\n`);
		expect(localSettingsTarget(tree, env())).toBeNull();
	});

	it('keeps the worktree itself when its back-pointer names another checkout', () => {
		const main = repo('main');
		const tree = worktree(main, 'wt');
		writeFileSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'), `${join(base, 'other', '.git')}\n`);
		expect(localSettingsTarget(tree, env())?.root).toBe(tree);
	});
});
