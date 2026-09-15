import { App, PluginSettingTab, Setting } from 'obsidian';
import type HerdrPlugin from './main';
import type { DiscoveryResult } from './herdr/binary';
import type { ProtocolMismatch } from './herdr/client';
import type { RowClickAction } from './views/rowModel';
import type { TerminalSetting } from './views/paneTerminal';
import {
	DEFAULT_CURSOR_STYLE,
	DEFAULT_TERMINAL_ENGINE,
	normalizeCursorStyle,
	normalizeEngineName,
	TERMINAL_CURSOR_STYLES,
	TERMINAL_CURSOR_STYLE_LABELS,
	TERMINAL_ENGINES,
	TERMINAL_ENGINE_LABELS,
	type CursorOptions,
	type TerminalCursorStyle,
	type TerminalEngine,
} from './views/renderer/TerminalRenderer';
import {
	DEFAULT_TOOL_GROUP_PRESENTATION,
	normalizeToolGroupPresentation,
	type ToolGroupPresentation,
} from './native/toolCalls';
import {
	DEFAULT_PANE_VIEW,
	normalizePaneView,
	PANE_VIEWS,
	PANE_VIEW_LABELS,
	splitRenderMode,
	type PaneView,
} from './native/renderMode';
import {
	DEFAULT_TERMINAL_THEME,
	TERMINAL_THEMES,
	TERMINAL_THEME_LABELS,
	normalizeThemeName,
	type TerminalThemeName,
} from './views/renderer/themes';

