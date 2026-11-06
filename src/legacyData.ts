/**
 * Settings carried over from the plugin's old id.
 *
 * The plugin shipped as id `herdr` until 0.5.0 and is `gjetr` now. Other
 * plugins use the `herdr` id too, so that folder is not necessarily ours. Obsidian
 * keeps a plugin's settings in `<configDir>/plugins/<id>/data.json`, so an
 * install from before the rename has its settings in `plugins/herdr/`.
 *
 * On a first load under the new id (no `data.json` of its own yet) the old file
 * is read and adopted only when it is unmistakably this plugin's: a manifest
 * beside it by this plugin's author, or, with no manifest at all, the settings
 * keys only this plugin writes. A manifest from anyone else vetoes it, whatever
 * the data looks like, since the other `herdr` plugins live in the same folder
 * name. The old folder is only read: never moved, changed or deleted.
 */

/** The old plugin folder, relative to the vault's config dir. */
export const LEGACY_PLUGIN_ID = 'herdr';

/** The slice of `DataAdapter` the migration reads through. */
export interface LegacyDataReader {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

/**
 * Keys only this plugin writes, from 0.2 on. Deliberately not the early ones
 * (`socketPath`, `herdrBinary`, `workspaceId`), which another herdr plugin
 * could plausibly store too.
 */
const DISTINCTIVE_KEYS: readonly string[] = [
	'runtimes',
	'activeRuntime',
	'defaultView',
	'terminalEngine',
	'pinnedPanes',
	'agentListSort',
	'agentListGroupBy',
	'agentListRowClick',
	'defaultAttachMode',
	'folderHoverButton',
	'splitIntoFolderTab',
	'terminalTitleSource',
	'claudeSessions',
];

/** How many of {@link DISTINCTIVE_KEYS} a manifest-less file must carry. */
const MIN_DISTINCTIVE_KEYS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a parsed `manifest.json` is this plugin's (by author), before or after the rename. */
export function isOurManifest(manifest: unknown): boolean {
	if (!isRecord(manifest)) return false;
	const author = typeof manifest.author === 'string' ? manifest.author : '';
	const authorUrl = typeof manifest.authorUrl === 'string' ? manifest.authorUrl : '';
	const byUs = /^Lasse(\s|$)/.test(author) || /github\.com\/nytafar\/?$/.test(authorUrl);
	const id = manifest.id;
	return byUs && (id === LEGACY_PLUGIN_ID || id === 'gjetr');
}

/** Whether parsed `data.json` carries enough of this plugin's own keys to be its settings. */
export function looksLikeOurData(data: unknown): boolean {
	if (!isRecord(data)) return false;
	return DISTINCTIVE_KEYS.filter((key) => key in data).length >= MIN_DISTINCTIVE_KEYS;
}

function parse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * The old id's settings when they are this plugin's, or null. Never throws: a
 * missing, unreadable or foreign file is simply not adopted.
 */
export async function readLegacyData(reader: LegacyDataReader, configDir: string): Promise<Record<string, unknown> | null> {
	const folder = `${configDir}/plugins/${LEGACY_PLUGIN_ID}`;
	try {
		const dataPath = `${folder}/data.json`;
		if (!(await reader.exists(dataPath))) return null;
		const data = parse(await reader.read(dataPath));
		if (!isRecord(data)) return null;
		const manifestPath = `${folder}/manifest.json`;
		if (await reader.exists(manifestPath)) {
			// A manifest decides: ours is adopted, anyone else's never is.
			return isOurManifest(parse(await reader.read(manifestPath))) ? data : null;
		}
		return looksLikeOurData(data) ? data : null;
	} catch {
		return null;
	}
}
