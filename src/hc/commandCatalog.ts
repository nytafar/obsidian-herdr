/**
 * The `/` catalog of a herdr-core runtime over SSH: the commands and skills
 * of the machine the agent runs on, read through the runtime's own
 * connection (issue #98, ADR-0006). The layout it reads is Claude Code's
 * (`../agents/claude/commands.ts`): herdr-core's native view follows Claude
 * sessions only, through the Claude hook's label.
 *
 * hc has `file.read` but no way to list a directory, so the tree is read
 * with **one `machine.exec`**: a POSIX `sh` script ({@link CATALOG_SCRIPT})
 * that walks the same three scopes the local walk does and prints what it
 * found as a snapshot. The snapshot is then served as a {@link CatalogFs},
 * and `loadCommandCatalog` walks it exactly as it walks this machine's
 * files: one set of rules for names, namespaces, precedence and frontmatter.
 *
 * **What the script assumes of the remote**: `sh`, `awk` and `tr`, as the
 * session hook does (`../sessionHook/hookScript.ts`), and nothing else.
 * `realpath` or `readlink -f`, when there is one, resolves a symlinked file;
 * without either, such a file reports its directory's real path and its own
 * name. Directories are resolved with `cd -P` and `pwd -P`.
 *
 * **What it prints** is a stream of records whose fields end in NUL, which no
 * path contains, so names with spaces, quotes or newlines come through as
 * they are. A Markdown file's text is cut to its frontmatter by `awk` (the
 * first line, and up to the closing `---` when it opens one, at most
 * {@link FRONTMATTER_LINES} lines), stripped of NUL bytes, and framed with
 * `\001`, which `tr` turns into NUL after the text has lost its own. The
 * stream ends with an `E` record; one without it was cut short and is not
 * used.
 *
 * - `H home configDir`: `$HOME`, and `$CLAUDE_CONFIG_DIR` or `$HOME/.claude`.
 * - `d path real`: a directory that was listed, with its real path.
 * - `c dir name kind`: one of its names; `kind` is `d` (a directory, links
 *   followed), `f` (anything else there) or `x` (a dangling link).
 * - `f path real`: a Markdown file that exists, with its real path.
 * - `g path`: a `.git` that exists, which ends the project walk.
 * - `B`, then `R path` per readable file of the batch, then `T index text`:
 *   the frontmatter of the batch's `index`th readable file (1-based); an
 *   empty file has no `T`.
 * - `J path text`: the installed-plugins file, whole.
 * - `E`: the end.
 *
 * The plugin paths are found in the installed-plugins file by `awk` on the
 * remote, decoding `\"`, `\\` and `\/` and skipping a path with any other
 * escape; the file itself is parsed here, as the local walk parses it, so a
 * path the script skipped is a plugin with nothing in it, never a wrong one.
 *
 * **Caching and failure** ({@link HcCommandCatalog}): per connection and per
 * cwd, for the local catalog's TTL, with one read in flight per cwd. A read
 * that has not answered within {@link CATALOG_DEADLINE_MS} gives the last
 * catalog this cwd had, or the built-ins, and is kept when it lands. A read
 * that fails gives the built-ins for the TTL. Never this machine's commands:
 * they are another machine's.
 */

import { CATALOG_TTL_MS, type CatalogEntry, type CommandCatalogSource } from '../native/commandCatalog';
import { builtinCatalog, loadCommandCatalog, type CatalogFs } from '../agents/claude/commands';
import { posix } from 'node:path';
import { clearTimer, setTimer } from '../timers';
import type { HcTimers } from './client';

/** How deep the script walks a commands tree; the walk's own limit. */
export const CATALOG_MAX_DEPTH = 6;
/** How far up from the cwd the script looks; the walk's own limit. */
export const CATALOG_MAX_LEVELS = 32;
/** The most lines of a file the script sends: more than any frontmatter. */
export const FRONTMATTER_LINES = 1000;
/** How long the popover waits for a read before offering what it has. */
export const CATALOG_DEADLINE_MS = 3000;
/** hc ends the script after this many seconds, whoever is waiting. */
export const CATALOG_EXEC_TIMEOUT_S = 30;
/** How many cwds one connection remembers. */
const MAX_CACHED_CWDS = 32;

