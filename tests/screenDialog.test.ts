/**
 * Claude Code 2.1.318's dialogs read off the screen (issue #163, ADR-0009 §1),
 * over every recorded screen in `tests/fixtures/screens/claude-2.1.318/`:
 * the wide ones from spike #151 and the 60- and 90-column ones recorded for
 * this parser, on herdr and on hc. Labels, questions, commands and folders
 * are checked by their text with `wrappedEquals`, the way the answer driver
 * will check them, never by where they sit.
 *
 * The parser feeds a driver that presses keys, so most of the tests below the
 * fixtures are screens it must refuse: torn, cut, doubled or altered.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import { agentFormat } from '../src/agents/format';
import {
	joinWrapped,
	wrappedEquals,
	type PermissionDialog,
	type PlanDialog,
	type QuestionDialog,
	type ReviewDialog,
	type ScreenDialog,
	type ScreenRow,
	type TrustDialog,
} from '../src/agents/screenDialog';

const DIR = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');

function screen(name: string): string {
	return readFileSync(join(DIR, name), 'utf8');
}

function parse(name: string): ScreenDialog {
	return parseClaudeScreen(screen(name));
}

/** An option as the call has it: label and description. */
type Option = [label: string, description: string];

interface QuestionWant {
	question: string;
	tabs: [string, boolean][];
	options: Option[];
	multiSelect?: boolean;
	ticked?: number[];
	text?: string | null;
	cursor: number | 'submit';
}

function expectQuestion(dialog: ScreenDialog, want: QuestionWant): void {
	expect(dialog.kind).toBe('question');
	const d = dialog as QuestionDialog;
	expect(wrappedEquals(d.question, want.question), `question ${JSON.stringify(d.question)}`).toBe(true);
	expect(d.tabs.map((tab) => [tab.header, tab.answered])).toEqual(want.tabs);
	expect(d.submitTab).toBe(want.tabs.length > 1 || want.multiSelect === true);
	expect(d.multiSelect).toBe(want.multiSelect ?? false);
	expect(d.submitRow).toBe(want.multiSelect ?? false);
	expect(d.options).toHaveLength(want.options.length);
	want.options.forEach(([label, description], i) => {
		const row = d.options[i] as ScreenRow;
		expect(wrappedEquals(row.lines, `${label}\n${description}`), `option ${JSON.stringify(row.lines)}`).toBe(true);
	});
	expect(d.text.number).toBe(want.options.length + 1);
	expect(d.chat).toBe(want.options.length + 2);
	if (want.text === null || want.text === undefined) expect(d.text.lines).toBeNull();
	else expect(wrappedEquals(d.text.lines ?? [], want.text), `text ${JSON.stringify(d.text.lines)}`).toBe(true);
	if (want.multiSelect) {
		const ticked = [...d.options.filter((row) => row.ticked).map((row) => row.number)];
		if (d.text.ticked) ticked.push(d.text.number);
		expect(ticked).toEqual(want.ticked ?? []);
	} else {
		expect(d.options.every((row) => row.ticked === null)).toBe(true);
		expect(d.text.ticked).toBeNull();
	}
	expect(d.cursor).toBe(want.cursor);
}

function expectReview(dialog: ScreenDialog, tabs: string[], answers: [string, string][]): void {
	expect(dialog.kind).toBe('review');
	const d = dialog as ReviewDialog;
	expect(d.tabs.map((tab) => [tab.header, tab.answered])).toEqual(tabs.map((tab) => [tab, true]));
	expect(d.answers).toHaveLength(answers.length);
	answers.forEach(([question, answer], i) => {
		const got = d.answers[i];
		expect(wrappedEquals(got?.question ?? [], question), `review question ${JSON.stringify(got)}`).toBe(true);
		expect(wrappedEquals(got?.answer ?? [], answer), `review answer ${JSON.stringify(got)}`).toBe(true);
	});
	expect(d.cursor).toBe('submit');
}

interface PermissionWant {
	tool: PermissionDialog['tool'];
	command?: string;
	file?: string;
	prompt: string;
	options: string[];
	cursor: number;
	amending?: boolean;
	feedback?: string | null;
}

