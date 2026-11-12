import type { StoredClaudeSession } from './claude/agents';
import type { UserAgentProfile } from './agents/catalog';
import type { DiscoveryResult } from './herdr/binary';
import { herdrStatusLines } from './herdr/status';
import type { RowClickAction } from './views/rowModel';
import {
	defaultRuntimeSettings,
	runtimeDisplayName,
	type RuntimeConfig,
	type RuntimeSettings,
} from './runtimes';
import {
	DEFAULT_CURSOR_STYLE,
	DEFAULT_TERMINAL_ENGINE,
	normalizeCursorStyle,
	normalizeEngineName,
	type CursorOptions,
	type TerminalCursorStyle,
	type TerminalEngine,
} from './views/renderer/TerminalRenderer';
import { DEFAULT_TOOL_GROUP_PRESENTATION, type ToolGroupPresentation } from './native/toolCalls';
import {
	DEFAULT_CONTEXT_READOUT_STYLE,
	DEFAULT_PROMPT_BOX_STYLE,
	type ContextReadoutStyle,
	type PromptBoxStyle,
} from './native/composerLook';
import { DEFAULT_PANE_VIEW, normalizePaneView, splitRenderMode, type PaneView } from './native/renderMode';
import { DEFAULT_TERMINAL_THEME, type TerminalThemeName } from './views/renderer/themes';

/**
 * The agent kinds the plugin draws a mark for (`views/kindIcons.ts`). What
 * herdr can start, and what the + menu offers, is the agent catalog's
 * (`agents/catalog.ts`, issue #125).
 */
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

/**
 * Everything the plugin stores. The registry half (`runtimes`, `activeRuntime`)
 * is `runtimes.ts`'s: which herdr, or herdr-core, on which machine, with the
 * binary, socket, remote vault path and workspace of each (ADR-0004).
 */
export interface HerdrSettings extends RuntimeSettings {
	notifications: NotificationSettings;
	/**
	 * The user's own agent CLIs (issue #125): a wrapper, another command,
	 * extra arguments. The built-ins and hc's templates are not stored.
	 */
	agentProfiles: UserAgentProfile[];
	/** Catalog entries the user hid from the + menu, by profile id. */
	hiddenAgents: string[];
	/**
	 * Each runtime's default agent, by runtime id, as a profile id. A runtime
	 * without one, or whose choice cannot start there, starts the first
	 * installed entry of its catalog. Replaces the global `defaultAgentKind`
	 * ({@link migrateDefaultAgents}).
	 */
	defaultAgents: Record<string, string>;
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
	/**
	 * How the native view's prompt box looks (issue #173): the toolbar strip
	 * divided off, joined to the text, or the whole box floating over the
	 * transcript. A class only, applied live. See `native/composerLook.ts`.
	 */
	nativePromptBoxStyle: PromptBoxStyle;
	/**
	 * How the prompt box's context readout reads (issue #173): the token
	 * counts and percentage, or a small ring with the percentage.
	 */
	nativeContextReadout: ContextReadoutStyle;
	/**
	 * How often each `/` command was picked in the native prompt box, by name
	 * (issue #149), so the popover offers the most used first. Read through
	 * `normalizeCommandUsage` (`native/commandCatalog.ts`), since a hand-edited
	 * file may hold anything here.
	 */
	commandUsage: Record<string, number>;
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
	 * pane ids keyed by the runtime id they belong to (`runtimes.ts`). Pane ids
	 * are only meaningful on the runtime that issued them, so a pin on one never
	 * touches a row on another. Client-side only: herdr knows nothing of it.
	 */
	pinnedPanes: Record<string, string[]>;
	/**
	 * The sessions each `claude` runtime started (ADR-0007), keyed by runtime
	 * id: row id, session id, cwd and name. What the agent list shows as
	 * stopped rows after a restart, and what `--resume` reopens.
	 */
	claudeSessions: Record<string, StoredClaudeSession[]>;
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
	...defaultRuntimeSettings(),
	notifications: {
		statusBar: true,
		blocked: { notice: true, os: true },
		done: { notice: true, os: false },
	},
	agentProfiles: [],
	hiddenAgents: [],
	defaultAgents: {},
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
	nativePromptBoxStyle: DEFAULT_PROMPT_BOX_STYLE,
	nativeContextReadout: DEFAULT_CONTEXT_READOUT_STYLE,
	commandUsage: {},
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
	claudeSessions: {},
};