/** Agent kinds herdr can start. Source of truth is `agent.start --help`. */
export const AGENT_KINDS = [
	'claude',
	'codex',
	'gemini',
	'opencode',
	'pi',
	'cursor',
	'amp',
	'copilot',
	'kimi',
	'droid',
	'grok',
	'qwen',
	'muse',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** How a terminal view attaches to a herdr pane. */
export type AttachMode = 'control' | 'observe';

/**
 * Where the terminal view opens when a note from the agent's directory is open
 * (issue #28). `tab` is the pre-#28 behaviour and is used everywhere else.
 */
export type TerminalPlacement = 'split-right' | 'split-left' | 'tab';

/** The default placement: beside the note, on the side reading continues on. */
export const DEFAULT_TERMINAL_PLACEMENT: TerminalPlacement = 'split-right';

const TERMINAL_PLACEMENTS: readonly TerminalPlacement[] = ['split-right', 'split-left', 'tab'];

/**
 * Whatever `data.json` holds turned into a placement, the same contract as
 * {@link clampScrollbackMb} and `normalizeThemeName`. Worth having because the
 * old read treated everything that was not `'tab'` as a split, so a typo or a
 * value from a future version silently split a note pane in two.
 */
export function normalizeTerminalPlacement(value: unknown): TerminalPlacement {
	return TERMINAL_PLACEMENTS.includes(value as TerminalPlacement)
		? (value as TerminalPlacement)
		: DEFAULT_TERMINAL_PLACEMENT;
}

/**
 * Whether each agent gets its own terminal tab (issue #38).
 *
 * `per-agent` is the v1 behaviour: one view, one bridge and one renderer per
 * pane. `reuse` keeps a single terminal tab and switches the pane it shows,
 * which costs a restart of the bridge but holds one terminal's memory instead
 * of one per open agent (#15 measured about 5.4 MB plus a repaint loop each).
 */
export type TerminalTabMode = 'per-agent' | 'reuse';

/** One tab per agent, as before #38 existed. */
export const DEFAULT_TERMINAL_TAB: TerminalTabMode = 'per-agent';

const TERMINAL_TABS: readonly TerminalTabMode[] = ['per-agent', 'reuse'];

/** `data.json` turned into a tab mode; same contract as the normalisers above. */
export function normalizeTerminalTab(value: unknown): TerminalTabMode {
	return TERMINAL_TABS.includes(value as TerminalTabMode)
		? (value as TerminalTabMode)
		: DEFAULT_TERMINAL_TAB;
}

/**
 * What titles a terminal tab (issue #43). `agent` is the agent's display name,
 * the behaviour since #36. `tab` is the herdr tab label, which reads the same
 * as herdr's own tab bar; while a tab is shared by two agents (issue #29) the
 * agent name is appended so the two terminals stay distinguishable.
 */
export type TerminalTitleSource = 'agent' | 'tab';

/** The agent name, as before the setting existed. */
export const DEFAULT_TERMINAL_TITLE_SOURCE: TerminalTitleSource = 'agent';

const TERMINAL_TITLE_SOURCES: readonly TerminalTitleSource[] = ['agent', 'tab'];

/** `data.json` turned into a title source; same contract as the normalisers above. */
export function normalizeTerminalTitleSource(value: unknown): TerminalTitleSource {
	return TERMINAL_TITLE_SOURCES.includes(value as TerminalTitleSource)
		? (value as TerminalTitleSource)
		: DEFAULT_TERMINAL_TITLE_SOURCE;
}

/**
 * Row order in the agent list (issue #20). `priority` is herdr's own attention
 * order, so the sidebar and a herdr TUI set to `agent_panel_sort = "priority"`
 * agree; `alphabetical` is by the name a row displays.
 */
export type AgentListSort = 'priority' | 'alphabetical';

/**
 * What the agent list groups rows under (issue #20). `tab` is the herdr tab and
 * the v1 behaviour; `folder` keeps one project's agents together even when herdr
 * has spread them over two tabs; `none` is a flat list.
 */
export type AgentListGroupBy = 'tab' | 'folder' | 'none';

/** Status transitions the plugin notifies about. Others are noise (PRD M12). */
export type NotifiedTransition = 'blocked' | 'done';

export interface TransitionNotificationSettings {
	/** Show an Obsidian `Notice` on the transition. */
	notice: boolean;
	/** Show an OS notification, only while the Obsidian window is unfocused. */
	os: boolean;
}

export interface NotificationSettings {
	/** Show the status bar item with blocked/done counts. */
	statusBar: boolean;
	blocked: TransitionNotificationSettings;
	done: TransitionNotificationSettings;
}

export interface RemoteSettings {
	/** Use a remote herdr over SSH instead of the local one. */
	enabled: boolean;
	/** SSH destination, e.g. `user@host` or a `~/.ssh/config` alias. */
	host: string;
	/** Socket path of the herdr server on the remote host. */
	remoteSocketPath: string;
	/** Absolute path to the herdr binary on the remote host. */
	remoteBinary: string;
	/** Absolute path of this vault on the remote host. */
	remoteVaultPath: string;
}

export interface HerdrSettings {
	/** Unix socket of the local herdr JSON API. */
	socketPath: string;
	/** Override for the local herdr binary. Empty means auto-discovery. */
	herdrBinary: string;
	/** Workspace id override. Empty means resolve by label, then by cwd. */
	workspaceId: string;
	remote: RemoteSettings;
	notifications: NotificationSettings;
	/** Agent kind used by "Herdr: start agent here". */
	defaultAgentKind: AgentKind;
	/** Name pattern for started agents. Supports `{folder}`, `{vault}`, `{n}`. */
	agentNamePattern: string;
	/** Terminal font family. Empty follows the Obsidian monospace font. */
	terminalFontFamily: string;
	/**
	 * Terminal colour theme (issue #26). `obsidian`, the default, follows the
	 * vault's CSS variables; the other names are built-in palettes. See
	 * `views/renderer/themes.ts`.
	 */
	terminalTheme: TerminalThemeName;
	/**
	 * What a new tab shows (issue #104): a terminal, or the native Markdown view
	 * of the pane's agent session. A tab stores its own view once it switches,
	 * and follows this one until it does; see `native/renderMode.ts`.
	 */
	defaultView: PaneView;
	/**
	 * Which library draws a tab's terminal (issues #27, #104): `ghostty-web`,
	 * the default and the v1 behaviour, or `xterm.js`, the mature alternative.
	 * Applies to every terminal whatever {@link defaultView} says, so a tab in
	 * the native view comes back to the terminal this names. Before #104 this
	 * field also held `native`; {@link migrateRenderMode} splits that out.
	 */
	terminalEngine: TerminalEngine;
	/**
	 * Cursor shape in the terminal view (issue #52). `block` is both engines'
	 * own default. See `views/renderer/TerminalRenderer.ts`.
	 */
	terminalCursorStyle: TerminalCursorStyle;
	/** Whether the terminal cursor blinks (issue #52). On by default. */
	terminalCursorBlink: boolean;
	/** Terminal font size in pixels. 0 follows the Obsidian monospace size. */
	terminalFontSize: number;
	/** Megabytes of scrollback each open terminal may keep. See {@link clampScrollbackMb}. */
	terminalScrollbackMb: number;
	/**
	 * How the native view shows a turn's tool calls (issue #95): the vault
	 * changes and sources kept out of the tool group, or everything collapsed
	 * into it. See `native/toolCalls.ts`.
	 */
	nativeToolGroups: ToolGroupPresentation;
	/**
	 * Whether the native view's waiting card answers the workspace trust prompt
	 * by itself (issue #99). Off by default, and that prompt only: tool
	 * permissions are Claude's own, decided by its permission mode, and a
	 * question and plan approval are the user's. One global switch is enough
	 * because this vault is knowledge work only (native-view-design.md). See
	 * `native/waitingCard.ts`.
	 */
	nativeAutoTrustFolders: boolean;
	/** Open the terminal view after starting an agent. */
	openTerminalAfterStart: boolean;
	/**
	 * Whether "Start agent here" may split a herdr tab that already holds an
	 * agent for the same folder (issue #29). Off means every agent gets its own
	 * tab, which maps one-to-one onto how herdr itself is navigated.
	 */
	splitIntoFolderTab: boolean;
	/**
	 * How many agent panes "Start agent here" puts in one herdr tab before it
	 * opens another tab, when {@link HerdrSettings.splitIntoFolderTab} is on.
	 * See {@link clampPanesPerTab}.
	 */
	panesPerTab: number;
	/**
	 * Show the hover button on file explorer folder rows (issue #30, PRD C21).
	 * Behind a setting because it injects into undocumented explorer DOM.
	 */
	folderHoverButton: boolean;
	/** Directories appended to PATH when spawning herdr, colon separated. */
	extraPath: string;
	/** Row order inside each group of the agent list. */
	agentListSort: AgentListSort;
	/** What the agent list groups its rows under. */
	agentListGroupBy: AgentListGroupBy;
	/** Attach mode used when opening a terminal view. */
	defaultAttachMode: AttachMode;
	/** Where a terminal opens when the active note is inside the agent's cwd. */
	terminalPlacement: TerminalPlacement;
	/** One terminal tab per agent, or one tab that switches pane (issue #38). */
	terminalTab: TerminalTabMode;
	/** What titles a terminal tab: the agent name or the herdr tab label (issue #43). */
	terminalTitleSource: TerminalTitleSource;
	/**
	 * What clicking the body of an agent row does (issue #21). The row's icon
	 * button always does the other one, so this setting swaps the pair.
	 */
	agentListRowClick: RowClickAction;
	/**
	 * Rows pinned to the top of their group in the agent list (issue #35), as
	 * pane ids keyed by the endpoint id they belong to (`connection.ts`). Pane
	 * ids are only meaningful on the herdr that issued them, so a local pin
	 * never touches a remote row. Client-side only: herdr knows nothing of it.
	 */
	pinnedPanes: Record<string, string[]>;
}

/**
 * Whatever `data.json` holds turned into a pin map: string keys to lists of
 * unique, non-empty string pane ids. Anything else is dropped rather than
 * trusted, the same contract as the other normalisers here.
 */
export function normalizePinnedPanes(value: unknown): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
	for (const [endpointId, ids] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(ids)) continue;
		const clean = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
		if (clean.length > 0) result[endpointId] = clean;
	}
	return result;
}

/** Pane ids pinned on one endpoint, in the order they were pinned. Never null. */
export function pinnedPaneIds(settings: Pick<HerdrSettings, 'pinnedPanes'>, endpointId: string): string[] {
	return settings.pinnedPanes?.[endpointId] ?? [];
}

