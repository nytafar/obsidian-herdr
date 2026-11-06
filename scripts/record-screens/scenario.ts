/**
 * What `npm run record-screens` drives Claude through (issue #168): every
 * screen in `tests/fixtures/screens/claude-2.1.318/`, by the prompts and the
 * keys that first produced it (issues #151, #163, #165). Pure data; the runner
 * is `./main.ts`.
 *
 * Each session is one throwaway `oh-test-*` herdr tab or hc terminal running
 * Claude in its own new folder. Prompts are trivial and ask Claude for one
 * tool call; nothing is ever approved for good: permissions are answered
 * "Yes" once, denied, or cancelled, and trust is never given. The folders are
 * the ones the committed screens name, so a re-recording wraps where they
 * did; the two wide trust folders are new, because the spike trusted the old
 * ones and Claude never asks about a trusted folder again.
 */

import type { ScreenKey } from '../../src/native/screenAccess';

export type Runtime = 'herdr' | 'hc';

export interface Size {
	cols: number;
	rows: number;
}

/** A dialog kind as `parseClaudeScreen` reads it. */
export type DialogKind = 'question' | 'review' | 'permission' | 'plan' | 'trust';

export type Step =
	/** Sends a prompt once Claude is idle. */
	| { do: 'prompt'; text: string }
	/** Cycles `shift+tab` until the footer shows this mode. */
	| { do: 'mode'; mode: 'plan' | 'default' }
	/** Presses each key alone and waits for the screen to take it. */
	| { do: 'keys'; keys: ScreenKey[] }
	/** Types text where the cursor is, with no Enter. */
	| { do: 'type'; text: string }
	/**
	 * Waits for the dialog, then saves the screen as `<name>.txt` (and the
	 * same read with colour as `<name>.ansi`). `until` waits for text instead
	 * of a dialog.
	 */
	| { do: 'record'; name: string; expect: DialogKind | null; ansi?: boolean; until?: string; torn?: boolean }
	/** Waits for a plan dialog whose plan names `planContains`. */
	| { do: 'await'; kind: 'plan'; planContains: string }
	/** Commits: presses the keys, then waits for Claude to go idle, cancelling any dialog that follows. */
	| { do: 'answer'; keys: ScreenKey[] }
	/** herdr only: holds the pane at another size. */
	| { do: 'resize'; size: Size }
	/**
	 * Sends a slash command once Claude is idle and waits for the screen to
	 * change and hold: a picker, not a dialog Claude blocks on (#169).
	 */
	| { do: 'command'; text: string }
	/** Sends a prompt that asks for no tool, and waits for the reply (#169). */
	| { do: 'say'; text: string };

export interface Session {
	/** Also the tab label or terminal name: always `oh-test-…`. */
	name: string;
	runtime: Runtime;
	/** Absolute; created by the run, removed after it. */
	folder: string;
	size: Size;
	/** Started in a folder Claude does not trust: only the trust prompt is read. */
	trust?: boolean;
	steps: Step[];
}

/** The terminal sizes the screens were recorded at. */
export const WIDE_HERDR: Size = { cols: 233, rows: 62 };
export const WIDE_HC: Size = { cols: 200, rows: 120 };
export const NARROW_60: Size = { cols: 60, rows: 40 };
export const NARROW_90: Size = { cols: 90, rows: 45 };

/** How Claude is started, after its own path. */
export const CLAUDE_ARGS = ['--permission-mode', 'default', '--model', 'haiku'] as const;

const PLAN =
	'Plan a one-step change: create c.txt containing the word plan. Keep the plan to two lines, do not explore, and call ExitPlanMode right away.';

// --- The wide screens (#151) -------------------------------------------------

const DRINK_WIDE =
	"Use the AskUserQuestion tool now to ask me exactly one single-choice question: 'Which drink do you want?' with header 'Drink' and options Tea, Coffee, Water. After my answer, reply with one word: the answer. Do nothing else.";
const FRUITS_WIDE =
	"Use the AskUserQuestion tool now to ask me exactly one multi-select question (multiSelect true): 'Which fruits do you like?' with header 'Fruit' and options Apple, Banana, Cherry, Durian. After my answer, reply with my answer verbatim. Do nothing else.";