/**
 * Keys older builds stored that this one has no setting for. Dropped on load.
 *
 * `nativeAutoAcceptPermissions` (#99, shipped in #113) let the waiting card
 * press "Allow" for a tool permission. Claude decides those itself, through its
 * permission modes, so the plugin answers none of them and the switch is gone.
 *
 * `socketPath`, `herdrBinary`, `workspaceId` and `remote` were the local herdr
 * and the one remote profile before the runtime registry (ADR-0004).
 * `migrateRuntimes` reads them into `runtimes` first; then they go.
 *
 * `defaultAgentKind` was one agent kind for every runtime before the agent
 * catalog (issue #125); `migrateDefaultAgents` reads it into each runtime's
 * default first.
 */
export const REMOVED_SETTING_KEYS: readonly string[] = [
	'nativeAutoAcceptPermissions',
	'socketPath',
	'herdrBinary',
	'workspaceId',
	'remote',
	'defaultAgentKind',
];

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
 * Where the settings tab reads the connection's state from. The plugin owns
 * the connection, so it supplies this: the state as it is now, and a way to
 * hear that it changed, so the root line and the active runtime's Status
 * group draw again.
 */
export interface ConnectionStatusSource {
	status(): ConnectionStatus;
	/** Runs the listener whenever the connection may have changed; returns what stops it. */
	onChange(listener: () => void): () => void;
}

/**
 * Whether the plugin is connected to the runtime: `connected` once the
 * connection is published and its scope primed, `connecting` while an
 * attempt or a reconnect is under way without an error, `not connected`
 * after a failure or for a kind this build cannot run.
 */
export type ConnectionState = 'connected' | 'connecting' | 'not connected';

/** One line of the status, and whether it is worth a warning. */
export interface StatusLine {
	text: string;
	warning: boolean;
}

/** The live connection state {@link connectionSummary} and {@link connectionDetails} describe. */
export interface ConnectionStatus {
	/**
	 * The runtime this is about: the published connection's snapshot, or the
	 * active runtime while none is published.
	 */
	runtime: RuntimeConfig;
	/** Why the runtime's kind cannot connect in this build, or null. */
	unavailable: string | null;
	/**
	 * The kind's own status lines, the last error included
	 * (`RuntimeKindAdapter.statusLines`), or null while it has none.
	 */
	details: readonly { text: string; warning?: boolean }[] | null;
	/** Binary and socket discovery, or null before the first connect attempt. */
	discovery: DiscoveryResult | null;
	/** The kind reports a protocol mismatch on this connection. */
	mismatch: boolean;
	/** Last connect or prime failure. */
	error: string | null;
	state: ConnectionState;
}

/**
 * The root's one line (PRD M1): which runtime is active and whether it is
 * connected, as a warning when it is not, or has an error, a protocol
 * mismatch or a kind this build cannot run. Pure, like the details.
 */
export function connectionSummary(status: ConnectionStatus): StatusLine {
	const state = status.unavailable ? 'not connected' : status.state;
	return {
		text: `Active runtime: ${runtimeDisplayName(status.runtime)} · ${state}`,
		warning: state !== 'connected' || status.error !== null || status.mismatch || status.unavailable !== null,
	};
}

/** Draws status lines into a container, a paragraph each. */
export function renderStatusLines(el: HTMLElement, lines: readonly StatusLine[]): void {
	for (const line of lines) {
		el.createEl('p', {
			cls: line.warning ? 'herdr-status-text mod-warning' : 'herdr-status-text',
			text: line.text,
		});
	}
}

/**
 * The active runtime's Status group (PRD M2, M3, M6, S5): tunnel, binary,
 * socket, server, mismatches, workspace and errors. The page is the
 * runtime's, so it is not named. The live connection only: what the
 * runtime's setup lacks or this build cannot run (a remote vault path, an
 * unavailable kind) is the page's Problems row, and is not said again here.
 * Pure: `main.ts` gathers the state and this decides what to say about it.
 */
export function connectionDetails(status: ConnectionStatus): StatusLine[] {
	const lines: StatusLine[] = [];
	const line = (text: string, warning = false): void => {
		lines.push({ text, warning });
	};
	const { discovery, runtime } = status;
	if (status.unavailable) {
		line('Not connected. Problems, below, says why.', true);
		return lines;
	}
	if (status.details) {
		for (const detail of status.details) line(detail.text, detail.warning === true);
		return lines;
	}
	// A kind that has not connected yet has nothing of its own to say: the
	// discovery layout, in herdr's words, as it always was (#185).
	return herdrStatusLines({
		runtime,
		discovery,
		socketPath: discovery?.socketPath ?? '',
		tunnel: null,
		mismatch: null,
		workspace: null,
		error: status.error,
	});
}