/** True when the pane is pinned on that endpoint. */
export function isPanePinned(
	settings: Pick<HerdrSettings, 'pinnedPanes'>,
	endpointId: string,
	paneId: string,
): boolean {
	return pinnedPaneIds(settings, endpointId).includes(paneId);
}

/**
 * Pins or unpins one pane on one endpoint, in place, and says whether it is
 * pinned afterwards. An endpoint left with no pins loses its key, so the stored
 * map does not accumulate empty lists for hosts that were tried once.
 */
export function togglePanePin(
	settings: Pick<HerdrSettings, 'pinnedPanes'>,
	endpointId: string,
	paneId: string,
): boolean {
	const current = pinnedPaneIds(settings, endpointId);
	const pinned = !current.includes(paneId);
	const next = pinned ? [...current, paneId] : current.filter((id) => id !== paneId);
	settings.pinnedPanes = { ...settings.pinnedPanes };
	if (next.length > 0) settings.pinnedPanes[endpointId] = next;
	else delete settings.pinnedPanes[endpointId];
	return pinned;
}

/**
 * Scrollback budget bounds, in megabytes per open terminal.
 *
 * ghostty-web's `scrollback` option is a **byte** budget for libghostty-vt's page
 * list, not a line count: measured headlessly, 10 MB holds ~5 961 lines, so
 * roughly 600 lines per megabyte, and the memory is taken from the one WebAssembly
 * memory every terminal in the window shares — which grows but never shrinks
 * (notes/memory.md). Hence a small default and a hard ceiling: 64 MB across a few
 * open terminals is already a quarter of a gigabyte that Obsidian keeps until it
 * restarts. `0` is never allowed through; it means "unlimited" and grew past 1 GB
 * in the measurement.
 */
export const MIN_SCROLLBACK_MB = 1;
export const MAX_SCROLLBACK_MB = 64;
export const DEFAULT_SCROLLBACK_MB = 10;
/** Bytes per megabyte for the budget. Decimal, because the setting is user-facing. */
export const SCROLLBACK_BYTES_PER_MB = 1_000_000;

/**
 * Whatever `data.json` holds (hand-edited, from an older version, or missing)
 * turned into an integer number of megabytes inside the supported range.
 */
export function clampScrollbackMb(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCROLLBACK_MB;
	const whole = Math.round(value);
	return Math.min(MAX_SCROLLBACK_MB, Math.max(MIN_SCROLLBACK_MB, whole));
}

/**
 * Bounds for the panes-per-tab cap (issue #29).
 *
 * The cap is a layout preference, not a grouping one: a folder's agents stay one
 * group in the agent list however herdr spread them, as long as the list groups
 * by folder (issue #20). One means "never split, always a new tab" — the
 * behaviour before this setting existed. Four is where a herdr tab stops being
 * readable at a normal window width, so nothing above it is offered.
 */
export const MIN_PANES_PER_TAB = 1;
export const MAX_PANES_PER_TAB = 4;
export const DEFAULT_PANES_PER_TAB = 2;

/**
 * Whatever `data.json` holds turned into a whole number of panes inside the
 * supported range. Anything that is not a finite number falls back to the
 * default, the same contract as {@link clampScrollbackMb}.
 */
export function clampPanesPerTab(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PANES_PER_TAB;
	const whole = Math.round(value);
	return Math.min(MAX_PANES_PER_TAB, Math.max(MIN_PANES_PER_TAB, whole));
}

/** The two cursor knobs (issue #52) as the renderer interface takes them. */
export function cursorOptions(settings: HerdrSettings): CursorOptions {
	return {
		cursorStyle: normalizeCursorStyle(settings.terminalCursorStyle),
		cursorBlink: settings.terminalCursorBlink !== false,
	};
}

/** The byte budget handed to the renderer for one terminal. */
export function scrollbackBytes(settings: HerdrSettings): number {
	return clampScrollbackMb(settings.terminalScrollbackMb) * SCROLLBACK_BYTES_PER_MB;
}

export const DEFAULT_SETTINGS: HerdrSettings = {
	socketPath: '~/.config/herdr/herdr.sock',
	herdrBinary: '',
	workspaceId: '',
	remote: {
		enabled: false,
		host: '',
		remoteSocketPath: '~/.config/herdr/herdr.sock',
		remoteBinary: '~/.local/bin/herdr',
		remoteVaultPath: '',
	},
	notifications: {
		statusBar: true,
		blocked: { notice: true, os: true },
		done: { notice: true, os: false },
	},
	defaultAgentKind: 'claude',
	agentNamePattern: '{folder}',
	terminalFontFamily: '',
	terminalTheme: DEFAULT_TERMINAL_THEME,
	defaultView: DEFAULT_PANE_VIEW,
	terminalEngine: DEFAULT_TERMINAL_ENGINE,
	terminalCursorStyle: DEFAULT_CURSOR_STYLE,
	terminalCursorBlink: true,
	terminalFontSize: 0,
	terminalScrollbackMb: DEFAULT_SCROLLBACK_MB,
	nativeToolGroups: DEFAULT_TOOL_GROUP_PRESENTATION,
	nativeAutoTrustFolders: false,
	openTerminalAfterStart: true,
	splitIntoFolderTab: true,
	panesPerTab: DEFAULT_PANES_PER_TAB,
	folderHoverButton: true,
	extraPath: '',
	agentListSort: 'priority',
	agentListGroupBy: 'tab',
	defaultAttachMode: 'control',
	terminalPlacement: DEFAULT_TERMINAL_PLACEMENT,
	terminalTab: DEFAULT_TERMINAL_TAB,
	terminalTitleSource: DEFAULT_TERMINAL_TITLE_SOURCE,
	agentListRowClick: 'terminal',
	pinnedPanes: {},
};

/**
 * Keys older builds stored that this one has no setting for. Dropped on load.
 *
 * `nativeAutoAcceptPermissions` (#99, shipped in #113) let the waiting card
 * press "Allow" for a tool permission. Claude decides those itself, through its
 * permission modes, so the plugin answers none of them and the switch is gone.
 */
export const REMOVED_SETTING_KEYS: readonly string[] = ['nativeAutoAcceptPermissions'];