const COLOUR_WIDE =
	"Use the AskUserQuestion tool now to ask me exactly one single-choice question: 'Which colour?' with header 'Colour' and options Red, Green. After my answer, reply with my answer verbatim. Do nothing else.";
const TWO_WIDE =
	"Use the AskUserQuestion tool now, in one call, with two single-choice questions: 1) 'Which size?' header 'Size', options Small, Large; 2) 'Which lid?' header 'Lid', options Yes, No. After my answer, reply with my answers verbatim. Do nothing else.";
const TOUCH_WIDE =
	'Run exactly this Bash command now and nothing else: touch one.txt   Then reply "ok" or, if refused, repeat my feedback verbatim.';
const PYTHON_WIDE =
	"Run exactly this Bash command now and nothing else: python3 -c 'print(6*7)'   Then reply with its output.";
const WRITE_WIDE = 'Use the Write tool now to create b.txt containing the word hi. Nothing else.';

const DOWN = (times: number): ScreenKey[] => Array.from({ length: times }, () => 'down' as const);

function wideHerdr(): Step[] {
	const p = 'herdr-';
	return [
		{ do: 'prompt', text: DRINK_WIDE },
		{ do: 'record', name: `${p}ask-single`, expect: 'question', ansi: true },
		{ do: 'answer', keys: ['2'] },

		{ do: 'prompt', text: FRUITS_WIDE },
		{ do: 'record', name: `${p}ask-multi`, expect: 'question' },
		{ do: 'keys', keys: ['1', '3', 'right'] },
		{ do: 'record', name: `${p}ask-multi-review`, expect: 'review' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: COLOUR_WIDE },
		{ do: 'keys', keys: DOWN(2) },
		{ do: 'record', name: `${p}ask-other-row`, expect: 'question' },
		{ do: 'type', text: 'Light blue, please' },
		{ do: 'record', name: `${p}ask-other-typed`, expect: 'question' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: FRUITS_WIDE },
		{ do: 'keys', keys: ['1', ...DOWN(4)] },
		{ do: 'type', text: 'Mango' },
		{ do: 'record', name: `${p}ask-multi-other`, expect: 'question' },
		{ do: 'keys', keys: ['down', 'enter'] },
		{ do: 'record', name: `${p}ask-multi-after-submit-row`, expect: 'review' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: TWO_WIDE },
		{ do: 'record', name: `${p}ask-two`, expect: 'question' },
		{ do: 'keys', keys: ['2', '1'] },
		{ do: 'record', name: `${p}ask-two-review`, expect: 'review' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: TOUCH_WIDE },
		{ do: 'record', name: `${p}bash-permission`, expect: 'permission' },
		{ do: 'keys', keys: [...DOWN(3), 'tab'] },
		{ do: 'type', text: 'use mkdir instead' },
		{ do: 'record', name: `${p}bash-deny-feedback`, expect: 'permission' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: PYTHON_WIDE },
		{ do: 'record', name: `${p}bash-permission-session`, expect: 'permission' },
		{ do: 'answer', keys: ['1'] },

		{ do: 'prompt', text: WRITE_WIDE },
		{ do: 'record', name: `${p}write-permission`, expect: 'permission' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'mode', mode: 'plan' },
		{ do: 'prompt', text: PLAN },
		{ do: 'record', name: `${p}plan`, expect: 'plan', ansi: true },
		{ do: 'keys', keys: DOWN(2) },
		{ do: 'type', text: 'name it d.txt instead' },
		{ do: 'record', name: `${p}plan-feedback`, expect: 'plan' },
		{ do: 'answer', keys: ['esc'] },
	];
}