/** The frontmatter cut: line 1, and on to the closing fence when it may open one. */
const FRONTMATTER_AWK = `
function fence(s) { gsub(/^[ \\t\\r\\f\\v]+|[ \\t\\r\\f\\v]+$/, "", s); return s == "---" }
function flush() { if (cur != "") printf "T\\001%d\\001%s\\001", ix[cur], buf; cur = "" }
BEGIN { for (i = 1; i < ARGC; i++) ix[ARGV[i]] = i }
FILENAME != cur { flush(); cur = FILENAME; buf = ""; n = 0; open = 1 }
open {
	line = $0; gsub(/\\001/, "", line); buf = buf line "\\n"; n++
	if (n == 1) { if (index($0, "---") == 0) open = 0 }
	else if (fence($0) || n >= ${FRONTMATTER_LINES}) open = 0
}
END { flush() }
`;

/** Every `"installPath": "…"` string, decoded, one per line. */
const INSTALL_PATH_AWK = `
{ s = s $0 "\\n" }
END {
	while (match(s, /"installPath"[ \\t\\r\\n]*:[ \\t\\r\\n]*"/)) {
		s = substr(s, RSTART + RLENGTH); out = ""; ok = 1
		while (1) {
			c = substr(s, 1, 1)
			if (c == "") { ok = 0; break }
			if (c == "\\"") { s = substr(s, 2); break }
			if (c == "\\\\") {
				e = substr(s, 2, 1)
				if (e == "\\"" || e == "\\\\" || e == "/") out = out e; else ok = 0
				s = substr(s, 3); continue
			}
			out = out c; s = substr(s, 2)
		}
		if (ok && out != "") print out
	}
}
`;