/**
 * A stored `data.json` with the keys this build no longer has taken out, so
 * nothing a past version wrote survives in the settings object or is written
 * back by the next save.
 *
 * Takes `unknown` and never throws: this reads `data.json`, which may hold
 * anything, and a file that has none of them comes back as it was.
 */
export function withoutRemovedSettings(stored: unknown): Partial<HerdrSettings> {
	if (typeof stored !== 'object' || stored === null) return {};
	const kept: Record<string, unknown> = { ...stored };
	for (const key of REMOVED_SETTING_KEYS) delete kept[key];
	return kept;
}

/** The two fields the v1 render mode setting becomes, and whether it moved. */
export interface RenderModeMigration {
	defaultView: PaneView;
	terminalEngine: TerminalEngine;
	/**
	 * True when the stored file said something this build no longer stores, so
	 * `loadSettings` writes the split back once. Only the old `native` render
	 * mode sets it: every other value already means what it says, and an
	 * unreadable one has always been normalized on read rather than rewritten.
	 */
	migrated: boolean;
}

/**
 * The stored render mode (issue #92) read as a view plus an engine (#104).
 *
 * Before #104 one field, `terminalEngine`, held `ghostty-web`, `xterm.js` or
 * `native`. A file holding `native` is migrated: the view becomes native and
 * the engine goes back to the default, which is what such a vault would have
 * come back to on a switch to a terminal anyway. A file this build wrote has a
 * `defaultView` of its own and needs nothing. A file holding only an engine name
 * is also migrated, to the terminal view on that engine: it was written when
 * the terminal was the default, and the native default of 0.4.0 must not turn
 * a chosen terminal into a native view. Both keys present with the old
 * `native` in the engine is a hand-edit; the legacy value wins, because it is
 * the one that cannot survive as it stands.
 *
 * Takes `unknown`: this reads `data.json`, which may hold anything, and
 * normalises rather than throwing.
 */
export function migrateRenderMode(stored: unknown): RenderModeMigration {
	const record = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
		string,
		unknown
	>;
	const legacy = splitRenderMode(record.terminalEngine);
	if (legacy?.view === 'native') {
		return {
			defaultView: 'native',
			terminalEngine: normalizeEngineName(record.terminalEngine),
			migrated: true,
		};
	}
	// An engine name with no view beside it is a pre-#104 file: it chose a
	// terminal on that engine when the terminal was the default, and keeps it
	// now that the native view is (0.4.0). Written back once, so the choice
	// survives the next read whatever the default becomes.
	if (legacy !== null && record.defaultView === undefined) {
		return { defaultView: 'terminal', terminalEngine: legacy.engine ?? 'ghostty-web', migrated: true };
	}
	return {
		defaultView: normalizePaneView(record.defaultView),
		terminalEngine: normalizeEngineName(record.terminalEngine),
		migrated: false,
	};
}

/**
 * Why the remote profile cannot turn a vault folder into a remote cwd, or null
 * when it can (PRD S5, M19).
 *
 * With the remote profile on and `remoteVaultPath` empty, path resolution falls
 * back to the local base path, which would hand a macOS path to a Linux host.
 * Refusing beats silently running an agent in the wrong (or a non-existent)
 * directory, so both the folder actions and the settings status ask this.
 */
export function remoteVaultPathIssue(settings: HerdrSettings): string | null {
	const remote = settings.remote;
	if (!remote.enabled) return null;
	if (remote.remoteVaultPath.trim()) return null;
	return 'the remote profile has no remote vault path, so folder paths cannot be resolved on the remote host';
}

/**
 * Renders connection status at the top of the settings tab. The plugin owns the
 * connection, so it supplies this; the tab only gives it a container.
 */
export type RenderStatus = (el: HTMLElement) => void;

/** The live connection state {@link renderConnectionStatus} describes. */
export interface ConnectionStatus {
	/** Binary and socket discovery, or null before the first connect attempt. */
	discovery: DiscoveryResult | null;
	/** Socket the client actually uses; the tunnel's local end when remote. */
	socketPath: string;
	/** SSH forward state, or null when no tunnel was started. */
	tunnel: { text: string; connected: boolean } | null;
	mismatch: ProtocolMismatch | null;
	/** Scoped workspace, or null when none matches this vault. */
	workspace: { id: string; label: string | null; method: string; agentCount: number } | null;
	/** Last connect or prime failure. */
	error: string | null;
}

/**
 * The status block at the top of the settings tab (PRD M1-M3, M6, S5). Pure
 * rendering: `main.ts` gathers the state and this decides what to say about it.
 */