function expectPermission(dialog: ScreenDialog, want: PermissionWant): void {
	expect(dialog.kind).toBe('permission');
	const d = dialog as PermissionDialog;
	expect(d.tool).toBe(want.tool);
	if (want.command === undefined) expect(d.command).toBeNull();
	else expect(wrappedEquals(d.command ?? [], want.command), `command ${JSON.stringify(d.command)}`).toBe(true);
	if (want.file === undefined) expect(d.file).toBeNull();
	else expect(wrappedEquals(d.file ?? [], want.file), `file ${JSON.stringify(d.file)}`).toBe(true);
	expect(wrappedEquals(d.prompt, want.prompt), `prompt ${JSON.stringify(d.prompt)}`).toBe(true);
	expect(d.cursor).toBe(want.cursor);
	expect(d.amending).toBe(want.amending ?? false);
	// The last row reads "No, …" while amending; the others are Claude's labels.
	const labels = want.amending ? want.options.slice(0, -1) : want.options;
	expect(d.options).toHaveLength(want.options.length);
	labels.forEach((label, i) => {
		const row = d.options[i] as ScreenRow;
		expect(row.number).toBe(i + 1);
		expect(wrappedEquals(row.lines, label), `option ${JSON.stringify(row.lines)}`).toBe(true);
	});
	if (want.feedback === undefined || want.feedback === null) expect(d.feedback).toBeNull();
	else expect(wrappedEquals(d.feedback ?? [], want.feedback), `feedback ${JSON.stringify(d.feedback)}`).toBe(true);
}

const PLAN_OPTIONS = ['Yes, and use auto mode', 'Yes, manually approve edits'];

function expectPlan(dialog: ScreenDialog, slug: string, cursor: number, feedback: string | null): void {
	expect(dialog.kind).toBe('plan');
	const d = dialog as PlanDialog;
	expect(d.slug).toBe(slug);
	expect(d.planFile).toBe(`~/.claude/plans/${slug}.md`);
	expect(d.plan.length).toBeGreaterThan(0);
	expect(d.cursor).toBe(cursor);
	PLAN_OPTIONS.forEach((label, i) => expect(wrappedEquals(d.options[i]?.lines ?? [], label)).toBe(true));
	if (feedback === null) {
		expect(d.feedback).toBeNull();
		expect(wrappedEquals(d.options[2]?.lines ?? [], 'Tell Claude what to change')).toBe(true);
	} else {
		expect(wrappedEquals(d.feedback ?? [], feedback), `feedback ${JSON.stringify(d.feedback)}`).toBe(true);
	}
}

function expectTrust(dialog: ScreenDialog, folder: string): void {
	expect(dialog.kind).toBe('trust');
	const d = dialog as TrustDialog;
	expect(wrappedEquals(d.folder, folder), `folder ${JSON.stringify(d.folder)}`).toBe(true);
	expect(d.cursor).toBe('no');
}

const BASH_OPTION_3 = 'Yes, and switch to auto mode · auto mode handles these prompts for you';
const EDITS_OPTION_2 =
	'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)';

/** Every fixture is claimed by exactly one check below. */
const checked = new Set<string>();
function fixture(name: string, check: (dialog: ScreenDialog) => void): void {
	checked.add(name);
	it(name, () => check(parse(name)));
}