function wideHc(): Step[] {
	const p = 'hc-';
	return [
		{ do: 'prompt', text: DRINK_WIDE },
		{ do: 'record', name: `${p}ask-single`, expect: 'question' },
		{ do: 'answer', keys: ['2'] },

		{ do: 'prompt', text: FRUITS_WIDE },
		{ do: 'keys', keys: ['1', '3'] },
		{ do: 'record', name: `${p}ask-multi-ticked`, expect: 'question' },
		{ do: 'keys', keys: DOWN(4) },
		{ do: 'type', text: 'Mango, Ripe 2' },
		{ do: 'record', name: `${p}ask-multi-other`, expect: 'question' },
		{ do: 'keys', keys: ['down', 'enter'] },
		{ do: 'record', name: `${p}ask-multi-review`, expect: 'review' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'prompt', text: TOUCH_WIDE },
		{ do: 'record', name: `${p}bash-permission`, expect: 'permission' },
		{ do: 'keys', keys: [...DOWN(3), 'tab'] },
		{ do: 'type', text: 'use mkdir instead' },
		{ do: 'record', name: `${p}bash-deny-feedback`, expect: 'permission' },
		{ do: 'answer', keys: ['enter'] },

		{ do: 'mode', mode: 'plan' },
		{ do: 'prompt', text: PLAN },
		{ do: 'record', name: `${p}plan`, expect: 'plan' },
		{ do: 'keys', keys: DOWN(2) },
		{ do: 'type', text: 'also write the word twice' },
		// Approves with the words, and switches the session to auto mode.
		{ do: 'keys', keys: ['shift+tab'] },
		{ do: 'record', name: `${p}plan-after-approve-feedback`, expect: null, until: "User approved Claude's plan" },
		{ do: 'answer', keys: [] },
	];
}

// --- After an approved plan (#165) ------------------------------------------

const PLAN_TRIVIAL =
	'Plan a trivial one-step change: create c.txt containing the word plan. Write the plan, then call ExitPlanMode right away. Ask nothing else.';

function afterPlan(runtime: Runtime): Step[] {
	return [
		{ do: 'mode', mode: 'plan' },
		{ do: 'prompt', text: PLAN_TRIVIAL },
		{ do: 'await', kind: 'plan', planContains: 'c.txt' },
		{ do: 'keys', keys: DOWN(2) },
		{ do: 'type', text: 'name it d.txt instead' },
		// Rejects with the words; Claude plans again.
		{ do: 'keys', keys: ['enter'] },
		{ do: 'await', kind: 'plan', planContains: 'd.txt' },
		// Approves with manual edits: the Write that follows asks.
		{ do: 'keys', keys: ['2'] },
		{ do: 'record', name: `${runtime}-write-after-plan`, expect: 'permission' },
		{ do: 'answer', keys: ['esc'] },
	];
}

// --- The narrow screens (#163) ----------------------------------------------

/** What one narrow set asks and types: long enough that every part wraps. */
export interface NarrowTexts {
	drink: string;
	fruits: string;
	two: string;
	touch: string;
	file: string;
	ownAnswer: string;
	mango: string;
	feedback: string;
	planFeedback: string;
}

const DRINK_SHORT =
	"Use the AskUserQuestion tool now to ask me exactly one single-choice question: 'Which of these hot drinks would you like me to prepare for the long afternoon meeting today?' with header 'Drink' and options 'Tea with milk and a little honey' (description 'A mild black tea, served with milk and a spoon of honey on the side'), 'Coffee', 'Water'. After my answer, reply with my answer verbatim. Do nothing else.";
const DRINK_LONG =
	"Use the AskUserQuestion tool now to ask me exactly one single-choice question: 'Which of these hot drinks would you like me to prepare for the long afternoon meeting with the whole design team today?' with header 'Drink' and options 'Tea with milk and a little honey' (description 'A mild black tea, served with milk and a spoon of honey on the side, in the large mug'), 'Coffee', 'Water'. After my answer, reply with my answer verbatim. Do nothing else.";
const FRUITS_SHORT =
	"Use the AskUserQuestion tool now to ask me exactly one multi-select question (multiSelect true): 'Which fruits would you like in the salad?' with header 'Fruit' and options 'Green apples from the orchard behind the old stone farmhouse' (description 'Crisp'), 'Banana', 'Cherry'. After my answer, reply with my answer verbatim. Do nothing else.";
const FRUITS_LONG =
	"Use the AskUserQuestion tool now to ask me exactly one multi-select question (multiSelect true): 'Which fruits would you like in the salad?' with header 'Fruit' and options 'Green apples from the orchard behind the old stone farmhouse at the end of the lane' (description 'Crisp'), 'Banana', 'Cherry'. After my answer, reply with my answer verbatim. Do nothing else.";
const TWO_SHORT =
	"Use the AskUserQuestion tool now to ask me two single-choice questions in one call: first 'Which cup size would you like for the coffee you are ordering this morning?' with header 'Size' and options Small, Large; second 'Which lid?' with header 'Lid' and options Yes, No. After my answers, reply with them verbatim. Do nothing else.";
