/**
 * The runtime registry (ADR-0004): what the plugin can connect to, and which
 * one it is connected to now.
 *
 * A runtime is a **kind** on a **target**. The kind is `herdr`, the herdr TUI
 * multiplexer with its JSON API and `herdr terminal session` bridge,
 * `herdr-core`, the headless `hc` runtime (ADR-0005), or `claude`, Claude Code
 * processes the plugin starts itself (ADR-0007, local only). The target is `local`,
 * this machine, or `ssh`, a host reached over SSH. The settings hold a list of
 * runtimes and the id of the active one; one is active at a time (ADR-0001),
 * and switching tears the connection down and opens the next.
 *
 * The id is what everything else keys on: saved terminal tabs persist it as
 * their `endpointId`, `pinnedPanes` is keyed by it, and the connection's
 * endpoint carries it. So an id never changes once given out. The two runtimes
 * a pre-registry `data.json` described keep the ids the old code derived —
 * `local`, and `ssh:<host>:<socket>` for the configured remote — so neither
 * store has to be rewritten; a runtime added later gets a generated id that
 * survives any edit of its host or binary.
 *
 * Pure: no `obsidian` import, no plugin. What a kind *can do* is
 * `runtime/kind.ts`; this file is only the data, its migration and the
 * decisions over it, all tested in `tests/runtimes.test.ts`.
 */

/** What runs on the target. */
export type RuntimeKind = 'herdr' | 'herdr-core' | 'claude';

/** Where it runs. */
export type RuntimeTarget = 'local' | 'ssh';

export const RUNTIME_KINDS: readonly RuntimeKind[] = ['herdr', 'herdr-core', 'claude'];
export const RUNTIME_TARGETS: readonly RuntimeTarget[] = ['local', 'ssh'];

/** What the settings tab shows for a kind. Product names keep their case. */
export const RUNTIME_KIND_LABELS: Record<RuntimeKind, string> = {
	herdr: 'herdr',
	'herdr-core': 'herdr-core (hc)',
	claude: 'Claude, run by Obsidian',
};

/**
 * Whether a kind runs on an SSH host at all. The `claude` kind is the simple
 * mode for getting started, and its agents are this plugin's own child
 * processes, so it is `local` only (ADR-0007).
 */
export function kindTargets(kind: RuntimeKind): readonly RuntimeTarget[] {
	return kind === 'claude' ? ['local'] : RUNTIME_TARGETS;
}

/**
 * The permission modes a `claude` runtime can start its agents in (`claude
 * --permission-mode`, the choices its `--help` lists). `manual` asks for every
 * tool that needs a permission, which the native view's waiting card then
 * answers; it is the documented name of what Claude calls `default`
 * internally (2.1.318 maps one to the other, reports `default` in its
 * `init`, and blocks Write and Bash on `can_use_tool` the same way, measured
 * 2026-11-06; every installed build back to 2.1.270 lists it).
 * `bypassPermissions` is left out on purpose: it needs its own flag and
 * would answer every prompt for the user.
 */
export const CLAUDE_PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'manual';

/** What the settings tab shows for each permission mode. */
export const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
	manual: 'Ask (default)',
	acceptEdits: 'Accept edits',
	plan: 'Plan',
	auto: 'Auto',
	dontAsk: "Don't ask (deny what is not allowed)",
};

/**
 * A stored permission mode, or the default for anything this build does not
 * know. `default`, which earlier builds stored, is the same choice as `manual`.
 */
export function normalizePermissionMode(value: unknown): ClaudePermissionMode {
	if (value === 'default') return 'manual';
	return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value)
		? (value as ClaudePermissionMode)
		: DEFAULT_CLAUDE_PERMISSION_MODE;
}

/** What the settings tab shows for a target. */
export const RUNTIME_TARGET_LABELS: Record<RuntimeTarget, string> = {
	local: 'This machine',
	ssh: 'SSH host',
};

/** The local herdr's id, from before the registry existed and kept for good. */
export const LOCAL_RUNTIME_ID = 'local';