describe('screen dialogs: the wide screens from spike #151', () => {
	const drink: Option[] = [
		['Tea', 'Tea'],
		['Coffee', 'Coffee'],
		['Water', 'Water'],
	];
	const fruit: Option[] = [
		['Apple', 'Apple'],
		['Banana', 'Banana'],
		['Cherry', 'Cherry'],
		['Durian', 'Durian'],
	];
	const colour: Option[] = [
		['Red', 'Red'],
		['Green', 'Green'],
	];
	for (const runtime of ['herdr', 'hc']) {
		fixture(`${runtime}-ask-single.txt`, (d) =>
			expectQuestion(d, { question: 'Which drink do you want?', tabs: [['Drink', false]], options: drink, cursor: 1 }),
		);
	}
	const multi = { question: 'Which fruits do you like?', options: fruit, multiSelect: true };
	fixture('herdr-ask-multi.txt', (d) => expectQuestion(d, { ...multi, tabs: [['Fruit', false]], ticked: [], cursor: 1 }));
	fixture('hc-ask-multi-ticked.txt', (d) =>
		expectQuestion(d, { ...multi, tabs: [['Fruit', true]], ticked: [1, 3], cursor: 1 }),
	);
	fixture('herdr-ask-multi-other.txt', (d) =>
		expectQuestion(d, { ...multi, tabs: [['Fruit', true]], ticked: [1, 5], text: 'Mango', cursor: 5 }),
	);
	fixture('hc-ask-multi-other.txt', (d) =>
		expectQuestion(d, { ...multi, tabs: [['Fruit', true]], ticked: [1, 3, 5], text: 'mango 2', cursor: 5 }),
	);
	fixture('herdr-ask-multi-after-submit-row.txt', (d) =>
		expectReview(d, ['Fruit'], [['Which fruits do you like?', 'Apple, Mango']]),
	);
	fixture('herdr-ask-multi-review.txt', (d) =>
		expectReview(d, ['Fruit'], [['Which fruits do you like?', 'Apple, Cherry']]),
	);
	fixture('hc-ask-multi-review.txt', (d) =>
		expectReview(d, ['Fruit'], [['Which fruits do you like?', 'Apple, Cherry, "Mango, Ripe 2"']]),
	);
	fixture('herdr-ask-other-row.txt', (d) =>
		expectQuestion(d, { question: 'Which colour?', tabs: [['Colour', false]], options: colour, cursor: 3 }),
	);
	fixture('herdr-ask-other-typed.txt', (d) =>
		expectQuestion(d, {
			question: 'Which colour?',
			tabs: [['Colour', false]],
			options: colour,
			text: 'Light blue, please',
			cursor: 3,
		}),
	);
	fixture('herdr-ask-two.txt', (d) =>
		expectQuestion(d, {
			question: 'Which size?',
			tabs: [
				['Size', false],
				['Lid', false],
			],
			options: [
				['Small', 'Small'],
				['Large', 'Large'],
			],
			cursor: 1,
		}),
	);
	fixture('herdr-ask-two-review.txt', (d) =>
		expectReview(
			d,
			['Size', 'Lid'],
			[
				['Which size?', 'Large'],
				['Which lid?', 'Yes'],
			],
		),
	);
	for (const runtime of ['herdr', 'hc']) {
		const cwd = `/tmp/oh-test-ask-${runtime}`;
		const options = ['Yes', `Yes, and always allow access to ${cwd} from this project`, BASH_OPTION_3, 'No'];
		fixture(`${runtime}-bash-permission.txt`, (d) =>
			expectPermission(d, { tool: 'Bash', command: 'touch one.txt', prompt: 'Do you want to proceed?', options, cursor: 1 }),
		);
		fixture(`${runtime}-bash-deny-feedback.txt`, (d) =>
			expectPermission(d, {
				tool: 'Bash',
				command: 'touch one.txt',
				prompt: 'Do you want to proceed?',
				options,
				cursor: 4,
				amending: true,
				feedback: 'use mkdir instead',
			}),
		);
	}
	fixture('herdr-bash-permission-session.txt', (d) =>
		expectPermission(d, {
			tool: 'Bash',
			command: "python3 -c 'print(6*7)'",
			prompt: 'This command requires approval\nDo you want to proceed?',
			options: ['Yes', 'Yes, and don’t ask again for: python3 *', BASH_OPTION_3, 'No'],
			cursor: 1,
		}),
	);
	fixture('herdr-write-permission.txt', (d) =>
		expectPermission(d, {
			tool: 'Write',
			file: 'b.txt',
			prompt: 'Do you want to create b.txt?',
			options: ['Yes', EDITS_OPTION_2, 'No'],
			cursor: 1,
		}),
	);
	fixture('herdr-plan.txt', (d) => expectPlan(d, 'plan-a-one-step-change-tidy-unicorn', 1, null));
	fixture('herdr-plan-feedback.txt', (d) =>
		expectPlan(d, 'plan-a-one-step-change-tidy-unicorn', 3, 'name it d.txt instead'),
	);
	fixture('hc-plan.txt', (d) => expectPlan(d, 'plan-a-one-step-change-quirky-cosmos', 1, null));
	fixture('herdr-trust.txt', (d) => expectTrust(d, '/var/tmp/oh-test-trust-herdr'));
	fixture('hc-trust.txt', (d) => expectTrust(d, '/var/tmp/oh-test-trust-hc'));
	// After `shift+tab` with feedback: the plan is approved, the composer is back.
	fixture('hc-plan-after-approve-feedback.txt', (d) => expect(d.kind).toBe('unknown'));
});

