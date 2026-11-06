/**
 * The herdr and herdr-core session settings sender (issues #169, #170),
 * against a simulated Claude whose screens are the ones recorded from Claude
 * Code 2.1.318 (`fixtures/screens/claude-2.1.318/herdr-*`): the `/model` and
 * `/effort` pickers, the "Switch model?" confirm and the footer in each
 * mode, with the cursor, the slider's mark and the history redrawn as keys
 * land. The simulation also records what must never happen: `enter` or a
 * digit in a picker (both save the default), a command typed into a picker,
 * a key pressed while a dialog Claude asks with is up.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import { CLAUDE_SCREEN_SETTINGS } from '../src/agents/claude/screenDialog';
import type { ScreenAccess, ScreenKey } from '../src/native/screenAccess';
import { BUSY_REASON, screenSettingsSender } from '../src/native/screenSettings';
import type { SessionSettingsSender, SettingQuestion } from '../src/native/sessionSettings';
import { createHerdrKind } from '../src/runtime/herdrKind';
import { createHerdrCoreKind } from '../src/runtime/herdrCoreKind';
import { FakeClock } from './fixtures/fakeClaudeScreen';

const DIR = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8');

const PROMPT = fixture('herdr-footer-manual.txt');
const MODEL_PICKER = fixture('herdr-model-picker.txt');
const EFFORT_PICKER = fixture('herdr-effort-picker.txt');
const SWITCH = fixture('herdr-switch-model.txt');
const PERMISSION = fixture('herdr-bash-permission.txt');

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOOTERS: Record<string, string> = {
	default: '  ⏸ manual mode on',
	acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
	plan: '  ⏸ plan mode on (shift+tab to cycle)',
	auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
};
const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
/** Rows 1-9 of the recorded picker, by number. */
const ROWS = ['Default (recommended)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5'];

type View = 'prompt' | 'model' | 'effort' | 'switch' | 'dialog';

/** Claude, as far as its settings screens go, drawn from the recorded ones. */
class FakeClaude implements ScreenAccess {
	view: View = 'prompt';
	mode = 'default';
	model = 'Haiku 5.5';
	effort = 'medium';
	/** Whether the conversation has a reply: a switch then asks first. */
	replies = false;
	status = 'idle';
	statuses: string[] = [];
	cursor = 5;
	level = 1;
	switchTo: { label: string; scope: 'session' | 'default' } | null = null;
	history: [string, string][] = [];
	readonly keys: string[] = [];
	readonly sent: string[] = [];
	/** What must never happen; every case checks it is empty. */
	readonly wrong: string[] = [];
	/** Keys that are taken by the call and never land. */
	drop = new Set<string>();
	/** Claude saying something else than what was done. */
	misreport: string | null = null;
	/** The command that does nothing at all. */
	ignore: string | null = null;

	async read(): Promise<string> {
		return this.draw();
	}

	async press(_paneId: string, key: ScreenKey): Promise<void> {
		this.keys.push(key);
		if (this.drop.has(key)) return;
		this.key(key);
	}

	async type(): Promise<void> {
		this.wrong.push('typed text');
	}

	async send(_paneId: string, text: string): Promise<void> {
		this.sent.push(text);
		if (this.view !== 'prompt') {
			this.wrong.push(`sent "${text}" while ${this.view} was up`);
			return;
		}
		if (text === this.ignore) return;
		const [command, arg] = text.split(' ');
		if (command === '/model' && !arg) {
			this.view = 'model';
			this.cursor = ROWS.indexOf(this.model) + 1;
		} else if (command === '/effort' && !arg) {
			this.view = 'effort';
			this.level = LEVELS.indexOf(this.effort);
		} else if (command === '/model' && arg) {
			const label = ROWS.find((row) => row.toLowerCase().startsWith(`${arg} `)) ?? arg;
			if (this.replies && label !== this.model) {
				this.view = 'switch';
				this.switchTo = { label, scope: 'default' };
			} else {
				this.setModel(text, label, 'default');
			}
		} else if (command === '/effort' && arg) {
			this.effort = arg;
			this.history.push([text, `Set effort level to ${arg} (saved as your default for new sessions): Quick`]);
		}
	}

