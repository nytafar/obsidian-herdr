/**
 * The pure half of `npm run record-screens` (issue #168): finding the tools,
 * scrubbing a screen the way the committed fixtures were scrubbed, naming what
 * Claude leaves in its config folder, and the diff against the last set.
 * Tested in `tests/recordScreens.test.ts`; the runner is `./main.ts`.
 */

import { join } from 'node:path';
import type { ScreenDialog } from '../../src/agents/screenDialog';

// --- Tools ------------------------------------------------------------------

/**
 * A mise shim or command wrapper runs mise to decide what to run, and the
 * run must never start one (issue #168): what it starts is the real binary.
 */
export function isMiseIndirection(path: string): boolean {
	return /\/mise\/(?:shims|command-wrappers)(?:\/|$)/.test(path);
}

/**
 * Every executable called `name` along `pathEnv`, in order, as `command -v -a`
 * lists them, minus mise shims and wrappers. Nothing is run to find them.
 */
export function onPath(name: string, pathEnv: string, isExecutable: (path: string) => boolean): string[] {
	const found: string[] = [];
	for (const dir of pathEnv.split(':')) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (isMiseIndirection(candidate) || found.includes(candidate)) continue;
		if (isExecutable(candidate)) found.push(candidate);
	}
	return found;
}

/**
 * Claude Code's own binary: the first on the PATH that is not a mise shim,
 * else mise's install of the latest version. The committed screens show it
 * started as `…/mise/installs/claude/latest/claude`.
 */
export function findClaude(pathEnv: string, home: string, isExecutable: (path: string) => boolean): string | null {
	const listed = onPath('claude', pathEnv, isExecutable)[0];
	if (listed) return listed;
	const installed = join(home, '.local/share/mise/installs/claude/latest/claude');
	return isExecutable(installed) ? installed : null;
}

