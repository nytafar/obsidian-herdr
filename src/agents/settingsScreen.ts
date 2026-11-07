/**
 * An agent's own settings pickers and its prompt footer, read off a pane's
 * visible screen (issues #169, #170). On herdr and herdr-core the only way
 * to change a session's model or effort for that session alone is the
 * agent's own picker (Claude's `/model` and `/effort` with no argument,
 * finding `native-view-session-settings` §2), and the permission mode shows
 * only in the footer under the prompt. The format reads its own screens
 * (`AgentFormat.screenSettings`, Claude's in `./claude/screenDialog.ts`);
 * the driver that presses the keys is `../native/screenSettings.ts`.
 *
 * Unsure is `unknown`, as for the dialogs (`./screenDialog.ts`): the driver
 * presses nothing on a screen it cannot read whole.
 */

import type { SettingChoice } from '../native/sessionSettings';

/** One row of a model picker, as shown. */
export interface PickerRow {
	/** The number the picker shows before it. Never pressed: a digit saves the default. */
	number: number;
	/** The model's name as shown (`Sonnet 5.5`), without the current-model tick. */
	label: string;
	/** Whether the row carries the tick of the model the session runs now. */
	current: boolean;
}

/** The model picker (`/model` with no argument). */
export interface ModelPickerScreen {
	kind: 'model-picker';
	/** The rows on screen, top to bottom; a long list scrolls, so these may not start at 1. */
	rows: PickerRow[];
	/** The number of the row under the cursor. */
	cursor: number;
	/**
	 * Whether rows are hidden above or below the ones shown (`↑ 2.`, `↓ 10.`,
	 * `… +3 models`): a choice is made only from the whole list, so the
	 * driver scrolls through them first.
	 */
	above: boolean;
	below: boolean;
}

/** The effort slider (`/effort` with no argument). */
export interface EffortPickerScreen {
	kind: 'effort-picker';
	/** The levels the slider offers, left to right, in the agent's words. */
	levels: string[];
	/** The level the slider's mark is under, or null when it is under none for certain. */
	selected: string | null;
}

/** The confirm a model switch in a conversation with replies asks first. */
export interface SwitchModelScreen {
	kind: 'switch-model';
	/** The title (`Switch model?`). */
	title: string;
	/** What the dialog says under the title, one entry per screen line. */
	body: string[];
	/** The model the switch is to, as the yes row names it (`Sonnet 5.5`). */
	target: string;
	/** The yes and no rows as shown. */
	yes: string;
	no: string;
	cursor: 'yes' | 'no';
}

/** What a settings command printed under its echo, read off the history. */
export type CommandResult =
	/** `Set model to <label> for this session only` or `… and saved as your default for new sessions`. */
	| { kind: 'model'; label: string; scope: 'session' | 'default' }
	/** `Set effort level to <level> (this session only)` or `(saved as your default for new sessions)`. */
	| { kind: 'effort'; level: string; scope: 'session' | 'default' }
	/** `Kept model as <label>`: a model picker left with nothing chosen. */
	| { kind: 'kept'; label: string }
	/** `Cancelled`: an effort picker left with nothing chosen. */
	| { kind: 'cancelled' }
	/** Anything else, in its words (`Model 'bogus' not found`). */
	| { kind: 'other'; text: string };

/** The prompt, with nothing over it: what a command may be sent into. */
export interface PromptScreen {
	kind: 'prompt';
	/** The permission mode the footer shows, in the agent's word, or null when it shows none it knows. */
	mode: string | null;
	/**
	 * What the input holds: nothing, the agent's own grey suggestion (Claude's
	 * `Try "…"`), or a draft someone typed, which a command sent now would be
	 * sent after, as one prompt. On a text read a draft that reads exactly
	 * like a suggestion cannot be told from one; where the runtime reads
	 * styles the driver checks the suggestion is drawn dim
	 * ({@link ScreenSettingsReader.placeholderStyled}).
	 */
	input: 'empty' | 'placeholder' | 'draft';
	/** The input's text as read, its lines joined with `\n`; '' when empty. */
	inputText: string;
	/**
	 * The newest prompt or command in the history above the prompt, as echoed
	 * (`/model`, `/effort high`), and what it printed under it, or null when
	 * the history shows none.
	 */
	last: { echo: string; result: CommandResult | null } | null;
}

export interface UnknownSettingsScreen {
	kind: 'unknown';
}

export type SettingsScreen =
	| ModelPickerScreen
	| EffortPickerScreen
	| SwitchModelScreen
	| PromptScreen
	| UnknownSettingsScreen;

export const UNKNOWN_SETTINGS_SCREEN: UnknownSettingsScreen = Object.freeze({ kind: 'unknown' });

/**
 * What a format tells the settings driver about its TUI: how to read the
 * screen, which commands open the pickers, and which picker row a choice
 * from its vocabulary (`AgentFormat.models`) means.
 */
export interface ScreenSettingsReader {
	parse(screen: string): SettingsScreen;
	/** Opens the model picker with no argument; with one, sets it and saves the default. */
	readonly modelCommand: string;
	/** Opens the effort picker with no argument; with one, sets it and saves the default. */
	readonly effortCommand: string;
	/**
	 * The row a model choice means, by label (never by position), or null
	 * when the picker lists none for it.
	 */
	modelRow(choice: SettingChoice, rows: readonly PickerRow[]): PickerRow | null;
	/** Whether a model the screen names (`Sonnet 5.5`) is the choice (`sonnet`). */
	isModel(choice: SettingChoice, label: string): boolean;
	/** Whether two of the agent's mode words are one mode (`manual` and `default`). */
	sameMode(a: string, b: string): boolean;
	/**
	 * The modes the agent's mode key (`shift+tab`) cycles through, in its
	 * words: the ones a picker can reach this way.
	 */
	readonly cycleModes: readonly string[];
	/**
	 * Whether the input's suggestion, on a screen read with its styles (ANSI),
	 * is drawn as the agent draws a suggestion and not as typed text: true,
	 * false, or null when the styled screen shows no suggestion to judge.
	 */
	placeholderStyled?(styled: string, placeholder: string): boolean | null;
}