/** Single-quoted for `sh`: the script's two awk programs. */
function shellWord(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script `machine.exec` runs as `sh -c <script> sh <cwd>`. `$1` is the
 * pane's cwd, normalized, or '' for no project scope.
 */
export const CATALOG_SCRIPT = `
unset CDPATH
LC_ALL=C; export LC_ALL
fm=${shellWord(FRONTMATTER_AWK)}
ip=${shellWord(INSTALL_PATH_AWK)}
if command -v realpath >/dev/null 2>&1; then rp=realpath
elif readlink -f / >/dev/null 2>&1; then rp='readlink -f'
else rp=; fi

realdir() {
	r=$(cd -P -- "$1" 2>/dev/null && pwd -P && echo .) || return 1
	r=\${r%??}
}

realfile() {
	if [ -L "$1" ] && [ -n "$rp" ]; then
		r=$($rp "$1" 2>/dev/null && echo .) || return 1
		r=\${r%??}
		return 0
	fi
	p=\${1%/*}; [ -n "$p" ] || p=/
	realdir "$p" || return 1
	case $r in */) r=$r\${1##*/} ;; *) r=$r/\${1##*/} ;; esac
}

kind() {
	if [ -d "$1" ]; then k=d; elif [ -e "$1" ]; then k=f; else k=x; fi
}

files() {
	[ $# -gt 0 ] || return 0
	printf 'B\\0'
	m=$#
	for f do
		realfile "$f" || r=
		printf 'f\\0%s\\0%s\\0' "$f" "$r"
		if [ -f "$f" ] && [ -r "$f" ]; then
			set -- "$@" "$f"
			printf 'R\\0%s\\0' "$f"
		fi
	done
	shift "$m"
	[ $# -gt 0 ] || return 0
	awk "$fm" "$@" 2>/dev/null | tr -d '\\000' | tr '\\001' '\\000'
}

walk() {
	[ "$2" -gt 0 ] && [ -d "$1" ] && realdir "$1" || return 0
	printf 'd\\0%s\\0%s\\0' "$1" "$r"
	w=$1 n=$2
	set --
	for c in "$w"/* "$w"/.[!.]* "$w"/..?*; do
		[ -e "$c" ] || [ -L "$c" ] || continue
		kind "$c"
		printf 'c\\0%s\\0%s\\0%s\\0' "$w" "\${c##*/}" "$k"
		if [ "$k" = d ]; then
			(walk "$c" $((n - 1)))
		else
			case $c in *.md) [ "$k" = f ] && set -- "$@" "$c" ;; esac
		fi
	done
	files "$@"
}

skills() {
	[ -d "$1" ] && realdir "$1" || return 0
	printf 'd\\0%s\\0%s\\0' "$1" "$r"
	w=$1
	set --
	for c in "$w"/* "$w"/.[!.]* "$w"/..?*; do
		[ -e "$c" ] || [ -L "$c" ] || continue
		kind "$c"
		printf 'c\\0%s\\0%s\\0%s\\0' "$w" "\${c##*/}" "$k"
		[ -e "$c/SKILL.md" ] && set -- "$@" "$c/SKILL.md"
	done
	files "$@"
}

scope() {
	walk "$1/commands" ${CATALOG_MAX_DEPTH}
	skills "$1/skills"
}

home=\${HOME:-}
cfg=\${CLAUDE_CONFIG_DIR:-}
[ -n "$cfg" ] || { [ -n "$home" ] && cfg=$home/.claude; }
printf 'H\\0%s\\0%s\\0' "$home" "$cfg"

dir=$1 lv=0
while [ -n "$dir" ] && [ $lv -lt ${CATALOG_MAX_LEVELS} ]; do
	case $dir in /) base= ;; *) base=$dir ;; esac
	(scope "$base/.claude")
	if [ -e "$base/.git" ]; then printf 'g\\0%s\\0' "$base/.git"; break; fi
	[ "$dir" = / ] && break
	dir=\${dir%/*}; [ -n "$dir" ] || dir=/
	lv=$((lv + 1))
done

if [ -n "$cfg" ]; then
	(scope "$cfg")
	pj=$cfg/plugins/installed_plugins.json
	if [ -f "$pj" ] && [ -r "$pj" ]; then
		printf 'J\\0%s\\0' "$pj"
		tr -d '\\000' < "$pj"
		printf '\\0'
		awk "$ip" "$pj" 2>/dev/null | while IFS= read -r path; do
			[ -n "$path" ] && (scope "$path")
		done
	fi
fi
printf 'E\\0'
`;

/** What the snapshot says of one remote machine. */
export interface CatalogSnapshot {
	home: string;
	configDir: string;
	fs: CatalogFs;
}

/** A path as the walk joins it: normalized, no trailing slash but the root's. */
function normal(path: string): string {
	if (path === '') return '';
	const out = posix.normalize(path);
	return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

/** The fields of the stream count per record kind. */
const FIELDS: Record<string, number> = { H: 2, d: 2, c: 3, f: 2, g: 1, B: 0, R: 1, T: 2, J: 2, E: 0 };

/**
 * The script's output as a filesystem, or null when it is not a whole one:
 * cut short, or not this script's.
 */
export function parseCatalogSnapshot(output: Buffer): CatalogSnapshot | null {
	const fields: string[] = [];
	let start = 0;
	for (;;) {
		const end = output.indexOf(0, start);
		if (end === -1) break;
		fields.push(output.subarray(start, end).toString('utf8'));
		start = end + 1;
	}
	const kinds = new Map<string, 'd' | 'f' | 'x'>();
	const children = new Map<string, string[]>();
	const reals = new Map<string, string>();
	const texts = new Map<string, string>();
	let home: string | null = null;
	let configDir = '';
	let batch: string[] = [];
	let ended = false;
	for (let at = 0; at < fields.length && !ended; ) {
		const kind = fields[at] ?? '';
		const count = FIELDS[kind];
		if (count === undefined || at + count >= fields.length) return null;
		const [a = '', b = '', c = ''] = fields.slice(at + 1, at + 1 + count);
		at += 1 + count;
		switch (kind) {
			case 'H':
				home = a;
				configDir = normal(b);
				break;
			case 'd':
				kinds.set(normal(a), 'd');
				if (b) reals.set(normal(a), b);
				if (!children.has(normal(a))) children.set(normal(a), []);
				break;
			case 'c': {
				const path = normal(posix.join(a, b));
				const list = children.get(normal(a)) ?? [];
				list.push(b);
				children.set(normal(a), list);
				if (!kinds.has(path)) kinds.set(path, c === 'd' ? 'd' : c === 'f' ? 'f' : 'x');
				break;
			}
			case 'f':
				if (!kinds.has(normal(a))) kinds.set(normal(a), 'f');
				if (b) reals.set(normal(a), b);
				break;
			case 'g':
				kinds.set(normal(a), 'f');
				break;
			case 'B':
				batch = [];
				break;
			case 'R':
				batch.push(normal(a));
				break;
			case 'T': {
				const path = batch[Number(a) - 1];
				if (path === undefined) return null;
				texts.set(normal(reals.get(path) ?? path), b);
				break;
			}
			case 'J':
				texts.set(normal(a), b);
				break;
			case 'E':
				ended = true;
				break;
		}
	}
	if (!ended || home === null) return null;
	const fs: CatalogFs = {
		path: posix,
		readdir: (dir) => [...(children.get(normal(dir)) ?? [])],
		exists: (path) => {
			const kind = kinds.get(normal(path));
			return kind === 'd' || kind === 'f';
		},
		isDirectory: (path) => kinds.get(normal(path)) === 'd',
		realpath: (path) => reals.get(normal(path)) ?? null,
		// A file reads the same through its link or its real path; one that
		// sent no text (empty, unreadable) is null, which the walk reads as ''.
		readFile: (path) => texts.get(normal(path)) ?? texts.get(normal(reals.get(normal(path)) ?? '')) ?? null,
	};
	return { home, configDir, fs };
}

/** `machine.exec`'s answer, as far as this reads it. */
interface ExecResult {
	code?: number | null;
	stdout?: string;
	truncated?: boolean;
	timed_out?: boolean;
}

/** The requester the catalog reads through: the runtime's `HcClient`. */
export interface HcExecRequester {
	request<T>(method: string, params: unknown): Promise<T>;
}

/** A cwd the script can start from: absolute and normalized, else ''. */
export function catalogCwd(cwd: string): string {
	return cwd.startsWith('/') ? normal(cwd) : '';
}

/**
 * The remote catalog for one cwd, in one `machine.exec`. Rejects when the
 * read fails, times out or comes back incomplete.
 */
export async function readRemoteCatalog(requester: HcExecRequester, cwd: string): Promise<CatalogEntry[]> {
	const start = catalogCwd(cwd);
	const result = await requester.request<ExecResult>('machine.exec', {
		argv: ['sh', '-c', CATALOG_SCRIPT, 'sh', start],
		timeout: CATALOG_EXEC_TIMEOUT_S,
	});
	if (!result || result.truncated || result.timed_out || typeof result.stdout !== 'string') {
		throw new Error('the command catalog could not be read');
	}
	const snapshot = parseCatalogSnapshot(Buffer.from(result.stdout, 'base64'));
	if (!snapshot) throw new Error('the command catalog came back incomplete');
	return loadCommandCatalog({
		home: snapshot.home,
		configDir: snapshot.configDir,
		cwd: start,
		fs: snapshot.fs,
	});
}

export interface HcCommandCatalogOptions {
	timers?: HcTimers;
	now?: () => number;
	ttlMs?: number;
	deadlineMs?: number;
}

const defaultTimers: HcTimers = {
	set: (callback, ms) => setTimer(callback, ms),
	clear: (handle) => clearTimer(handle as ReturnType<typeof setTimer>),
};

interface CachedCatalog {
	/** The last catalog read for this cwd, or the built-ins after a failure. */
	entries: CatalogEntry[] | null;
	at: number;
	pending: Promise<CatalogEntry[]> | null;
}

/** One herdr-core connection's `/` catalogs, by cwd. */
export class HcCommandCatalog implements CommandCatalogSource {
	private readonly cache = new Map<string, CachedCatalog>();
	private readonly timers: HcTimers;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly deadlineMs: number;

	constructor(
		private readonly requester: HcExecRequester,
		options: HcCommandCatalogOptions = {},
	) {
		this.timers = options.timers ?? defaultTimers;
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
		this.deadlineMs = options.deadlineMs ?? CATALOG_DEADLINE_MS;
	}

	catalog(cwd: string): CatalogEntry[] | Promise<CatalogEntry[]> {
		const key = catalogCwd(cwd);
		const cached = this.cache.get(key);
		if (cached?.entries && this.now() - cached.at < this.ttlMs) return cached.entries;
		const pending = cached?.pending ?? this.load(key);
		const fallback = cached?.entries ?? builtinCatalog();
		return new Promise((resolve) => {
			const timer = this.timers.set(() => resolve(fallback), this.deadlineMs);
			void pending.then((entries) => {
				this.timers.clear(timer);
				resolve(entries);
			});
		});
	}

	/** One read for `key`, remembered when it lands; never rejects. */
	private load(key: string): Promise<CatalogEntry[]> {
		const record: CachedCatalog = this.cache.get(key) ?? { entries: null, at: 0, pending: null };
		this.remember(key, record);
		const pending = readRemoteCatalog(this.requester, key).then(
			(entries) => entries,
			() => builtinCatalog(),
		);
		record.pending = pending.then((entries) => {
			record.entries = entries;
			record.at = this.now();
			record.pending = null;
			return entries;
		});
		return record.pending;
	}

	/** Most recently used last; the oldest goes past {@link MAX_CACHED_CWDS}. */
	private remember(key: string, record: CachedCatalog): void {
		this.cache.delete(key);
		this.cache.set(key, record);
		while (this.cache.size > MAX_CACHED_CWDS) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}
}
