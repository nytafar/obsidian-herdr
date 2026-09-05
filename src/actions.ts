/**
 * Folder actions: new tab, split, start agent (PRD M19, M20; T6).
 *
 * The three actions all mean "do this in herdr, where this vault folder is".
 * Two things make that non-trivial:
 *
 *   - **Paths.** Obsidian speaks vault-relative paths; herdr wants an absolute
 *     cwd on the machine it runs on. Locally that is
 *     `FileSystemAdapter.getBasePath()`, and with a remote profile it is
 *     `settings.remote.remoteVaultPath` (PRD S5, M19). See {@link resolveFolderPath}.
 *   - **Agent names.** herdr rejects a name that does not match
 *     `[a-z][a-z0-9_-]{0,31}` with `invalid_agent_name`, and a duplicate with
 *     `agent_name_taken`. {@link buildAgentName} makes both impossible up front.
 *
 * No `obsidian` import lives here on purpose: menus and commands are wired in
 * `src/main.ts`, everything the action needs from Obsidian arrives through
 * {@link ActionHost}, and the module stays unit testable against a fake client.
 */

import type { HerdrSettings } from './settings';
import { HerdrError } from './herdr/client';
import type { PaneInfo, TabInfo } from './herdr/types.gen';

/** herdr's own rule from `src/app/agents.rs`: `[a-z][a-z0-9_-]{0,31}`. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_AGENT_NAME = 32;

/** How long to wait for the new tab's pane to show up before giving up. */
export const PANE_WAIT_TIMEOUT_MS = 5000;
const PANE_POLL_INTERVAL_MS = 150;

/** The bits of the plugin an action needs. Everything Obsidian-shaped is here. */
export interface ActionHost {
	/** Live settings; read through a function because the object is replaced. */
	settings(): HerdrSettings;
	/** Scoped workspace id, or null when no herdr workspace matches this vault. */
	workspaceId(): string | null;
	/** One JSON API call. Rejects with `HerdrError`. */
	request<T>(method: string, params: unknown): Promise<T>;
	/** Agent names already in use in this workspace, for uniqueness. */
	takenAgentNames(): Set<string>;
	/** Vault folder name, for the `{vault}` placeholder. */
	vaultName(): string;
	/** Show a message to the user. */
	notice(message: string): void;
	/** Opens the terminal view for a pane (a stub until T9). */
	openTerminal(paneId: string): Promise<void>;
	/** Sleep, injected so tests do not actually wait. */
	sleep(ms: number): Promise<void>;
	/** Clock, injected for the pane wait timeout. */
	now(): number;
}

/** Joins path segments with `/` and collapses `.`, `..` and duplicate slashes. */
export function normalizePosixPath(path: string): string {
	const absolute = path.startsWith('/');
	const parts: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
			else if (!absolute) parts.push('..');
			continue;
		}
		parts.push(segment);
	}
	const joined = parts.join('/');
	if (absolute) return `/${joined}`;
	return joined === '' ? '.' : joined;
}

export interface PathRoots {
	/** `FileSystemAdapter.getBasePath()`. */
	basePath: string;
	/** `settings.remote.remoteVaultPath`, only when the remote profile is on. */
	remoteVaultPath?: string;
}

/**
 * Turns a vault-relative folder path into the absolute path herdr should use.
 *
 * The remote root wins when a remote profile is enabled, because the cwd is
 * interpreted on the remote host. An already-absolute input is passed through
 * untouched: the file explorer never produces one, but a caller resolving a
 * folder outside the vault might.
 */
export function resolveFolderPath(vaultRelativePath: string, roots: PathRoots): string {
	const relative = vaultRelativePath.trim();
	if (relative.startsWith('/')) return normalizePosixPath(relative);
	const root = (roots.remoteVaultPath?.trim() || roots.basePath).replace(/\/+$/, '');
	if (!root) return normalizePosixPath(relative);
	// The vault root itself comes through as '' or '/' from TFolder.isRoot().
	if (relative === '' || relative === '/' || relative === '.') return normalizePosixPath(root);
	return normalizePosixPath(`${root}/${relative}`);
}

/** Last path segment, used as a tab label and for `{folder}`. */
export function folderName(absolutePath: string): string {
	const trimmed = absolutePath.replace(/\/+$/, '');
	const slash = trimmed.lastIndexOf('/');
	const name = slash === -1 ? trimmed : trimmed.slice(slash + 1);
	return name || '/';
}

