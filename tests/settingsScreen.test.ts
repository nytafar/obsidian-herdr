/**
 * Claude Code 2.1.318's settings screens read off the screen (issues #169,
 * #170): the `/model` and `/effort` pickers, the "Switch model?" confirm and
 * the prompt's footer in each mode, over the screens recorded for them in
 * `tests/fixtures/screens/claude-2.1.318/` (wide and at 60 columns, herdr and
 * hc). The driver presses keys on what these say, so the tests below the
 * fixtures are screens it must not read as a picker.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SCREEN_SETTINGS, commandResult, parseClaudeSettingsScreen } from '../src/agents/claude/screenDialog';
import { agentFormat } from '../src/agents/format';
import type {
	EffortPickerScreen,
	ModelPickerScreen,
	PromptScreen,
	SettingsScreen,
	SwitchModelScreen,
} from '../src/agents/settingsScreen';

const DIR = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const parse = (name: string): SettingsScreen => parseClaudeSettingsScreen(screen(name));

const RUNS = ['herdr-', 'hc-', 'herdr-60-', 'hc-60-'] as const;
const WIDE = ['herdr-', 'hc-'] as const;

/** The rows as `n label` with a `*` on the current one. */
function rowsOf(picker: SettingsScreen): string[] {
	expect(picker.kind).toBe('model-picker');
	return (picker as ModelPickerScreen).rows.map((row) => `${row.number} ${row.label}${row.current ? ' *' : ''}`);
}

const OPENED = [
	'1 Default (recommended)',
	'2 Opus 5.5',
	'3 Fable 5.1',
	'4 Sonnet 5.5',
	'5 Haiku 5.5 *',
	'6 Haiku 4.5',
	'7 Sonnet 5',
	'8 Opus 5',
	'9 Fable 5',
	'10 Opus 4.8',
];

describe('the model picker', () => {
	for (const p of RUNS) {
		it(`${p}model-picker: every row by its name, the cursor on the current model`, () => {
			const picker = parse(`${p}model-picker.txt`) as ModelPickerScreen;
			expect(rowsOf(picker)).toEqual(OPENED);
			expect(picker.cursor).toBe(5);
		});
		it(`${p}model-picker-back: "No, go back" is the picker again, on the current model`, () => {
			const picker = parse(`${p}model-picker-back.txt`) as ModelPickerScreen;
			expect(rowsOf(picker)).toEqual(OPENED);
			expect(picker.cursor).toBe(5);
		});
	}
	for (const p of WIDE) {
		it(`${p}model-picker-scrolled: a scrolled list keeps its numbers`, () => {
			const picker = parse(`${p}model-picker-scrolled.txt`) as ModelPickerScreen;
			expect(rowsOf(picker)).toEqual([...OPENED.slice(1), '11 Opus 4.7']);
			expect(picker.cursor).toBe(11);
		});
	}

	it('finds the row a choice means by name: the newest of its family, never the default row', () => {
		const picker = parse('herdr-60-model-picker.txt') as ModelPickerScreen;
		const row = (value: string): string | undefined =>
			CLAUDE_SCREEN_SETTINGS.modelRow({ value, label: value }, picker.rows)?.label;
		expect(row('opus')).toBe('Opus 5.5');
		expect(row('sonnet')).toBe('Sonnet 5.5');
		expect(row('haiku')).toBe('Haiku 5.5');
		expect(row('fable')).toBe('Fable 5.1');
		expect(row('default')).toBeUndefined();
		expect(row('gpt')).toBeUndefined();
		expect(CLAUDE_SCREEN_SETTINGS.isModel({ value: 'sonnet', label: 'Sonnet' }, 'Sonnet 5.5')).toBe(true);
		expect(CLAUDE_SCREEN_SETTINGS.isModel({ value: 'sonnet', label: 'Sonnet' }, 'Opus 5.5')).toBe(false);
	});
});

describe('the effort picker', () => {
	for (const p of RUNS) {
		it(`${p}effort-picker: the levels, and medium under the mark`, () => {
			expect(parse(`${p}effort-picker.txt`)).toEqual<EffortPickerScreen>({
				kind: 'effort-picker',
				levels: ['low', 'medium', 'high', 'xhigh', 'max'],
				selected: 'medium',
			});
		});
		it(`${p}effort-picker-right: high after one right`, () => {
			expect((parse(`${p}effort-picker-right.txt`) as EffortPickerScreen).selected).toBe('high');
		});
	}

	it('reads the mark at each level, and no level when it stands between two', () => {
		const lines = screen('herdr-60-effort-picker.txt').split('\n');
		const at = lines.findIndex((line) => line.includes('▲'));
		const scale = lines[at + 1] ?? '';
		const moved = (column: number): SettingsScreen => {
			const copy = [...lines];
			const width = (lines[at] ?? '').trimStart().length;
			const indent = (lines[at] ?? '').length - width;
			copy[at] = `${' '.repeat(indent)}${'─'.repeat(column - indent)}▲${'─'.repeat(width - 1 - (column - indent))}`;
			return parseClaudeSettingsScreen(copy.join('\n'));
		};
		for (const word of ['low', 'medium', 'high', 'xhigh', 'max']) {
			const start = scale.indexOf(word);
			expect((moved(start + Math.floor(word.length / 2)) as EffortPickerScreen).selected, word).toBe(word);
		}
		// Halfway between `low` and `medium`.
		const between = Math.floor((scale.indexOf('low') + 3 + scale.indexOf('medium')) / 2);
		expect((moved(between) as EffortPickerScreen).selected).toBeNull();
	});
});

