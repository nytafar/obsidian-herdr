/* eslint-disable */
/**
 * GENERATED FILE — do not edit. Run `npm run gen:types` (PRD N3).
 * Source: `herdr api schema --json` from herdr 0.8.0.
 * Protocol 19, schema version 1.
 *
 * Unknown fields are tolerated at runtime: these types describe what the
 * server promised at generation time, never what a newer server may add.
 */

/** herdr JSON API protocol number this bundle was generated against. */
export const HERDR_PROTOCOL = 19;
/** `schema_version` of the schema document used for generation. */
export const HERDR_SCHEMA_VERSION = 1;
/** herdr build the schema was read from. Informational only. */
export const HERDR_SCHEMA_SOURCE_VERSION = 'herdr 0.8.0';

export interface AgentInfo {
	agent?: string | null;
	agent_session?: AgentSessionInfo | null;
	agent_status: AgentStatus;
	cwd?: string | null;
	display_agent?: string | null;
	focused: boolean;
	foreground_cwd?: string | null;
	interactive_ready?: boolean;
	launch_pending?: boolean;
	name?: string | null;
	pane_id: string;
	revision: number;
	screen_detection_skipped?: boolean;
	state_change_seq?: number;
	state_labels?: Record<string, string>;
	tab_id: string;
	terminal_id: string;
	terminal_title?: string | null;
	terminal_title_stripped?: string | null;
	title?: string | null;
	tokens?: Record<string, string>;
	workspace_id: string;
}

export interface AgentManifestInfo {
	active_version?: string | null;
	agent: string;
	cached_remote_version?: string | null;
	local_override_shadowing_remote: boolean;
	remote_last_checked_unix?: number | null;
	remote_update_error?: string | null;
	remote_update_result?: string | null;
	source: string;
	source_kind: string;
	warning?: string | null;
}

export interface AgentPromptParams {
	target: string;
	text: string;
	wait?: AgentPromptWaitOptions | null;
}

export interface AgentPromptWaitOptions {
	timeout_ms?: number | null;
	until?: AgentStatus[];
}

export interface AgentReadParams {
	format?: ReadFormat;
	lines?: number | null;
	source: ReadSource;
	strip_ansi?: boolean;
	target: string;
}

export interface AgentRenameParams {
	name?: string | null;
	target: string;
}

export interface AgentSendKeysParams {
	keys: string[];
	target: string;
}

export interface AgentSessionInfo {
	agent: string;
	kind: AgentSessionRefKind;
	source: string;
	value: string;
}

export type AgentSessionRefKind = 'id' | 'path';

