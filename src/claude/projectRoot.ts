/**
 * Where Claude Code writes an "Always allow in this project" rule: the
 * `localSettings` suggestion's `settings.local.json` (ADR-0007), so the
 * waiting card can name the file and say how far the rule reaches before it
 * is pressed.
 *
 * Claude Code does not write it in the cwd. Since 2.1.x `localSettings` is
 * canonicalised to the repository: the file is
 * `<root>/.claude/settings.local.json`, where the root is decided like this
 * (read from the 2.1.318 bundle, measured live under `/tmp/oh-d1f-*` on
 * 2026-11-06 for every case marked "live"):
 *
 * 1. The cwd is its real path: a symlinked folder is followed (live).
 * 2. The git root is the nearest folder upwards with a `.git` folder or file
 *    (live: a subfolder, a nested repository takes the innermost one).
 * 3. A linked worktree's root is its main checkout: the `.git` file's
 *    `gitdir`, whose `commondir` leads to `<main>/.git`, and whose `gitdir`
 *    points back at this `.git` (live). A `.git` file without a `commondir`,
 *    as a submodule has, keeps its own folder.
 * 4. When that root is not the cwd, it is used only if it is not the home
 *    directory (live: the folder is used instead), the platform has uids, and
 *    the root, its `.git` and its `.claude` (when there is one) belong to the
 *    current user. Otherwise the file stays in the cwd.
 *
 * A rule in the repository's file applies to every agent started anywhere in
 * that repository and its worktrees; one in a folder's own file only to
 * agents started in exactly that folder. Wherever the rule cannot be told
 * for sure (the folder cannot be resolved, `.git` is a link, a worktree of a
 * bare repository), the answer is null and the card offers no such button.
 *
 * The filesystem, home, platform and uid are injected, so the rules are
 * tested on built layouts with no git.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** What the resolver reads of one entry. */
export interface ProjectRootStats {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	uid: number;
}

/** The slice of the machine the rule reads. Every call throws as `node:fs` does. */
export interface ProjectRootEnv {
	realpath(path: string): string;
	lstat(path: string): ProjectRootStats;
	stat(path: string): ProjectRootStats;
	readFile(path: string): string;
	/** The home directory Claude sees. */
	home: string;
	/** The effective uid, or null on a platform without uids (Windows). */
	euid: number | null;
}

/** The settings file a project rule goes to, and how far it reaches. */
export interface LocalSettingsTarget {
	/** `<root>/.claude/settings.local.json`, absolute. */
	file: string;
	/** The folder the file belongs to. */
	root: string;
	/**
	 * `repository`: every agent started anywhere in the git repository at
	 * `root`, its worktrees included. `folder`: agents started in `root` itself.
	 */
	scope: 'repository' | 'folder';
}

/** The real machine, for the plugin. */
export function nodeProjectRootEnv(): ProjectRootEnv {
	return {
		realpath: (path) => realpathSync(path),
		lstat: (path) => lstatSync(path),
		stat: (path) => statSync(path),
		readFile: (path) => readFileSync(path, 'utf8'),
		home: homedir(),
		euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
	};
}

const missing = (error: unknown): boolean => {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
};

/** An entry's stats, null when it is not there; anything else throws. */
function entry(env: ProjectRootEnv, path: string): ProjectRootStats | null {
	try {
		return env.lstat(path);
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

/** Thrown where the rule cannot be followed for sure. */
class Unknown extends Error {}

/** The nearest folder from `start` upwards with a `.git` folder or file; null for none. */
function gitRoot(env: ProjectRootEnv, start: string): string | null {
	let dir = start;
	for (;;) {
		const git = entry(env, join(dir, '.git'));
		if (git?.isSymbolicLink()) throw new Unknown();
		if (git && (git.isDirectory() || git.isFile())) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** A small file's trimmed text, or null when it is not a plain file. */
function plainText(env: ProjectRootEnv, path: string): string | null {
	const stats = entry(env, path);
	if (!stats || !stats.isFile()) return null;
	return env.readFile(path).trim();
}

/** A linked worktree's main checkout; the root itself for anything else. */
function canonicalRoot(env: ProjectRootEnv, root: string): string {
	const git = join(root, '.git');
	if (env.lstat(git).isDirectory()) return root;
	const content = env.readFile(git).trim();
	if (!content.startsWith('gitdir:')) return root;
	const admin = resolve(root, content.slice('gitdir:'.length).trim());
	const commondir = plainText(env, join(admin, 'commondir'));
	// No commondir: a submodule or a plain gitfile, whose root is its own.
	if (commondir === null) return root;
	const common = resolve(admin, commondir);
	if (resolve(dirname(admin)) !== join(common, 'worktrees')) return root;
	const back = plainText(env, join(admin, 'gitdir'));
	if (back === null || resolve(admin, back) !== git) return root;
	// A worktree of a bare repository: Claude reads more than is mirrored here.
	if (basename(common) !== '.git') throw new Unknown();
	return dirname(common);
}

/** Whether the root, its `.git` and its `.claude` (if any) are the current user's. */
function ownedByUser(env: ProjectRootEnv, root: string): boolean {
	if (env.euid === null) return false;
	try {
		const claude = entry(env, join(root, '.claude'));
		return (
			env.stat(root).uid === env.euid &&
			env.lstat(join(root, '.git')).uid === env.euid &&
			(claude === null || claude.uid === env.euid)
		);
	} catch {
		return false;
	}
}

function realHome(env: ProjectRootEnv): string | null {
	try {
		return env.realpath(env.home);
	} catch {
		return null;
	}
}

/**
 * The `settings.local.json` Claude writes a project rule to for an agent in
 * `cwd`, or null when that cannot be told for sure.
 */
export function localSettingsTarget(cwd: string, env: ProjectRootEnv): LocalSettingsTarget | null {
	const at = (root: string, scope: LocalSettingsTarget['scope']): LocalSettingsTarget => ({
		file: join(root, '.claude', 'settings.local.json'),
		root,
		scope,
	});
	try {
		const real = env.realpath(cwd);
		const found = gitRoot(env, real);
		if (found === null) return at(real, 'folder');
		const root = canonicalRoot(env, found);
		if (root === real) return at(root, 'repository');
		const home = realHome(env);
		if (home === null || root === home) return at(real, 'folder');
		return ownedByUser(env, root) ? at(root, 'repository') : at(real, 'folder');
	} catch {
		return null;
	}
}