/** Where herdr puts its API socket unless told otherwise, on any host. */
export const DEFAULT_HERDR_SOCKET = '~/.config/herdr/herdr.sock';

/** Where the herdr installer puts the binary on a remote host. */
export const DEFAULT_REMOTE_HERDR_BINARY = '~/.local/bin/herdr';

/** One entry of the registry, as `data.json` stores it. */
export interface RuntimeConfig {
	/** Stable key: saved tabs and pins refer to it. Never derived again after creation. */
	id: string;
	/** Display name. Empty falls back to {@link runtimeDisplayName}'s derived one. */
	name: string;
	kind: RuntimeKind;
	target: RuntimeTarget;
	/** SSH destination (`user@host` or a `~/.ssh/config` alias); `ssh` only. */
	host: string;
	/**
	 * The binary. On `local`, an override for discovery, empty to search; on
	 * `ssh`, the path on the remote host, where non-interactive SSH rarely has
	 * the PATH a login shell has. Empty for herdr-core means `hc` on the PATH.
	 */
	binary: string;
	/**
	 * herdr's API socket, as the target sees it: the local server's on `local`,
	 * the one forwarded over SSH on `ssh`. herdr-core has none (ADR-0005: its
	 * transport is `hc connect`, which knows its own socket).
	 */
	socketPath: string;
	/** This vault's absolute path on the remote host; `ssh` only. */
	remoteVaultPath: string;
	/**
	 * The workspace (herdr) or space (herdr-core) to scope to. Empty means the
	 * kind's own resolution: by vault name, then by cwd under the vault.
	 */
	workspace: string;
	/**
	 * The `--permission-mode` a `claude` runtime starts its agents in; absent
	 * for every other kind, and read through {@link normalizePermissionMode}.
	 */
	permissionMode?: ClaudePermissionMode;
}

/** The two keys of the settings this module owns. */
export interface RuntimeSettings {
	runtimes: RuntimeConfig[];
	/** Id of the runtime the plugin connects to. Always one of `runtimes`. */
	activeRuntime: string;
}

/** The local herdr, as a fresh install has it. */
export function defaultLocalRuntime(): RuntimeConfig {
	return {
		id: LOCAL_RUNTIME_ID,
		name: 'Local',
		kind: 'herdr',
		target: 'local',
		host: '',
		binary: '',
		socketPath: DEFAULT_HERDR_SOCKET,
		remoteVaultPath: '',
		workspace: '',
	};
}

/** The registry a fresh install starts with: the local herdr, active. */
export function defaultRuntimeSettings(): RuntimeSettings {
	return { runtimes: [defaultLocalRuntime()], activeRuntime: LOCAL_RUNTIME_ID };
}

/**
 * The id the pre-registry code derived for its one remote profile
 * (`endpointIdOf` before ADR-0004). Kept so saved tabs and pins written by
 * that code still name the runtime the migration makes of it.
 */
export function legacySshRuntimeId(host: string, socketPath: string): string {
	return `ssh:${host.trim()}:${socketPath.trim()}`;
}

/**
 * A fresh id that collides with nothing in `taken`. Opaque, prefixed so it
 * can never be mistaken for `local` or a legacy `ssh:` id.
 */
export function newRuntimeId(taken: Iterable<string>, random: () => number = Math.random): string {
	const used = new Set(taken);
	for (;;) {
		const id = `rt-${Math.floor(random() * 36 ** 8)
			.toString(36)
			.padStart(8, '0')}`;
		if (!used.has(id)) return id;
	}
}

/**
 * A new runtime of this kind on this target, with the defaults the settings
 * tab starts its form from. The name is left empty so the derived one shows
 * until the user types their own.
 */
export function newRuntime(
	kind: RuntimeKind,
	target: RuntimeTarget,
	taken: Iterable<string>,
	random?: () => number,
): RuntimeConfig {
	const runtime: RuntimeConfig = {
		id: newRuntimeId(taken, random),
		name: '',
		kind,
		target: kindTargets(kind).includes(target) ? target : 'local',
		host: '',
		binary: defaultBinary(kind, target),
		socketPath: kind === 'herdr' ? DEFAULT_HERDR_SOCKET : '',
		remoteVaultPath: '',
		workspace: '',
	};
	if (kind === 'claude') runtime.permissionMode = DEFAULT_CLAUDE_PERMISSION_MODE;
	return runtime;
}