	private setModel(echo: string, label: string, scope: 'session' | 'default'): void {
		this.model = label;
		const how = scope === 'session' ? 'for this session only' : 'and saved as your default for new sessions';
		this.history.push([echo, this.misreport ?? `Set model to ${label} ${how}`]);
		this.view = 'prompt';
	}

	private key(key: ScreenKey): void {
		if (/^\d$/.test(key)) this.wrong.push(`digit ${key} on ${this.view}`);
		switch (this.view) {
			case 'dialog':
				this.wrong.push(`${key} on a dialog`);
				return;
			case 'prompt':
				if (key === 'shift+tab') this.mode = CYCLE[(CYCLE.indexOf(this.mode) + 1) % CYCLE.length] ?? 'default';
				else this.wrong.push(`${key} on the prompt`);
				return;
			case 'model':
				if (key === 'up') this.cursor = Math.max(1, this.cursor - 1);
				else if (key === 'down') this.cursor = Math.min(ROWS.length, this.cursor + 1);
				else if (key === 'esc') {
					this.history.push(['/model', `Kept model as ${this.model}`]);
					this.view = 'prompt';
				} else if (key === 's') {
					const label = ROWS[this.cursor - 1] ?? '';
					if (this.replies && label !== this.model) {
						this.view = 'switch';
						this.switchTo = { label, scope: 'session' };
					} else this.setModel('/model', label, 'session');
				} else this.wrong.push(`${key} in the model picker`);
				return;
			case 'effort':
				if (key === 'left') this.level = Math.max(0, this.level - 1);
				else if (key === 'right') this.level = Math.min(LEVELS.length - 1, this.level + 1);
				else if (key === 'esc') {
					this.history.push(['/effort', 'Cancelled']);
					this.view = 'prompt';
				} else if (key === 's') {
					this.effort = LEVELS[this.level] ?? '';
					this.history.push(['/effort', this.misreport ?? `Set effort level to ${this.effort} (this session only): Balanced`]);
					this.view = 'prompt';
				} else this.wrong.push(`${key} in the effort picker`);
				return;
			case 'switch': {
				const to = this.switchTo;
				if (!to) return;
				if (key === 'enter') this.setModel(to.scope === 'session' ? '/model' : `/model ${to.label.split(' ')[0]?.toLowerCase()}`, to.label, to.scope);
				else if (key === 'esc') {
					if (to.scope === 'session') {
						this.view = 'model';
						this.cursor = ROWS.indexOf(this.model) + 1;
					} else {
						this.history.push([`/model ${to.label.split(' ')[0]?.toLowerCase()}`, `Kept model as ${this.model}`]);
						this.view = 'prompt';
					}
				} else this.wrong.push(`${key} on the switch confirm`);
				return;
			}
		}
	}

	draw(): string {
		switch (this.view) {
			case 'dialog':
				return PERMISSION;
			case 'model':
				return MODEL_PICKER.split('\n')
					.map((line) => {
						const row = /^ {3}[❯ ] (\d)\. /.exec(line);
						if (!row) return line;
						return `   ${Number(row[1]) === this.cursor ? '❯' : ' '}${line.slice(4)}`;
					})
					.join('\n');
			case 'effort': {
				const lines = EFFORT_PICKER.split('\n');
				const at = lines.findIndex((line) => line.includes('▲'));
				const scale = lines[at + 1] ?? '';
				const word = LEVELS[this.level] ?? 'low';
				const mark = scale.indexOf(word) + Math.floor((word.length - 1) / 2);
				const slider = lines[at] ?? '';
				const indent = slider.length - slider.trimStart().length;
				lines[at] = `${' '.repeat(indent)}${'─'.repeat(mark - indent)}▲${'─'.repeat(slider.length - mark - 1)}`;
				return lines.join('\n');
			}
			case 'switch':
				return SWITCH.split('Sonnet 5.5').join(this.switchTo?.label ?? '');
			case 'prompt': {
				const lines = PROMPT.split('\n');
				while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
				lines[lines.length - 1] = FOOTERS[this.mode] ?? '';
				const top = lines.findIndex((line) => /^─{10,}$/.test(line));
				const history = this.history.flatMap(([echo, result]) => [`❯ ${echo}`, `  ⎿  ${result}`]);
				lines.splice(top, 0, ...history);
				return `${lines.join('\n')}\n`;
			}
		}
	}
}