const TWO_LONG =
	"Use the AskUserQuestion tool now to ask me two single-choice questions in one call: first 'Which cup size would you like for the coffee you are ordering this morning at the station kiosk?' with header 'Size' and options Small, Large; second 'Which lid?' with header 'Lid' and options Yes, No. After my answers, reply with them verbatim. Do nothing else.";

const touch = (suffix: string): string =>
	`Run exactly this Bash command now and nothing else: touch a-rather-long-file-name-for-wrapping${suffix}.txt another-quite-long-file-name-to-wrap${suffix}.txt   Then reply ok.`;

const NOTES = 'notes-from-the-long-afternoon-meeting-about-drinks';

export const NARROW_TEXTS: Record<'herdr60' | 'herdr90' | 'hc', NarrowTexts> = {
	herdr60: {
		drink: DRINK_SHORT,
		fruits: FRUITS_SHORT,
		two: TWO_SHORT,
		touch: touch(''),
		file: `${NOTES}.txt`,
		ownAnswer: 'Light blue tea in the large mug with the chipped handle, please',
		mango: 'Mango, Ripe 2, and a handful of wild strawberries from the garden',
		feedback: 'use mkdir for both of these instead, and name them with a date prefix',
		planFeedback: 'name it d.txt instead, and put the word plan in it twice please',
	},
	herdr90: {
		drink: DRINK_LONG,
		fruits: FRUITS_LONG,
		two: TWO_LONG,
		touch: touch('-at-ninety'),
		file: `${NOTES}-and-lids.txt`,
		ownAnswer: 'Light blue tea in the large mug with the chipped handle, and a slice of lemon on the side, please',
		mango: 'Mango, Ripe 2, and a handful of wild strawberries from the garden behind the house',
		feedback: 'use mkdir for both of these instead, and name them with a date prefix in the ISO format',
		planFeedback: 'name it d.txt instead, and put the word plan in it twice please, on two separate lines',
	},
	hc: {
		drink: DRINK_LONG,
		fruits: FRUITS_LONG,
		two: TWO_LONG,
		touch: touch('-on-hc'),
		file: `${NOTES}.txt`,
		ownAnswer: 'Light blue tea in the large mug with the chipped handle, please',
		mango: 'Mango, Ripe 2, and wild strawberries from the garden',
		feedback: 'use mkdir for both of these instead, and name them with a date prefix',
		planFeedback: 'name it d.txt instead, and put the word plan in it twice please',
	},
};

/** One narrow set: every dialog, each part made to wrap; `p` is the file prefix (`herdr-60-`). */
export function narrowSteps(p: string, t: NarrowTexts): Step[] {
	return [
		{ do: 'prompt', text: t.drink },
		{ do: 'record', name: `${p}ask-single`, expect: 'question' },
		{ do: 'keys', keys: DOWN(3) },
		{ do: 'type', text: t.ownAnswer },
		{ do: 'record', name: `${p}ask-other-typed`, expect: 'question' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'prompt', text: t.fruits },
		{ do: 'record', name: `${p}ask-multi`, expect: 'question' },
		{ do: 'keys', keys: ['enter', 'down', 'down', 'enter'] },
		{ do: 'record', name: `${p}ask-multi-ticked`, expect: 'question' },
		{ do: 'keys', keys: ['down'] },
		{ do: 'type', text: t.mango },
		{ do: 'record', name: `${p}ask-multi-other`, expect: 'question' },
		{ do: 'keys', keys: ['down'] },
		// Claude sometimes repaints this row torn (README, #163): saved as `-torn` when it reads as no dialog.
		{ do: 'record', name: `${p}ask-multi-submit-row`, expect: 'question', torn: true },
		{ do: 'keys', keys: ['enter'] },
		{ do: 'record', name: `${p}ask-multi-review`, expect: 'review' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'prompt', text: t.two },
		{ do: 'record', name: `${p}ask-two`, expect: 'question' },
		{ do: 'keys', keys: ['2'] },
		{ do: 'record', name: `${p}ask-two-second`, expect: 'question' },
		{ do: 'keys', keys: ['1'] },
		{ do: 'record', name: `${p}ask-two-review`, expect: 'review' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'prompt', text: t.touch },
		{ do: 'record', name: `${p}bash-permission`, expect: 'permission' },
		{ do: 'keys', keys: [...DOWN(3), 'tab'] },
		{ do: 'record', name: `${p}bash-deny-amend`, expect: 'permission' },
		{ do: 'type', text: t.feedback },
		{ do: 'record', name: `${p}bash-deny-feedback`, expect: 'permission' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'prompt', text: `Use the Write tool now to create the file ${t.file} containing the single word hi. Do nothing else.` },
		{ do: 'record', name: `${p}write-permission`, expect: 'permission' },
		{ do: 'answer', keys: ['1'] },

		{ do: 'prompt', text: `Use the Edit tool now to replace hi with hello in ${t.file}. Do nothing else.` },
		{ do: 'record', name: `${p}edit-permission`, expect: 'permission' },
		{ do: 'answer', keys: ['esc'] },

		{ do: 'mode', mode: 'plan' },
		{ do: 'prompt', text: PLAN },
		{ do: 'record', name: `${p}plan`, expect: 'plan' },
		{ do: 'keys', keys: DOWN(2) },
		{ do: 'type', text: t.planFeedback },
		{ do: 'record', name: `${p}plan-feedback`, expect: 'plan' },
		{ do: 'answer', keys: ['esc'] },
		{ do: 'mode', mode: 'default' },
	];
}