/** What the binary field starts at for a kind on a target. */
export function defaultBinary(kind: RuntimeKind, target: RuntimeTarget): string {
	return kind === 'herdr' && target === 'ssh' ? DEFAULT_REMOTE_HERDR_BINARY : '';
}

function isKind(value: unknown): value is RuntimeKind {
	return RUNTIME_KINDS.includes(value as RuntimeKind);
}

function isTarget(value: unknown): value is RuntimeTarget {
	return RUNTIME_TARGETS.includes(value as RuntimeTarget);
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

/**
 * One stored entry turned into a runtime, or null when it has no usable id or
 * names a kind or target this build does not know: such an entry cannot be
 * connected or drawn, and guessing what it meant would point saved tabs at the
 * wrong server. Missing string fields fall back to the kind's defaults.
 * {@link migrateRuntimes} keeps the unknown-kind ones aside rather than lose
 * them.
 */
export function normalizeRuntime(value: unknown): RuntimeConfig | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id.trim() : '';
	if (id.length === 0) return null;
	if (!isKind(record.kind) || !isTarget(record.target)) return null;
	const kind = record.kind;
	// A `claude` runtime only runs here (ADR-0007); a hand-edited `ssh` one is
	// read as the local runtime it can only be.
	const target = kindTargets(kind).includes(record.target) ? record.target : 'local';
	const runtime: RuntimeConfig = {
		id,
		name: stringOr(record.name, ''),
		kind,
		target,
		host: stringOr(record.host, ''),
		binary: stringOr(record.binary, defaultBinary(kind, target)),
		socketPath: stringOr(record.socketPath, kind === 'herdr' ? DEFAULT_HERDR_SOCKET : ''),
		remoteVaultPath: stringOr(record.remoteVaultPath, ''),
		workspace: stringOr(record.workspace, ''),
	};
	if (kind === 'claude') runtime.permissionMode = normalizePermissionMode(record.permissionMode);
	return runtime;
}

/** What {@link migrateRuntimes} makes of a stored `data.json`. */
export interface RuntimeMigration extends RuntimeSettings {
	/**
	 * True when the file held the pre-registry keys, so `loadSettings` writes
	 * the registry back once and the legacy keys go with that save. A file
	 * with neither shape (a fresh install) is not written for this.
	 */
	migrated: boolean;
	/**
	 * Stored entries this build cannot read but must not erase: an id, and a
	 * kind or target it does not know (a newer build's). Never shown or
	 * connected; `saveSettings` writes them back after the known ones.
	 */
	foreign: unknown[];
}

/** The keys the pre-registry settings stored the local herdr and the remote in. */
const LEGACY_KEYS: readonly string[] = ['socketPath', 'herdrBinary', 'workspaceId', 'remote'];

/** The pre-registry remote block, as `data.json` held it. */
interface LegacyRemote {
	enabled?: unknown;
	host?: unknown;
	remoteSocketPath?: unknown;
	remoteBinary?: unknown;
	remoteVaultPath?: unknown;
}

/**
 * The stored entry's id when it has one but names a kind or target this
 * build does not know, else null.
 */
function foreignId(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === 'string' ? record.id.trim() : '';
	if (id.length === 0) return null;
	return isKind(record.kind) && isTarget(record.target) ? null : id;
}

/**
 * The pre-registry remote profile as a runtime, or null when it has no host.
 * The old load merged the stored block over these defaults before deriving
 * the id, so a file that never stored a socket still derived it from this.
 */
