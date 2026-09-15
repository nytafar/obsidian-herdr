/**
 * The command catalog (issue #98).
 *
 * What a `/` in the prompt box may offer: Claude Code's own commands and
 * skills, from the three places it reads them, plus the built-ins it carries
 * itself. Nothing here talks to Claude; the catalog is the file tree, read on
 * demand, which is also why it is a plain module with no `obsidian` import and
 * a temp tree for a test.
 *
 * **The scopes**, in the order that wins a name (design:
 * `findings/native-view-design.md`):
 *
 *   1. **project** — `.claude/commands` and `.claude/skills` in the pane's cwd
 *      and every directory above it up to the repository root, the nearer
 *      directory winning. The walk stops at the repository root because a
 *      sibling checkout's commands are not this project's.
 *   2. **user** — `~/.claude/commands` and `~/.claude/skills`.
 *   3. **plugin** — the `commands` and `skills` of every plugin named in
 *      `~/.claude/plugins/installed_plugins.json`, at its `installPath`.
 *   4. **builtin** — {@link BUILTIN_COMMANDS}, a static list.
 *
 * **Symlinks are followed and resolved.** `~/.claude/skills` on this machine is
 * half symlinks into other checkouts, so a catalog that skipped them would be
 * missing most of what a user types. Every entry reports the real path it was
 * read from, and a link cycle cannot loop the walk: a real path is visited once.
 *
 * A command's name is its file name without `.md`, namespaced by the folders
 * under the scope root with `:` — `commands/ns/deep.md` is `/ns:deep` — and a
 * skill's name is its directory's. The description and the argument hint come
 * from the file's frontmatter.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

/** Where an entry came from; also its precedence, highest first. */
export type CommandScope = 'project' | 'user' | 'plugin' | 'builtin';

/** A command, a skill or a built-in: one thing a `/` can offer. */
export interface CatalogEntry {
	/** What is typed after the slash, namespaces included: `ns:deep`. */
	name: string;
	scope: CommandScope;
	kind: 'command' | 'skill' | 'builtin';
	/** Frontmatter `description`, empty when the file has none. */
	description: string;
	/** Frontmatter `argument-hint`, empty when the file has none. */
	argumentHint: string;
	/** The file it was read from, symlinks resolved; null for a built-in. */
	path: string | null;
}

/** Scope order, strongest first. A name is taken by the first scope that has it. */
const SCOPE_ORDER: CommandScope[] = ['project', 'user', 'plugin', 'builtin'];

/** How deep a scope root is walked. Deeper than any real command tree. */
const MAX_DEPTH = 6;

/** How far up from the cwd the project walk may go before giving up. */
const MAX_PROJECT_LEVELS = 32;

/**
 * Claude Code's own slash commands. A static list, as the design says: the
 * shipped set is not readable from anywhere on disk, so it is written down
 * here and stays a best-effort until it is verified against a release
 * (`findings/native-view-design.md`, "Still unverified").
 */
export const BUILTIN_COMMANDS: CatalogEntry[] = [
	['add-dir', 'Add a working directory to the session'],
	['agents', 'Manage subagents'],
	['clear', 'Clear the conversation and start a new session'],
	['compact', 'Compact the conversation'],
	['config', 'Open the configuration panel'],
	['context', 'Show what is in the context window'],
	['cost', 'Show the cost of this session'],
	['doctor', 'Check the installation'],
	['exit', 'Leave Claude Code'],
	['export', 'Export the conversation'],
	['help', 'Show the built-in help'],
	['hooks', 'Manage hooks'],
	['init', 'Write a CLAUDE.md for this project'],
	['mcp', 'Manage MCP servers'],
	['memory', 'Edit the memory files'],
	['model', 'Choose the model'],
	['permissions', 'Edit the permission rules'],
	['resume', 'Resume an earlier session'],
	['review', 'Review a pull request'],
	['status', 'Show the session status'],
	['todos', 'Show the todo list'],
	['usage', 'Show usage limits'],
].map(([name, description]) => ({
	name: name as string,
	scope: 'builtin' as const,
	kind: 'builtin' as const,
	description: description as string,
	argumentHint: '',
	path: null,
}));

export interface CommandCatalogOptions {
	/** Home directory of the transcript's host. Defaults to this machine's. */
	home?: string;
	/** The pane's working directory: where the project scope starts. */
	cwd: string;
}

/**
 * The `.claude` directories of the project scope, nearest first: the cwd and
 * every directory above it, stopping at the one that holds `.git` — the
 * repository root — or at the filesystem root when there is none.
 *
 * `.git` counts whether it is a directory or a file: in a Git worktree, and in
 * a submodule, it is a file naming the real repository, and such a checkout is
 * a repository root like any other. A walk that went past it would offer the
 * commands of whatever directory the worktrees happen to sit in (#98).
 */
