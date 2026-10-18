/**
 * What a click on a link in the native view means (issue #114).
 *
 * The view shows three kinds of link. A wikilink, from the rendered prose or
 * from a prompt, is Obsidian's `a.internal-link` carrying its target in
 * `data-href`. A web page is an `http(s)` url, which goes to the browser
 * exactly as it does today: `webUrl()` in `./toolCalls.ts` stays the one
 * guard on what may become one. And an `obsidian://` url, which would
 * otherwise leave the app for the OS protocol handler only to come back into
 * whichever vault that picks, is resolved here instead when it names this
 * vault, so it opens beside the panel like a wikilink does. An `obsidian://`
 * url for another vault, or one this file cannot read as a file to open, is
 * left alone and the OS handler gets it as before.
 *
 * Pure and free of the DOM, so all of it is unit tested; the surface reads the
 * anchor's class and attributes and hands them over.
 */

import { webUrl } from './toolCalls';
import { vaultRelativeFolder } from '../paths';

/** The vault a link is resolved against, as the running app knows it. */
export interface VaultIdentity {
	/** `vault.getName()`, which `obsidian://` urls name a vault by. */
	name: string;
	/** The vault's absolute path, or empty when it has no filesystem adapter. */
	path: string;
}

/** What the view does with a clicked anchor. */
export type LinkAction =
	/** Open this link text beside the panel. */
	| { kind: 'note'; linktext: string }
	/** Not the view's to handle: the browser, the OS, or nothing at all. */
	| { kind: 'pass' };

const PASS: LinkAction = { kind: 'pass' };

/**
 * What a click on an anchor does, from its class and its two hrefs.
 *
 * An internal link opens its `data-href`, falling back to `href` the way
 * Obsidian's own handler does. Anything else is only ever taken over when it
 * is an `obsidian://` url naming a file in this vault; a web page is passed,
 * and so is every other scheme.
 */
export function linkAction(
	anchor: { internal: boolean; dataHref: string | null; href: string | null },
	vault: VaultIdentity,
): LinkAction {
	if (anchor.internal) {
		const target = (anchor.dataHref ?? anchor.href ?? '').trim();
		return target ? { kind: 'note', linktext: target } : PASS;
	}
	const href = anchor.href?.trim() ?? '';
	if (!href || webUrl(href)) return PASS;
	const linktext = obsidianUrlTarget(href, vault);
	return linktext ? { kind: 'note', linktext } : PASS;
}

/**
 * The vault path an `obsidian://` url opens, when it opens a file in this
 * vault, else null.
 *
 * The forms read are the ones Obsidian documents for opening a file:
 *
 * - `obsidian://open?vault=<name>&file=<path>`: the file by vault path or
 *   name, `.md` optional. No `vault` at all is taken as this one, which is
 *   where the OS handler would most likely have sent it anyway.
 * - `obsidian://open?path=<absolute path>`: any vault's file by its path on
 *   disk, so only a path inside this vault resolves.
 * - `obsidian://vault/<name>/<path>`, the shorthand.
 * - `obsidian:///<absolute path>`, the other shorthand.
 *
 * Query values are percent-decoded and nothing else, so a `+` stays a plus as
 * it does in Obsidian's own handler, rather than becoming the space
 * `URLSearchParams` would make of it. Any other action — a search, a new note,
 * a plugin's own — is not a file to open and is left to the OS handler.
 */
export function obsidianUrlTarget(href: string, vault: VaultIdentity): string | null {
	const match = /^obsidian:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(href);
	if (!match) return null;
	const action = (match[1] ?? '').toLowerCase();
	const rest = match[2] ?? '';
	try {
		if (action === 'open') {
			const params = queryParams(match[3] ?? '');
			const path = params.get('path');
			if (path) return insideVault(path, vault.path);
			const name = params.get('vault');
			if (name !== undefined && name !== vault.name) return null;
			return vaultFile(params.get('file') ?? '');
		}
		if (action === 'vault') {
			const [name, ...file] = rest.split('/').filter(Boolean).map(decodeURIComponent);
			if (name !== vault.name) return null;
			return vaultFile(file.join('/'));
		}
		if (action === '') return insideVault(decodeURIComponent(rest), vault.path);
	} catch {
		// A malformed escape: not a url Obsidian could open either.
		return null;
	}
	return null;
}

/** A query string as decoded pairs; the first value of a repeated key wins. */
function queryParams(query: string): Map<string, string> {
	const params = new Map<string, string>();
	for (const pair of query.split('&')) {
		if (!pair) continue;
		const at = pair.indexOf('=');
		const key = decodeURIComponent(at === -1 ? pair : pair.slice(0, at));
		const value = at === -1 ? '' : decodeURIComponent(pair.slice(at + 1));
		if (!params.has(key)) params.set(key, value);
	}
	return params;
}

/**
 * A vault path in the form Obsidian keeps one: no leading, trailing or doubled
 * slashes, no `.` segments. Null when it is empty, or when it has a `..`
 * segment anywhere: a url's file is named from the vault root, and a `..`
 * there either climbs out of the vault or means nothing a link should mean.
 */
function vaultFile(path: string): string | null {
	const segments = path
		.trim()
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..')) return null;
	return segments.join('/') || null;
}

/**
 * An absolute path made vault-relative, or null when it is not a file inside
 * the vault. `vaultRelativeFolder` resolves `..` and doubled slashes before
 * it compares whole segments, so `<vault>/../x` and `<vault>-old/x` are
 * outside; the vault root itself is no file.
 */
function insideVault(path: string, vaultPath: string): string | null {
	const relative = vaultRelativeFolder(path, vaultPath);
	return relative ? relative : null;
}

/**
 * A file name no vault holds, standing in for the transcript as a note.
 * Obsidian resolves a link against the folder of its source path, and a
 * transcript is not a note, so the source path is this name inside the folder
 * the links should resolve from.
 */
const SOURCE_NAME = '.herdr-session';

/**
 * The source path a pane's links resolve against: a note in the pane's
 * working directory when that is inside the vault, so `./sibling` and an
 * ambiguous name both resolve the way they would from a note there; the vault
 * root otherwise, which is what the view always used before (#114).
 *
 * `cwd` and `vaultPath` are both absolute paths on this machine: the native
 * view is local only (ADR-0002).
 */
export function linkSourcePath(cwd: string, vaultPath: string): string {
	const folder = vaultRelativeFolder(cwd, vaultPath);
	return folder ? `${folder}/${SOURCE_NAME}` : '';
}