// --- The session settings pickers (#169, #170) -------------------------------

/**
 * Claude's `/model` and `/effort` pickers, the "Switch model?" confirm, and
 * the footer in every mode `shift+tab` reaches. Nothing is ever chosen:
 * `enter` in a picker saves the default, so the pickers are left with `esc`;
 * `s` (this session only) is pressed once, in a conversation with a reply,
 * to bring up the confirm, which `esc` leaves for the picker again. The
 * cursor starts on Haiku 5.5 (`--model haiku`), and `up` moves it to Sonnet
 * 5.5 on this account. The mode is cycled back to manual at the end.
 */
export function settingsSteps(p: string, wide: boolean): Step[] {
	return [
		{ do: 'record', name: `${p}footer-manual`, expect: null, until: 'manual mode on' },
		{ do: 'command', text: '/model' },
		{ do: 'record', name: `${p}model-picker`, expect: null, until: 'Select model' },
		...(wide
			? ([
					// Past row 10 the list scrolls: `↑ 2.` on top, `… +2 models` under it.
					{ do: 'keys', keys: DOWN(6) },
					{ do: 'record', name: `${p}model-picker-scrolled`, expect: null, until: '↑ 2.' },
				] satisfies Step[])
			: []),
		{ do: 'answer', keys: ['esc'] },
		{ do: 'command', text: '/effort' },
		{ do: 'record', name: `${p}effort-picker`, expect: null, until: 'Smarter' },
		{ do: 'keys', keys: ['right'] },
		{ do: 'record', name: `${p}effort-picker-right`, expect: null, until: 'Smarter' },
		{ do: 'answer', keys: ['esc'] },
		{ do: 'say', text: 'Reply with the single word ok. Use no tools.' },
		{ do: 'command', text: '/model' },
		{ do: 'keys', keys: ['up', 's'] },
		{ do: 'record', name: `${p}switch-model`, expect: null, until: 'Switch model?' },
		// "No, go back" is the picker again, the cursor on the current model.
		{ do: 'keys', keys: ['esc'] },
		{ do: 'record', name: `${p}model-picker-back`, expect: null, until: 'Select model' },
		{ do: 'answer', keys: ['esc'] },
		{ do: 'keys', keys: ['shift+tab'] },
		{ do: 'record', name: `${p}footer-accept-edits`, expect: null, until: 'accept edits on' },
		{ do: 'keys', keys: ['shift+tab'] },
		{ do: 'record', name: `${p}footer-plan`, expect: null, until: 'plan mode on' },
		{ do: 'keys', keys: ['shift+tab'] },
		{ do: 'record', name: `${p}footer-auto`, expect: null, until: 'auto mode on' },
		{ do: 'mode', mode: 'default' },
	];
}