/** What one narrow recording asked and typed; the four runs differ in their prompts and in what Claude wrote. */
interface Run {
	prefix: string;
	drink: string;
	drinkOptions: Option[];
	drinkTyped: string;
	fruitOptions: Option[];
	fruitTyped: string;
	size: string;
	sizeOptions: Option[];
	lidOptions: Option[];
	command: string;
	cwd: string;
	denyTyped: string;
	file: string;
	slug: string;
	planTyped: string;
	folder: string;
	/** The `Submit` row screens Claude repainted with the end of the typed answer left behind it. */
	tornSubmitRow: boolean;
}

const DRINK_60 = 'Which of these hot drinks would you like me to prepare for the long afternoon meeting today?';
const DRINK = 'Which of these hot drinks would you like me to prepare for the long afternoon meeting with the whole design team today?';
const TEA_60: Option = ['Tea with milk and a little honey', 'A mild black tea, served with milk and a spoon of honey on the side'];
const TEA: Option = [TEA_60[0], `${TEA_60[1]}, in the large mug`];
const APPLES_60 = 'Green apples from the orchard behind the old stone farmhouse';
const APPLES = `${APPLES_60} at the end of the lane`;
const SIZE_60 = 'Which cup size would you like for the coffee you are ordering this morning?';
const SIZE = 'Which cup size would you like for the coffee you are ordering this morning at the station kiosk?';
const NOTES = 'notes-from-the-long-afternoon-meeting-about-drinks.txt';
const TYPED_TEA = 'Light blue tea in the large mug with the chipped handle, please';
const TYPED_DENY = 'use mkdir for both of these instead, and name them with a date prefix';
const TYPED_PLAN = 'name it d.txt instead, and put the word plan in it twice please';

const HC: Omit<Run, 'prefix' | 'cwd' | 'slug' | 'folder' | 'tornSubmitRow'> = {
	drink: DRINK,
	drinkOptions: [TEA, ['Coffee', 'Coffee'], ['Water', 'Water']],
	drinkTyped: TYPED_TEA,
	fruitOptions: [
		[APPLES, 'Crisp'],
		['Banana', 'Banana'],
		['Cherry', 'Cherry'],
	],
	fruitTyped: 'Mango, Ripe 2, and wild strawberries from the garden',
	size: SIZE,
	sizeOptions: [
		['Small', 'Small'],
		['Large', 'Large'],
	],
	lidOptions: [
		['Yes', 'Yes'],
		['No', 'No'],
	],
	command: 'touch a-rather-long-file-name-for-wrapping-on-hc.txt another-quite-long-file-name-to-wrap-on-hc.txt',
	denyTyped: TYPED_DENY,
	file: NOTES,
	planTyped: TYPED_PLAN,
};

