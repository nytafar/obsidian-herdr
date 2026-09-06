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

import { clampPanesPerTab, remoteVaultPathIssue, type HerdrSettings } from './settings';
import { HerdrError } from './herdr/client';
import type { PaneInfo, TabInfo } from './herdr/types.gen';

/** herdr's own rule from `src/app/agents.rs`: `[a-z][a-z0-9_-]{0,31}`. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_AGENT_NAME = 32;

/** How long to wait for the new tab's pane to show up before giving up. */
export const PANE_WAIT_TIMEOUT_MS = 5000;
const PANE_POLL_INTERVAL_MS = 150;

/**
 * How long `agent.start` is retried while the new pane's shell is still coming
 * up, and how often. Same window and interval as herdr's own CLI
 * (`src/cli/agent.rs`: `PANE_SHELL_READINESS_RETRY_TIMEOUT` 2 s,
 * `AGENT_START_POLL_INTERVAL` 100 ms).
 */
export const AGENT_START_RETRY_MS = 2000;
const AGENT_START_POLL_MS = 100;

/**
 * herdr's answers when the pane exists but cannot host an agent *yet*
 * (`src/app/agents.rs`): no terminal runtime attached, or no shell prompt found
 * by `available_shell_name`. Both are the launch race, not a real refusal.
 */
const PANE_NOT_READY_CODES = new Set(['agent_pane_unavailable', 'agent_pane_busy']);