/** Every session, in the order they run. */
export function sessions(): Session[] {
	return [
		{ name: 'oh-test-ask-herdr', runtime: 'herdr', folder: '/tmp/oh-test-ask-herdr', size: WIDE_HERDR, steps: wideHerdr() },
		{ name: 'oh-test-ask-hc', runtime: 'hc', folder: '/tmp/oh-test-ask-hc', size: WIDE_HC, steps: wideHc() },
		{ name: 'oh-test-ans-herdr', runtime: 'herdr', folder: '/tmp/oh-test-ans-herdr', size: WIDE_HERDR, steps: afterPlan('herdr') },
		{ name: 'oh-test-ans-hc', runtime: 'hc', folder: '/tmp/oh-test-ans-hc', size: WIDE_HC, steps: afterPlan('hc') },
		{
			// One pane and one session for both widths, as recorded: the 90-column
			// screens name the `…-herdr60` folder.
			name: 'oh-test-narrow-herdr60',
			runtime: 'herdr',
			folder: '/tmp/oh-test-narrow-herdr60',
			size: NARROW_60,
			steps: [
				...narrowSteps('herdr-60-', NARROW_TEXTS.herdr60),
				{ do: 'resize', size: NARROW_90 },
				...narrowSteps('herdr-90-', NARROW_TEXTS.herdr90),
			],
		},
		{ name: 'oh-test-narrow-hc60', runtime: 'hc', folder: '/tmp/oh-test-narrow-hc60', size: NARROW_60, steps: narrowSteps('hc-60-', NARROW_TEXTS.hc) },
		{ name: 'oh-test-narrow-hc90', runtime: 'hc', folder: '/tmp/oh-test-narrow-hc90', size: NARROW_90, steps: narrowSteps('hc-90-', NARROW_TEXTS.hc) },
		{
			name: 'oh-test-trust-wide-herdr',
			runtime: 'herdr',
			folder: '/var/tmp/oh-test-trust-wide-herdr',
			size: WIDE_HERDR,
			trust: true,
			steps: [{ do: 'record', name: 'herdr-trust', expect: 'trust' }],
		},
		{
			name: 'oh-test-trust-wide-hc',
			runtime: 'hc',
			folder: '/var/tmp/oh-test-trust-wide-hc',
			size: WIDE_HC,
			trust: true,
			steps: [{ do: 'record', name: 'hc-trust', expect: 'trust' }],
		},
		{
			name: 'oh-test-trust-narrow-herdr',
			runtime: 'herdr',
			folder: '/var/tmp/oh-test-trust-narrow-herdr',
			size: NARROW_60,
			trust: true,
			steps: [
				{ do: 'record', name: 'herdr-60-trust', expect: 'trust' },
				{ do: 'resize', size: NARROW_90 },
				{ do: 'record', name: 'herdr-90-trust', expect: 'trust' },
			],
		},
		{
			name: 'oh-test-trust-narrow-hc90',
			runtime: 'hc',
			folder: '/var/tmp/oh-test-trust-narrow-hc',
			size: NARROW_90,
			trust: true,
			steps: [{ do: 'record', name: 'hc-90-trust', expect: 'trust' }],
		},
		{
			// A long folder name, so the path wraps mid-word at 60 columns.
			name: 'oh-test-trust-narrow-hc60',
			runtime: 'hc',
			folder: '/var/tmp/oh-test-trust-narrow-hc/a-nested-folder-with-a-rather-long-name-so-the-path-wraps',
			size: NARROW_60,
			trust: true,
			steps: [{ do: 'record', name: 'hc-60-trust', expect: 'trust' }],
		},
		{ name: 'oh-test-settings-herdr', runtime: 'herdr', folder: '/tmp/oh-test-settings-herdr', size: WIDE_HERDR, steps: settingsSteps('herdr-', true) },
		{ name: 'oh-test-settings-hc', runtime: 'hc', folder: '/tmp/oh-test-settings-hc', size: WIDE_HC, steps: settingsSteps('hc-', true) },
		{ name: 'oh-test-settings-herdr60', runtime: 'herdr', folder: '/tmp/oh-test-settings-herdr60', size: NARROW_60, steps: settingsSteps('herdr-60-', false) },
		{ name: 'oh-test-settings-hc60', runtime: 'hc', folder: '/tmp/oh-test-settings-hc60', size: NARROW_60, steps: settingsSteps('hc-60-', false) },
	];
}
