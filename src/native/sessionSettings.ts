/**
 * The session settings seam (issues #161, #162; findings
 * `native-view-session-settings` §6 and `native-view-header`).
 *
 * The session bar under the prompt box (`./sessionBar.ts`) shows the model,
 * the reasoning effort and the permission mode a session runs with, and lets
 * them be changed. What is shown is read: the agent's format and the
 * runtime's overlay (`SessionModelView.sessionInfo`, #160). What changes them
 * is the runtime kind's, not the agent's, because each kind reaches its agent
 * differently: the `claude` kind with control requests over its own process
 * (#162), herdr and herdr-core through Claude's own pickers on screen (#169,
 * #170). A kind with no sender yet leaves the pickers showing the value,
 * disabled, with the reason.
 *
 * The format supplies only the vocabulary (`AgentFormat.models`, `efforts`,
 * `modes`), so the pickers are not one agent's shape.
 *
 * No Obsidian here: what is pure is tested without a DOM.
 */

import type { AgentStatus } from '../herdr/types.gen';
import type { SessionInfo } from './conversation';

/**
 * How far a change reaches: this session only, or the agent's default for
 * new sessions as well (Claude's `/model <alias>` saves the default).
 */
export type SettingScope = 'session' | 'default';

/** What the session bar can change. */
export type SessionSetting = 'model' | 'effort' | 'mode';

/**
 * A runtime kind's way of changing a session's settings
 * (`RuntimeKindAdapter.sessionSettings`). Every call rejects with a readable
 * message, which the bar turns into a notice; nothing is shown as changed
 * until the runtime or the transcript says it is (ADR-0003).
 */
export interface SessionSettingsSender {
	/** The scopes a change can be made in; the first is the picker's own action. */
	readonly scopes: readonly SettingScope[];
	/** The settings this kind can change; the others stay disabled. */
	readonly settings: readonly SessionSetting[];
	/**
	 * Whether a change is taken while the agent works (it applies from the
	 * next turn). Without it the pickers wait for `idle` or `done`.
	 */
	readonly midTurn: boolean;
	/** Why this pane's settings cannot be changed now, beyond its status, or null. */
	unavailable?(paneId: string): string | null;
	/** Switches the model, by a name the agent takes (`AgentFormat.models`). */
	setModel(paneId: string, model: string, scope: SettingScope): Promise<void>;
	/** Sets the reasoning effort, in the agent's word (`AgentFormat.efforts`). */
	setEffort(paneId: string, effort: string, scope: SettingScope): Promise<void>;
	/** Sets the permission mode, in the agent's word (`AgentFormat.modes`). */
	setMode(paneId: string, mode: string): Promise<void>;
}

/** One value a picker offers: the word the agent takes, and the name to show. */
export interface SettingChoice {
	value: string;
	label: string;
}

/** What a picker shows for a mode: a label, and a shorter one for a narrow view. */
export interface ModeLabel {
	label: string;
	short: string;
}

/** What a value nobody has stated yet shows. */
export const UNKNOWN_VALUE = '—';

/** Why a picker is disabled on a kind that has no sender yet. */
export const NO_SENDER_REASON = 'This runtime cannot change it yet.';
/** Why a picker is disabled with no agent to change. */
export const NO_AGENT_REASON = 'No agent in this pane.';
/** Why a picker is disabled while the waiting card stands. */
export const BLOCKED_REASON = 'Answer the waiting card first.';
/** Why a picker is disabled while a turn runs, on a kind that changes nothing mid-turn. */
export const WORKING_REASON = 'After this turn.';
/** Why a picker is disabled when the agent offers nothing to pick. */
export const NO_CHOICES_REASON = 'This agent offers nothing to choose here.';

/**
 * Whether one picker may be used now, and why not. The order is what the
 * reader would fix first: no agent, the kind, the block, the turn, the
 * kind's own reason, then the vocabulary.
 */
export function pickerBlock(input: {
	setting: SessionSetting;
	status: AgentStatus;
	connected: boolean;
	sender: SessionSettingsSender | null;
	paneId: string;
	choices: number;
}): string | null {
	const { sender, status } = input;
	if (!input.connected || status === 'unknown' || !input.paneId) return NO_AGENT_REASON;
	if (!sender || !sender.settings.includes(input.setting)) return NO_SENDER_REASON;
	if (status === 'blocked') return BLOCKED_REASON;
	if (status === 'working' && !sender.midTurn) return WORKING_REASON;
	const reason = sender.unavailable?.(input.paneId) ?? null;
	if (reason) return reason;
	return input.choices > 0 ? null : NO_CHOICES_REASON;
}

/** Words a model's name or id splits into, lower case. */
function modelWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s\-_[\]()]+/)
		.filter(Boolean);
}

