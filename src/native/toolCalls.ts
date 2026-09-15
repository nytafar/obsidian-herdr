/**
 * What a turn's tool calls look like on screen (issue #95).
 *
 * The native surface draws a turn as prose with the tool calls folded away: a
 * run of consecutive calls becomes one **tool group** (CONTEXT.md), a summary
 * line such as "Read 4 files, ran 2 commands" that expands to one row per call.
 * Two kinds of call escape that fold, because they are the two things a reader
 * of this vault actually wants in the text: a **vault change** (a write or an
 * edit, shown as "Updated [[note]]") and a **source** (a web search or fetch).
 * They render at their chronological position between the prose blocks and are
 * not counted in the summary — unless the setting says to collapse everything,
 * in which case they go back inside the group and are counted like the rest
 * (native-view-design.md).
 *
 * Everything here is pure and DOM-free: the alias table, the phrases, the vault
 * path arithmetic and the plan of what to draw in which order. The surface does
 * the drawing. Nothing outside `src/native/` imports this: the kind-to-renderer
 * map is internal until a second consumer exists, which is what the design
 * settled.
 */

import {
	isAsyncLaunchNotice,
	type ThinkingEntry,
	type TextEntry,
	type SteerEntry,
	type ToolEntry,
	type ToolStatus,
	type TurnEntry,
} from './reducer';
import { trimTrailingSlashes } from '../paths';

/**
 * The kinds a tool call is shown as. Claude Code's tool names change between
 * releases and a vault picks up MCP tools with names of their own, so the table
 * below is an alias table over a small set of kinds, and anything it does not
 * know is `other` rather than a gap.
 */
export type ToolKind =
	| 'bash'
	| 'read'
	| 'edit'
	| 'write'
	| 'grep'
	| 'glob'
	| 'webfetch'
	| 'websearch'
	| 'todo'
	| 'agent'
	| 'question'
	| 'other';

/**
 * Tool name (lower-cased) to kind. The names are the ones Claude Code 2.1.266
 * writes, counted over every transcript on this machine on 2026-09-15, plus the
 * older `Task` spelling of `Agent` and the edit variants.
 */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
	bash: 'bash',
	read: 'read',
	edit: 'edit',
	multiedit: 'edit',
	notebookedit: 'edit',
	write: 'write',
	grep: 'grep',
	glob: 'glob',
	webfetch: 'webfetch',
	websearch: 'websearch',
	todowrite: 'todo',
	agent: 'agent',
	task: 'agent',
	askuserquestion: 'question',
};

/** The kind a tool name is shown as; `other` for one this build does not know. */
export function toolKind(name: string): ToolKind {
	return TOOL_KINDS[name.trim().toLowerCase()] ?? 'other';
}

/** One kind's share of a summary line: "ran 2 commands", "read 1 file". */
interface ToolPhrase {
	verb: string;
	one: string;
	many: string;
}

/**
 * What each kind says in a summary. One shape for all of them — verb, then the
 * count, then the unit — so a kind added later needs no new sentence.
 */
const TOOL_PHRASES: Readonly<Record<ToolKind, ToolPhrase>> = {
	bash: { verb: 'ran', one: 'command', many: 'commands' },
	read: { verb: 'read', one: 'file', many: 'files' },
	edit: { verb: 'edited', one: 'file', many: 'files' },
	write: { verb: 'wrote', one: 'file', many: 'files' },
	grep: { verb: 'searched', one: 'pattern', many: 'patterns' },
	glob: { verb: 'matched', one: 'pattern', many: 'patterns' },
	webfetch: { verb: 'fetched', one: 'page', many: 'pages' },
	websearch: { verb: 'ran', one: 'web search', many: 'web searches' },
	todo: { verb: 'updated', one: 'to-do list', many: 'to-do lists' },
	agent: { verb: 'ran', one: 'subagent', many: 'subagents' },
	question: { verb: 'asked', one: 'question', many: 'questions' },
	other: { verb: 'used', one: 'tool', many: 'tools' },
};

/**
 * The group's summary line, counted by kind in the order the kinds first
 * appear: "Read 4 files, ran 2 commands". Only the first letter is capitalised,
 * so the parts read as one sentence however they are ordered.
 */
export function toolGroupSummary(tools: readonly ToolEntry[]): string {
	const counts = new Map<ToolKind, number>();
	for (const entry of tools) {
		const kind = toolKind(entry.name);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [kind, count] of counts) {
		const phrase = TOOL_PHRASES[kind];
		parts.push(`${phrase.verb} ${count} ${count === 1 ? phrase.one : phrase.many}`);
	}
	const line = parts.join(', ');
	return line ? `${line.charAt(0).toUpperCase()}${line.slice(1)}` : '';
}