export function projectCommandRoots(cwd: string): string[] {
	const roots: string[] = [];
	let dir = cwd;
	for (let level = 0; level < MAX_PROJECT_LEVELS; level++) {
		roots.push(join(dir, '.claude'));
		if (exists(join(dir, '.git'))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return roots;
}

/**
 * The install paths of the plugins Claude Code has installed for this home, in
 * the order the file lists them. An unreadable or unexpected file is no
 * plugins, never a failure: the catalog is a convenience and a broken file
 * must not stop a prompt being typed.
 */
export function pluginInstallPaths(home: string): string[] {
	const file = join(home, '.claude', 'plugins', 'installed_plugins.json');
	const raw = readFileOrNull(file);
	if (raw === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
	if (typeof plugins !== 'object' || plugins === null) return [];
	const paths: string[] = [];
	for (const installs of Object.values(plugins as Record<string, unknown>)) {
		for (const install of Array.isArray(installs) ? installs : []) {
			const path = (install as { installPath?: unknown }).installPath;
			if (typeof path === 'string' && path !== '') paths.push(path);
		}
	}
	return paths;
}

/**
 * Everything a `/` may offer for this pane, one entry per name: the scopes are
 * read strongest first and a name already taken is left alone.
 */
export function loadCommandCatalog(options: CommandCatalogOptions): CatalogEntry[] {
	const home = options.home ?? homedir();
	const found: CatalogEntry[] = [];
	for (const root of projectCommandRoots(options.cwd)) found.push(...entriesUnder(root, 'project'));
	found.push(...entriesUnder(join(home, '.claude'), 'user'));
	for (const path of pluginInstallPaths(home)) found.push(...entriesUnder(path, 'plugin'));
	found.push(...BUILTIN_COMMANDS);

	const byName = new Map<string, CatalogEntry>();
	for (const scope of SCOPE_ORDER) {
		for (const entry of found) {
			// The scopes are pushed nearest-first within a scope too, so the first
			// entry of a name in a scope is the one that wins it.
			if (entry.scope === scope && !byName.has(entry.name)) byName.set(entry.name, entry);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The entries a query offers, prefix matches first and each group in name
 * order. Matching is case-insensitive and on the name only: a description is
 * there to be read, not to be searched.
 */
export function matchCommands(entries: CatalogEntry[], query: string): CatalogEntry[] {
	const needle = query.toLowerCase();
	const prefix: CatalogEntry[] = [];
	const rest: CatalogEntry[] = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		if (name.startsWith(needle)) prefix.push(entry);
		else if (needle !== '' && name.includes(needle)) rest.push(entry);
	}
	const byName = (a: CatalogEntry, b: CatalogEntry): number => a.name.localeCompare(b.name);
	return [...prefix.sort(byName), ...rest.sort(byName)];
}

// -- Reading one scope ------------------------------------------------------

/** The commands and skills under one scope root (`<somewhere>/.claude` or a plugin). */
function entriesUnder(root: string, scope: CommandScope): CatalogEntry[] {
	return [
		...commandsUnder(join(root, 'commands'), scope),
		...skillsUnder(join(root, 'skills'), scope),
	];
}

/** Every `*.md` under a commands directory, folders becoming namespaces. */
function commandsUnder(dir: string, scope: CommandScope): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const file of markdownFilesUnder(dir, MAX_DEPTH, new Set())) {
		const name = file.relative.slice(0, -'.md'.length).split(sep).join(':');
		entries.push(entryFor(name, scope, 'command', file.path));
	}
	return entries;
}

/** Every `<skill>/SKILL.md` under a skills directory, links followed. */
function skillsUnder(dir: string, scope: CommandScope): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const child of childNames(dir)) {
		const skillFile = join(dir, child, 'SKILL.md');
		const real = realPathOrNull(skillFile);
		if (real === null) continue;
		entries.push(entryFor(child, scope, 'skill', real));
	}
	return entries;
}

/** One entry, with whatever its frontmatter says. */
function entryFor(
	name: string,
	scope: CommandScope,
	kind: 'command' | 'skill',
	path: string,
): CatalogEntry {
	const front = frontmatter(readFileOrNull(path) ?? '');
	return {
		name,
		scope,
		kind,
		description: front.description ?? '',
		argumentHint: front['argument-hint'] ?? '',
		path,
	};
}

/**
 * Markdown files under `dir`, depth first, with the path relative to `dir` and
 * the real path on disk. `visited` holds real directory paths, so a symlink
 * that points back up is walked once and not forever.
 */
function markdownFilesUnder(
	dir: string,
	depth: number,
	visited: Set<string>,
	prefix = '',
): { relative: string; path: string }[] {
	if (depth <= 0) return [];
	const real = realPathOrNull(dir);
	if (real === null || visited.has(real)) return [];
	visited.add(real);
	const found: { relative: string; path: string }[] = [];
	for (const child of childNames(dir)) {
		const path = join(dir, child);
		const relative = prefix === '' ? child : join(prefix, child);
		if (isDirectory(path)) {
			found.push(...markdownFilesUnder(path, depth - 1, visited, relative));
			continue;
		}
		if (!child.endsWith('.md')) continue;
		const realFile = realPathOrNull(path);
		if (realFile !== null) found.push({ relative, path: realFile });
	}
	return found;
}

/** The `key: value` lines of a leading `---` block; nothing else is read. */
export function frontmatter(text: string): Record<string, string> {
	const lines = text.split('\n');
	if (lines[0]?.trim() !== '---') return {};
	const values: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		if (line.trim() === '---') break;
		const at = line.indexOf(':');
		if (at <= 0) continue;
		const key = line.slice(0, at).trim();
		values[key] = unquote(line.slice(at + 1).trim());
	}
	return values;
}

/** A YAML scalar as these files write them: bare, or in quotes of either kind. */
function unquote(value: string): string {
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	if (!quoted) return value;
	return (quoted[1] ?? '').replace(/\\"/g, '"');
}

// -- Filesystem, all of it forgiving ---------------------------------------
//
// A directory that is not there, a dangling symlink and a file that cannot be
// read are all "nothing here". The catalog is read while someone is typing.

function childNames(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** True for anything on disk at `path`, whatever kind of thing it is. */
function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/** True for a directory, and for a symlink that points at one. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function realPathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** The name a scope root would be shown under. Exported for the suggest (#98). */
export function scopeLabel(scope: CommandScope): string {
	if (scope === 'builtin') return 'Built-in';
	return `${scope[0]?.toUpperCase() ?? ''}${scope.slice(1)}`;
}