export function renderConnectionStatus(
	el: HTMLElement,
	settings: HerdrSettings,
	status: ConnectionStatus,
): void {
	const line = (text: string, warning = false): void => {
		el.createEl('p', {
			cls: warning ? 'herdr-status-text mod-warning' : 'herdr-status-text',
			text,
		});
	};
	const { discovery } = status;
	if (!discovery) {
		line('Not connected yet.');
		return;
	}
	const remote = settings.remote;
	if (status.tunnel) {
		line(status.tunnel.text, !status.tunnel.connected);
	} else if (remote.enabled) {
		line('SSH tunnel: not started.', true);
	}
	if (discovery.binary) {
		line(`Binary: ${discovery.binary.path} (${discovery.binary.source})`);
	} else {
		// A remote profile only needs `ssh` locally, so this is not fatal there.
		line(discovery.error ?? 'Herdr binary not found.', !remote.enabled);
		if (!remote.enabled) return;
	}
	if (remote.enabled) {
		line(`Remote terminals: ssh -T ${remote.host} ${remote.remoteBinary}`);
		// Without it the folder actions refuse rather than send a local path to
		// the remote host (see `remoteVaultPathIssue`).
		const issue = remoteVaultPathIssue(settings);
		if (issue) line(`Folder actions are off: ${issue}.`, true);
	}
	line(`Socket: ${status.socketPath}`);
	// `discovery.status` describes the *local* server. With a remote profile
	// that is the wrong machine, so the tunnel line above stands in for it.
	if (!remote.enabled) {
		const server = discovery.status;
		line(
			server
				? `Server: ${server.status}, version ${server.version ?? 'unknown'}, protocol ${server.protocol ?? 'unknown'}`
				: `Server: not reachable (${discovery.error ?? 'unknown error'})`,
			!server,
		);
	}
	if (status.mismatch) {
		line(
			`Protocol mismatch: herdr speaks ${status.mismatch.server}, this plugin was built against ${status.mismatch.expected}. Everything still works unless a method is missing.`,
			true,
		);
	}
	// The binary runs every terminal session, so an old one beside a newer
	// server is worth saying out loud (issue #87). With a remote profile the
	// local server is the wrong machine to compare against, as above.
	const binaryProtocol = discovery.identity?.protocol ?? null;
	const serverProtocol = discovery.status?.protocol ?? null;
	const binaryProtocolDiffers =
		binaryProtocol !== null && serverProtocol !== null && binaryProtocol !== serverProtocol;
	if (!remote.enabled && binaryProtocolDiffers) {
		line(
			`Binary protocol mismatch: ${discovery.binary?.path ?? 'the herdr binary'} speaks protocol ${binaryProtocol} (version ${discovery.identity?.version ?? 'unknown'}), the server speaks ${serverProtocol}. Terminal sessions run through this binary; point the binary path at the server's herdr.`,
			true,
		);
	}
	if (status.workspace) {
		const { id, label, method, agentCount } = status.workspace;
		line(`Workspace: ${label ?? id} (${id}, matched by ${method}), ${agentCount} agent panes`);
	} else {
		line('Workspace: no herdr workspace matches this vault yet.', true);
	}
	if (status.error) line(status.error, true);
}

/**
 * What a section builder may do besides write into the settings object it was
 * handed. The tab owns the plugin; a builder never sees it, so every effect a
 * control has is one of these — which is what makes a section buildable on a
 * bare container in a test (issue #85).
 */
export interface SettingsCallbacks {
	/** Persist the settings as they now are. */
	save: () => Promise<void>;
	/** Persist, then rebuild the connection from them. Connection fields only. */
	saveAndReconnect: () => Promise<void>;
	/** Render the whole tab again, for a control that shows or hides fields. */
	redisplay: () => void;
	/** Repaint every open agent list (issue #20). */
	refreshAgentList: () => void;
	/** Add or remove the file explorer's folder hover buttons (issue #30). */
	refreshFolderHoverButton: () => void;
	/** Hand one changed setting to the open terminals (issue #84). */
	applyTerminalSetting: (setting: TerminalSetting) => void;
	/** Draw every open native view again (issue #95). */
	refreshNativeViews: () => void;
}

/**
 * Socket, binary, PATH and workspace: everything the connection is rebuilt
 * from, so every field here saves and reconnects.
 */