/**
 * Forces a string into herdr's agent-name shape, `[a-z][a-z0-9_-]{0,31}`.
 *
 * Lower-cases, folds anything else to `-`, collapses runs, trims separators, and
 * prefixes `a-` when the result would not start with a letter (herdr requires
 * one). An input with nothing usable left becomes `agent`.
 */
export function sanitizeAgentName(raw: string): string {
	let name = raw
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-_]+/, '')
		.replace(/[-_]+$/, '');
	if (name === '') return 'agent';
	if (!/^[a-z]/.test(name)) name = `a-${name}`;
	name = name.slice(0, MAX_AGENT_NAME).replace(/[-_]+$/, '');
	return name === '' ? 'agent' : name;
}

/** Appends `-n` to a name without breaking the 32-character limit. */
function withSuffix(base: string, n: number): string {
	const suffix = `-${n}`;
	const head = base.slice(0, MAX_AGENT_NAME - suffix.length).replace(/[-_]+$/, '');
	return `${head || 'agent'}${suffix}`;
}

export interface AgentNameVars {
	/** Folder the agent starts in. */
	folder: string;
	/** Vault folder name. */
	vault: string;
}

/**
 * Expands the name pattern, sanitises it, and makes it unique against `taken`.
 *
 * `{n}` is a counter the user can place anywhere; when the pattern has none, the
 * uniqueness suffix is appended instead. Counting starts at 2, so the first
 * agent in a folder is just `notes`, the next `notes-2`.
 */
export function buildAgentName(
	pattern: string,
	vars: AgentNameVars,
	taken: Set<string> = new Set(),
): string {
	const expand = (n: number): string =>
		pattern
			.replaceAll('{folder}', vars.folder)
			.replaceAll('{vault}', vars.vault)
			.replaceAll('{n}', String(n));
	const hasCounter = pattern.includes('{n}');
	const base = sanitizeAgentName(expand(1));
	if (!taken.has(base) && !hasCounter) return base;

	for (let n = hasCounter ? 1 : 2; n < 1000; n++) {
		const candidate = hasCounter ? sanitizeAgentName(expand(n)) : withSuffix(base, n);
		if (!taken.has(candidate)) return candidate;
	}
	// 998 collisions in one folder: fall back to something certainly free.
	return sanitizeAgentName(`agent-${Date.now().toString(36)}`);
}

/** `{tab, root_pane}` as returned by `tab.create`. */
interface TabCreatedResult {
	tab: TabInfo;
	root_pane?: PaneInfo | null;
}

/** `{pane}` as returned by `pane.split` and `pane.focus`. */
interface PaneResult {
	pane: PaneInfo;
}

interface PaneListResult {
	panes?: PaneInfo[];
}

/** Result of {@link startAgentHere}, so callers and tests can assert on it. */
export interface StartedAgent {
	tabId: string;
	paneId: string;
	name: string;
	kind: string;
}

/** The three folder actions (PRD M19, M20), one method each. */
export class HerdrActions {
	constructor(private readonly host: ActionHost) {}

	/** `tab.create` in the scoped workspace, cwd = folder, label = folder name. */
	async newTabHere(folderAbsPath: string): Promise<TabInfo | null> {
		const workspaceId = this.host.workspaceId();
		if (!this.guard(workspaceId)) return null;
		const label = folderName(folderAbsPath);
		try {
			const result = await this.host.request<TabCreatedResult>('tab.create', {
				workspace_id: workspaceId,
				cwd: folderAbsPath,
				label,
				focus: true,
			});
			this.host.notice(`Herdr: new tab "${result.tab?.label ?? label}"`);
			return result.tab ?? null;
		} catch (error) {
			this.reportFailure('create a tab', error);
			return null;
		}
	}

	/**
	 * `pane.split` with cwd = folder. Splitting to the right and passing only the
	 * workspace id makes herdr split *that workspace's* focused pane, which is
	 * what "here" means for a vault scoped to one workspace (notes/herdr-api.md).
	 */
	async splitHere(folderAbsPath: string): Promise<PaneInfo | null> {
		const workspaceId = this.host.workspaceId();
		if (!this.guard(workspaceId)) return null;
		try {
			const result = await this.host.request<PaneResult>('pane.split', {
				direction: 'right',
				workspace_id: workspaceId,
				cwd: folderAbsPath,
				focus: true,
			});
			this.host.notice(`Herdr: split in ${folderName(folderAbsPath)}`);
			return result.pane ?? null;
		} catch (error) {
			this.reportFailure('split a pane', error);
			return null;
		}
	}