/**
 * Whether the session's model is this choice: its shown name starts with the
 * choice's (`Opus 5.5` is `Opus`), or its id has the choice's word in it
 * (`claude-opus-5-5` is `opus`).
 */
export function isCurrentModel(model: SessionInfo['model'], choice: SettingChoice): boolean {
	if (!model) return false;
	const label = choice.label.toLowerCase();
	const shown = model.label.toLowerCase();
	if (shown === label || shown.startsWith(`${label} `)) return true;
	const value = choice.value.toLowerCase();
	return modelWords(model.id).includes(value) || modelWords(model.label).includes(value);
}

/** What the model picker shows, full and short (the first word, for a narrow view). */
export function modelText(model: SessionInfo['model']): { full: string; short: string } {
	const full = model?.label || model?.id || '';
	if (!full) return { full: UNKNOWN_VALUE, short: UNKNOWN_VALUE };
	return { full, short: full.split(/\s+/)[0] ?? full };
}

/**
 * The glyphs Claude's own prompt shows for an effort (`○ low`, `◐ medium`,
 * `● high`), so a narrow view says the same; any other word shows itself.
 */
const EFFORT_GLYPHS: Readonly<Record<string, string>> = { low: '○', medium: '◐', high: '●' };

/** What the effort picker shows, full and short. */
export function effortText(effort: string | undefined): { full: string; short: string } {
	if (!effort) return { full: UNKNOWN_VALUE, short: UNKNOWN_VALUE };
	const glyph = EFFORT_GLYPHS[effort];
	return glyph ? { full: `${glyph} ${effort}`, short: glyph } : { full: effort, short: effort };
}

/** What the mode picker shows, full and short, by the format's labels. */
export function modeText(
	mode: string | undefined,
	labels: Readonly<Record<string, ModeLabel>> | undefined,
): { full: string; short: string } {
	if (!mode) return { full: UNKNOWN_VALUE, short: UNKNOWN_VALUE };
	const known = labels?.[mode];
	return known ? { full: known.label, short: known.short } : { full: mode, short: mode };
}

/** Whether `mode` is the session's, as the reader sees it: two words with one label are one mode. */
export function isCurrentMode(
	current: string | undefined,
	mode: string,
	labels: Readonly<Record<string, ModeLabel>> | undefined,
): boolean {
	if (!current) return false;
	if (current === mode) return true;
	const a = labels?.[current]?.label;
	return a !== undefined && a === labels?.[mode]?.label;
}

/**
 * A token count the way Claude's `/context` says it, rounded for a glance:
 * `850`, `23k`, `1M`, `1.5M`.
 */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
	const millions = tokens / 1_000_000;
	return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
}

/** The context readout: tokens, the window when known, and the share of it. */
export interface ContextReadout {
	/** `23k / 1M`, or `23k` without a window; empty when nothing is known. */
	tokens: string;
	/** `2%`, or empty without a window. */
	percent: string;
	/** From 80% of the window, the readout turns amber. */
	warning: boolean;
	/** The tooltip: the exact numbers and who stated the window. */
	title: string;
}

/** Where a window came from, for the tooltip. */
const WINDOW_SOURCES: Readonly<Record<NonNullable<SessionInfo['contextWindow']>['source'], string>> = {
	agent: 'as the agent records it',
	'context-command': 'from /context',
	runtime: 'as the runtime reports it',
};

/** The share of the window from which the readout warns (finding `native-view-header` §1). */
export const CONTEXT_WARNING_SHARE = 0.8;

/**
 * The readout for a session: no percentage without a window, since a guessed
 * window is worse than none (finding `native-view-header` §1).
 */
export function contextReadout(info: SessionInfo): ContextReadout {
	const used = info.contextUsed;
	if (used === undefined) return { tokens: '', percent: '', warning: false, title: '' };
	const window = info.contextWindow;
	const exact = used.toLocaleString('en-US');
	if (!window || window.tokens <= 0) {
		return { tokens: formatTokens(used), percent: '', warning: false, title: `Context: ${exact} tokens` };
	}
	const share = used / window.tokens;
	return {
		tokens: `${formatTokens(used)} / ${formatTokens(window.tokens)}`,
		percent: `${Math.round(share * 100)}%`,
		warning: share >= CONTEXT_WARNING_SHARE,
		title: `Context: ${exact} of ${window.tokens.toLocaleString('en-US')} tokens, the window ${WINDOW_SOURCES[window.source]}`,
	};
}

/** What a failed change says, with the runtime's own words in the tail. */
export function settingFailureMessage(setting: SessionSetting, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	const what = setting === 'mode' ? 'permission mode' : setting;
	return `Gjetr: could not change the ${what} (${reason})`;
}