function setup(configure: (claude: FakeClaude) => void = () => {}) {
	const claude = new FakeClaude();
	configure(claude);
	const clock = new FakeClock();
	const owner = {};
	const sender = screenSettingsSender({
		screen: claude,
		prompt: { send: (paneId, text) => claude.send(paneId, text) },
		reader: CLAUDE_SCREEN_SETTINGS,
		// A status queued up is reported once each, before the standing one.
		status: () => Promise.resolve(claude.statuses.shift() ?? claude.status),
		owner: () => owner,
		models: CLAUDE_FORMAT.models,
		modeLabels: CLAUDE_FORMAT.modeLabels,
		clock,
	});
	const run = <T>(promise: Promise<T>): Promise<T> => clock.run(promise);
	// Caught at once: the fake clock lets the event loop turn before it awaits.
	const outcome = (promise: Promise<unknown>): Promise<string> =>
		run(promise.then(() => 'ok', (error: unknown) => (error as Error).message));
	return { claude, sender, run, outcome, clock };
}

const PANE = 't1';

describe('the model, this session only (#169)', () => {
	it('opens the picker, moves to the row by its name, and presses s', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session'))).toBe('ok');
		expect(claude.sent).toEqual(['/model']);
		expect(claude.keys).toEqual(['up', 's']);
		expect(claude.model).toBe('Sonnet 5.5');
		expect(claude.wrong).toEqual([]);
	});

	it('goes down as far as the row is: Fable 5.1 is the newest Fable', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.model = 'Default (recommended)';
		});
		expect(await outcome(sender.setModel(PANE, 'fable', 'session'))).toBe('ok');
		expect(claude.keys).toEqual(['down', 'down', 's']);
		expect(claude.model).toBe('Fable 5.1');
	});

	it('puts "Switch model?" to the user with Claude\'s words, and answers yes with enter on the yes row', async () => {
		const asked: SettingQuestion[] = [];
		const { claude, sender, outcome } = setup((c) => {
			c.replies = true;
		});
		const ask = (question: SettingQuestion) => {
			asked.push(question);
			return Promise.resolve(true);
		};
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session', ask))).toBe('ok');
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ title: 'Switch model?', confirm: 'Yes, switch to Sonnet 5.5', cancel: 'No, go back' });
		expect(asked[0]?.body).toContain('Switching to Sonnet 5.5 means the full history gets re-read.');
		expect(claude.keys).toEqual(['up', 's', 'enter']);
		expect(claude.model).toBe('Sonnet 5.5');
		expect(claude.wrong).toEqual([]);
	});

	it('goes back on a no, leaving the model as it was and saying nothing went wrong', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.replies = true;
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session', () => Promise.resolve(false)))).toBe('ok');
		// `esc` on the confirm is the picker again, a second `esc` leaves it.
		expect(claude.keys).toEqual(['up', 's', 'esc', 'esc']);
		expect(claude.model).toBe('Haiku 5.5');
		expect(claude.view).toBe('prompt');
		expect(claude.history.at(-1)).toEqual(['/model', 'Kept model as Haiku 5.5']);
	});

	it('leaves the picker with esc, and says so, when it lists no such model', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setModel(PANE, 'gpt', 'session'))).toBe(
			"Claude's model picker lists no gpt model; nothing was changed",
		);
		expect(claude.keys).toEqual(['esc']);
		expect(claude.view).toBe('prompt');
		expect(claude.wrong).toEqual([]);
	});

	it('refuses with esc when the cursor does not follow, and never presses s', async () => {
		const { claude, sender, outcome, clock } = setup((c) => {
			c.drop.add('up');
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session'))).toBe(
			'the picker did not follow the keys; nothing was changed',
		);
		expect(claude.keys).toEqual(['up', 'esc']);
		expect(claude.model).toBe('Haiku 5.5');
		expect(clock.now()).toBeGreaterThanOrEqual(3000);
	});

	it('leaves a picker already on the session\'s model with esc, changing nothing', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setModel(PANE, 'haiku', 'session'))).toBe('ok');
		expect(claude.keys).toEqual(['esc']);
	});

	it('reports a result that says the default was saved, as what it is', async () => {
		const { sender, outcome } = setup((c) => {
			c.misreport = 'Set model to Sonnet 5.5 and saved as your default for new sessions';
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session'))).toBe(
			'Claude set Sonnet 5.5 and saved it as your default for new sessions',
		);
	});

	it('presses nothing when the picker never opens', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.ignore = '/model';
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session'))).toBe('the model picker did not open; nothing was changed');
		expect(claude.keys).toEqual([]);
	});
});