describe('the switch confirm', () => {
	for (const p of RUNS) {
		it(`${p}switch-model: the model it switches to, the cursor on yes`, () => {
			const dialog = parse(`${p}switch-model.txt`) as SwitchModelScreen;
			expect(dialog).toMatchObject({
				kind: 'switch-model',
				title: 'Switch model?',
				target: 'Sonnet 5.5',
				yes: 'Yes, switch to Sonnet 5.5',
				no: 'No, go back',
				cursor: 'yes',
			});
			expect(dialog.body.join(' ')).toContain('Your next response will be slower and use more tokens');
		});
	}

	it('refuses a confirm whose body names another model than its yes row', () => {
		const text = screen('herdr-switch-model.txt').replace('Switching to Sonnet 5.5', 'Switching to Opus 5.5');
		expect(parseClaudeSettingsScreen(text).kind).toBe('unknown');
	});
});

describe('the prompt and its footer', () => {
	const modes: [string, string][] = [
		['footer-manual', 'default'],
		['footer-accept-edits', 'acceptEdits'],
		['footer-plan', 'plan'],
		['footer-auto', 'auto'],
	];
	for (const p of RUNS) {
		for (const [name, mode] of modes) {
			it(`${p}${name}: ${mode}`, () => {
				const prompt = parse(`${p}${name}.txt`) as PromptScreen;
				expect(prompt.kind).toBe('prompt');
				expect(prompt.mode).toBe(mode);
			});
		}
	}

	it('reads the newest command and what it printed', () => {
		expect((parse('herdr-footer-auto.txt') as PromptScreen).last).toEqual({
			echo: '/model',
			result: { kind: 'kept', label: 'Haiku 5.5' },
		});
		// Before anything was sent: no history.
		expect((parse('hc-footer-manual.txt') as PromptScreen).last).toBeNull();
	});

	it('reads a footer it does not know as no mode', () => {
		const text = screen('herdr-footer-plan.txt').replace('⏸ plan mode on', '⏸ some new mode on');
		expect(parseClaudeSettingsScreen(text)).toMatchObject({ kind: 'prompt', mode: null });
	});
});

describe('what a settings command printed', () => {
	it('reads each of the measured outcomes', () => {
		expect(commandResult('Set model to Sonnet 5.5 for this session only')).toEqual({
			kind: 'model',
			label: 'Sonnet 5.5',
			scope: 'session',
		});
		expect(commandResult('Set model to `Sonnet 5.5` for this session only with `medium` effort')).toEqual({
			kind: 'model',
			label: 'Sonnet 5.5',
			scope: 'session',
		});
		expect(commandResult('Set model to Haiku 5.5 and saved as your default for new sessions')).toEqual({
			kind: 'model',
			label: 'Haiku 5.5',
			scope: 'default',
		});
		expect(
			commandResult('Set effort level to medium (this session only): Balanced approach with standard implementation and testing'),
		).toEqual({ kind: 'effort', level: 'medium', scope: 'session' });
		expect(commandResult('Set effort level to low (saved as your default for new sessions): Quick')).toEqual({
			kind: 'effort',
			level: 'low',
			scope: 'default',
		});
		expect(commandResult('Kept model as Haiku 5.5')).toEqual({ kind: 'kept', label: 'Haiku 5.5' });
		expect(commandResult('Cancelled')).toEqual({ kind: 'cancelled' });
		expect(commandResult("Model 'bogus' not found")).toEqual({ kind: 'other', text: "Model 'bogus' not found" });
	});
});

describe('screens that are no settings screen', () => {
	it('reads every dialog fixture as no picker and no prompt', () => {
		const dialogs = readdirSync(DIR).filter(
			(file) => file.endsWith('.txt') && !/(model-picker|effort-picker|switch-model|footer-)/.test(file),
		);
		expect(dialogs.length).toBeGreaterThan(50);
		for (const file of dialogs) {
			const kind = parse(file).kind;
			// A torn repaint or a screen after a dialog was answered may show the prompt; none shows a picker.
			expect(['unknown', 'prompt'], file).toContain(kind);
		}
	});

	it('refuses a picker with two cursors, a gap in its numbers, or another hint', () => {
		const lines = screen('herdr-model-picker.txt');
		expect(parseClaudeSettingsScreen(lines.replace('     4.  Sonnet 5.5', '   ❯ 4.  Sonnet 5.5')).kind).toBe('unknown');
		expect(parseClaudeSettingsScreen(lines.replace('     4.  Sonnet 5.5', '     7.  Sonnet 5.5')).kind).toBe('unknown');
		expect(parseClaudeSettingsScreen(lines.replace('s to use this session only', 's to save')).kind).toBe('unknown');
		expect(parseClaudeSettingsScreen(lines.replace('   Select model', '   Select a model')).kind).toBe('unknown');
	});

	it("is Claude's format's reader", () => {
		expect(agentFormat('claude')?.screenSettings).toBe(CLAUDE_SCREEN_SETTINGS);
	});
});