const RUNS: Run[] = [
	{
		prefix: 'herdr-60',
		drink: DRINK_60,
		drinkOptions: [TEA_60, ['Coffee', 'Coffee'], ['Water', 'Hot water']],
		drinkTyped: TYPED_TEA,
		fruitOptions: [
			[APPLES_60, 'Crisp'],
			['Banana', 'Banana'],
			['Cherry', 'Cherry'],
		],
		fruitTyped: 'Mango, Ripe 2, and a handful of wild strawberries from the garden',
		size: SIZE_60,
		sizeOptions: [
			['Small', 'A small cup'],
			['Large', 'A large cup'],
		],
		lidOptions: [
			['Yes', 'With a lid'],
			['No', 'Without a lid'],
		],
		command: 'touch a-rather-long-file-name-for-wrapping.txt another-quite-long-file-name-to-wrap.txt',
		cwd: '/tmp/oh-test-narrow-herdr60',
		denyTyped: TYPED_DENY,
		file: NOTES,
		slug: 'plan-a-one-step-change-peppy-lake',
		planTyped: TYPED_PLAN,
		folder: '/var/tmp/oh-test-trust-narrow-herdr',
		tornSubmitRow: false,
	},
	{
		// The same session as herdr-60, resized: its folder name says 60.
		prefix: 'herdr-90',
		drink: DRINK,
		drinkOptions: [TEA, ['Coffee', 'Coffee'], ['Water', 'Hot water']],
		drinkTyped: 'Light blue tea in the large mug with the chipped handle, and a slice of lemon on the side, please',
		fruitOptions: [
			[APPLES, 'Crisp'],
			['Banana', 'Banana'],
			['Cherry', 'Cherry'],
		],
		fruitTyped: 'Mango, Ripe 2, and a handful of wild strawberries from the garden behind the house',
		size: SIZE,
		sizeOptions: [
			['Small', 'A small cup'],
			['Large', 'A large cup'],
		],
		lidOptions: [
			['Yes', 'With a lid'],
			['No', 'Without a lid'],
		],
		command:
			'touch a-rather-long-file-name-for-wrapping-at-ninety.txt another-quite-long-file-name-to-wrap-at-ninety.txt',
		cwd: '/tmp/oh-test-narrow-herdr60',
		denyTyped: `${TYPED_DENY} in the ISO format`,
		file: 'notes-from-the-long-afternoon-meeting-about-drinks-and-lids.txt',
		slug: 'plan-a-one-step-change-peppy-lake',
		planTyped: `${TYPED_PLAN}, on two separate lines`,
		folder: '/var/tmp/oh-test-trust-narrow-herdr',
		tornSubmitRow: true,
	},
	{
		...HC,
		prefix: 'hc-60',
		cwd: '/tmp/oh-test-narrow-hc60',
		slug: 'plan-a-one-step-change-foamy-wigderson',
		folder: '/var/tmp/oh-test-trust-narrow-hc/a-nested-folder-with-a-rather-long-name-so-the-path-wraps',
		tornSubmitRow: true,
	},
	{
		...HC,
		prefix: 'hc-90',
		cwd: '/tmp/oh-test-narrow-hc90',
		slug: 'plan-a-one-step-change-spicy-catmull',
		folder: '/var/tmp/oh-test-trust-narrow-hc',
		tornSubmitRow: false,
	},
];

for (const run of RUNS) {
	describe(`screen dialogs: ${run.prefix} columns, wrapped`, () => {
		const name = (state: string) => `${run.prefix}-${state}.txt`;
		const drink = { question: run.drink, tabs: [['Drink', false]] as [string, boolean][], options: run.drinkOptions };
		fixture(name('ask-single'), (d) => expectQuestion(d, { ...drink, cursor: 1 }));
		fixture(name('ask-other-typed'), (d) => expectQuestion(d, { ...drink, text: run.drinkTyped, cursor: 4 }));

		const fruit = {
			question: 'Which fruits would you like in the salad?',
			options: run.fruitOptions,
			multiSelect: true,
		};
		fixture(name('ask-multi'), (d) => expectQuestion(d, { ...fruit, tabs: [['Fruit', false]], ticked: [], cursor: 1 }));
		fixture(name('ask-multi-ticked'), (d) =>
			expectQuestion(d, { ...fruit, tabs: [['Fruit', true]], ticked: [1, 3], cursor: 3 }),
		);
		fixture(name('ask-multi-other'), (d) =>
			expectQuestion(d, { ...fruit, tabs: [['Fruit', true]], ticked: [1, 3, 4], text: run.fruitTyped, cursor: 4 }),
		);
		if (run.tornSubmitRow) {
			// `❯    Submitrden`: the typed answer's last line left behind, and gone from its row.
			fixture(name('ask-multi-submit-row-torn'), (d) => expect(d.kind).toBe('unknown'));
		} else {
			fixture(name('ask-multi-submit-row'), (d) =>
				expectQuestion(d, { ...fruit, tabs: [['Fruit', true]], ticked: [1, 3, 4], text: run.fruitTyped, cursor: 'submit' }),
			);
		}
		fixture(name('ask-multi-review'), (d) =>
			expectReview(
				d,
				['Fruit'],
				[['Which fruits would you like in the salad?', `${run.fruitOptions[0]?.[0]}, Cherry, "${run.fruitTyped}"`]],
			),
		);

		fixture(name('ask-two'), (d) =>
			expectQuestion(d, {
				question: run.size,
				tabs: [
					['Size', false],
					['Lid', false],
				],
				options: run.sizeOptions,
				cursor: 1,
			}),
		);
		fixture(name('ask-two-second'), (d) =>
			expectQuestion(d, {
				question: 'Which lid?',
				tabs: [
					['Size', true],
					['Lid', false],
				],
				options: run.lidOptions,
				cursor: 1,
			}),
		);
		fixture(name('ask-two-review'), (d) =>
			expectReview(
				d,
				['Size', 'Lid'],
				[
					[run.size, 'Large'],
					['Which lid?', 'Yes'],
				],
			),
		);

		const bash = {
			tool: 'Bash' as const,
			command: run.command,
			prompt: 'Do you want to proceed?',
			options: ['Yes', `Yes, and always allow access to ${run.cwd} from this project`, BASH_OPTION_3, 'No'],
		};
		fixture(name('bash-permission'), (d) => expectPermission(d, { ...bash, cursor: 1 }));
		fixture(name('bash-deny-amend'), (d) => expectPermission(d, { ...bash, cursor: 4, amending: true, feedback: null }));
		fixture(name('bash-deny-feedback'), (d) =>
			expectPermission(d, { ...bash, cursor: 4, amending: true, feedback: run.denyTyped }),
		);
		const edits = ['Yes', EDITS_OPTION_2, 'No'];
		fixture(name('write-permission'), (d) =>
			expectPermission(d, {
				tool: 'Write',
				file: run.file,
				prompt: `Do you want to create ${run.file}?`,
				options: edits,
				cursor: 1,
			}),
		);
		fixture(name('edit-permission'), (d) =>
			expectPermission(d, {
				tool: 'Edit',
				file: run.file,
				prompt: `Do you want to make this edit to ${run.file}?`,
				options: edits,
				cursor: 1,
			}),
		);

		fixture(name('plan'), (d) => expectPlan(d, run.slug, 1, null));
		fixture(name('plan-feedback'), (d) => expectPlan(d, run.slug, 3, run.planTyped));
		fixture(name('trust'), (d) => expectTrust(d, run.folder));
	});
}