/**
 * How much of a turn's tool calls the view folds away: vault changes and
 * sources kept out in the prose, or everything inside the group.
 */
export type ToolGroupPresentation = 'highlight' | 'collapse';

/** Highlighting is the default: this vault is read for the notes it changes. */
export const DEFAULT_TOOL_GROUP_PRESENTATION: ToolGroupPresentation = 'highlight';

/** A stored or hand-edited value read as a presentation; anything else is the default. */
export function normalizeToolGroupPresentation(value: unknown): ToolGroupPresentation {
	return value === 'collapse' ? 'collapse' : DEFAULT_TOOL_GROUP_PRESENTATION;
}

/** The kinds shown as a vault change, in the order a reader thinks of them. */
const CHANGE_KINDS: readonly ToolKind[] = ['write', 'edit'];
/** The kinds shown as a source. */
const SOURCE_KINDS: readonly ToolKind[] = ['websearch', 'webfetch'];

/** Whether this call renders on its own instead of inside the group. */
export function escapesToolGroup(kind: ToolKind, presentation: ToolGroupPresentation): boolean {
	if (presentation === 'collapse') return false;
	return CHANGE_KINDS.includes(kind) || SOURCE_KINDS.includes(kind);
}

/**
 * The field of a call's input worth showing beside its name: the file, the
 * command, the pattern, the query or the description. The first one present
 * wins, which is enough for every tool that has an obvious subject and leaves
 * the rest with just their name.
 */
const DETAIL_FIELDS = [
	'file_path',
	'path',
	'command',
	'pattern',
	'query',
	'url',
	'description',
	'notebook_path',
] as const;

/** The one line a tool row says after the tool's name; empty when there is none. */
export function toolDetail(entry: ToolEntry, vaultPath: string): string {
	for (const field of DETAIL_FIELDS) {
		const value = entry.input[field];
		if (typeof value !== 'string' || !value.trim()) continue;
		const text = field.endsWith('path') ? displayPath(value, vaultPath) : value;
		return firstLine(text);
	}
	return '';
}

/** A long value cut to its first line, so one row stays one row. */
function firstLine(text: string): string {
	const line = text.split('\n', 1)[0] ?? '';
	return line.trim();
}

/**
 * A path inside the vault, relative to it, or null when it is somewhere else.
 * Both sides are compared without trailing slashes, and the vault root itself
 * is not "inside" anything.
 */
export function vaultRelativePath(path: string, vaultPath: string): string | null {
	const root = trimTrailingSlashes(vaultPath);
	if (!root || !path.startsWith(`${root}/`)) return null;
	const relative = path.slice(root.length + 1);
	return relative || null;
}

/**
 * What a path is called on screen: vault-relative inside the vault, and the
 * path as the tool gave it outside, where there is nothing to strip.
 */
export function displayPath(path: string, vaultPath: string): string {
	return vaultRelativePath(path, vaultPath) ?? path;
}

/**
 * The wikilink target for a changed note, or null when the file is not one:
 * outside the vault, or not a Markdown note. Obsidian's links carry no `.md`,
 * so the extension goes.
 */
export function vaultNoteLink(path: string, vaultPath: string): string | null {
	const relative = vaultRelativePath(path, vaultPath);
	if (!relative) return null;
	return relative.endsWith('.md') ? relative.slice(0, -'.md'.length) : relative;
}

/**
 * What a vault-change line says around the note, for the state the call is in
 * (#91, #95): an edit that was refused or has not answered yet must not read
 * like one that landed. Sentence case, and the note itself goes between.
 */
export function changeLine(status: ToolStatus): { lead: string; trail: string } {
	if (status === 'error') return { lead: 'Could not update ', trail: '' };
	if (status === 'done') return { lead: 'Updated ', trail: '' };
	return { lead: 'Updating ', trail: '…' };
}

/** The class a vault-change line carries beside its own, for a state worth showing. */
export function changeStateClass(status: ToolStatus): string | null {
	if (status === 'error') return 'is-error';
	if (status === 'done') return null;
	return 'is-pending';
}

/** The path a write or an edit changed, empty when the call named none. */
export function changedPath(entry: ToolEntry): string {
	const value = entry.input.file_path ?? entry.input.notebook_path ?? entry.input.path;
	return typeof value === 'string' ? value : '';
}