	/**
	 * Creates a tab, waits for its pane to exist, then starts an agent in it
	 * (PRD M20). `tab.create` already returns `root_pane`, but the pane is only
	 * usable once herdr lists it, so the id from the reply is confirmed against
	 * `pane.list` before `agent.start` — otherwise the call races the shell and
	 * comes back `agent_pane_unavailable`.
	 */
	async startAgentHere(folderAbsPath: string): Promise<StartedAgent | null> {
		const workspaceId = this.host.workspaceId();
		if (!this.guard(workspaceId)) return null;
		const settings = this.host.settings();
		const label = folderName(folderAbsPath);

		let created: TabCreatedResult;
		try {
			created = await this.host.request<TabCreatedResult>('tab.create', {
				workspace_id: workspaceId,
				cwd: folderAbsPath,
				label,
				focus: false,
			});
		} catch (error) {
			this.reportFailure('create a tab', error);
			return null;
		}

		const tabId = created.tab?.tab_id ?? '';
		const paneId = await this.waitForPane(tabId, created.root_pane?.pane_id);
		if (!paneId) {
			this.host.notice('Herdr: the new tab never reported a pane, so no agent was started.');
			return null;
		}

		const kind = settings.defaultAgentKind;
		const taken = this.host.takenAgentNames();
		let name = buildAgentName(settings.agentNamePattern || '{folder}', {
			folder: label,
			vault: this.host.vaultName(),
		}, taken);

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await this.host.request('agent.start', { name, kind, pane_id: paneId });
				this.host.notice(`Herdr: started ${kind} agent "${name}" in ${label}`);
				if (settings.openTerminalAfterStart) await this.host.openTerminal(paneId);
				return { tabId, paneId, name, kind };
			} catch (error) {
				// Another client can take the name between our check and the call.
				if (error instanceof HerdrError && error.code === 'agent_name_taken' && attempt === 0) {
					taken.add(name);
					name = buildAgentName(settings.agentNamePattern || '{folder}', {
						folder: label,
						vault: this.host.vaultName(),
					}, taken);
					continue;
				}
				this.reportFailure('start an agent', error);
				return null;
			}
		}
		return null;
	}

	/** Focuses a pane in herdr; the one source of truth for "seen" (PRD M9). */
	async focusPane(paneId: string): Promise<boolean> {
		try {
			await this.host.request<PaneResult>('pane.focus', { pane_id: paneId });
			return true;
		} catch (error) {
			this.reportFailure('focus the pane', error);
			return false;
		}
	}

	/**
	 * Polls `pane.list` until a pane of `tabId` exists, or the timeout passes.
	 * `hint` is `tab.create`'s `root_pane.pane_id`; it is preferred when the list
	 * confirms it, so a tab that already holds several panes cannot mislead us.
	 */
	private async waitForPane(tabId: string, hint?: string | null): Promise<string | null> {
		if (!tabId && hint) return hint;
		const deadline = this.host.now() + PANE_WAIT_TIMEOUT_MS;
		for (;;) {
			try {
				const result = await this.host.request<PaneListResult>('pane.list', {
					workspace_id: this.host.workspaceId(),
				});
				const panes = result.panes ?? [];
				if (hint && panes.some((pane) => pane.pane_id === hint)) return hint;
				const match = panes.find((pane) => pane.tab_id === tabId);
				if (match) return match.pane_id;
			} catch (error) {
				this.reportFailure('list panes', error);
				return null;
			}
			if (this.host.now() >= deadline) return hint ?? null;
			await this.host.sleep(PANE_POLL_INTERVAL_MS);
		}
	}

	/** True when there is a workspace to act in; otherwise it explains why not. */
	private guard(workspaceId: string | null): workspaceId is string {
		if (workspaceId) return true;
		this.host.notice(
			'Herdr: no herdr workspace matches this vault yet. Open one in herdr, or set a workspace ID in the settings.',
		);
		return false;
	}

	private reportFailure(what: string, error: unknown): void {
		const message =
			error instanceof HerdrError
				? `${error.message} (${error.code})`
				: error instanceof Error
					? error.message
					: String(error);
		this.host.notice(`Herdr: could not ${what}. ${message}`);
	}
}