export function buildConnectionSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Connection').setHeading();

	new Setting(containerEl)
		.setName('Socket path')
		.setDesc(
			'Unix socket of the running herdr server. Leave the default unless you start herdr with a custom socket.',
		)
		.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.socketPath)
				.setValue(settings.socketPath)
				.onChange(async (value) => {
					settings.socketPath = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Herdr binary')
		.setDesc(
			'Absolute path to the herdr executable. Leave empty to search Homebrew, /usr/local/bin, ~/.local/bin and a login-shell PATH. Set it if Obsidian was launched from the Dock and cannot find herdr.',
		)
		.addText((text) =>
			text
				.setPlaceholder('Auto-discover')
				.setValue(settings.herdrBinary)
				.onChange(async (value) => {
					settings.herdrBinary = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Extra PATH entries')
		.setDesc(
			'Colon-separated directories appended to PATH when the plugin spawns herdr, for tools your agents need.',
		)
		.addText((text) =>
			text
				.setPlaceholder('/opt/homebrew/bin:/usr/local/bin')
				.setValue(settings.extraPath)
				.onChange(async (value) => {
					settings.extraPath = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Workspace ID')
		.setDesc(
			'Pin the plugin to one herdr workspace. Leave empty to match the workspace labelled like the vault folder, then the one whose panes run inside the vault. Ids are opaque and change between servers.',
		)
		.addText((text) =>
			text
				.setPlaceholder('Auto-detect')
				.setValue(settings.workspaceId)
				.onChange(async (value) => {
					settings.workspaceId = value;
					await callbacks.saveAndReconnect();
				}),
		);
}

/**
 * The remote profile (PRD S5). The enable toggle is always here — turning the
 * profile off must stay reachable — and only the four fields under it are
 * conditional; the toggle redisplays the tab to show or hide them.
 */
export function buildRemoteSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Remote host').setHeading();

	new Setting(containerEl)
		.setName('Use a remote herdr')
		.setDesc(
			'Talk to herdr on another machine over SSH. The socket is forwarded locally and terminals are spawned through SSH.',
		)
		.addToggle((toggle) =>
			toggle.setValue(settings.remote.enabled).onChange(async (value) => {
				settings.remote.enabled = value;
				await callbacks.saveAndReconnect();
				callbacks.redisplay();
			}),
		);

	if (!settings.remote.enabled) return;

	new Setting(containerEl)
		.setName('SSH host')
		.setDesc(
			'SSH destination, for example user@host or an alias from your SSH config. Key-based login without a passphrase prompt is required.',
		)
		.addText((text) =>
			text
				.setPlaceholder('user@host')
				.setValue(settings.remote.host)
				.onChange(async (value) => {
					settings.remote.host = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Remote socket path')
		.setDesc('Socket of the herdr server on the remote host.')
		.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.remote.remoteSocketPath)
				.setValue(settings.remote.remoteSocketPath)
				.onChange(async (value) => {
					settings.remote.remoteSocketPath = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Remote herdr binary')
		.setDesc(
			'Absolute path to herdr on the remote host. Non-interactive SSH usually has a minimal PATH, so a full path is safest.',
		)
		.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.remote.remoteBinary)
				.setValue(settings.remote.remoteBinary)
				.onChange(async (value) => {
					settings.remote.remoteBinary = value;
					await callbacks.saveAndReconnect();
				}),
		);

	new Setting(containerEl)
		.setName('Remote vault path')
		.setDesc(
			'Absolute path of this vault on the remote host. Folder actions resolve note paths against it.',
		)
		.addText((text) =>
			text
				.setPlaceholder('/home/user/vault')
				.setValue(settings.remote.remoteVaultPath)
				.onChange(async (value) => {
					settings.remote.remoteVaultPath = value;
					await callbacks.saveAndReconnect();
				}),
		);
}

/** The notice and system-notification pair for one transition. */
function buildTransitionSettings(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
	transition: NotifiedTransition,
	label: string,
	when: string,
): void {
	const state = settings.notifications[transition];

	new Setting(containerEl)
		.setName(`${label}: notice`)
		.setDesc(`Show a notice in Obsidian when ${when}.`)
		.addToggle((toggle) =>
			toggle.setValue(state.notice).onChange(async (value) => {
				state.notice = value;
				await callbacks.save();
			}),
		);

	new Setting(containerEl)
		.setName(`${label}: system notification`)
		.setDesc(
			`Send a system notification when ${when} and the Obsidian window is not focused.`,
		)
		.addToggle((toggle) =>
			toggle.setValue(state.os).onChange(async (value) => {
				state.os = value;
				await callbacks.save();
			}),
		);
}

/** Status bar counts and the two transitions that can notify (PRD M7-M9). */
export function buildNotificationsSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Notifications').setHeading();

	new Setting(containerEl)
		.setName('Status bar counts')
		.setDesc(
			'Show how many agents in this vault are blocked or done, in the status bar.',
		)
		.addToggle((toggle) =>
			toggle.setValue(settings.notifications.statusBar).onChange(async (value) => {
				settings.notifications.statusBar = value;
				await callbacks.save();
			}),
		);

	buildTransitionSettings(
		containerEl,
		settings,
		callbacks,
		'blocked',
		'Blocked',
		'an agent stops and waits for you',
	);
	buildTransitionSettings(
		containerEl,
		settings,
		callbacks,
		'done',
		'Done',
		'an agent finishes its turn',
	);
}

/**
 * What "start agent here" does. The panes-per-tab cap only means something
 * while agents share a herdr tab, so the toggle above it redisplays the tab.
 */
export function buildAgentsSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Agents').setHeading();

	new Setting(containerEl)
		.setName('Default agent kind')
		.setDesc('Agent that folder actions start.')
		.addDropdown((dropdown) => {
			for (const kind of AGENT_KINDS) {
				dropdown.addOption(kind, kind);
			}
			dropdown.setValue(settings.defaultAgentKind).onChange(async (value) => {
				settings.defaultAgentKind = value as AgentKind;
				await callbacks.save();
			});
		});

	new Setting(containerEl)
		.setName('Agent name pattern')
		.setDesc(
			'Name given to new agents. {folder} is the folder the agent starts in, {vault} the vault name, {n} a counter that avoids collisions.',
		)
		.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.agentNamePattern)
				.setValue(settings.agentNamePattern)
				.onChange(async (value) => {
					settings.agentNamePattern = value;
					await callbacks.save();
				}),
		);

	new Setting(containerEl)
		.setName('Open terminal after starting an agent')
		.setDesc('Open the new agent as a terminal tab as soon as it starts.')
		.addToggle((toggle) =>
			toggle.setValue(settings.openTerminalAfterStart).onChange(async (value) => {
				settings.openTerminalAfterStart = value;
				await callbacks.save();
			}),
		);

	new Setting(containerEl)
		.setName('Share a herdr tab between agents in the same folder')
		.setDesc(
			'On: a second agent started in a folder splits that folder’s herdr tab instead of opening another tab. Off: every agent gets its own tab, matching how herdr is navigated. Group the agent list by folder to keep a folder’s agents together either way.',
		)
		.addToggle((toggle) =>
			toggle.setValue(settings.splitIntoFolderTab).onChange(async (value) => {
				settings.splitIntoFolderTab = value;
				await callbacks.save();
				// The cap below only means something while sharing is on.
				callbacks.redisplay();
			}),
		);

	if (!settings.splitIntoFolderTab) return;

	new Setting(containerEl)
		.setName('Panes per herdr tab')
		.setDesc('How many agents share one herdr tab before the next one opens a new tab.')
		.addSlider((slider) =>
			slider
				.setLimits(MIN_PANES_PER_TAB, MAX_PANES_PER_TAB, 1)
				.setValue(clampPanesPerTab(settings.panesPerTab))
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.panesPerTab = clampPanesPerTab(value);
					await callbacks.save();
				}),
		);
}

/** The folder hover button (issue #30), which is injected or removed at once. */
export function buildFileExplorerSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('File explorer').setHeading();

	new Setting(containerEl)
		.setName('Folder hover button')
		.setDesc(
			'Show a button on folder rows in the file explorer, on hover, that opens the herdr actions for that folder. The right-click menu has the same actions and is unaffected. Turn this off if an Obsidian update makes the button misbehave.',
		)
		.addToggle((toggle) =>
			toggle.setValue(settings.folderHoverButton).onChange(async (value) => {
				settings.folderHoverButton = value;
				await callbacks.save();
				callbacks.refreshFolderHoverButton();
			}),
		);
}

/** Row order, grouping and what a click does (issue #20). Each repaints the list. */
export function buildAgentListSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Agent list').setHeading();

	new Setting(containerEl)
		.setName('Sort')
		.setDesc(
			'Row order inside each group. Priority is herdr’s own: blocked first, then finished but unseen, then working, then idle, with the most recent change first among equals.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('priority', 'Priority (same as herdr)')
				.addOption('alphabetical', 'Alphabetical by name')
				.setValue(settings.agentListSort)
				.onChange(async (value) => {
					settings.agentListSort = value as AgentListSort;
					await callbacks.save();
					callbacks.refreshAgentList();
				}),
		);

	new Setting(containerEl)
		.setName('Group by')
		.setDesc(
			'What rows are grouped under. Folder keeps a project’s agents together when herdr has spread them over several tabs.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('tab', 'Herdr tab')
				.addOption('folder', 'Working directory')
				.addOption('none', 'Nothing, one flat list')
				.setValue(settings.agentListGroupBy)
				.onChange(async (value) => {
					settings.agentListGroupBy = value as AgentListGroupBy;
					await callbacks.save();
					callbacks.refreshAgentList();
				}),
		);

	new Setting(containerEl)
		.setName('Clicking an agent row')
		.setDesc(
			'What a click on the row itself does. The icon button on the row always does the other one, and its tooltip says which.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('terminal', 'Opens the terminal in Obsidian')
				.addOption('focus', 'Focuses the pane in herdr')
				.setValue(settings.agentListRowClick)
				.onChange(async (value) => {
					settings.agentListRowClick = value as RowClickAction;
					await callbacks.save();
					callbacks.refreshAgentList();
				}),
		);
}

