/**
 * Adding the session hook's one `SessionStart` entry to a Claude settings
 * file, removing it again, and telling whether it is there (ADR-0006).
 *
 * Pure text in, text out: the installer (`./installer.ts`) reads and writes
 * the files. The rules:
 *
 * - **Ours is recognised by the script's file name** in a command hook's
 *   command, wherever that script lives, so an entry pointing at a moved
 *   config dir is still ours to replace or remove.
 * - **Nothing else changes value.** Every other key, event, group and hook
 *   keeps its value, and groups keep their order. Install replaces our group
 *   in place, or appends one; it never adds our hook to someone else's group
 *   (herdr's included).
 * - **The file is rewritten in standard formatting**, as Claude rewrites it
 *   itself: `JSON.stringify` with the file's own indentation, final newline
 *   and line endings (CRLF stays CRLF). Inline arrays and objects come out
 *   expanded, and integer-like keys come first in their object.
 * - **A rewrite that would change a value is refused** ({@link rewriteIssue}):
 *   a number JavaScript cannot hold exactly (beyond the safe integers, more
 *   digits than a double keeps, out of range), or a key that appears twice
 *   in one object, of which `JSON.parse` keeps only the last.
 * - **Refuse, never repair.** Text that is not JSON, a root that is not an
 *   object, a `hooks` that is not an object or a `SessionStart` that is not
 *   an array is left alone with a reason. A missing or blank file is an
 *   empty one: install creates it, remove has nothing to do.
 */

import {
	SESSION_HOOK_FILE,
	SESSION_HOOK_VERSION,
	sessionHookEntry,
	sessionHookScript,
	sessionHookScriptVersion,
	type ClaudeHookGroup,
} from './hookScript';