function legacyRemoteRuntime(
	record: Record<string, unknown>,
	workspace: string,
): { runtime: RuntimeConfig; enabled: boolean } | null {
	const remote = (
		typeof record.remote === 'object' && record.remote !== null ? record.remote : {}
	) as LegacyRemote;
	const host = stringOr(remote.host, '').trim();
	if (host.length === 0) return null;
	const socketPath = stringOr(remote.remoteSocketPath, DEFAULT_HERDR_SOCKET);
	return {
		runtime: {
			id: legacySshRuntimeId(host, socketPath),
			name: host,
			kind: 'herdr',
			target: 'ssh',
			host,
			binary: stringOr(remote.remoteBinary, DEFAULT_REMOTE_HERDR_BINARY),
			socketPath,
			remoteVaultPath: stringOr(remote.remoteVaultPath, ''),
			workspace,
		},
		enabled: remote.enabled === true,
	};
}

/**
 * The registry from a stored `data.json` (ADR-0004).
 *
 * A file with a `runtimes` list is read as it is: entries that cannot be used
 * are dropped, duplicate ids keep their first entry, and an `activeRuntime`
 * that names none of them falls back to the first. A list that ends up empty
 * becomes the default local herdr, since the plugin always needs one to
 * connect to. Two things beside it are not lost:
 *
 * - an entry with an id and a kind or target this build does not know, a
 *   newer build's, is kept aside in `foreign` and written back by the next
 *   save, so a downgrade does not erase it;
 * - a legacy `remote` profile, which an older build writes again after a
 *   downgrade, is imported as an extra, inactive runtime when its id is not
 *   in the list yet, and the file is written back once without it.
 *
 * A file without one is the pre-registry shape, and is migrated:
 *
 * - the local herdr becomes `{id: "local", kind: herdr, target: local}`, with
 *   the old `herdrBinary` and `socketPath` as its binary and socket;
 * - a remote profile with a host becomes `{id: "ssh:<host>:<socket>", kind:
 *   herdr, target: ssh}` with its binary, socket and vault path, keeping the
 *   exact id the old code derived — on or off, a configured remote was one
 *   toolbar click away, so it stays in the list;
 * - the old global `workspaceId` goes to both, because it applied to whichever
 *   one was connected;
 * - `activeRuntime` is the remote's id when the profile was on, else `local`.
 *
 * Takes `unknown` and never throws: this reads `data.json`.
 */
export function migrateRuntimes(stored: unknown): RuntimeMigration {
	const record = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
		string,
		unknown
	>;
	const legacy = LEGACY_KEYS.some((key) => key in record);
	if (Array.isArray(record.runtimes)) {
		const runtimes: RuntimeConfig[] = [];
		const foreign: unknown[] = [];
		const seen = new Set<string>();
		for (const entry of record.runtimes) {
			const unknownId = foreignId(entry);
			if (unknownId !== null) {
				if (seen.has(unknownId)) continue;
				seen.add(unknownId);
				foreign.push(entry);
				continue;
			}
			const runtime = normalizeRuntime(entry);
			if (!runtime || seen.has(runtime.id)) continue;
			seen.add(runtime.id);
			runtimes.push(runtime);
		}
		const remote = legacyRemoteRuntime(record, stringOr(record.workspaceId, ''));
		if (remote && !seen.has(remote.runtime.id)) runtimes.push(remote.runtime);
		const active = new Set(runtimes.map((runtime) => runtime.id));
		if (runtimes.length === 0) return { ...defaultRuntimeSettings(), migrated: legacy, foreign };
		const wanted = typeof record.activeRuntime === 'string' ? record.activeRuntime : '';
		const [first] = runtimes as [RuntimeConfig, ...RuntimeConfig[]];
		return {
			runtimes,
			activeRuntime: active.has(wanted) ? wanted : first.id,
			migrated: legacy,
			foreign,
		};
	}

	const workspace = stringOr(record.workspaceId, '');
	const local: RuntimeConfig = {
		...defaultLocalRuntime(),
		binary: stringOr(record.herdrBinary, ''),
		socketPath: stringOr(record.socketPath, DEFAULT_HERDR_SOCKET),
		workspace,
	};
	const runtimes: RuntimeConfig[] = [local];
	let activeRuntime = LOCAL_RUNTIME_ID;

	const remote = legacyRemoteRuntime(record, workspace);
	if (remote) {
		runtimes.push(remote.runtime);
		if (remote.enabled) activeRuntime = remote.runtime.id;
	}
	return { runtimes, activeRuntime, migrated: legacy, foreign: [] };
}