/**
 * The terminal view. Everything an open terminal can be told about goes through
 * `applyTerminalSetting`, which names the setting and lets the effect matrix
 * (issue #84) decide what that costs; the first three settings here are read at
 * the next open instead, so they only save.
 */
export function buildTerminalSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Terminal').setHeading();

	new Setting(containerEl)
		.setName('Attach mode')
		.setDesc(
			'Control types into the agent and makes the herdr pane follow this window’s size while the view is open; closing it hands ownership back. Observe is read-only and leaves the pane alone.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('control', 'Control (type and resize)')
				.addOption('observe', 'Observe (read-only)')
				.setValue(settings.defaultAttachMode)
				.onChange(async (value) => {
					settings.defaultAttachMode = value as AttachMode;
					await callbacks.save();
				}),
		);

	new Setting(containerEl)
		.setName('Terminal placement')
		.setDesc(
			'Where a terminal opens when the note you are looking at lives inside the agent’s working directory. Otherwise, and when that terminal is already open, nothing splits: the existing tab is revealed.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('split-right', 'Split to the right of the note')
				.addOption('split-left', 'Split to the left of the note')
				.addOption('tab', 'Always a new tab')
				.setValue(normalizeTerminalPlacement(settings.terminalPlacement))
				.onChange(async (value) => {
					settings.terminalPlacement = normalizeTerminalPlacement(value);
					await callbacks.save();
				}),
		);

	new Setting(containerEl)
		.setName('Terminal tab')
		.setDesc(
			'One terminal tab per agent, or a single tab that switches to whichever agent you open. Reusing one tab keeps a single terminal in memory instead of one per open agent — roughly five megabytes and a repaint loop each — at the cost of reconnecting the bridge on every switch.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('per-agent', 'One tab per agent')
				.addOption('reuse', 'Reuse one tab')
				.setValue(normalizeTerminalTab(settings.terminalTab))
				.onChange(async (value) => {
					settings.terminalTab = normalizeTerminalTab(value);
					await callbacks.save();
				}),
		);

	new Setting(containerEl)
		.setName('Terminal tab title')
		.setDesc(
			'What names a terminal tab. Agent name is the name the agent list shows. Herdr tab label is the label of the herdr tab the agent runs in, as in herdr’s own tab bar; while a tab is shared by two agents the agent name is appended. Open terminals retitle at once.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('agent', 'Agent name')
				.addOption('tab', 'Herdr tab label')
				.setValue(normalizeTerminalTitleSource(settings.terminalTitleSource))
				.onChange(async (value) => {
					settings.terminalTitleSource = normalizeTerminalTitleSource(value);
					await callbacks.save();
					callbacks.applyTerminalSetting('terminalTitleSource');
				}),
		);

	new Setting(containerEl)
		.setName('Theme')
		.setDesc(
			'Colours for the terminal view. Follow Obsidian takes them from the vault’s theme and follows it when you switch; the others are fixed palettes. Open terminals repaint immediately.',
		)
		.addDropdown((dropdown) => {
			for (const name of TERMINAL_THEMES) {
				dropdown.addOption(name, TERMINAL_THEME_LABELS[name]);
			}
			dropdown
				.setValue(normalizeThemeName(settings.terminalTheme))
				.onChange(async (value) => {
					settings.terminalTheme = normalizeThemeName(value);
					await callbacks.save();
					callbacks.applyTerminalSetting('terminalTheme');
				});
		});

	new Setting(containerEl)
		.setName('Default view')
		.setDesc(
			'What a tab shows until it chooses for itself. A terminal, or the native view, which shows the pane’s agent session as Markdown with a prompt box and is offered for local panes only. Each tab keeps its own choice, switched from its header button or its tab menu; open tabs that never chose follow this one and are rebuilt on change.',
		)
		.addDropdown((dropdown) => {
			for (const view of PANE_VIEWS) {
				dropdown.addOption(view, PANE_VIEW_LABELS[view]);
			}
			dropdown.setValue(normalizePaneView(settings.defaultView)).onChange(async (value) => {
				settings.defaultView = normalizePaneView(value);
				await callbacks.save();
				callbacks.applyTerminalSetting('defaultView');
			});
		});

	new Setting(containerEl)
		.setName('Terminal engine')
		.setDesc(
			'Which library draws a terminal. Ghostty web is the default and repaints a canvas continuously; xterm.js draws into the DOM and only repaints changed rows. Applies to every tab showing a terminal, whatever the default view is. Open terminals are rebuilt on change, so their scrollback is replayed as plain text and colours from before the switch are lost.',
		)
		.addDropdown((dropdown) => {
			for (const name of TERMINAL_ENGINES) {
				dropdown.addOption(name, TERMINAL_ENGINE_LABELS[name]);
			}
			dropdown.setValue(normalizeEngineName(settings.terminalEngine)).onChange(async (value) => {
				settings.terminalEngine = normalizeEngineName(value);
				await callbacks.save();
				callbacks.applyTerminalSetting('terminalEngine');
			});
		});

	new Setting(containerEl)
		.setName('Cursor style')
		.setDesc('Shape of the terminal cursor. Applies to open terminals immediately.')
		.addDropdown((dropdown) => {
			for (const style of TERMINAL_CURSOR_STYLES) {
				dropdown.addOption(style, TERMINAL_CURSOR_STYLE_LABELS[style]);
			}
			dropdown
				.setValue(normalizeCursorStyle(settings.terminalCursorStyle))
				.onChange(async (value) => {
					settings.terminalCursorStyle = normalizeCursorStyle(value);
					await callbacks.save();
					callbacks.applyTerminalSetting('terminalCursorStyle');
				});
		});

	new Setting(containerEl)
		.setName('Blinking cursor')
		.setDesc('Blink the terminal cursor. Applies to open terminals immediately.')
		.addToggle((toggle) =>
			toggle.setValue(settings.terminalCursorBlink !== false).onChange(async (value) => {
				settings.terminalCursorBlink = value;
				await callbacks.save();
				callbacks.applyTerminalSetting('terminalCursorBlink');
			}),
		);

	new Setting(containerEl)
		.setName('Font family')
		.setDesc(
			'Font for the terminal view. Leave empty to follow the Obsidian monospace font.',
		)
		.addText((text) =>
			text
				.setPlaceholder('Follow Obsidian')
				.setValue(settings.terminalFontFamily)
				.onChange(async (value) => {
					settings.terminalFontFamily = value;
					await callbacks.save();
					// A `next-mount` row in the matrix: open terminals keep the
					// font they were built with, and the next mount reads this.
					callbacks.applyTerminalSetting('terminalFontFamily');
				}),
		);

	new Setting(containerEl)
		.setName('Scrollback memory budget')
		.setDesc(
			'Megabytes of scrollback each open terminal keeps. This is a memory budget, not a line count: roughly 600 lines per megabyte. The memory is shared by every open terminal and is only given back when Obsidian restarts.',
		)
		.addSlider((slider) =>
			slider
				.setLimits(MIN_SCROLLBACK_MB, MAX_SCROLLBACK_MB, 1)
				.setValue(clampScrollbackMb(settings.terminalScrollbackMb))
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.terminalScrollbackMb = clampScrollbackMb(value);
					await callbacks.save();
					callbacks.applyTerminalSetting('terminalScrollbackMb');
				}),
		);

	new Setting(containerEl)
		.setName('Font size')
		.setDesc(
			'Terminal font size in pixels. Set to 0 to follow the Obsidian monospace size.',
		)
		.addSlider((slider) =>
			slider
				.setLimits(0, 32, 1)
				.setValue(settings.terminalFontSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.terminalFontSize = value;
					await callbacks.save();
					callbacks.applyTerminalSetting('terminalFontSize');
				}),
		);
}