export type SettingsEdit =
	| { ok: true; text: string; changed: boolean }
	| { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A command hook that runs our script. */
export function isSessionHookCommand(hook: unknown): boolean {
	if (!isObject(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return false;
	return hook.command.includes(SESSION_HOOK_FILE);
}

type Parsed = { ok: true; root: JsonObject; created: boolean } | { ok: false; reason: string };

/** The settings as an object; a missing or blank file is an empty one. */
function parse(text: string | null): Parsed {
	if (text === null || text.trim() === '') return { ok: true, root: {}, created: true };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `it is not valid JSON (${detail})` };
	}
	if (!isObject(value)) return { ok: false, reason: 'its top level is not a JSON object' };
	return { ok: true, root: value, created: false };
}

/** `hooks.SessionStart`, checked; undefined where absent. */
function sessionStartOf(root: JsonObject): { ok: true; groups: unknown[] | undefined } | { ok: false; reason: string } {
	const hooks = root.hooks;
	if (hooks === undefined) return { ok: true, groups: undefined };
	if (!isObject(hooks)) return { ok: false, reason: '"hooks" is not an object' };
	const groups = hooks.SessionStart;
	if (groups === undefined) return { ok: true, groups: undefined };
	if (!Array.isArray(groups)) return { ok: false, reason: '"hooks.SessionStart" is not a list' };
	return { ok: true, groups };
}

/** The indentation the file already uses, else Claude's own two spaces. */
function indentOf(text: string | null): string {
	const match = text ? /\n([ \t]+)\S/.exec(text) : null;
	return match?.[1] ?? '  ';
}

function serialize(root: JsonObject, original: string | null): string {
	const text = JSON.stringify(root, null, indentOf(original));
	const newline = original === null || original.trim() === '' || original.endsWith('\n');
	const out = newline ? `${text}\n` : text;
	// A string value never holds a raw newline once stringified, so every
	// newline in the output is a line break and can take the file's ending.
	const firstBreak = original?.indexOf('\n') ?? -1;
	const crlf = firstBreak > 0 && original?.charAt(firstBreak - 1) === '\r';
	return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/** A JSON number token as digits without leading or trailing zeros, and a power of ten. */
function decimalOf(token: string): { digits: string; exponent: number } {
	const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
	if (!match) return { digits: token, exponent: 0 };
	const fraction = match[2] ?? '';
	let digits = `${match[1] ?? ''}${fraction}`.replace(/^0+/, '');
	if (digits === '') return { digits: '', exponent: 0 };
	let exponent = Number(match[3] ?? '0') - fraction.length;
	const trailing = digits.length - digits.replace(/0+$/, '').length;
	digits = digits.slice(0, digits.length - trailing);
	exponent += trailing;
	return { digits, exponent };
}

/**
 * Whether `JSON.stringify(JSON.parse(token))` is the same number as the
 * token: `1.0` and `1e2` are, `12345678901234567890` and `1e400` are not.
 * The sign of zero does not count.
 */
function keepsNumber(token: string): boolean {
	const value = Number(token);
	if (!Number.isFinite(value)) return false;
	const read = decimalOf(token);
	const written = decimalOf(String(Math.abs(value)));
	if (read.digits !== written.digits || read.exponent !== written.exponent) return false;
	return read.digits === '' || token.startsWith('-') === value < 0;
}

/**
 * What a parse-and-stringify of `text` would change other than formatting,
 * or null when nothing. `text` is valid JSON (`JSON.parse` took it).
 */
export function rewriteIssue(text: string): string | null {
	let i = 0;
	const number = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	const ws = (): void => {
		while (i < text.length && ' \t\r\n'.includes(text.charAt(i))) i++;
	};
	const string = (): string => {
		const start = i;
		i++;
		while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
		i++;
		return JSON.parse(text.slice(start, i)) as string;
	};
	const where = (path: string): string => (path === '' ? 'the top level' : path);
	const value = (path: string): string | null => {
		ws();
		const c = text.charAt(i);
		if (c === '{') {
			i++;
			const seen = new Set<string>();
			ws();
			if (text.charAt(i) === '}') {
				i++;
				return null;
			}
			for (;;) {
				ws();
				const key = string();
				if (seen.has(key)) return `the key "${key}" appears twice in ${where(path)}, and only the last would be kept`;
				seen.add(key);
				ws();
				i++; // the colon
				const issue = value(path === '' ? key : `${path}.${key}`);
				if (issue) return issue;
				ws();
				if (text.charAt(i++) !== ',') return null;
			}
		}
		if (c === '[') {
			i++;
			ws();
			if (text.charAt(i) === ']') {
				i++;
				return null;
			}
			for (let index = 0; ; index++) {
				const issue = value(`${path}[${index}]`);
				if (issue) return issue;
				ws();
				if (text.charAt(i++) !== ',') return null;
			}
		}
		if (c === '"') {
			string();
			return null;
		}
		number.lastIndex = i;
		const token = number.exec(text)?.[0];
		if (token) {
			i += token.length;
			if (keepsNumber(token)) return null;
			return `the number ${token} at ${where(path)} would be written as ${JSON.stringify(Number(token))}`;
		}
		i += c === 'f' ? 5 : 4; // false, true, null
		return null;
	};
	return value('');
}

/** The rewritten text, unless the rewrite would change a value of the original. */
function rewrite(root: JsonObject, original: string | null): SettingsEdit {
	const issue = original === null || original.trim() === '' ? null : rewriteIssue(original);
	if (issue) {
		return {
			ok: false,
			reason: `The Claude settings were left alone: rewriting them would change a value, because ${issue}. Add or remove the entry by hand instead.`,
		};
	}
	return { ok: true, text: serialize(root, original), changed: true };
}

function groupHooks(group: unknown): unknown[] | null {
	return isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
}

/** A group holding our hook and nothing else. */
function isOurGroup(group: unknown): boolean {
	const hooks = groupHooks(group);
	return hooks !== null && hooks.length > 0 && hooks.every(isSessionHookCommand);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Our hooks taken out of `groups`: a group left empty by it goes, every
 * other group stays as it was. Null when there was nothing of ours.
 */
function withoutOurs(groups: unknown[]): unknown[] | null {
	let removed = false;
	const kept: unknown[] = [];
	for (const group of groups) {
		const hooks = groupHooks(group);
		if (!hooks || !hooks.some(isSessionHookCommand)) {
			kept.push(group);
			continue;
		}
		removed = true;
		const rest = hooks.filter((hook) => !isSessionHookCommand(hook));
		if (rest.length > 0) kept.push({ ...(group as JsonObject), hooks: rest });
	}
	return removed ? kept : null;
}

/** Adds (or brings up to date) our one entry; idempotent. */
export function addSessionHook(text: string | null, entry: ClaudeHookGroup): SettingsEdit {
	const parsed = parse(text);
	if (!parsed.ok) return { ok: false, reason: `The Claude settings were left alone: ${parsed.reason}.` };
	const found = sessionStartOf(parsed.root);
	if (!found.ok) return { ok: false, reason: `The Claude settings were left alone: ${found.reason}.` };
	const groups = found.groups ?? [];
	const ours = groups.filter((group) => groupHooks(group)?.some(isSessionHookCommand));
	if (ours.length === 1 && sameJson(ours[0], entry)) {
		return { ok: true, text: text ?? '', changed: false };
	}
	// Our own group is replaced where it stands; strays of ours inside other
	// groups are taken out of them; with no group of ours, it goes last.
	const at = groups.findIndex(isOurGroup);
	const next: unknown[] = [];
	groups.forEach((group, index) => {
		if (index === at) {
			next.push(entry);
			return;
		}
		const hooks = groupHooks(group);
		if (!hooks || !hooks.some(isSessionHookCommand)) {
			next.push(group);
			return;
		}
		const rest = hooks.filter((hook) => !isSessionHookCommand(hook));
		if (rest.length > 0) next.push({ ...(group as JsonObject), hooks: rest });
	});
	if (at < 0) next.push(entry);
	const root = parsed.root;
	const hooks = isObject(root.hooks) ? root.hooks : {};
	hooks.SessionStart = next;
	root.hooks = hooks;
	return rewrite(root, text);
}

/** Removes our entry and nothing else; an empty list or object it leaves goes too. */
export function removeSessionHook(text: string | null): SettingsEdit {
	const parsed = parse(text);
	if (!parsed.ok) return { ok: false, reason: `The Claude settings were left alone: ${parsed.reason}.` };
	if (parsed.created) return { ok: true, text: text ?? '', changed: false };
	const found = sessionStartOf(parsed.root);
	if (!found.ok) return { ok: false, reason: `The Claude settings were left alone: ${found.reason}.` };
	const kept = found.groups ? withoutOurs(found.groups) : null;
	if (!kept) return { ok: true, text: text ?? '', changed: false };
	const root = parsed.root;
	const hooks = root.hooks as JsonObject;
	if (kept.length > 0) hooks.SessionStart = kept;
	else delete hooks.SessionStart;
	if (Object.keys(hooks).length === 0) delete root.hooks;
	return rewrite(root, text);
}

/** Our command hooks' groups as they stand in the file, for showing them. */
export function installedSessionHookGroups(text: string | null): unknown[] {
	const parsed = parse(text);
	if (!parsed.ok) return [];
	const found = sessionStartOf(parsed.root);
	if (!found.ok || !found.groups) return [];
	return found.groups.filter((group) => groupHooks(group)?.some(isSessionHookCommand));
}

export type SessionHookState = 'absent' | 'installed' | 'outdated' | 'unreadable';

export interface SessionHookStatus {
	state: SessionHookState;
	/** One sentence for the settings and the modal. */
	detail: string;
	/** The installed script's version marker, when there is a script. */
	scriptVersion: number | null;
}

/**
 * Whether the hook is in place, from the two files' text (null: missing).
 * Installed means our exact entry and our exact script; anything of ours
 * that differs is outdated, and install would bring it up to date.
 */
export function sessionHookStatus(
	settingsText: string | null,
	scriptText: string | null,
	scriptPath: string,
): SessionHookStatus {
	const scriptVersion = scriptText === null ? null : sessionHookScriptVersion(scriptText);
	const parsed = parse(settingsText);
	if (!parsed.ok) {
		return { state: 'unreadable', detail: `The Claude settings cannot be read: ${parsed.reason}.`, scriptVersion };
	}
	const found = sessionStartOf(parsed.root);
	if (!found.ok) {
		return { state: 'unreadable', detail: `The Claude settings cannot be read: ${found.reason}.`, scriptVersion };
	}
	const ours = (found.groups ?? []).filter((group) => groupHooks(group)?.some(isSessionHookCommand));
	if (ours.length === 0) {
		const leftover = scriptText !== null ? ' Its script is still on disk.' : '';
		return { state: 'absent', detail: `Not installed.${leftover}`, scriptVersion };
	}
	const outdated = (why: string): SessionHookStatus => ({ state: 'outdated', detail: `Outdated: ${why}.`, scriptVersion });
	if (scriptText === null) return outdated('the settings entry is there but its script is missing');
	if (scriptVersion === null) return outdated('the script has no version marker');
	if (scriptVersion < SESSION_HOOK_VERSION) {
		return outdated(`version ${scriptVersion} is installed, this plugin has ${SESSION_HOOK_VERSION}`);
	}
	if (ours.length !== 1 || !sameJson(ours[0], sessionHookEntry(scriptPath))) {
		return outdated('the settings entry differs from the one this plugin writes');
	}
	if (scriptVersion === SESSION_HOOK_VERSION && scriptText !== sessionHookScript()) {
		return outdated('the script was changed after it was installed');
	}
	const newer = scriptVersion > SESSION_HOOK_VERSION ? ', by a newer version of the plugin' : '';
	return { state: 'installed', detail: `Installed (version ${scriptVersion}${newer}).`, scriptVersion };
}