describe('screen dialogs: the dialog after an approved plan (#165’s live run)', () => {
	// A titled rule (`──── <name> ─`) sits under the hint, as the screen's last line.
	const write: PermissionWant = {
		tool: 'Write',
		file: 'd.txt',
		prompt: 'Do you want to create d.txt?',
		options: ['Yes', EDITS_OPTION_2, 'No'],
		cursor: 1,
	};
	fixture('herdr-write-after-plan.txt', (d) => {
		expectPermission(d, write);
		expect((d as PermissionDialog).content).toEqual([' 1 plan']);
	});
	fixture('hc-write-after-plan.txt', (d) => expectPermission(d, write));
});

describe('screen dialogs: every fixture is checked', () => {
	it('has a check for each recorded screen', () => {
		const files = readdirSync(DIR).filter((file) => file.endsWith('.txt'));
		expect(files.filter((file) => !checked.has(file))).toEqual([]);
		expect([...checked].filter((file) => !files.includes(file))).toEqual([]);
	});
});

/** A fixture with one line changed by `edit`, which must find a line to change. */
function altered(name: string, edit: (lines: string[]) => string[]): string {
	const lines = screen(name).split('\n');
	const out = edit([...lines]);
	expect(out.join('\n')).not.toBe(lines.join('\n'));
	return out.join('\n');
}

function replaceLine(lines: string[], from: RegExp, to: string): string[] {
	const i = lines.findIndex((line) => from.test(line));
	expect(i, `no line matches ${String(from)}`).toBeGreaterThanOrEqual(0);
	lines[i] = (lines[i] ?? '').replace(from, to);
	return lines;
}

/** The fixture's lines from the dialog's own rule down, the way a screen shorter than the dialog cuts it. */
function withoutRule(lines: string[], ruleFromBottom: number): string[] {
	const rules = lines.map((line, i) => (/^ *─{10,}$/.test(line) ? i : -1)).filter((i) => i >= 0);
	const rule = rules[rules.length - ruleFromBottom] ?? -1;
	return lines.slice(rule + 1);
}