export interface AgentStartParams {
	args?: string[];
	kind: string;
	name: string;
	pane_id: string;
	timeout_ms?: number | null;
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentTarget {
	target: string;
}

export type AgentViewBuiltinField = 'status' | 'workspace_id' | 'tab_id' | 'pane_id' | 'agent' | 'seen' | 'state_change_seq';

export type AgentViewBuiltinSortField = 'workspace_order' | 'tab_order' | 'pane_order' | 'attention' | 'status' | 'agent' | 'seen' | 'state_change_seq';

export interface AgentViewClearParams {
	source?: string | null;
}

export type AgentViewContext = 'current_workspace_id' | 'current_tab_id';

export type AgentViewField = 
	| AgentViewBuiltinField
	| {
	token: string;
};

export type AgentViewFilter = 
	| {
	filters: AgentViewFilter[];
	op: 'all';
}
	| {
	filters: AgentViewFilter[];
	op: 'any';
}
	| {
	filter: AgentViewFilter;
	op: 'not';
}
	| {
	field: AgentViewField;
	op: 'eq';
	value: AgentViewValue;
}
	| {
	field: AgentViewField;
	op: 'in';
	values: AgentViewValue[];
}
	| {
	field: AgentViewField;
	op: 'exists';
};

export interface AgentViewSetParams {
	filter?: AgentViewFilter | null;
	label?: string | null;
	sort?: AgentViewSort[];
	source: string;
}

export interface AgentViewSort {
	field: AgentViewSortField;
	order?: AgentViewSortOrder;
}

export type AgentViewSortField = 
	| AgentViewBuiltinSortField
	| {
	token: string;
};

export type AgentViewSortOrder = 'asc' | 'desc';

export type AgentViewValue = 
	| string
	| boolean
	| number
	| {
	context: AgentViewContext;
};

export interface AgentWaitParams {
	target: string;
	timeout_ms?: number | null;
	until?: AgentStatus[];
}

export type ClientWindowTitleReason = 'set' | 'cleared' | 'no_foreground_client';

export interface ClientWindowTitleSetParams {
	title: string;
}

export type ConfigReloadStatus = 'applied' | 'partial' | 'failed';

export type EmptyParams = Record<string, unknown>;

export interface ErrorBody {
	code: string;
	message: string;
}

export type EventData = 
	| {
	type: 'workspace_created';
	workspace: WorkspaceInfo;
}
	| {
	type: 'workspace_updated';
	workspace: WorkspaceInfo;
}
	| {
	type: 'workspace_metadata_updated';
	workspace: WorkspaceInfo;
}
	| {
	type: 'workspace_closed';
	workspace?: WorkspaceInfo | null;
	workspace_id: string;
}
	| {
	label: string;
	type: 'workspace_renamed';
	workspace_id: string;
}
	| {
	insert_index: number;
	type: 'workspace_moved';
	workspace_id: string;
	workspaces: WorkspaceInfo[];
}
	| {
	before_workspace_id?: string | null;
	type: 'workspace_reordered';
	workspace_ids: string[];
	workspaces: WorkspaceInfo[];
}
	| {
	type: 'workspace_focused';
	workspace_id: string;
}
	| {
	type: 'worktree_created';
	workspace: WorkspaceInfo;
	worktree: WorktreeInfo;
}
	| {
	already_open: boolean;
	type: 'worktree_opened';
	workspace: WorkspaceInfo;
	worktree: WorktreeInfo;
}
	| {
	forced: boolean;
	type: 'worktree_removed';
	workspace?: WorkspaceInfo | null;
	workspace_id: string;
	worktree: WorktreeInfo;
}
	| {
	tab: TabInfo;
	type: 'tab_created';
}
	| {
	tab_id: string;
	type: 'tab_closed';
	workspace_id: string;
}
	| {
	label: string;
	tab_id: string;
	type: 'tab_renamed';
	workspace_id: string;
}
	| {
	insert_index: number;
	tab_id: string;
	tabs: TabInfo[];
	type: 'tab_moved';
	workspace_id: string;
}
	| {
	tab_id: string;
	type: 'tab_focused';
	workspace_id: string;
}
	| {
	pane: PaneInfo;
	type: 'pane_created';
}
	| {
	pane_id: string;
	type: 'pane_closed';
	workspace_id: string;
}
	| {
	pane: PaneInfo;
	type: 'pane_updated';
}
	| {
	pane_id: string;
	type: 'pane_focused';
	workspace_id: string;
}
	| {
	closed_tab_id?: string | null;
	closed_workspace_id?: string | null;
	created_tab?: TabInfo | null;
	created_workspace?: WorkspaceInfo | null;
	pane: PaneInfo;
	previous_pane_id: string;
	previous_tab_id: string;
	previous_workspace_id: string;
	type: 'pane_moved';
}
	| {
	pane_id: string;
	revision: number;
	type: 'pane_output_changed';
	workspace_id: string;
}
	| {
	pane_id: string;
	type: 'pane_exited';
	workspace_id: string;
}
	| {
	agent?: string | null;
	final_status?: AgentStatus | null;
	pane_id: string;
	released?: boolean;
	type: 'pane_agent_detected';
	workspace_id: string;
}
	| {
	agent?: string | null;
	agent_status: AgentStatus;
	display_agent?: string | null;
	pane_id: string;
	state_labels?: Record<string, string>;
	title?: string | null;
	type: 'pane_agent_status_changed';
	workspace_id: string;
}
	| {
	layout: PaneLayoutSnapshot;
	type: 'layout_updated';
};

export interface EventEnvelope {
	data: EventData;
	event: EventKind;
}

export type EventKind = 'workspace_created' | 'workspace_updated' | 'workspace_metadata_updated' | 'workspace_closed' | 'workspace_renamed' | 'workspace_moved' | 'workspace_reordered' | 'workspace_focused' | 'worktree_created' | 'worktree_opened' | 'worktree_removed' | 'tab_created' | 'tab_closed' | 'tab_renamed' | 'tab_moved' | 'tab_focused' | 'pane_created' | 'pane_closed' | 'pane_updated' | 'pane_focused' | 'pane_moved' | 'pane_output_changed' | 'pane_exited' | 'pane_agent_detected' | 'pane_agent_status_changed' | 'layout_updated';

export type EventMatch = 
	| {
	event: 'workspace_created';
	workspace_id?: string | null;
}
	| {
	event: 'workspace_updated';
	workspace_id: string;
}
	| {
	event: 'workspace_closed';
	workspace_id: string;
}
	| {
	event: 'workspace_renamed';
	label?: string | null;
	workspace_id: string;
}
	| {
	event: 'workspace_moved';
	workspace_id: string;
}
	| {
	event: 'workspace_focused';
	workspace_id: string;
}
	| {
	event: 'tab_created';
	tab_id?: string | null;
	workspace_id?: string | null;
}
	| {
	event: 'tab_closed';
	tab_id: string;
}
	| {
	event: 'tab_renamed';
	label?: string | null;
	tab_id: string;
}
	| {
	event: 'tab_moved';
	tab_id: string;
}
	| {
	event: 'tab_focused';
	tab_id: string;
}
	| {
	event: 'pane_created';
	pane_id?: string | null;
	workspace_id?: string | null;
}
	| {
	event: 'pane_closed';
	pane_id: string;
}
	| {
	event: 'pane_focused';
	pane_id: string;
}
	| {
	event: 'pane_moved';
	pane_id: string;
}
	| {
	event: 'pane_output_changed';
	min_revision?: number | null;
	pane_id: string;
}
	| {
	event: 'pane_exited';
	pane_id: string;
}
	| {
	agent?: string | null;
	event: 'pane_agent_detected';
	pane_id: string;
}
	| {
	agent_status: AgentStatus;
	event: 'pane_agent_status_changed';
	pane_id: string;
};

export interface EventsSubscribeParams {
	subscriptions: Subscription[];
}

export interface EventsWaitParams {
	match_event: EventMatch;
	timeout_ms?: number | null;
}

export interface InstalledPluginInfo {
	actions?: PluginManifestAction[];
	build?: PluginManifestBuild[];
	description?: string | null;
	enabled: boolean;
	events?: PluginManifestEventHook[];
	link_handlers?: PluginManifestLinkHandler[];
	manifest_path: string;
	min_herdr_version?: string;
	name: string;
	panes?: PluginManifestPane[];
	platforms?: PluginPlatform[] | null;
	plugin_id: string;
	plugin_root: string;
	source?: PluginSourceInfo;
	startup?: PluginManifestStartup[];
	version: string;
	warnings?: string[];
}

export interface IntegrationInstallParams {
	target: IntegrationTarget;
}

export interface IntegrationInstallResult {
	messages: string[];
}

export type IntegrationTarget = 'pi' | 'omp' | 'claude' | 'codex' | 'copilot' | 'devin' | 'droid' | 'kimi' | 'opencode' | 'kilo' | 'hermes' | 'qodercli' | 'cursor' | 'mastracode' | 'antigravity_cli' | 'grok';

export interface IntegrationUninstallParams {
	target: IntegrationTarget;
}

export interface IntegrationUninstallResult {
	messages: string[];
}

export interface LayoutApplyParams {
	focus?: boolean;
	root: LayoutNode;
	tab_id?: string | null;
	tab_label?: string | null;
	workspace_id?: string | null;
}

export interface LayoutDescription {
	focused_pane_id: string;
	root: LayoutNode;
	tab_id: string;
	workspace_id: string;
	zoomed: boolean;
}

export interface LayoutExportParams {
	pane_id?: string | null;
	tab_id?: string | null;
}

export type LayoutNode = 
	| {
	command?: string[] | null;
	cwd?: string | null;
	env?: Record<string, string>;
	label?: string | null;
	pane_id?: string | null;
	type: 'pane';
}
	| {
	direction: SplitDirection;
	first: LayoutNode;
	ratio: number;
	second: LayoutNode;
	type: 'split';
};

export interface LayoutSetSplitRatioParams {
	pane_id?: string | null;
	path: boolean[];
	ratio: number;
	tab_id?: string | null;
}

export interface NotificationShowParams {
	body?: string | null;
	position?: ToastHerdrPosition | null;
	sound?: NotificationShowSound;
	title: string;
}

export type NotificationShowReason = 'shown' | 'disabled' | 'rate_limited' | 'no_foreground_client' | 'busy';

export type NotificationShowSound = 'none' | 'done' | 'request';

export type OutputMatch = 
	| {
	type: 'substring';
	value: string;
}
	| {
	type: 'regex';
	value: string;
};

export type PaneAgentState = 'idle' | 'working' | 'blocked' | 'unknown';

export interface PaneAgentStatusChangedEvent {
	agent?: string | null;
	agent_status: AgentStatus;
	display_agent?: string | null;
	pane_id: string;
	state_labels?: Record<string, string>;
	title?: string | null;
	workspace_id: string;
}

export interface PaneClearAgentAuthorityParams {
	pane_id: string;
	seq?: number | null;
	source?: string | null;
}

export interface PaneCurrentParams {
	caller_pane_id?: string | null;
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export interface PaneEdgesParams {
	pane_id?: string | null;
}

export interface PaneEdgesResult {
	down: boolean;
	layout: PaneLayoutSnapshot;
	left: boolean;
	pane_id: string;
	right: boolean;
	up: boolean;
}

export interface PaneFocusDirectionParams {
	direction: PaneDirection;
	pane_id?: string | null;
}

export type PaneFocusDirectionReason = 'no_neighbor';

export interface PaneFocusDirectionResult {
	changed: boolean;
	focused_pane_id?: string | null;
	layout: PaneLayoutSnapshot;
	reason?: PaneFocusDirectionReason | null;
	source_pane_id: string;
}

export interface PaneGraphicsClearParams {
	pane_id: string;
}

export type PaneGraphicsFormat = 'png' | 'rgb' | 'rgba';

export interface PaneGraphicsPlacementParams {
	grid_cols?: number;
	grid_rows?: number;
	viewport_col?: number;
	viewport_row?: number;
}

export interface PaneGraphicsSetParams {
	data_base64?: string;
	format: PaneGraphicsFormat;
	image_height: number;
	image_width: number;
	pane_id: string;
	placement?: PaneGraphicsPlacementParams;
}

export interface PaneInfo {
	agent?: string | null;
	agent_session?: AgentSessionInfo | null;
	agent_status: AgentStatus;
	cwd?: string | null;
	display_agent?: string | null;
	focused: boolean;
	foreground_cwd?: string | null;
	label?: string | null;
	pane_id: string;
	revision: number;
	scroll?: PaneScrollInfo | null;
	state_labels?: Record<string, string>;
	tab_id: string;
	terminal_id: string;
	terminal_title?: string | null;
	terminal_title_stripped?: string | null;
	title?: string | null;
	tokens?: Record<string, string>;
	workspace_id: string;
}

export interface PaneLayoutPane {
	focused: boolean;
	pane_id: string;
	rect: PaneLayoutRect;
}

export interface PaneLayoutParams {
	pane_id?: string | null;
}

export interface PaneLayoutRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface PaneLayoutSnapshot {
	area: PaneLayoutRect;
	focused_pane_id: string;
	panes: PaneLayoutPane[];
	splits: PaneLayoutSplit[];
	tab_id: string;
	workspace_id: string;
	zoomed: boolean;
}

export interface PaneLayoutSplit {
	direction: SplitDirection;
	id: string;
	ratio: number;
	rect: PaneLayoutRect;
}

export interface PaneListParams {
	workspace_id?: string | null;
}

export type PaneMoveDestination = 
	| {
	ratio?: number | null;
	split: SplitDirection;
	tab_id: string;
	target_pane_id?: string | null;
	type: 'tab';
}
	| {
	label?: string | null;
	type: 'new_tab';
	workspace_id?: string | null;
}
	| {
	label?: string | null;
	tab_label?: string | null;
	type: 'new_workspace';
};

export interface PaneMoveParams {
	destination: PaneMoveDestination;
	focus?: boolean;
	pane_id: string;
}

export type PaneMoveReason = 'same_tab' | 'zoomed_tab';

export interface PaneMoveResult {
	changed: boolean;
	closed_tab_id?: string | null;
	closed_workspace_id?: string | null;
	created_tab?: TabInfo | null;
	created_workspace?: WorkspaceInfo | null;
	focused_pane_id: string;
	pane: PaneInfo;
	previous_pane_id: string;
	previous_tab_id: string;
	previous_workspace_id: string;
	reason?: PaneMoveReason | null;
	source_layout?: PaneLayoutSnapshot | null;
	target_layout: PaneLayoutSnapshot;
}

export interface PaneNeighborParams {
	direction: PaneDirection;
	pane_id?: string | null;
}

export interface PaneNeighborResult {
	direction: PaneDirection;
	layout: PaneLayoutSnapshot;
	neighbor_pane_id?: string | null;
	pane_id: string;
}

export interface PaneOutputMatchedEvent {
	matched_line: string;
	pane_id: string;
	read: PaneReadResult;
}

export interface PaneProcessInfo {
	foreground_process_group_id?: number | null;
	foreground_processes?: PaneProcessInfoProcess[];
	pane_id: string;
	shell_pid?: number | null;
	tty?: string | null;
}

export interface PaneProcessInfoParams {
	pane_id?: string | null;
}

export interface PaneProcessInfoProcess {
	argv?: string[] | null;
	argv0?: string | null;
	cmdline?: string | null;
	cwd?: string | null;
	name: string;
	pid: number;
}

export interface PaneReadParams {
	format?: ReadFormat;
	lines?: number | null;
	pane_id: string;
	source: ReadSource;
	strip_ansi?: boolean;
}

export interface PaneReadResult {
	format: ReadFormat;
	pane_id: string;
	revision: number;
	source: ReadSource;
	tab_id: string;
	text: string;
	truncated: boolean;
	workspace_id: string;
}

export interface PaneReleaseAgentParams {
	agent: string;
	pane_id: string;
	seq?: number | null;
	source: string;
}

export interface PaneRenameParams {
	label?: string | null;
	pane_id: string;
}

export interface PaneReportAgentParams {
	agent: string;
	agent_session_id?: string | null;
	agent_session_path?: string | null;
	message?: string | null;
	pane_id: string;
	seq?: number | null;
	source: string;
	state: PaneAgentState;
}

export interface PaneReportAgentSessionParams {
	agent: string;
	agent_session_id?: string | null;
	agent_session_path?: string | null;
	pane_id: string;
	seq?: number | null;
	session_start_source?: string | null;
	source: string;
}

export interface PaneReportMetadataParams {
	agent?: string | null;
	applies_to_source?: string | null;
	clear_display_agent?: boolean;
	clear_state_labels?: boolean;
	clear_title?: boolean;
	display_agent?: string | null;
	pane_id: string;
	seq?: number | null;
	source: string;
	state_labels?: Record<string, string>;
	title?: string | null;
	tokens?: Record<string, string | null>;
	ttl_ms?: number | null;
}

export interface PaneResizeParams {
	amount?: number | null;
	direction: PaneDirection;
	pane_id?: string | null;
}

export type PaneResizeReason = 'unchanged';

export interface PaneResizeResult {
	changed: boolean;
	focused_pane_id: string;
	layout: PaneLayoutSnapshot;
	pane_id: string;
	reason?: PaneResizeReason | null;
}

export interface PaneScrollChangedEvent {
	pane_id: string;
	scroll: PaneScrollInfo;
	workspace_id: string;
}

export interface PaneScrollInfo {
	max_offset_from_bottom: number;
	offset_from_bottom: number;
	viewport_rows: number;
}

export interface PaneSendInputParams {
	keys?: string[];
	pane_id: string;
	text?: string;
}

export interface PaneSendKeysParams {
	keys: string[];
	pane_id: string;
}

export interface PaneSendTextParams {
	pane_id: string;
	text: string;
}

export interface PaneSplitParams {
	cwd?: string | null;
	direction: SplitDirection;
	env?: Record<string, string>;
	focus?: boolean;
	ratio?: number | null;
	target_pane_id?: string | null;
	workspace_id?: string | null;
}

export interface PaneSwapParams {
	direction?: PaneDirection | null;
	pane_id?: string | null;
	source_pane_id?: string | null;
	target_pane_id?: string | null;
}

export type PaneSwapReason = 'no_neighbor' | 'same_pane' | 'not_found' | 'cross_tab';

export interface PaneSwapResult {
	changed: boolean;
	focused_pane_id: string;
	layout: PaneLayoutSnapshot;
	reason?: PaneSwapReason | null;
	source_pane_id: string;
	target_pane_id?: string | null;
}

export interface PaneTarget {
	pane_id: string;
}

export interface PaneWaitForOutputParams {
	lines?: number | null;
	match: OutputMatch;
	pane_id: string;
	source: ReadSource;
	strip_ansi?: boolean;
	timeout_ms?: number | null;
}

export type PaneZoomMode = 'toggle' | 'on' | 'off';

export interface PaneZoomParams {
	mode?: PaneZoomMode;
	pane_id?: string | null;
}

export type PaneZoomReason = 'single_pane' | 'already_zoomed' | 'already_unzoomed';

export interface PaneZoomResult {
	changed: boolean;
	focus_changed: boolean;
	focused_pane_id: string;
	layout: PaneLayoutSnapshot;
	pane_id: string;
	reason?: PaneZoomReason | null;
	zoom_changed: boolean;
	zoomed: boolean;
}

export type PingParams = Record<string, unknown>;

export type PluginActionContext = 'global' | 'workspace' | 'tab' | 'pane' | 'selection';

export interface PluginActionInfo {
	action_id: string;
	command: string[];
	contexts?: PluginActionContext[];
	description?: string | null;
	platforms?: PluginPlatform[] | null;
	plugin_id: string;
	title: string;
}

export interface PluginActionInvokeParams {
	action_id: string;
	context?: PluginInvocationContext | null;
	plugin_id?: string | null;
}

export interface PluginActionListParams {
	plugin_id?: string | null;
}

export interface PluginCommandLogInfo {
	action_id?: string | null;
	command: string[];
	error?: string | null;
	event?: string | null;
	exit_code?: number | null;
	finished_unix_ms?: number | null;
	log_id: string;
	plugin_id: string;
	started_unix_ms: number;
	status: PluginCommandStatus;
	stderr?: string | null;
	stdout?: string | null;
}

export type PluginCommandStatus = 'running' | 'succeeded' | 'failed';

export interface PluginInvocationContext {
	clicked_url?: string | null;
	correlation_id?: string | null;
	focused_pane_agent?: string | null;
	focused_pane_cwd?: string | null;
	focused_pane_id?: string | null;
	focused_pane_status?: AgentStatus | null;
	invocation_source?: string | null;
	link_handler_id?: string | null;
	selected_text?: string | null;
	tab_id?: string | null;
	tab_label?: string | null;
	workspace_cwd?: string | null;
	workspace_id?: string | null;
	workspace_label?: string | null;
	worktree?: WorkspaceWorktreeInfo | null;
}

export interface PluginLinkParams {
	enabled?: boolean;
	path: string;
	source?: PluginSourceInfo | null;
}

export interface PluginListParams {
	plugin_id?: string | null;
}

export interface PluginLogListParams {
	limit?: number | null;
	plugin_id?: string | null;
}

export interface PluginManifestAction {
	command: string[];
	contexts?: PluginActionContext[];
	description?: string | null;
	id: string;
	platforms?: PluginPlatform[] | null;
	title: string;
}

export interface PluginManifestBuild {
	command: string[];
	platforms?: PluginPlatform[] | null;
}

export interface PluginManifestEventHook {
	command: string[];
	on: string;
	platforms?: PluginPlatform[] | null;
}

export interface PluginManifestLinkHandler {
	action: string;
	id: string;
	pattern: string;
	platforms?: PluginPlatform[] | null;
	title: string;
}

export interface PluginManifestPane {
	command: string[];
	description?: string | null;
	height?: PopupSize | null;
	id: string;
	placement?: PluginPanePlacement;
	platforms?: PluginPlatform[] | null;
	title: string;
	width?: PopupSize | null;
}

export interface PluginManifestStartup {
	command: string[];
	platforms?: PluginPlatform[] | null;
}

export interface PluginPaneCloseParams {
	pane_id: string;
}

export interface PluginPaneFocusParams {
	pane_id: string;
}

export interface PluginPaneInfo {
	entrypoint: string;
	pane: PaneInfo;
	plugin_id: string;
}

export interface PluginPaneOpenParams {
	cwd?: string | null;
	direction?: SplitDirection | null;
	entrypoint: string;
	env?: Record<string, string>;
	focus?: boolean;
	height?: PopupSize | null;
	placement?: PluginPanePlacement | null;
	plugin_id: string;
	target_pane_id?: string | null;
	width?: PopupSize | null;
	workspace_id?: string | null;
}

export type PluginPanePlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed';

export type PluginPlatform = 'linux' | 'macos' | 'windows';

export interface PluginSetEnabledParams {
	plugin_id: string;
}

export interface PluginSourceInfo {
	installed_unix_ms?: number | null;
	kind?: PluginSourceKind;
	managed_path?: string | null;
	owner?: string | null;
	repo?: string | null;
	requested_ref?: string | null;
	resolved_commit?: string | null;
	subdir?: string | null;
}

export type PluginSourceKind = 'local' | 'github';

export interface PluginUnlinkParams {
	plugin_id: string;
}

export type PopupSize = number | string;

export type ReadFormat = 'text' | 'ansi';

export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection';

export type ResponseResult = 
	| {
	capabilities?: ServerCapabilities | null;
	protocol: number;
	type: 'pong';
	version: string;
}
	| {
	snapshot: SessionSnapshot;
	type: 'session_snapshot';
}
	| {
	type: 'workspace_info';
	workspace: WorkspaceInfo;
}
	| {
	root_pane: PaneInfo;
	tab: TabInfo;
	type: 'workspace_created';
	workspace: WorkspaceInfo;
}
	| {
	type: 'workspace_list';
	workspaces: WorkspaceInfo[];
}
	| {
	source: WorktreeSourceInfo;
	type: 'worktree_list';
	worktrees: WorktreeInfo[];
}
	| {
	root_pane: PaneInfo;
	tab: TabInfo;
	type: 'worktree_created';
	workspace: WorkspaceInfo;
	worktree: WorktreeInfo;
}
	| {
	already_open: boolean;
	root_pane: PaneInfo;
	tab: TabInfo;
	type: 'worktree_opened';
	workspace: WorkspaceInfo;
	worktree: WorktreeInfo;
}
	| {
	forced: boolean;
	path: string;
	type: 'worktree_removed';
	workspace_id: string;
}
	| {
	tab: TabInfo;
	type: 'tab_info';
}
	| {
	root_pane: PaneInfo;
	tab: TabInfo;
	type: 'tab_created';
}
	| {
	tabs: TabInfo[];
	type: 'tab_list';
}
	| {
	agent: AgentInfo;
	type: 'agent_info';
}
	| {
	agent: AgentInfo;
	argv: string[];
	type: 'agent_started';
}
	| {
	agent: AgentInfo;
	type: 'agent_prompted';
}
	| {
	agents: AgentInfo[];
	type: 'agent_list';
}
	| {
	active: boolean;
	label?: string | null;
	source?: string | null;
	type: 'agent_view';
}
	| {
	pane: PaneInfo;
	type: 'pane_info';
}
	| {
	panes: PaneInfo[];
	type: 'pane_list';
}
	| {
	pane: PaneInfo;
	type: 'pane_current';
}
	| {
	swap: PaneSwapResult;
	type: 'pane_swap';
}
	| {
	move_result: PaneMoveResult;
	type: 'pane_move';
}
	| {
	type: 'pane_zoom';
	zoom: PaneZoomResult;
}
	| {
	layout: PaneLayoutSnapshot;
	type: 'pane_layout';
}
	| {
	process_info: PaneProcessInfo;
	type: 'pane_process_info';
}
	| {
	layout: LayoutDescription;
	type: 'layout_export';
}
	| {
	layout: LayoutDescription;
	type: 'layout_apply';
}
	| {
	layout: LayoutDescription;
	type: 'layout_split_ratio_set';
}
	| {
	neighbor: PaneNeighborResult;
	type: 'pane_neighbor';
}
	| {
	edges: PaneEdgesResult;
	type: 'pane_edges';
}
	| {
	focus: PaneFocusDirectionResult;
	type: 'pane_focus_direction';
}
	| {
	resize: PaneResizeResult;
	type: 'pane_resize';
}
	| {
	read: PaneReadResult;
	type: 'pane_read';
}
	| {
	cell_height_px: number;
	cell_width_px: number;
	type: 'pane_graphics_info';
}
	| {
	explain: unknown;
	type: 'agent_explain';
}
	| {
	type: 'subscription_started';
}
	| {
	event: EventEnvelope;
	type: 'wait_matched';
}
	| {
	matched_line?: string | null;
	pane_id: string;
	read: PaneReadResult;
	revision: number;
	type: 'output_matched';
}
	| {
	reason: NotificationShowReason;
	shown: boolean;
	type: 'notification_show';
}
	| {
	changed: boolean;
	reason: ClientWindowTitleReason;
	type: 'client_window_title';
}
	| {
	details: IntegrationInstallResult;
	target: IntegrationTarget;
	type: 'integration_install';
}
	| {
	details: IntegrationUninstallResult;
	target: IntegrationTarget;
	type: 'integration_uninstall';
}
	| {
	manifests: AgentManifestInfo[];
	type: 'agent_manifest_reload';
}
	| {
	last_check_unix?: number | null;
	last_result?: string | null;
	manifests: AgentManifestInfo[];
	type: 'agent_manifest_status';
}
	| {
	plugin: InstalledPluginInfo;
	type: 'plugin_linked';
}
	| {
	plugins: InstalledPluginInfo[];
	type: 'plugin_list';
}
	| {
	plugin_id: string;
	removed: boolean;
	type: 'plugin_unlinked';
}
	| {
	plugin: InstalledPluginInfo;
	type: 'plugin_enabled';
}
	| {
	plugin: InstalledPluginInfo;
	type: 'plugin_disabled';
}
	| {
	actions: PluginActionInfo[];
	type: 'plugin_action_list';
}
	| {
	action: PluginActionInfo;
	context: PluginInvocationContext;
	log: PluginCommandLogInfo;
	type: 'plugin_action_invoked';
}
	| {
	logs: PluginCommandLogInfo[];
	type: 'plugin_log_list';
}
	| {
	plugin_pane: PluginPaneInfo;
	type: 'plugin_pane_opened';
}
	| {
	plugin_pane: PluginPaneInfo;
	type: 'plugin_pane_focused';
}
	| {
	pane_id: string;
	type: 'plugin_pane_closed';
}
	| {
	diagnostics: string[];
	status: ConfigReloadStatus;
	type: 'config_reload';
}
	| {
	type: 'ok';
};

export interface ServerCapabilities {
	detached_server_daemon?: boolean;
	live_handoff: boolean;
}

export interface ServerLiveHandoffParams {
	expected_protocol?: number | null;
	expected_version?: string | null;
	import_exe?: string | null;
}

export interface SessionSnapshot {
	agents: AgentInfo[];
	focused_pane_id?: string | null;
	focused_tab_id?: string | null;
	focused_workspace_id?: string | null;
	layouts: PaneLayoutSnapshot[];
	panes: PaneInfo[];
	protocol: number;
	tabs: TabInfo[];
	version: string;
	workspaces: WorkspaceInfo[];
}

export type SplitDirection = 'right' | 'down';

export type Subscription = 
	| {
	type: 'workspace.created';
}
	| {
	type: 'workspace.updated';
}
	| {
	type: 'workspace.metadata_updated';
}
	| {
	type: 'workspace.renamed';
}
	| {
	type: 'workspace.moved';
}
	| {
	type: 'workspace.reordered';
}
	| {
	type: 'workspace.closed';
}
	| {
	type: 'workspace.focused';
}
	| {
	type: 'worktree.created';
}
	| {
	type: 'worktree.opened';
}
	| {
	type: 'worktree.removed';
}
	| {
	type: 'tab.created';
}
	| {
	type: 'tab.closed';
}
	| {
	type: 'tab.focused';
}
	| {
	type: 'tab.renamed';
}
	| {
	type: 'tab.moved';
}
	| {
	type: 'pane.created';
}
	| {
	type: 'pane.closed';
}
	| {
	type: 'pane.updated';
}
	| {
	type: 'pane.focused';
}
	| {
	type: 'pane.moved';
}
	| {
	type: 'pane.exited';
}
	| {
	type: 'pane.agent_detected';
}
	| {
	lines?: number | null;
	match: OutputMatch;
	pane_id: string;
	source: ReadSource;
	strip_ansi?: boolean;
	type: 'pane.output_matched';
}
	| {
	agent_status?: AgentStatus | null;
	pane_id: string;
	type: 'pane.agent_status_changed';
}
	| {
	pane_id: string;
	type: 'pane.scroll_changed';
}
	| {
	type: 'layout.updated';
};

export type SubscriptionEventData = PaneOutputMatchedEvent | PaneAgentStatusChangedEvent | PaneScrollChangedEvent;

export type SubscriptionEventKind = 'pane.output_matched' | 'pane.agent_status_changed' | 'pane.scroll_changed';

export interface TabCreateParams {
	cwd?: string | null;
	env?: Record<string, string>;
	focus?: boolean;
	label?: string | null;
	workspace_id?: string | null;
}

export interface TabInfo {
	agent_status: AgentStatus;
	focused: boolean;
	label: string;
	number: number;
	pane_count: number;
	tab_id: string;
	workspace_id: string;
}

export interface TabListParams {
	workspace_id?: string | null;
}

export interface TabMoveParams {
	insert_index: number;
	tab_id: string;
}

export interface TabRenameParams {
	label: string;
	tab_id: string;
}

export interface TabTarget {
	tab_id: string;
}

export type ToastHerdrPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface WorkspaceCreateParams {
	cwd?: string | null;
	env?: Record<string, string>;
	focus?: boolean;
	label?: string | null;
}

export interface WorkspaceInfo {
	active_tab_id: string;
	agent_status: AgentStatus;
	focused: boolean;
	label: string;
	number: number;
	pane_count: number;
	tab_count: number;
	tokens?: Record<string, string>;
	workspace_id: string;
	worktree?: WorkspaceWorktreeInfo | null;
}

export interface WorkspaceMoveBlockParams {
	before_workspace_id?: string | null;
	workspace_ids: string[];
}

export interface WorkspaceMoveParams {
	insert_index: number;
	workspace_id: string;
}

export interface WorkspaceRenameParams {
	label: string;
	workspace_id: string;
}

export interface WorkspaceReportMetadataParams {
	seq?: number | null;
	source: string;
	tokens: Record<string, string | null>;
	ttl_ms?: number | null;
	workspace_id: string;
}

export interface WorkspaceTarget {
	workspace_id: string;
}

export interface WorkspaceWorktreeInfo {
	checkout_path: string;
	is_linked_worktree: boolean;
	repo_key: string;
	repo_name: string;
	repo_root: string;
}

export interface WorktreeCreateParams {
	base?: string | null;
	branch?: string | null;
	cwd?: string | null;
	focus?: boolean;
	label?: string | null;
	path?: string | null;
	workspace_id?: string | null;
}

export interface WorktreeInfo {
	branch?: string | null;
	is_bare: boolean;
	is_detached: boolean;
	is_linked_worktree: boolean;
	is_prunable: boolean;
	label: string;
	open_workspace_id?: string | null;
	path: string;
}

export interface WorktreeListParams {
	cwd?: string | null;
	workspace_id?: string | null;
}

export interface WorktreeOpenParams {
	branch?: string | null;
	cwd?: string | null;
	focus?: boolean;
	label?: string | null;
	path?: string | null;
	workspace_id?: string | null;
}

export interface WorktreeRemoveParams {
	force?: boolean;
	workspace_id: string;
}

export interface WorktreeSourceInfo {
	repo_key: string;
	repo_name: string;
	repo_root: string;
	source_checkout_path: string;
	source_workspace_id?: string | null;
}

/** Every method name the server accepts, and the params each requires. */
export interface HerdrMethodParams {
	'agent.explain': AgentTarget;
	'agent.focus': AgentTarget;
	'agent.get': AgentTarget;
	'agent.list': EmptyParams;
	'agent.prompt': AgentPromptParams;
	'agent.read': AgentReadParams;
	'agent.rename': AgentRenameParams;
	'agent.send_keys': AgentSendKeysParams;
	'agent.start': AgentStartParams;
	'agent.view.clear': AgentViewClearParams;
	'agent.view.set': AgentViewSetParams;
	'agent.wait': AgentWaitParams;
	'client.window_title.clear': EmptyParams;
	'client.window_title.set': ClientWindowTitleSetParams;
	'events.subscribe': EventsSubscribeParams;
	'events.wait': EventsWaitParams;
	'integration.install': IntegrationInstallParams;
	'integration.uninstall': IntegrationUninstallParams;
	'layout.apply': LayoutApplyParams;
	'layout.export': LayoutExportParams;
	'layout.set_split_ratio': LayoutSetSplitRatioParams;
	'notification.show': NotificationShowParams;
	'pane.clear_agent_authority': PaneClearAgentAuthorityParams;
	'pane.close': PaneTarget;
	'pane.current': PaneCurrentParams;
	'pane.edges': PaneEdgesParams;
	'pane.focus': PaneTarget;
	'pane.focus_direction': PaneFocusDirectionParams;
	'pane.get': PaneTarget;
	'pane.graphics.clear': PaneGraphicsClearParams;
	'pane.graphics.info': PaneTarget;
	'pane.graphics.set': PaneGraphicsSetParams;
	'pane.layout': PaneLayoutParams;
	'pane.list': PaneListParams;
	'pane.move': PaneMoveParams;
	'pane.neighbor': PaneNeighborParams;
	'pane.process_info': PaneProcessInfoParams;
	'pane.read': PaneReadParams;
	'pane.release_agent': PaneReleaseAgentParams;
	'pane.rename': PaneRenameParams;
	'pane.report_agent': PaneReportAgentParams;
	'pane.report_agent_session': PaneReportAgentSessionParams;
	'pane.report_metadata': PaneReportMetadataParams;
	'pane.resize': PaneResizeParams;
	'pane.send_input': PaneSendInputParams;
	'pane.send_keys': PaneSendKeysParams;
	'pane.send_text': PaneSendTextParams;
	'pane.split': PaneSplitParams;
	'pane.swap': PaneSwapParams;
	'pane.wait_for_output': PaneWaitForOutputParams;
	'pane.zoom': PaneZoomParams;
	'ping': PingParams;
	'plugin.action.invoke': PluginActionInvokeParams;
	'plugin.action.list': PluginActionListParams;
	'plugin.disable': PluginSetEnabledParams;
	'plugin.enable': PluginSetEnabledParams;
	'plugin.link': PluginLinkParams;
	'plugin.list': PluginListParams;
	'plugin.log.list': PluginLogListParams;
	'plugin.pane.close': PluginPaneCloseParams;
	'plugin.pane.focus': PluginPaneFocusParams;
	'plugin.pane.open': PluginPaneOpenParams;
	'plugin.unlink': PluginUnlinkParams;
	'popup.close': EmptyParams;
	'server.agent_manifests': EmptyParams;
	'server.live_handoff': ServerLiveHandoffParams;
	'server.reload_agent_manifests': EmptyParams;
	'server.reload_config': EmptyParams;
	'server.stop': EmptyParams;
	'session.snapshot': EmptyParams;
	'tab.close': TabTarget;
	'tab.create': TabCreateParams;
	'tab.focus': TabTarget;
	'tab.get': TabTarget;
	'tab.list': TabListParams;
	'tab.move': TabMoveParams;
	'tab.rename': TabRenameParams;
	'workspace.close': WorkspaceTarget;
	'workspace.create': WorkspaceCreateParams;
	'workspace.focus': WorkspaceTarget;
	'workspace.get': WorkspaceTarget;
	'workspace.list': EmptyParams;
	'workspace.move': WorkspaceMoveParams;
	'workspace.move_block': WorkspaceMoveBlockParams;
	'workspace.rename': WorkspaceRenameParams;
	'workspace.report_metadata': WorkspaceReportMetadataParams;
	'worktree.create': WorktreeCreateParams;
	'worktree.list': WorktreeListParams;
	'worktree.open': WorktreeOpenParams;
	'worktree.remove': WorktreeRemoveParams;
}

export type HerdrMethod = keyof HerdrMethodParams;

/** Result payloads keyed by their internal `type` tag. */
export interface HerdrResultByType {
	'pong': {
		capabilities?: ServerCapabilities | null;
		protocol: number;
		type: 'pong';
		version: string;
	};
	'session_snapshot': {
		snapshot: SessionSnapshot;
		type: 'session_snapshot';
	};
	'workspace_info': {
		type: 'workspace_info';
		workspace: WorkspaceInfo;
	};
	'workspace_created': {
		root_pane: PaneInfo;
		tab: TabInfo;
		type: 'workspace_created';
		workspace: WorkspaceInfo;
	};
	'workspace_list': {
		type: 'workspace_list';
		workspaces: WorkspaceInfo[];
	};
	'worktree_list': {
		source: WorktreeSourceInfo;
		type: 'worktree_list';
		worktrees: WorktreeInfo[];
	};
	'worktree_created': {
		root_pane: PaneInfo;
		tab: TabInfo;
		type: 'worktree_created';
		workspace: WorkspaceInfo;
		worktree: WorktreeInfo;
	};
	'worktree_opened': {
		already_open: boolean;
		root_pane: PaneInfo;
		tab: TabInfo;
		type: 'worktree_opened';
		workspace: WorkspaceInfo;
		worktree: WorktreeInfo;
	};
	'worktree_removed': {
		forced: boolean;
		path: string;
		type: 'worktree_removed';
		workspace_id: string;
	};
	'tab_info': {
		tab: TabInfo;
		type: 'tab_info';
	};
	'tab_created': {
		root_pane: PaneInfo;
		tab: TabInfo;
		type: 'tab_created';
	};
	'tab_list': {
		tabs: TabInfo[];
		type: 'tab_list';
	};
	'agent_info': {
		agent: AgentInfo;
		type: 'agent_info';
	};
	'agent_started': {
		agent: AgentInfo;
		argv: string[];
		type: 'agent_started';
	};
	'agent_prompted': {
		agent: AgentInfo;
		type: 'agent_prompted';
	};
	'agent_list': {
		agents: AgentInfo[];
		type: 'agent_list';
	};
	'agent_view': {
		active: boolean;
		label?: string | null;
		source?: string | null;
		type: 'agent_view';
	};
	'pane_info': {
		pane: PaneInfo;
		type: 'pane_info';
	};
	'pane_list': {
		panes: PaneInfo[];
		type: 'pane_list';
	};
	'pane_current': {
		pane: PaneInfo;
		type: 'pane_current';
	};
	'pane_swap': {
		swap: PaneSwapResult;
		type: 'pane_swap';
	};
	'pane_move': {
		move_result: PaneMoveResult;
		type: 'pane_move';
	};
	'pane_zoom': {
		type: 'pane_zoom';
		zoom: PaneZoomResult;
	};
	'pane_layout': {
		layout: PaneLayoutSnapshot;
		type: 'pane_layout';
	};
	'pane_process_info': {
		process_info: PaneProcessInfo;
		type: 'pane_process_info';
	};
	'layout_export': {
		layout: LayoutDescription;
		type: 'layout_export';
	};
	'layout_apply': {
		layout: LayoutDescription;
		type: 'layout_apply';
	};
	'layout_split_ratio_set': {
		layout: LayoutDescription;
		type: 'layout_split_ratio_set';
	};
	'pane_neighbor': {
		neighbor: PaneNeighborResult;
		type: 'pane_neighbor';
	};
	'pane_edges': {
		edges: PaneEdgesResult;
		type: 'pane_edges';
	};
	'pane_focus_direction': {
		focus: PaneFocusDirectionResult;
		type: 'pane_focus_direction';
	};
	'pane_resize': {
		resize: PaneResizeResult;
		type: 'pane_resize';
	};
	'pane_read': {
		read: PaneReadResult;
		type: 'pane_read';
	};
	'pane_graphics_info': {
		cell_height_px: number;
		cell_width_px: number;
		type: 'pane_graphics_info';
	};
	'agent_explain': {
		explain: unknown;
		type: 'agent_explain';
	};
	'subscription_started': {
		type: 'subscription_started';
	};
	'wait_matched': {
		event: EventEnvelope;
		type: 'wait_matched';
	};
	'output_matched': {
		matched_line?: string | null;
		pane_id: string;
		read: PaneReadResult;
		revision: number;
		type: 'output_matched';
	};
	'notification_show': {
		reason: NotificationShowReason;
		shown: boolean;
		type: 'notification_show';
	};
	'client_window_title': {
		changed: boolean;
		reason: ClientWindowTitleReason;
		type: 'client_window_title';
	};
	'integration_install': {
		details: IntegrationInstallResult;
		target: IntegrationTarget;
		type: 'integration_install';
	};
	'integration_uninstall': {
		details: IntegrationUninstallResult;
		target: IntegrationTarget;
		type: 'integration_uninstall';
	};
	'agent_manifest_reload': {
		manifests: AgentManifestInfo[];
		type: 'agent_manifest_reload';
	};
	'agent_manifest_status': {
		last_check_unix?: number | null;
		last_result?: string | null;
		manifests: AgentManifestInfo[];
		type: 'agent_manifest_status';
	};
	'plugin_linked': {
		plugin: InstalledPluginInfo;
		type: 'plugin_linked';
	};
	'plugin_list': {
		plugins: InstalledPluginInfo[];
		type: 'plugin_list';
	};
	'plugin_unlinked': {
		plugin_id: string;
		removed: boolean;
		type: 'plugin_unlinked';
	};
	'plugin_enabled': {
		plugin: InstalledPluginInfo;
		type: 'plugin_enabled';
	};
	'plugin_disabled': {
		plugin: InstalledPluginInfo;
		type: 'plugin_disabled';
	};
	'plugin_action_list': {
		actions: PluginActionInfo[];
		type: 'plugin_action_list';
	};
	'plugin_action_invoked': {
		action: PluginActionInfo;
		context: PluginInvocationContext;
		log: PluginCommandLogInfo;
		type: 'plugin_action_invoked';
	};
	'plugin_log_list': {
		logs: PluginCommandLogInfo[];
		type: 'plugin_log_list';
	};
	'plugin_pane_opened': {
		plugin_pane: PluginPaneInfo;
		type: 'plugin_pane_opened';
	};
	'plugin_pane_focused': {
		plugin_pane: PluginPaneInfo;
		type: 'plugin_pane_focused';
	};
	'plugin_pane_closed': {
		pane_id: string;
		type: 'plugin_pane_closed';
	};
	'config_reload': {
		diagnostics: string[];
		status: ConfigReloadStatus;
		type: 'config_reload';
	};
	'ok': {
		type: 'ok';
	};
}

export type HerdrResultType = keyof HerdrResultByType;

/** Lifecycle event payloads keyed by `data.type` (equal to `event`). */
export interface HerdrEventByKind {
	'workspace_created': {
		type: 'workspace_created';
		workspace: WorkspaceInfo;
	};
	'workspace_updated': {
		type: 'workspace_updated';
		workspace: WorkspaceInfo;
	};
	'workspace_metadata_updated': {
		type: 'workspace_metadata_updated';
		workspace: WorkspaceInfo;
	};
	'workspace_closed': {
		type: 'workspace_closed';
		workspace?: WorkspaceInfo | null;
		workspace_id: string;
	};
	'workspace_renamed': {
		label: string;
		type: 'workspace_renamed';
		workspace_id: string;
	};
	'workspace_moved': {
		insert_index: number;
		type: 'workspace_moved';
		workspace_id: string;
		workspaces: WorkspaceInfo[];
	};
	'workspace_reordered': {
		before_workspace_id?: string | null;
		type: 'workspace_reordered';
		workspace_ids: string[];
		workspaces: WorkspaceInfo[];
	};
	'workspace_focused': {
		type: 'workspace_focused';
		workspace_id: string;
	};
	'worktree_created': {
		type: 'worktree_created';
		workspace: WorkspaceInfo;
		worktree: WorktreeInfo;
	};
	'worktree_opened': {
		already_open: boolean;
		type: 'worktree_opened';
		workspace: WorkspaceInfo;
		worktree: WorktreeInfo;
	};
	'worktree_removed': {
		forced: boolean;
		type: 'worktree_removed';
		workspace?: WorkspaceInfo | null;
		workspace_id: string;
		worktree: WorktreeInfo;
	};
	'tab_created': {
		tab: TabInfo;
		type: 'tab_created';
	};
	'tab_closed': {
		tab_id: string;
		type: 'tab_closed';
		workspace_id: string;
	};
	'tab_renamed': {
		label: string;
		tab_id: string;
		type: 'tab_renamed';
		workspace_id: string;
	};
	'tab_moved': {
		insert_index: number;
		tab_id: string;
		tabs: TabInfo[];
		type: 'tab_moved';
		workspace_id: string;
	};
	'tab_focused': {
		tab_id: string;
		type: 'tab_focused';
		workspace_id: string;
	};
	'pane_created': {
		pane: PaneInfo;
		type: 'pane_created';
	};
	'pane_closed': {
		pane_id: string;
		type: 'pane_closed';
		workspace_id: string;
	};
	'pane_updated': {
		pane: PaneInfo;
		type: 'pane_updated';
	};
	'pane_focused': {
		pane_id: string;
		type: 'pane_focused';
		workspace_id: string;
	};
	'pane_moved': {
		closed_tab_id?: string | null;
		closed_workspace_id?: string | null;
		created_tab?: TabInfo | null;
		created_workspace?: WorkspaceInfo | null;
		pane: PaneInfo;
		previous_pane_id: string;
		previous_tab_id: string;
		previous_workspace_id: string;
		type: 'pane_moved';
	};
	'pane_output_changed': {
		pane_id: string;
		revision: number;
		type: 'pane_output_changed';
		workspace_id: string;
	};
	'pane_exited': {
		pane_id: string;
		type: 'pane_exited';
		workspace_id: string;
	};
	'pane_agent_detected': {
		agent?: string | null;
		final_status?: AgentStatus | null;
		pane_id: string;
		released?: boolean;
		type: 'pane_agent_detected';
		workspace_id: string;
	};
	'pane_agent_status_changed': {
		agent?: string | null;
		agent_status: AgentStatus;
		display_agent?: string | null;
		pane_id: string;
		state_labels?: Record<string, string>;
		title?: string | null;
		type: 'pane_agent_status_changed';
		workspace_id: string;
	};
	'layout_updated': {
		layout: PaneLayoutSnapshot;
		type: 'layout_updated';
	};
}