describe('what a change starts from', () => {
	it('sends nothing while Claude works', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.status = 'working';
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'session'))).toBe('Claude is working; change it after this turn');
		expect(claude.sent).toEqual([]);
		expect(claude.keys).toEqual([]);
	});

	it('waits out the moment herdr still calls a closed picker blocked', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.statuses = ['blocked', 'blocked', 'blocked'];
		});
		expect(await outcome(sender.setEffort(PANE, 'high', 'session'))).toBe('ok');
		expect(claude.keys).toEqual(['right', 's']);
	});

	it('refuses a status that stays blocked, sending nothing', async () => {
		const { claude, sender, outcome, clock } = setup((c) => {
			c.status = 'blocked';
		});
		expect(await outcome(sender.setEffort(PANE, 'high', 'session'))).toBe('Claude is not waiting for a prompt');
		expect(clock.now()).toBeGreaterThanOrEqual(5000);
		expect(claude.sent).toEqual([]);
	});

	it('sends nothing, and presses no esc, over a dialog Claude asks with', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.view = 'dialog';
		});
		expect(await outcome(sender.setEffort(PANE, 'high', 'session'))).toBe(
			'the terminal shows something over the prompt; finish it there first (nothing was changed)',
		);
		expect(claude.sent).toEqual([]);
		expect(claude.keys).toEqual([]);
	});

	it('sends nothing over a picker someone left open in the terminal', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.view = 'model';
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'default'))).toContain('finish it there first');
		expect(claude.sent).toEqual([]);
		expect(claude.keys).toEqual([]);
	});

	it('runs one change per pane at a time', async () => {
		const { sender, run } = setup();
		const first = sender.setModel(PANE, 'sonnet', 'session');
		expect(sender.unavailable?.(PANE)).toBe(BUSY_REASON);
		await expect(sender.setEffort(PANE, 'high', 'session')).rejects.toThrow(BUSY_REASON);
		await run(first);
		expect(sender.unavailable?.(PANE)).toBeNull();
	});

	it('offers both scopes for model and effort, idle or done only, and no mode yet', () => {
		const { sender } = setup();
		expect(sender.scopes).toEqual(['session', 'default']);
		expect(sender.midTurn).toBe(false);
		expect(sender.settings).toEqual(['model', 'effort']);
	});
});