/** The bits of the plugin an action needs. Everything Obsidian-shaped is here. */
export interface ActionHost {
	/** Live settings; read through a function because the object is replaced. */
	settings(): HerdrSettings;
	/** Scoped workspace id, or null when no herdr workspace matches this vault. */
	workspaceId(): string | null;
	/** One JSON API call. Rejects with `HerdrError`. */
	request<T>(method: string, params: unknown): Promise<T>;
	/** Agent names herdr already uses session-wide, for uniqueness (M20). */
	takenAgentNames(): Set<string>;
	/**
	 * Agent panes of the scoped workspace, as the scope currently knows them.
	 * Only {@link chooseSplitTarget} reads this (issue #29).
	 */
	agentPanes(): readonly AgentPaneSummary[];
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
 * What {@link chooseSplitTarget} needs of an agent pane. `PaneState` from
 * `src/herdr/scope.ts` satisfies it; the structural type keeps this module free
 * of the scope.
 */
export interface AgentPaneSummary {
	paneId: string;
	tabId: string;
	/** Absolute cwd as herdr reports it. */
	cwd: string;
	/**
	 * The scope's monotonic status stamp, higher meaning more recently changed.
	 * Optional and zero for a pane that has not moved since it was first listed,
	 * so it can only ever break a tie, never invent an order.
	 */
	statusChangedSeq?: number;
}

/** Where the next agent of a folder goes: into an existing tab, or a new one. */
export type SplitTarget =
	| { kind: 'split'; paneId: string; tabId: string }
	| { kind: 'new-tab' };

/** Per-tab tally {@link chooseSplitTarget} builds while scanning the panes. */
interface TabTally {
	tabId: string;
	/** Agent panes of this tab that the scope knows about. */
	count: number;
	/** False as soon as one of them sits somewhere other than the folder. */
	sameFolder: boolean;
	/** The pane to split, and its stamp. */
	paneId: string;
	seq: number;
}

/**
 * Picks the herdr tab a new agent for `folderPath` should be split into, or
 * `new-tab` when none qualifies (issue #29).
 *
 * A tab qualifies when *every* agent pane the scope knows in it has that folder
 * as its cwd — an exact match after normalisation, not `isUnder`, so a parent
 * folder's tab never swallows a subfolder's agent — and when it holds fewer than
 * `panesPerTab` of them. Among the qualifying tabs the most recently active one
 * wins, measured by the highest `statusChangedSeq` in the tab; with no stamps to
 * compare (everything a fresh `pane.list` primed is 0) that is the first tab in
 * list order, and the pane chosen inside it is likewise its most recent one.
 *
 * Only agent panes are counted, because only those are in scope (PRD M7). A tab
 * where the user also keeps a plain shell therefore reads as holding one pane,
 * and the cap is a cap on *agents* per tab. That is the number the setting talks
 * about, and it is the only one herdr tells us about without a second call.
 */
export function chooseSplitTarget(
	panes: readonly AgentPaneSummary[],
	folderPath: string,
	panesPerTab: number,
): SplitTarget {
	const cap = clampPanesPerTab(panesPerTab);
	// A cap of one is "always a new tab": no tab can be under it and non-empty.
	if (cap < 2) return { kind: 'new-tab' };
	const folder = normalizePosixPath(folderPath);
	if (folder === '' || folder === '.') return { kind: 'new-tab' };

	const tabs = new Map<string, TabTally>();
	for (const pane of panes) {
		if (!pane.paneId || !pane.tabId) continue;
		const seq = typeof pane.statusChangedSeq === 'number' ? pane.statusChangedSeq : 0;
		const sameFolder = pane.cwd ? normalizePosixPath(pane.cwd) === folder : false;
		const tally = tabs.get(pane.tabId);
		if (!tally) {
			tabs.set(pane.tabId, {
				tabId: pane.tabId,
				count: 1,
				sameFolder,
				paneId: pane.paneId,
				seq,
			});
			continue;
		}
		tally.count += 1;
		tally.sameFolder = tally.sameFolder && sameFolder;
		if (seq > tally.seq) {
			tally.paneId = pane.paneId;
			tally.seq = seq;
		}
	}

	let best: TabTally | null = null;
	for (const tally of tabs.values()) {
		if (!tally.sameFolder || tally.count >= cap) continue;
		// Strictly greater, so a tie keeps the tab seen first.
		if (!best || tally.seq > best.seq) best = tally;
	}
	return best ? { kind: 'split', paneId: best.paneId, tabId: best.tabId } : { kind: 'new-tab' };
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
	 * Makes a pane for the folder, waits for it to exist, then starts an agent in
	 * it (PRD M20).
	 *
	 * The pane comes from splitting the folder's existing herdr tab when one is
	 * under the panes-per-tab cap (issue #29), and from a new tab otherwise.
	 * Either way the pane is only usable once herdr lists it, so the id from the
	 * reply is confirmed against `pane.list` first. That still does not mean the
	 * pane sits at a prompt, so the start itself is retried on the two "not ready
	 * yet" codes for {@link AGENT_START_RETRY_MS} — see the retry loop.
	 */
	async startAgentHere(folderAbsPath: string): Promise<StartedAgent | null> {
		const workspaceId = this.host.workspaceId();
		if (!this.guard(workspaceId)) return null;
		const settings = this.host.settings();
		const label = folderName(folderAbsPath);

		const target = chooseSplitTarget(
			this.host.agentPanes(),
			folderAbsPath,
			settings.panesPerTab,
		);
		let tabId = '';
		let paneId: string | null = null;
		if (target.kind === 'split') {
			const split = await this.splitForAgent(folderAbsPath, target);
			if (split) {
				tabId = split.tabId;
				paneId = split.paneId;
			}
		}

		if (!paneId) {
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
			tabId = created.tab?.tab_id ?? '';
			paneId = await this.waitForPane(tabId, created.root_pane?.pane_id);
		}
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

		const readyDeadline = this.host.now() + AGENT_START_RETRY_MS;
		let renamed = false;
		for (;;) {
			try {
				await this.host.request('agent.start', { name, kind, pane_id: paneId });
				this.host.notice(`Herdr: started ${kind} agent "${name}" in ${label}`);
				if (settings.openTerminalAfterStart) await this.host.openTerminal(paneId);
				return { tabId, paneId, name, kind };
			} catch (error) {
				if (error instanceof HerdrError) {
					// Another client can take the name between our check and the call.
					if (error.code === 'agent_name_taken' && !renamed) {
						renamed = true;
						taken.add(name);
						name = buildAgentName(settings.agentNamePattern || '{folder}', {
							folder: label,
							vault: this.host.vaultName(),
						}, taken);
						continue;
					}
					// The listed pane is not the same thing as a pane at a prompt, and
					// herdr has no "wait until interactive" call: `agent.start`'s own
					// `timeout_ms` only bounds agent *detection* after the command has
					// been typed, and `pane.wait_for_output` would need a prompt regex
					// per shell. herdr's CLI solves it by retrying the start itself
					// while the shell initialises, so this does the same.
					if (PANE_NOT_READY_CODES.has(error.code) && this.host.now() < readyDeadline) {
						await this.host.sleep(AGENT_START_POLL_MS);
						continue;
					}
				}
				this.reportFailure('start an agent', error);
				return null;
			}
		}
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
	 * Splits an existing agent pane of the folder's tab and returns the new pane
	 * (issue #29). `pane.split` answers with the *new* pane
	 * (notes/herdr-api.md), which is the one the agent starts in.
	 *
	 * Returns null instead of reporting when herdr refuses, because the caller
	 * then falls back to creating a tab: the pane list behind the choice is
	 * event-driven, so it can still name a pane that closed a moment ago, and a
	 * new tab is a better answer to that than an error the user cannot act on.
	 */
	private async splitForAgent(
		folderAbsPath: string,
		target: { paneId: string; tabId: string },
	): Promise<{ tabId: string; paneId: string } | null> {
		let result: PaneResult;
		try {
			result = await this.host.request<PaneResult>('pane.split', {
				direction: 'right',
				target_pane_id: target.paneId,
				cwd: folderAbsPath,
				focus: false,
			});
		} catch (error) {
			// Not reported to the user — the caller falls back to a new tab, which
			// is a better answer than an error nobody can act on — but a refusal
			// here is worth knowing about when a split unexpectedly became a tab.
			console.warn('Herdr: pane.split for a new agent failed', error);
			return null;
		}
		const created = result.pane?.pane_id;
		if (!created) return null;
		const tabId = result.pane?.tab_id || target.tabId;
		// Only this pane will do: the tab already holds an agent, and falling back
		// to "any pane of the tab" would start a second agent on top of it.
		// A `pane.list` that never confirms it is not a reason to create a tab as
		// well: the pane exists, herdr just said so, and creating another one would
		// leave the split behind as an empty shell.
		const paneId = await this.waitForPane(tabId, created, true);
		return { tabId, paneId: paneId ?? created };
	}

	/**
	 * Polls `pane.list` until a pane of `tabId` exists, or the timeout passes.
	 * `hint` is `tab.create`'s `root_pane.pane_id` (or `pane.split`'s new pane);
	 * it is preferred when the list confirms it, so a tab that already holds
	 * several panes cannot mislead us. With `onlyHint`, nothing else is accepted.
	 */
	private async waitForPane(
		tabId: string,
		hint?: string | null,
		onlyHint = false,
	): Promise<string | null> {
		if (!tabId && hint) return hint;
		const deadline = this.host.now() + PANE_WAIT_TIMEOUT_MS;
		for (;;) {
			try {
				const result = await this.host.request<PaneListResult>('pane.list', {
					workspace_id: this.host.workspaceId(),
				});
				const panes = result.panes ?? [];
				if (hint && panes.some((pane) => pane.pane_id === hint)) return hint;
				const match = onlyHint ? undefined : panes.find((pane) => pane.tab_id === tabId);
				if (match) return match.pane_id;
			} catch (error) {
				this.reportFailure('list panes', error);
				return null;
			}
			if (this.host.now() >= deadline) return hint ?? null;
			await this.host.sleep(PANE_POLL_INTERVAL_MS);
		}
	}

	/**
	 * True when the action can run: a workspace to act in, and a path root that
	 * belongs to the machine herdr runs on. Otherwise it explains why not.
	 */
	private guard(workspaceId: string | null): workspaceId is string {
		if (!workspaceId) {
			this.host.notice(
				'Herdr: no herdr workspace matches this vault yet. Open one in herdr, or set a workspace ID in the settings.',
			);
			return false;
		}
		const issue = remoteVaultPathIssue(this.host.settings());
		if (issue) {
			this.host.notice(`Herdr: ${issue}. Set it in the plugin settings.`);
			return false;
		}
		return true;
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