describe('screen dialogs: anything not wholly one dialog is unknown', () => {
	const unknown = (text: string) => expect(parseClaudeScreen(text)).toEqual({ kind: 'unknown' });

	it('reads an empty screen and a bare composer as unknown', () => {
		unknown('');
		unknown('\n\n');
		unknown(['─'.repeat(60), '❯ ', '─'.repeat(60), '  0k   haiku', '  ⏸ manual mode on'].join('\n'));
	});

	it('refuses a dialog whose rule is off the top of the screen', () => {
		unknown(altered('herdr-ask-single.txt', (lines) => withoutRule(lines, 2)));
		unknown(altered('hc-60-bash-permission.txt', (lines) => withoutRule(lines, 1)));
		unknown(altered('herdr-60-trust.txt', (lines) => withoutRule(lines, 1)));
		unknown(altered('herdr-60-plan.txt', (lines) => withoutRule(lines, 2)));
	});

	it('drops a titled rule only as the last line, with a name for its title', () => {
		const titled = screen('herdr-write-after-plan.txt');
		const rule = /^─+ create-d-txt-file ─$/m;
		expect(parseClaudeScreen(titled).kind).toBe('permission');
		// Anything after it, the title not a name, no title, or a rule that does not end in `─`.
		unknown(`${titled.trimEnd()}\n❯ something typed below`);
		unknown(`${titled.trimEnd()}\n${'─'.repeat(20)} another-name ─`);
		unknown(titled.replace(rule, `${'─'.repeat(40)} Create D txt file ─`));
		unknown(titled.replace(rule, `${'─'.repeat(40)} create-d-txt-file`));
		unknown(titled.replace(rule, `${'─'.repeat(40)} create-d-txt-file ─ x`));
		unknown(titled.replace(rule, `─── create-d-txt-file ─`));
		// Above the hint, it is a line inside the dialog.
		unknown(
			altered('herdr-write-permission.txt', (lines) =>
				replaceLine(lines, /^ Esc to cancel · Tab to amend$/, `${'─'.repeat(40)} b-txt ─\n Esc to cancel · Tab to amend`),
			),
		);
	});

	it('refuses a screen with a line after the dialog', () => {
		for (const name of ['herdr-ask-single.txt', 'herdr-bash-permission.txt', 'herdr-plan.txt', 'herdr-trust.txt', 'herdr-ask-two-review.txt']) {
			unknown(`${screen(name).trimEnd()}\n❯ something typed below`);
		}
	});

	it('refuses two cursors, or none', () => {
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^ {2}2\. Coffee$/, '❯ 2. Coffee')));
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^❯ 1\. Tea$/, '  1. Tea')));
		unknown(altered('herdr-ask-multi.txt', (lines) => replaceLine(lines, /^ {5}Submit$/, '❯    Submit')));
		unknown(altered('herdr-bash-permission.txt', (lines) => replaceLine(lines, /^ {3}4\. No$/, ' ❯ 4. No')));
		unknown(altered('herdr-plan.txt', (lines) => replaceLine(lines, /^ {3}❯ 1\./, '     1.')));
		unknown(altered('herdr-trust.txt', (lines) => replaceLine(lines, /^ {3}Yes, I trust/, ' ❯ Yes, I trust')));
		unknown(altered('herdr-ask-two-review.txt', (lines) => replaceLine(lines, /^ {2}2\. Cancel$/, '❯ 2. Cancel')));
	});

	it('refuses rows numbered out of turn', () => {
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^ {2}2\. Coffee$/, '  7. Coffee')));
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^ {2}5\. Chat about this$/, '  6. Chat about this')));
		unknown(altered('herdr-bash-permission.txt', (lines) => replaceLine(lines, /^ {3}3\. Yes/, '   5. Yes')));
	});

	it('refuses a Submit row with anything after it', () => {
		unknown(altered('herdr-ask-multi.txt', (lines) => replaceLine(lines, /^ {5}Submit$/, '     Submitted')));
	});

	it('refuses a multi-select row without its box, or a box on a single-choice row', () => {
		unknown(altered('herdr-ask-multi.txt', (lines) => replaceLine(lines, /^ {2}2\. \[ \] Banana$/, '  2. Banana')));
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^ {2}2\. Coffee$/, '  2. [ ] Coffee')));
	});

	it('refuses a permission whose last row is not No', () => {
		unknown(altered('herdr-bash-permission.txt', (lines) => replaceLine(lines, /^ {3}4\. No$/, '   4. Never')));
	});

	it('refuses a permission without both dotted rules', () => {
		unknown(
			altered('herdr-bash-permission.txt', (lines) => {
				const i = lines.findIndex((line) => /^╌+$/.test(line));
				lines.splice(i, 1);
				return lines;
			}),
		);
	});

	it('refuses a plan whose wording or rows differ', () => {
		unknown(altered('herdr-plan.txt', (lines) => replaceLine(lines, /2\. Yes, manually approve edits/, '2. Yes, approve')));
		unknown(altered('herdr-plan.txt', (lines) => replaceLine(lines, /shift\+tab to approve with this feedback/, 'shift+tab')));
		unknown(altered('herdr-plan.txt', (lines) => replaceLine(lines, /ready to execute\./, 'ready.')));
	});

	it('keeps a plan whose hint names no plans file, without a file', () => {
		const text = altered('herdr-plan.txt', (lines) => replaceLine(lines, /~\/\.claude\/plans\/.*\.md$/, '~/notes/x.md'));
		const dialog = parseClaudeScreen(text) as PlanDialog;
		expect(dialog.kind).toBe('plan');
		expect(dialog.planFile).toBeNull();
		expect(dialog.slug).toBeNull();
	});

	it('refuses a trust prompt with other options', () => {
		unknown(altered('herdr-trust.txt', (lines) => replaceLine(lines, /No, exit$/, 'No, go back')));
		unknown(altered('herdr-trust.txt', (lines) => replaceLine(lines, /Yes, I trust this folder$/, 'Yes, trust it')));
	});

	it('refuses a review with a third row or no answer', () => {
		unknown(`${screen('herdr-ask-two-review.txt').trimEnd()}\n  3. Something else`);
		unknown(altered('herdr-ask-two-review.txt', (lines) => lines.filter((line) => !line.startsWith('   → '))));
	});

	it('refuses a question whose hint is not a question’s', () => {
		unknown(altered('herdr-ask-single.txt', (lines) => replaceLine(lines, /^Enter to select/, 'Enter to confirm')));
	});
});