describe('the model, for new sessions too (#169)', () => {
	it('sends the command with its argument and checks what Claude printed', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'default'))).toBe('ok');
		expect(claude.sent).toEqual(['/model sonnet']);
		expect(claude.keys).toEqual([]);
	});

	it('answers the confirm the same way', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.replies = true;
		});
		expect(await outcome(sender.setModel(PANE, 'opus', 'default', () => Promise.resolve(true)))).toBe('ok');
		expect(claude.keys).toEqual(['enter']);
		expect(claude.model).toBe('Opus 5.5');
	});

	it('goes back from the confirm on a no', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.replies = true;
		});
		expect(await outcome(sender.setModel(PANE, 'opus', 'default', () => Promise.resolve(false)))).toBe('ok');
		expect(claude.keys).toEqual(['esc']);
		expect(claude.model).toBe('Haiku 5.5');
	});

	it('does not take an older line for this command\'s', async () => {
		const { claude, sender, outcome } = setup((c) => {
			c.history.push(['/model sonnet', 'Set model to Sonnet 5.5 and saved as your default for new sessions']);
			c.ignore = '/model sonnet';
		});
		expect(await outcome(sender.setModel(PANE, 'sonnet', 'default'))).toBe(
			'Claude did not say what it made of /model sonnet; look in the terminal',
		);
		expect(claude.keys).toEqual([]);
	});
});

describe('the effort (#169)', () => {
	it('this session only: the slider moved to the level, then s', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setEffort(PANE, 'max', 'session'))).toBe('ok');
		expect(claude.sent).toEqual(['/effort']);
		expect(claude.keys).toEqual(['right', 'right', 'right', 's']);
		expect(claude.effort).toBe('max');
		expect(claude.wrong).toEqual([]);
	});

	it('to the left as well', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setEffort(PANE, 'low', 'session'))).toBe('ok');
		expect(claude.keys).toEqual(['left', 's']);
	});

	it('refuses a level the slider does not have, with esc', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setEffort(PANE, 'auto', 'session'))).toBe(
			'Claude\'s effort picker has no auto for this session; "Use for new sessions too" sets it; nothing was changed',
		);
		expect(claude.keys).toEqual(['esc']);
		expect(claude.effort).toBe('medium');
	});

	it('reports a result that says the default was saved', async () => {
		const { sender, outcome } = setup((c) => {
			c.misreport = 'Set effort level to high (saved as your default for new sessions): Deeper';
		});
		expect(await outcome(sender.setEffort(PANE, 'high', 'session'))).toBe(
			'Claude set high and saved it as your default for new sessions',
		);
	});

	it('for new sessions too: the command with its level', async () => {
		const { claude, sender, outcome } = setup();
		expect(await outcome(sender.setEffort(PANE, 'auto', 'default'))).toBe('ok');
		expect(claude.sent).toEqual(['/effort auto']);
		expect(claude.keys).toEqual([]);
	});
});

describe('the kinds (#169, #170)', () => {
	it('herdr and herdr-core have the sender for an agent whose format reads its screens', () => {
		const herdr = createHerdrKind({
			extraPath: () => '',
			vaultPath: () => '/v',
			onProtocolMismatch: () => undefined,
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const core = createHerdrCoreKind({
			extraPath: () => '',
			spawnEnv: () => ({}),
			vaultPath: () => '/v',
			vaultName: () => 'v',
			onMismatch: () => undefined,
			currentScope: () => null,
		});
		for (const kind of [herdr, core]) {
			const sender: SessionSettingsSender | null | undefined = kind.sessionSettings?.(() => null, CLAUDE_FORMAT);
			expect(sender?.scopes).toEqual(['session', 'default']);
			const plain = { ...CLAUDE_FORMAT, screenSettings: undefined };
			expect(kind.sessionSettings?.(() => null, plain)).toBeNull();
			expect(kind.sessionSettings?.(() => null, null)).toBeNull();
		}
	});

	it('says so when the runtime is not connected, sending nothing', async () => {
		const herdr = createHerdrKind({
			extraPath: () => '',
			vaultPath: () => '/v',
			onProtocolMismatch: () => undefined,
			onUnsupportedMethod: () => undefined,
			isPublished: () => true,
		});
		const sender = herdr.sessionSettings?.(() => null, CLAUDE_FORMAT);
		await expect(sender?.setEffort('w1:p1', 'high', 'session')).rejects.toThrow('not connected');
	});
});