/** `2.1.318` from `claude --version` (`2.1.318 (Claude Code)`), `hc --version` or `herdr --version`. */
export function versionIn(output: string): string | null {
	return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

// --- Fixture sets -----------------------------------------------------------

/** Orders `2.1.318` before `2.1.400`; non-numeric parts sort as 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
	const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The newest `claude-<version>` folder among `names`, leaving out `exclude`. */
export function latestSet(names: readonly string[], exclude: string | null): string | null {
	const sets = names
		.filter((name) => /^claude-\d+(?:\.\d+)*$/.test(name) && name !== exclude)
		.sort((a, b) => compareVersions(a.slice('claude-'.length), b.slice('claude-'.length)));
	return sets[sets.length - 1] ?? null;
}

// --- Scrubbing --------------------------------------------------------------

/** What the committed screens show in place of the account's own details. */
export const SCRUBBED_HOME = '/home/user';
export const SCRUBBED_PLAN = 'Claude Pro';
export const SCRUBBED_EDITOR = 'nvim';

export interface Scrubbed {
	text: string;
	/** The account's plan name as the banner showed it, when it did. */
	plan: string | null;
	/** The editor the `ctrl+g` hint named, when it did. */
	editor: string | null;
}

/**
 * Scrubs one screen as the fixtures were (their README): the home folder
 * becomes `/home/user`, the plan name in the banner `Claude Pro`, and the
 * editor on the `ctrl+g` hint `nvim`. Each is replaced within its line, so a
 * shorter name shortens the line and nothing re-wraps. Works on `format:
 * ansi` reads too: colour codes end the replaced span.
 */
export function scrubScreen(screen: string, home: string): Scrubbed {
	let plan: string | null = null;
	let editor: string | null = null;
	let text = home && home !== SCRUBBED_HOME ? screen.split(home).join(SCRUBBED_HOME) : screen;
	// The banner's second row, `▝▜██████▀  Haiku 5.5 · Claude Pro`: everything
	// after the model is the account's.
	text = text
		.split('\n')
		.map((line) => {
			if (!line.includes('██') || !line.includes('▀')) return line;
			// eslint-disable-next-line no-control-regex -- an escape ends the plan name in an ANSI read
			return line.replace(/ · ([^\u001b\r\n]*)/, (_match, name: string) => {
				plan = name;
				return ` · ${SCRUBBED_PLAN}`;
			});
		})
		.join('\n');
	// The hint may wrap between `in` and the editor's name, and an ANSI read
	// may colour the gap.
	text = text.replace(
		// eslint-disable-next-line no-control-regex -- colour codes may sit in the gap
		/(ctrl\+g to edit in)((?:\s|\u001b\[[0-9;]*m)+)([^\s·\u001b]+)/g,
		(_match, hint: string, gap: string, name: string) => {
			editor = name;
			return `${hint}${gap}${SCRUBBED_EDITOR}`;
		},
	);
	return { text, plan, editor };
}

/** Whether `text` still names the account's user, after scrubbing. */
export function namesUser(text: string, user: string): boolean {
	if (!user) return false;
	return new RegExp(`(^|[^A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(text);
}

/** How a read is saved: as returned, with one line break at the end of a text read. */
export function fixtureText(screen: string): string {
	return screen.endsWith('\n') ? screen : `${screen}\n`;
}

// --- What Claude leaves behind ----------------------------------------------

/** Claude's per-folder transcript folder under `<config>/projects/`: every non-alphanumeric a `-`. */
export function projectDirName(folder: string): string {
	return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The plan slugs a transcript names (a top-level `"slug"` on its lines,
 * `docs/architecture.md`, "Plan approval and the plan file"), only those a
 * plan file could have: lowercase words and hyphens.
 */
export function slugsIn(transcript: string): string[] {
	const slugs = new Set<string>();
	for (const line of transcript.split('\n')) {
		if (!line.includes('"slug"')) continue;
		try {
			const slug = (JSON.parse(line) as { slug?: unknown }).slug;
			if (typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) slugs.add(slug);
		} catch {
			// A torn last line, while Claude was still writing it.
		}
	}
	return [...slugs];
}

/** A session id as Claude names its transcript (`<uuid>.jsonl`), or null. */
export function sessionIdOf(fileName: string): string | null {
	const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(fileName);
	return match?.[1] ?? null;
}

/**
 * Whether `~/.claude.json` already trusts `folder` or a folder above it:
 * Claude never asks again there, so a trust screen cannot be recorded.
 */
export function trustedIn(claudeJson: unknown, folder: string): string | null {
	const projects = (claudeJson as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | null)
		?.projects;
	if (!projects) return null;
	let at = folder;
	for (;;) {
		if (projects[at]?.hasTrustDialogAccepted === true) return at;
		if (at === '/' || !at.startsWith('/')) return null;
		const cut = at.lastIndexOf('/');
		at = cut <= 0 ? '/' : at.slice(0, cut);
	}
}

// --- Comparing sets ---------------------------------------------------------

/** A full-width rule, maybe indented (plan approval's is). */
const RULE = /^ *─{10,}/;

/**
 * The dialog part of a screen: from the rule that opens the dialog the
 * parser reads, to the end. The history above it changes with every run
 * (times, spinner words, Claude's replies) and says nothing about the
 * dialog. Null when the screen reads as no dialog; compare all of it then.
 */
export function dialogRegion(screen: string, parse: (screen: string) => ScreenDialog): string[] | null {
	const kind = parse(screen).kind;
	if (kind === 'unknown') return null;
	const lines = screen.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!RULE.test(lines[i] ?? '')) continue;
		const region = lines.slice(i);
		if (parse(region.join('\n')).kind === kind) return region;
	}
	return null;
}

/**
 * A unified diff of two texts' lines, with `context` lines around each
 * change, or an empty string when they are equal. Longest common subsequence;
 * screens are a few dozen lines.
 */
export function unifiedDiff(
	a: readonly string[],
	b: readonly string[],
	labels: [string, string],
	context = 2,
): string {
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ kind: ' ', text: a[i]!, ai: i++, bi: j++ });
		} else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
			ops.push({ kind: '-', text: a[i]!, ai: i++, bi: j });
		} else {
			ops.push({ kind: '+', text: b[j]!, ai: i, bi: j++ });
		}
	}
	const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
	if (changed.length === 0) return '';
	const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
	let k = 0;
	while (k < changed.length) {
		const start = Math.max(0, changed[k]! - context);
		let end = Math.min(ops.length - 1, changed[k]! + context);
		while (k + 1 < changed.length && changed[k + 1]! - context <= end + 1) {
			k++;
			end = Math.min(ops.length - 1, changed[k]! + context);
		}
		k++;
		const hunk = ops.slice(start, end + 1);
		const first = hunk[0]!;
		const aCount = hunk.filter((op) => op.kind !== '+').length;
		const bCount = hunk.filter((op) => op.kind !== '-').length;
		out.push(`@@ -${first.ai + 1},${aCount} +${first.bi + 1},${bCount} @@`);
		for (const op of hunk) out.push(`${op.kind}${op.text}`);
	}
	return `${out.join('\n')}\n`;
}

/** Which footer mode a screen shows, from its last lines. */
export function modeOf(screen: string): 'plan' | 'acceptEdits' | 'auto' | 'default' {
	const tail = screen
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.slice(-4)
		.join('\n');
	if (/plan mode on/.test(tail)) return 'plan';
	if (/accept edits on/.test(tail)) return 'acceptEdits';
	if (/auto mode on/.test(tail)) return 'auto';
	return 'default';
}

// --- Typing on hc, key by key -----------------------------------------------

/** hc's size for a terminal no viewer leads ([[herdr-core-api]] §5). */
export const HC_HEADLESS = { cols: 200, rows: 120 } as const;

/**
 * `text` as `terminal.keys` names, one per character: hc lowercases a bare
 * letter, so a capital is `shift+<letter>`, and a space is `space`
 * (`docs/architecture.md`, "Answering Claude's dialogs from the screen").
 * Only letters, digits, spaces, commas and full stops, which is all the
 * scenario types; anything else throws.
 *
 * Used on a terminal started at another size than hc's headless one: the
 * plugin's typing attach (`HcClient.input`) put such a terminal back to
 * 200x120 when it detached (hc 0.1.18, measured 2026-11-06 by this script),
 * which re-wraps every screen after it. The narrow hc screens were typed
 * this way in #163.
 */
export function hcTypingKeys(text: string): string[] {
	return [...text].map((char) => {
		if (/^[a-z0-9,.]$/.test(char)) return char;
		if (/^[A-Z]$/.test(char)) return `shift+${char.toLowerCase()}`;
		if (char === ' ') return 'space';
		throw new Error(`cannot type "${char}" key by key on hc`);
	});
}