/** The runtime with this id, or undefined when the registry has none. */
export function runtimeById(
	settings: RuntimeSettings,
	id: string,
): RuntimeConfig | undefined {
	return settings.runtimes.find((runtime) => runtime.id === id);
}

/**
 * The runtime the plugin connects to. Falls back to the first one, and to the
 * default local herdr for an empty list, so a hand-edited file can never leave
 * the plugin with nothing to connect to.
 */
export function activeRuntimeOf(settings: RuntimeSettings): RuntimeConfig {
	return (
		runtimeById(settings, settings.activeRuntime) ??
		settings.runtimes.at(0) ??
		defaultLocalRuntime()
	);
}

/**
 * A connection's runtime snapshot with the name the settings give it now.
 * The snapshot is frozen for the connection's life, so what it connects to
 * only changes on a reconnect; a rename is display only and shows at once.
 */
export function withLiveName(
	settings: RuntimeSettings,
	runtime: Readonly<RuntimeConfig>,
): RuntimeConfig {
	const live = runtimeById(settings, runtime.id);
	return { ...runtime, name: live ? live.name : runtime.name };
}

/**
 * The name a runtime is shown under: its own, or one derived from what it is
 * when the user left it empty — "Local herdr", "herdr-core on xl".
 */
export function runtimeDisplayName(runtime: RuntimeConfig): string {
	const own = runtime.name.trim();
	if (own.length > 0) return own;
	if (runtime.kind === 'claude') return RUNTIME_KIND_LABELS.claude;
	const kind = runtime.kind === 'herdr' ? 'herdr' : 'herdr-core';
	if (runtime.target === 'local') return `Local ${kind}`;
	const host = runtime.host.trim();
	return host.length > 0 ? `${kind} on ${host}` : `${kind} over SSH`;
}

/** Where a runtime runs, for status lines: `local` or `ssh <host>`. */
export function runtimeLocation(runtime: Pick<RuntimeConfig, 'target' | 'host'>): string {
	return runtime.target === 'ssh' ? `ssh ${runtime.host.trim()}` : 'local';
}

/**
 * One line under a runtime in the settings list: what it is and where.
 * "herdr on this machine", "herdr-core (hc) over SSH to xl".
 */
export function runtimeSummary(runtime: RuntimeConfig): string {
	const kind = RUNTIME_KIND_LABELS[runtime.kind];
	if (runtime.target === 'local') return `${kind} on this machine`;
	const host = runtime.host.trim();
	return host.length > 0 ? `${kind} over SSH to ${host}` : `${kind} over SSH, no host yet`;
}

/**
 * Why an `ssh` runtime cannot turn a vault folder into a remote cwd, or null
 * when it can (PRD S5, M19).
 *
 * With `remoteVaultPath` empty, path resolution would fall back to the local
 * base path and hand a macOS path to a Linux host. Refusing beats silently
 * running an agent in the wrong (or a non-existent) directory, so the folder
 * actions, the settings status and the runtime form all ask this.
 */
export function remoteVaultPathIssue(
	runtime: Pick<RuntimeConfig, 'target' | 'remoteVaultPath'>,
): string | null {
	if (runtime.target !== 'ssh') return null;
	if (runtime.remoteVaultPath.trim()) return null;
	return 'the runtime has no remote vault path, so folder paths cannot be resolved on the remote host';
}

/**
 * What is missing from a runtime before it can work, as lowercase clauses the
 * caller frames ("Herdr: …" in a notice, a sentence in the form). Empty when
 * nothing is. Whether the kind exists in this build is the kind registry's
 * question, not this one.
 */
export function runtimeIssues(runtime: RuntimeConfig): string[] {
	const issues: string[] = [];
	if (runtime.target !== 'ssh') return issues;
	if (runtime.host.trim().length === 0) issues.push('the runtime has no SSH host');
	if (runtime.kind === 'herdr') {
		if (runtime.socketPath.trim().length === 0) {
			issues.push('the runtime has no remote socket path');
		}
		if (runtime.binary.trim().length === 0) {
			issues.push('the runtime has no remote herdr binary');
		}
	}
	const vault = remoteVaultPathIssue(runtime);
	if (vault) issues.push(vault);
	return issues;
}