/** One page a search returned: what a reader clicks to check a fact. */
export interface SourceLink {
	title: string;
	url: string;
}

/**
 * The `Links:` line of a `WebSearch` result, which is where its sources are.
 *
 * A search's input holds only the query; the pages it found come back in the
 * `tool_result`, as `Web search results for query: "…"`, then one line of JSON
 * objects with a title and a url, then the model's prose. Measured against the
 * WebSearch results in this machine's transcripts on 2026-09-15. Anything that
 * does not parse is no sources rather than an error: a search that failed, or a
 * shape a later Claude Code writes, simply shows its query.
 */
export function searchSources(result: string | null): SourceLink[] {
	const line = /^Links: (\[.*\])\s*$/m.exec(result ?? '');
	if (!line?.[1]) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(line[1]);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const links: SourceLink[] = [];
	for (const item of parsed) {
		if (typeof item !== 'object' || item === null) continue;
		const { title, url } = item as { title?: unknown; url?: unknown };
		if (typeof url !== 'string' || !url) continue;
		links.push({ title: typeof title === 'string' && title ? title : url, url });
	}
	return links;
}

/**
 * What a source line says: the page a fetch named, or the query a search ran
 * and the pages it came back with (#95, #91 user story 13).
 */
export function sourceText(entry: ToolEntry): {
	label: string;
	url: string | null;
	links: SourceLink[];
} {
	const url = typeof entry.input.url === 'string' ? entry.input.url : '';
	if (url) return { label: url, url, links: [] };
	const query = typeof entry.input.query === 'string' ? entry.input.query : '';
	return {
		label: `Searched the web for “${query}”`,
		url: null,
		links: searchSources(entry.result),
	};
}

/**
 * A subagent's report, ready to render, or empty when there is none to show.
 *
 * A synchronous `Agent` call carries its report in the tool result. An async one
 * carries a launch notice there instead — internal metadata that says not to
 * quote it — and its report is read out of the file its notification named
 * (`docs/architecture.md`, issue #96), so until that read lands there is
 * nothing to show and the notice is never shown at all.
 *
 * The notice, not the notification, is what tells the two apart: the
 * notification arrives only when the subagent finishes, and between the launch
 * and that moment the notice would otherwise read as the report.
 */
export function subagentReport(entry: ToolEntry): string {
	if (toolKind(entry.name) !== 'agent') return '';
	const report = isAsyncLaunchNotice(entry.result) ? entry.report : entry.report ?? entry.result;
	return report?.trim() ? report : '';
}

/** One thing the surface draws inside a turn, in the order it draws them. */
export type TurnItem =
	| { kind: 'text'; entry: TextEntry }
	| { kind: 'thinking'; entry: ThinkingEntry }
	| { kind: 'steer'; entry: SteerEntry }
	| { kind: 'group'; tools: ToolEntry[] }
	| { kind: 'change'; entry: ToolEntry }
	| { kind: 'source'; entry: ToolEntry }
	| { kind: 'report'; entry: ToolEntry };

/**
 * A turn's entries as the things to draw.
 *
 * Consecutive tool calls join one group; anything else — prose, a thought, a
 * steer — ends the run, so a steer is never inside a group (issue #96). A call
 * that escapes the group is drawn where it happened and does not end the run:
 * the reads around a write are still one group, and the write sits after it,
 * before whatever prose comes next. A group whose calls all escaped is not
 * drawn at all.
 */
export function turnItems(
	entries: readonly TurnEntry[],
	presentation: ToolGroupPresentation,
): TurnItem[] {
	const items: TurnItem[] = [];
	let group: { kind: 'group'; tools: ToolEntry[] } | null = null;

	for (const entry of entries) {
		if (entry.kind === 'text') {
			group = null;
			items.push({ kind: 'text', entry });
			continue;
		}
		if (entry.kind === 'thinking') {
			group = null;
			items.push({ kind: 'thinking', entry });
			continue;
		}
		if (entry.kind === 'steer') {
			group = null;
			items.push({ kind: 'steer', entry });
			continue;
		}
		const kind = toolKind(entry.name);
		if (escapesToolGroup(kind, presentation)) {
			items.push({ kind: SOURCE_KINDS.includes(kind) ? 'source' : 'change', entry });
			continue;
		}
		if (!group) {
			group = { kind: 'group', tools: [] };
			items.push(group);
		}
		group.tools.push(entry);
		// The call itself folds into the group; what the subagent reported is
		// prose, and reads after it (#96).
		if (subagentReport(entry)) items.push({ kind: 'report', entry });
	}
	return items;
}
