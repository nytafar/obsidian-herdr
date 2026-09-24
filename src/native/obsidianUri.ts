/**
 * `obsidian://` URIs in a transcript (issue #114).
 *
 * Agents in this vault print links to the notes they touched as Obsidian URIs,
 * `obsidian://open?vault=hvelv&file=registry%2Fclients%2Fmy%2FPr%C3%B8ver`:
 * percent-encoded, usually without `.md`, often non-ASCII. The native view
 * shows such a link as the note's path from the vault root and opens it inside
 * this vault, instead of handing the URI to the operating system, which would
 * bring Obsidian back to the front and replace whatever leaf it chose.
 *
 * Everything here is pure except {@link vaultLookup}, which is the one place
 * that reads the app. What is parsed mirrors Obsidian 1.13.7's own URI handler,
 * read from its `app.js`: the scheme is matched as written, `obsidian://vault/<name>/<path>`
 * is a shorthand for `open`, every query value is `decodeURIComponent`ed on its
 * own (so a `+` stays a `+`), a `#` ends the query, and the action is what
 * comes before the `?` with trailing slashes dropped.
 */

import { TFile, type App } from 'obsidian';

const SCHEME = 'obsidian://';

/** What an `obsidian://open` URI names, before it is looked up. */
export type ObsidianUriTarget =
	/** `open?vault=…&file=…` or `vault/<name>/<path>`: a path inside a named vault. */
	| { kind: 'file'; vault: string | null; file: string }
	/** `open?path=…`: an absolute path on disk, which names no vault at all. */
	| { kind: 'path'; path: string };

/**
 * Parses an `obsidian://` URI into the note it opens, or null for anything
 * this view does not open: another action (`new`, `search`, a plugin's own),
 * an `open` that names no note, or a URI that does not decode.
 */
export function parseObsidianUri(uri: string): ObsidianUriTarget | null {
	if (!uri.startsWith(SCHEME)) return null;
	const rest = uri.slice(SCHEME.length);
	try {
		if (rest.startsWith('vault/')) {
			const [vault, ...path] = rest.slice('vault/'.length).split('/').map(decodeURIComponent);
			const file = path.join('/');
			if (!vault || !file) return null;
			return { kind: 'file', vault, file };
		}
		const query = rest.indexOf('?');
		const hash = rest.indexOf('#', Math.max(0, query));
		const head = hash === -1 ? rest : rest.slice(0, hash);
		const action = (query === -1 ? head : head.slice(0, query)).replace(/\/+$/, '');
		if (action !== 'open' || query === -1) return null;
		const params = new Map<string, string>();
		for (const pair of head.slice(query + 1).split('&')) {
			const at = pair.indexOf('=');
			const key = at === -1 ? pair : pair.slice(0, at);
			if (!key) continue;
			params.set(decodeURIComponent(key), at === -1 ? 'true' : decodeURIComponent(pair.slice(at + 1)));
		}
		// Obsidian's own rule: `path` overrides both `vault` and `file`.
		const path = params.get('path');
		if (path) return { kind: 'path', path };
		const file = params.get('file');
		if (!file) return null;
		return { kind: 'file', vault: params.get('vault') ?? null, file };
	} catch {
		// `decodeURIComponent` throws on a malformed escape: not a link to anything.
		return null;
	}
}

/** What {@link resolveObsidianUri} needs to know about the running vault. */
export interface VaultLookup {
	/** `app.vault.getName()`, which a `vault=` must equal. */
	name: string;
	/** The vault's absolute path, or empty where there is none to strip. */
	basePath: string;
	/** The path of the file at exactly this vault-relative path, or null. */
	exact(path: string): string | null;
	/** The path of the note a link to `linkpath` resolves to, or null. */
	link(linkpath: string): string | null;
}

/**
 * The vault-relative path of the note an `obsidian://` URI opens in *this*
 * vault, or null: a URI for another vault, another action, or a note that is
 * not there is left alone as the external link it is.
 *
 * A `file=` is tried as written, then with `.md`, which is how agents usually
 * print it and how Obsidian itself reads it, then as a link would resolve.
 */
export function resolveObsidianUri(uri: string, vault: VaultLookup): string | null {
	const target = parseObsidianUri(uri);
	if (!target) return null;
	if (target.kind === 'path') {
		const base = vault.basePath.replace(/\/+$/, '');
		if (!base || !target.path.startsWith(`${base}/`)) return null;
		return lookUp(target.path.slice(base.length + 1), vault);
	}
	if (target.vault !== vault.name) return null;
	return lookUp(target.file, vault);
}

function lookUp(file: string, vault: VaultLookup): string | null {
	const path = file.replace(/^\/+/, '');
	if (!path) return null;
	return vault.exact(path) ?? vault.exact(`${path}.md`) ?? vault.link(path);
}

/** The running vault, for {@link resolveObsidianUri}. Read when a URI is found, not before. */
export function vaultLookup(app: App, basePath: string): VaultLookup {
	return {
		name: app.vault.getName(),
		basePath,
		exact: (path) => {
			const file = app.vault.getAbstractFileByPath(path);
			return file instanceof TFile ? file.path : null;
		},
		link: (linkpath) => app.metadataCache.getFirstLinkpathDest(linkpath, '')?.path ?? null,
	};
}

/** One URI found in a run of text: `text.slice(start, end) === uri`. */
export interface UriMatch {
	uri: string;
	start: number;
	end: number;
}

/**
 * A URI runs to the next space, quote, angle bracket or backtick: agents print
 * them percent-encoded, so a space inside one is already `%20`.
 */
const URI_PATTERN = /obsidian:\/\/[^\s<>"'`]+/g;

/** Punctuation that ends the sentence around a URI rather than the URI itself. */
const TRAILING = /[.,;:!?*_~]+$/;

/**
 * Every `obsidian://` URI in a run of plain text, in order, with the sentence
 * punctuation after it left out: `See obsidian://open?…&file=a.` links `a`,
 * not `a.`. A closing bracket is the URI's own only when it opened one, so a
 * URI in parentheses loses the parenthesis that closes them.
 */
export function findObsidianUris(text: string): UriMatch[] {
	const found: UriMatch[] = [];
	for (const match of text.matchAll(URI_PATTERN)) {
		const uri = trimUri(match[0]);
		if (uri.length <= SCHEME.length) continue;
		found.push({ uri, start: match.index, end: match.index + uri.length });
	}
	return found;
}

function trimUri(raw: string): string {
	let uri = raw;
	for (;;) {
		const before = uri;
		uri = uri.replace(TRAILING, '');
		for (const [open, close] of [
			['(', ')'],
			['[', ']'],
			['{', '}'],
		] as const) {
			if (uri.endsWith(close) && count(uri, close) > count(uri, open)) uri = uri.slice(0, -1);
		}
		if (uri === before) return uri;
	}
}

function count(text: string, char: string): number {
	return text.split(char).length - 1;
}

/** The URI a run of text is, when it is exactly one and nothing else. */
export function soleObsidianUri(text: string): string | null {
	const trimmed = text.trim();
	const [match] = findObsidianUris(trimmed);
	return match && match.start === 0 && match.end === trimmed.length ? match.uri : null;
}