/** A clause from {@link runtimeIssues} as a sentence for the settings tab. */
export function issueSentence(issue: string): string {
	const trimmed = issue.trim();
	if (trimmed.length === 0) return '';
	const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** One runtime in the switcher menu. */
export interface RuntimeSwitcherEntry {
	id: string;
	name: string;
	/** The active one carries the check. */
	checked: boolean;
}

/**
 * What the agent list's toolbar button is, by how many runtimes there are
 * (ADR-0004): nothing with one, a toggle to the other with two, a menu of all
 * of them with three or more.
 */
export interface RuntimeSwitcher {
	mode: 'hidden' | 'toggle' | 'menu';
	/** A picture of where the list points: `laptop` local, `server` over SSH. */
	icon: string;
	/** Tooltip and aria-label: what a click does, not what is on. */
	label: string;
	/** The active runtime is on another machine; the button is drawn pressed. */
	remote: boolean;
	/** The runtime a toggle switches to; null unless `mode` is `toggle`. */
	next: RuntimeConfig | null;
	/** Every runtime, in settings order, the active one checked. */
	entries: RuntimeSwitcherEntry[];
}

/** The switcher for the registry as it is now. */
export function runtimeSwitcher(settings: RuntimeSettings): RuntimeSwitcher {
	const active = activeRuntimeOf(settings);
	const remote = active.target === 'ssh';
	const icon = remote ? 'server' : 'laptop';
	const entries = settings.runtimes.map((runtime) => ({
		id: runtime.id,
		name: runtimeDisplayName(runtime),
		checked: runtime.id === active.id,
	}));
	const count = settings.runtimes.length;
	if (count <= 1) {
		return { mode: 'hidden', icon, label: '', remote, next: null, entries };
	}
	if (count === 2) {
		const next = settings.runtimes.find((runtime) => runtime.id !== active.id) ?? null;
		const label = next ? `Switch to ${runtimeDisplayName(next)}` : 'Switch runtime';
		return { mode: 'toggle', icon, label, remote, next, entries };
	}
	return {
		mode: 'menu',
		icon,
		label: `Switch runtime (now ${runtimeDisplayName(active)})`,
		remote,
		next: null,
		entries,
	};
}

/**
 * Takes a runtime out of the registry, in place, with its pins. Refuses the
 * last one, which the plugin needs to connect to. Returns whether the active
 * runtime changed, so the caller knows to reconnect.
 */
export function removeRuntime(
	settings: RuntimeSettings & {
		pinnedPanes: Record<string, string[]>;
		claudeSessions?: Record<string, unknown>;
	},
	id: string,
): { removed: boolean; activeChanged: boolean } {
	if (settings.runtimes.length <= 1) return { removed: false, activeChanged: false };
	const index = settings.runtimes.findIndex((runtime) => runtime.id === id);
	if (index < 0) return { removed: false, activeChanged: false };
	settings.runtimes = settings.runtimes.filter((runtime) => runtime.id !== id);
	// The pins of a runtime that is gone can never match a row again; a new
	// runtime gets a new id, so nothing would ever bring them back.
	if (id in settings.pinnedPanes) {
		settings.pinnedPanes = { ...settings.pinnedPanes };
		delete settings.pinnedPanes[id];
	}
	// The same for a `claude` runtime's stored sessions (ADR-0007): their rows
	// belong to the runtime, and the transcripts stay where Claude keeps them.
	if (settings.claudeSessions && id in settings.claudeSessions) {
		settings.claudeSessions = { ...settings.claudeSessions };
		delete settings.claudeSessions[id];
	}
	if (settings.activeRuntime !== id) return { removed: true, activeChanged: false };
	const [first] = settings.runtimes as [RuntimeConfig, ...RuntimeConfig[]];
	settings.activeRuntime = first.id;
	return { removed: true, activeChanged: true };
}