describe('screen dialogs: the cursor where it was moved', () => {
	it('reads the cursor on the chat row and on the trust prompt’s yes', () => {
		const chat = altered('herdr-ask-single.txt', (lines) =>
			replaceLine(replaceLine(lines, /^❯ 1\. Tea$/, '  1. Tea'), /^ {2}5\. Chat about this$/, '❯ 5. Chat about this'),
		);
		expect((parseClaudeScreen(chat) as QuestionDialog).cursor).toBe(5);
		const yes = altered('herdr-trust.txt', (lines) =>
			replaceLine(replaceLine(lines, /^ ❯ No, exit$/, '   No, exit'), /^ {3}Yes, I trust/, ' ❯ Yes, I trust'),
		);
		expect((parseClaudeScreen(yes) as TrustDialog).cursor).toBe('yes');
	});
});

describe('screen dialogs: text kept as wrapped', () => {
	it('matches a wrap that swallowed spaces, a line break or nothing', () => {
		expect(wrappedEquals(['touch a.txt', 'b.txt'], 'touch a.txt b.txt')).toBe(true);
		expect(wrappedEquals(['touch a.txt', 'b.txt'], 'touch a.txt   b.txt')).toBe(true);
		expect(wrappedEquals(['line one', 'line two'], 'line one\nline two')).toBe(true);
		expect(wrappedEquals(['/var/tmp/a-ra', 'ther'], '/var/tmp/a-rather')).toBe(true);
		expect(wrappedEquals(['Tea', 'A mild tea'], 'Tea\nA mild tea')).toBe(true);
		expect(wrappedEquals([], '')).toBe(true);
	});

	it('does not match other text, more text, less text or two line breaks', () => {
		expect(wrappedEquals(['touch a.txt', 'b.txt'], 'touch a.txt c.txt')).toBe(false);
		expect(wrappedEquals(['touch a.txt'], 'touch a.txt b.txt')).toBe(false);
		expect(wrappedEquals(['touch a.txt', 'b.txt'], 'touch a.txt')).toBe(false);
		expect(wrappedEquals(['a', 'b'], 'a\n\nb')).toBe(false);
		expect(wrappedEquals(['Yes, and'], 'Yes')).toBe(false);
		expect(wrappedEquals(['Tea', 'Tea'], 'Tea')).toBe(false);
		expect(wrappedEquals([], 'x')).toBe(false);
	});

	it('joins lines for showing', () => {
		expect(joinWrapped(['Yes, and always allow access to', '/tmp/x from this project'])).toBe(
			'Yes, and always allow access to /tmp/x from this project',
		);
	});
});

describe('screen dialogs: through the agent seam', () => {
	it('is Claude’s format’s screen reader', () => {
		const format = agentFormat('claude');
		expect(format?.screenDialog).toBeDefined();
		expect(format?.screenDialog?.(screen('herdr-trust.txt')).kind).toBe('trust');
	});
});