/**
 * The native view (issues #95, #99): how much of a turn's tool calls the view
 * folds away, and whether the waiting card answers the workspace trust prompt
 * by itself. The first changes nothing a view holds, only how it reads, so a
 * change redraws the open native views; the second is read per block, so an
 * open view picks it up at the next one.
 */
export function buildNativeViewSection(
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
): void {
	new Setting(containerEl).setName('Native view').setHeading();

	new Setting(containerEl)
		.setName('Tool groups')
		.setDesc(
			'What a turn\u2019s tool calls look like. Highlighting keeps the notes the agent changed and the sources it read in the text, at the point it used them, and leaves the rest inside the collapsed group. Collapsing puts every call inside it.',
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOption('highlight', 'Highlight vault changes and sources')
				.addOption('collapse', 'Collapse everything')
				.setValue(normalizeToolGroupPresentation(settings.nativeToolGroups))
				.onChange(async (value) => {
					settings.nativeToolGroups = normalizeToolGroupPresentation(value);
					await callbacks.save();
					callbacks.refreshNativeViews();
				}),
		);

	new Setting(containerEl)
		.setName('Trust new folders automatically')
		.setDesc(
			'Answer the workspace trust prompt from the native view, so a fresh agent in a new folder starts without a trip to the terminal. Nothing else is answered for you: tool permissions are Claude\u2019s own, and questions and plan approval are yours. Off by default.',
		)
		.addToggle((toggle) =>
			toggle.setValue(settings.nativeAutoTrustFolders === true).onChange(async (value) => {
				settings.nativeAutoTrustFolders = value;
				await callbacks.save();
				// The card on screen was drawn from the setting as it was, and a
				// card is what a blocked pane shows until the block is over: without
				// the redraw the switch would only reach the block after this one.
				callbacks.refreshNativeViews();
			}),
		);
}

/**
 * The order the sections are rendered in. One entry per builder, so adding a
 * section is adding a builder and a line here.
 */
export const SETTINGS_SECTIONS: readonly ((
	containerEl: HTMLElement,
	settings: HerdrSettings,
	callbacks: SettingsCallbacks,
) => void)[] = [
	buildConnectionSection,
	buildRemoteSection,
	buildNotificationsSection,
	buildAgentsSection,
	buildFileExplorerSection,
	buildAgentListSection,
	buildTerminalSection,
	buildNativeViewSection,
];

/**
 * The settings tab: the status block, then every section in order. The tab is
 * the only thing here that knows the plugin — it turns it into the callback
 * bundle the builders take.
 */
export class HerdrSettingTab extends PluginSettingTab {
	private readonly plugin: HerdrPlugin;
	private readonly renderStatus: RenderStatus;

	constructor(app: App, plugin: HerdrPlugin, renderStatus: RenderStatus) {
		super(app, plugin);
		this.plugin = plugin;
		this.renderStatus = renderStatus;
	}

	private callbacks(): SettingsCallbacks {
		const { plugin } = this;
		return {
			save: () => plugin.saveSettings(),
			/** For connection fields: save, then rebuild the connection from them. */
			saveAndReconnect: async () => {
				await plugin.saveSettings();
				plugin.scheduleReconnect();
			},
			redisplay: () => this.display(),
			refreshAgentList: () => plugin.refreshAgentList(),
			refreshFolderHoverButton: () => plugin.refreshFolderHoverButton(),
			applyTerminalSetting: (setting) => plugin.applyTerminalSetting(setting),
			refreshNativeViews: () => plugin.refreshNativeViews(),
		};
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		const callbacks = this.callbacks();

		containerEl.empty();

		this.renderStatus(containerEl.createDiv({ cls: 'herdr-settings-status' }));

		for (const section of SETTINGS_SECTIONS) section(containerEl, settings, callbacks);
	}
}
