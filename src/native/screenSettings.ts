/**
 * The session settings sender for herdr and herdr-core (issues #169, #170):
 * changes a pane's model, effort and permission mode by driving the agent's
 * own pickers on its screen, the way ADR-0009 answers its dialogs.
 *
 * Why the screen: on these runtimes `/model <alias>` and `/effort <level>`
 * always save the user's default for new sessions, and only the pickers
 * Claude opens for the bare command change this session alone (finding
 * `native-view-session-settings` §2). So:
 *
 * - **This session only** (the picker's own action): the bare command
 *   through the prompt, then the picker read, moved one key at a time to the
 *   row or level by its label, read again, and `s`. Never a digit and never
 *   `enter` in a picker: both save the default.
 * - **Use for new sessions too**: the command with its argument through the
 *   prompt, which Claude carries out and saves.
 * - **The permission mode**: `shift+tab`, one press at a time, the footer
 *   read after each, stopping on the target and refusing after one full
 *   cycle. Herdr and hc report the mode nowhere; the footer is the only
 *   current word on it, and `readMode` reads it.
 * - **"Switch model?"**, which Claude asks before a switch in a conversation
 *   with replies (and which neither runtime reports): read off the screen,
 *   its words put to the user through `ask`, and `enter` on "Yes, switch to
 *   <model>" only after a read showed the cursor there and the model the
 *   user picked. A "no" goes back with `esc`, and the bar stays as it was.
 *
 * The rules are ADR-0009's: idle or done only; nothing sent while the screen
 * shows anything but the prompt; every key alone in its call and followed by
 * reads until the screen shows it took; a key that did not show is never
 * sent again; a screen that does not match ends with `esc`, only on a picker
 * this run opened (an `esc` on another dialog would answer it), and a
 * readable refusal. The result is confirmed by what Claude prints under the
 * command ("… for this session only"), and a result that says otherwise is
 * reported as what it is.
 *
 * Since the safety review: a command goes only into an input that holds
 * nothing but Claude's suggestion (a draft would go with it as one prompt);
 * a model is chosen from the whole list, scrolled through first when rows
 * are hidden; the mode cycle checks the status before every press; and the
 * pane is held in the pane gate (`./paneGate.ts`) for the whole change, and
 * past it while a picker may still be open, so nothing the user types in the
 * view lands in a picker the run opened.
 *
 * From the answer driver (`./screenAnswer.ts`) this takes the clock and its
 * timings, the runtime's {@link ScreenAccess} and the agent format's reader,
 * not its run: that one answers a request the agent is waiting on and is
 * judged by the transcript, while this opens its own picker and is judged by
 * the screen.
 *
 * Agent-neutral: the format's {@link ScreenSettingsReader} says how the
 * screens read and which commands open them. Facts: `docs/architecture.md`,
 * "Model, effort, permission mode and context".
 */

import type {
	CommandResult,
	ModelPickerScreen,
	PickerRow,
	PromptScreen,
	ScreenSettingsReader,
	SettingsScreen,
} from '../agents/settingsScreen';
import { PANE_GATE, type PaneClaim, type PaneGate } from './paneGate';
import type { PromptSender } from './promptSender';
import type { ScreenAccess, ScreenKey } from './screenAccess';
import { ANSWER_TIMING, SYSTEM_CLOCK, type AnswerClock } from './screenAnswer';
import type { ModeLabel, SessionSettingsSender, SettingChoice, SettingQuestion, SettingScope } from './sessionSettings';

export { BUSY_REASON } from './paneGate';

export interface ScreenSettingsTiming {
	/** Between reads while waiting for the screen. */
	pollMs: number;
	/** How long one key has to show (hc may hold keys while a person types). */
	stepMs: number;
	/** How long a command has to open its picker, or to print what it did. */
	openMs: number;
	/** How long a status that is neither idle, done nor working may take to settle first. */
	statusMs: number;
	/** Between reads while a picker may still be open after a change ended. */
	watchMs: number;
}

export const SETTINGS_TIMING: ScreenSettingsTiming = {
	pollMs: ANSWER_TIMING.pollMs,
	stepMs: ANSWER_TIMING.stepMs,
	openMs: 15000,
	statusMs: 5000,
	watchMs: 1000,
};

/** The most `up`/`down`/`left`/`right` one move sends; past it, it refuses. */
const MAX_MOVES = 30;
/** The most keys reading a scrolled model list takes, up to its top and down to its end. */
const MAX_SURVEY = 2 * MAX_MOVES;
/** How many `esc`s leaving a picker may take: the confirm, then the picker. */
const MAX_ESCAPES = 3;
/** Reads at {@link ScreenSettingsTiming.watchMs} before the watch slows to one in five. */
const WATCH_FAST_READS = 60;

/** What the sender needs of the runtime and the agent's format. */
export interface ScreenSettingsDeps {
	screen: ScreenAccess;
	/**
	 * The runtime's own prompt path, not the gated one the views use: a
	 * change holds the pane gate itself while it sends its command.
	 */
	prompt: Pick<PromptSender, 'send'>;
	/** The agent format's reader (`AgentFormat.screenSettings`). */
	reader: ScreenSettingsReader;
	/** The agent's status as the runtime reports it now: `idle`, `done`, `working`, …, or null. */
	status(paneId: string): Promise<string | null>;
	/** The runtime connection the pane is on: the pane gate's key. Null when none. */
	owner(): object | null;
	/** The format's model choices and mode names, for the words of a refusal. */
	models?: readonly SettingChoice[];
	modeLabels?: Readonly<Record<string, ModeLabel>>;
	clock?: AnswerClock;
	timing?: Partial<ScreenSettingsTiming>;
	/** The pane gate; the plugin's one by default. */
	gate?: PaneGate;
}

/** The words a refusal ends with when the run left the terminal as it found it. */
const UNCHANGED = 'nothing was changed';
/** The words a failure ends with when the terminal may show something the run left. */
const LOOK = 'look in the terminal';

/**
 * The herdr and herdr-core sender for an agent whose format reads its
 * settings screens. Idle or done only (`midTurn: false`); both scopes for the
 * model and the effort; the modes the agent's `shift+tab` cycles through.
 */
export function screenSettingsSender(deps: ScreenSettingsDeps): SessionSettingsSender {
	const driver = new SettingsDriver(deps);
	const gate = deps.gate ?? PANE_GATE;
	return {
		scopes: ['session', 'default'],
		settings: ['model', 'effort', 'mode'],
		midTurn: false,
		modes: deps.reader.cycleModes,
		unavailable: (paneId) => gate.settingsBlock(deps.owner(), paneId),
		screenHeld: (paneId) => gate.screenHeld(deps.owner(), paneId),
		setModel: (paneId, model, scope, ask) => driver.locked(paneId, (run) => driver.model(run, model, scope, ask)),
		setEffort: (paneId, effort, scope) => driver.locked(paneId, (run) => driver.effort(run, effort, scope)),
		setMode: (paneId, mode) => driver.locked(paneId, (run) => driver.mode(run, mode)),
		readMode: (paneId) => driver.readMode(paneId),
	};
}

/** One change on one pane. */
interface Run {
	paneId: string;
	/** Whether the run has sent a command or pressed a key. */
	touched: boolean;
}

/** The whole model list, read through a scrolled picker, and where its cursor ended. */
interface ModelList {
	rows: PickerRow[];
	cursor: number;
}

class SettingsDriver {
	private readonly clock: AnswerClock;
	private readonly timing: ScreenSettingsTiming;
	private readonly gate: PaneGate;

	constructor(private readonly deps: ScreenSettingsDeps) {
		this.clock = deps.clock ?? SYSTEM_CLOCK;
		this.timing = { ...SETTINGS_TIMING, ...deps.timing };
		this.gate = deps.gate ?? PANE_GATE;
	}

	/**
	 * Runs `work` as the pane's one change, holding the pane gate: no prompt
	 * goes into the pane meanwhile. A run that touched the terminal and ended
	 * on anything but the plain prompt keeps it shut until a read shows the
	 * prompt again, whatever it reported.
	 */
	async locked<T>(paneId: string, work: (run: Run) => Promise<T>): Promise<T> {
		const owner = this.deps.owner();
		if (!owner) throw new Error('not connected');
		const claim = this.gate.claim(owner, paneId);
		const run: Run = { paneId, touched: false };
		try {
			const result = await work(run);
			claim.release(run.touched);
			return result;
		} catch (error) {
			if (run.touched && !(await this.showsPrompt(paneId))) {
				claim.stick();
				void this.watch(owner, paneId, claim);
			} else claim.release(run.touched);
			throw error;
		}
	}

	/** Reads until the plain prompt is back, then lets prompts go again. */
	private async watch(owner: object, paneId: string, claim: PaneClaim): Promise<void> {
		for (let reads = 0; ; reads++) {
			await this.clock.sleep(reads < WATCH_FAST_READS ? this.timing.watchMs : 5 * this.timing.watchMs);
			// Another connection is another gate: this one has nothing left to hold.
			if (this.deps.owner() !== owner || (await this.showsPrompt(paneId))) {
				claim.release();
				return;
			}
		}
	}

	private async showsPrompt(paneId: string): Promise<boolean> {
		try {
			return (await this.read(paneId)).kind === 'prompt';
		} catch {
			return false;
		}
	}

	// ------------------------------------------------------------- the model

	async model(run: Run, model: string, scope: SettingScope, ask?: (q: SettingQuestion) => Promise<boolean>): Promise<void> {
		const { paneId } = run;
		const choice = this.choice(model);
		await this.ready(paneId, true);
		const { reader } = this.deps;
		if (scope === 'default') {
			const command = `${reader.modelCommand} ${choice.value}`;
			const before = await this.deps.screen.read(paneId);
			await this.command(run, command);
			const after = await this.until(
				paneId,
				(s) => s.kind === 'switch-model' || this.printed(s, command),
				this.timing.openMs,
				before,
			);
			if (after?.kind === 'switch-model') {
				if (!reader.isModel(choice, after.target)) {
					return this.refuse(run, `Claude asks to switch to ${after.target}, not ${choice.label}`);
				}
				const done = await this.confirmSwitch(run, after.target, ask);
				if (!done) return;
			} else if (!after) {
				throw new Error(`Claude did not say what it made of ${command}; ${LOOK}`);
			}
			return this.checkModel(paneId, command, choice, 'default', before);
		}

		await this.command(run, reader.modelCommand);
		const opened = await this.until(paneId, (s) => s.kind === 'model-picker', this.timing.openMs);
		if (opened?.kind !== 'model-picker') return this.notOpened(run, reader.modelCommand, 'model picker');
		const list = await this.wholeList(run, opened);
		const target = reader.modelRow(choice, list.rows);
		if (!target) return this.refuse(run, `Claude's model picker lists no ${choice.label} model`);
		if (target.current) {
			// Already the session's model: leave the picker as it was opened.
			if (!(await this.leave(run))) {
				throw new Error(`${target.label} is already this session's model, but the picker did not close; ${LOOK}`);
			}
			return;
		}
		await this.moveModel(run, list.cursor, target);
		const shown = await this.read(paneId);
		if (shown.kind !== 'model-picker' || !onRow(shown.rows, shown.cursor, target)) {
			return this.refuse(run, `the picker is not on ${target.label}`);
		}
		await this.press(run, 's');
		const after = await this.until(
			paneId,
			(s) => s.kind === 'switch-model' || this.printed(s, reader.modelCommand),
			this.timing.openMs,
		);
		if (after?.kind === 'switch-model') {
			if (after.target !== target.label) return this.refuse(run, `Claude asks to switch to ${after.target}, not ${target.label}`);
			const done = await this.confirmSwitch(run, after.target, ask);
			if (!done) return;
		} else if (!after) {
			// `s` is never sent again; whatever is up, the user finishes it.
			throw new Error(`the picker did not take the key; ${LOOK}`);
		}
		return this.checkModel(paneId, reader.modelCommand, choice, 'session', undefined, list.rows);
	}

	/**
	 * The whole model list: the rows the picker shows, and where rows are
	 * hidden above or below, the rest, read by moving the cursor up to the
	 * top and down to the end, one key and one read at a time. A choice is
	 * the newest of its family, which a scrolled-off row may be.
	 */
	private async wholeList(run: Run, opened: ModelPickerScreen): Promise<ModelList> {
		const rows = new Map<number, PickerRow>();
		const keep = (shown: ModelPickerScreen): void => {
			for (const row of shown.rows) rows.set(row.number, row);
		};
		keep(opened);
		let cursor = opened.cursor;
		let top = !opened.above;
		let end = !opened.below;
		let keys = 0;
		const step = async (key: 'up' | 'down'): Promise<void> => {
			if (++keys > MAX_SURVEY) return this.refuse(run, 'the model list is too long to read');
			const next = cursor + (key === 'down' ? 1 : -1);
			await this.press(run, key);
			const moved = await this.until(run.paneId, (s) => s.kind === 'model-picker' && s.cursor === next, this.timing.stepMs);
			if (moved?.kind !== 'model-picker') return this.refuse(run, 'the picker did not follow the keys');
			cursor = next;
			keep(moved);
			if (!moved.above) top = true;
			if (!moved.below) end = true;
		};
		while (!top) await step('up');
		while (!end) await step('down');
		const list = [...rows.values()].sort((a, b) => a.number - b.number);
		if (list.some((row, i) => row.number !== i + 1) || list.filter((row) => row.current).length > 1) {
			return this.refuse(run, 'the model list did not read the same all the way through');
		}
		return { rows: list, cursor };
	}

	/** Moves the model picker's cursor to `target`, one key and one read at a time. */
	private async moveModel(run: Run, from: number, target: PickerRow): Promise<void> {
		let at = from;
		if (Math.abs(target.number - at) > MAX_MOVES) return this.refuse(run, 'the row is too far down the list');
		while (at !== target.number) {
			const key = target.number > at ? 'down' : 'up';
			const next = at + (key === 'down' ? 1 : -1);
			await this.press(run, key);
			const moved = await this.until(run.paneId, (s) => s.kind === 'model-picker' && s.cursor === next, this.timing.stepMs);
			if (!moved) return this.refuse(run, 'the picker did not follow the keys');
			at = next;
		}
	}

	/**
	 * "Switch model?" is up, naming the model the user picked: asks the user
	 * with Claude's own words, then `enter` on yes after a read showed it, or
	 * goes back with `esc`. True when the switch was confirmed.
	 */
	private async confirmSwitch(run: Run, target: string, ask?: (q: SettingQuestion) => Promise<boolean>): Promise<boolean> {
		const shown = await this.read(run.paneId);
		if (shown.kind !== 'switch-model' || shown.target !== target) {
			return this.refuse(run, 'the switch confirm changed under the run');
		}
		const yes = ask ? await ask({ title: shown.title, body: shown.body.join(' '), confirm: shown.yes, cancel: shown.no }) : true;
		if (!yes) {
			if (!(await this.leave(run))) throw new Error(`could not go back from Claude's confirm; ${LOOK}`);
			return false;
		}
		const again = await this.read(run.paneId);
		if (again.kind !== 'switch-model' || again.target !== target || again.cursor !== 'yes') {
			return this.refuse(run, `the confirm no longer shows "${shown.yes}" under the cursor`);
		}
		await this.press(run, 'enter');
		return true;
	}

	/**
	 * Reads what Claude printed under `command` and checks it is the change
	 * asked for: with the whole list read, the newest model of the family on
	 * it, not merely the row the run moved to.
	 */
	private async checkModel(
		paneId: string,
		command: string,
		choice: SettingChoice,
		scope: SettingScope,
		before?: string,
		list?: readonly PickerRow[],
	): Promise<void> {
		const printed = await this.result(paneId, command, before);
		if (printed.kind === 'model') {
			const newest = list ? (this.deps.reader.modelRow(choice, list)?.label ?? null) : undefined;
			const right =
				newest === undefined ? this.deps.reader.isModel(choice, printed.label) : printed.label === newest;
			if (!right) throw new Error(`Claude set the model to ${printed.label}`);
			if (printed.scope !== scope) {
				throw new Error(
					scope === 'session'
						? `Claude set ${printed.label} and saved it as your default for new sessions`
						: `Claude set ${printed.label} for this session only`,
				);
			}
			return;
		}
		if (printed.kind === 'kept') throw new Error(`Claude kept the model as ${printed.label}`);
		throw new Error(printed.kind === 'other' ? printed.text : 'Claude did not change the model');
	}

	// ------------------------------------------------------------ the effort

	async effort(run: Run, level: string, scope: SettingScope): Promise<void> {
		const { paneId } = run;
		await this.ready(paneId, true);
		const { reader } = this.deps;
		if (scope === 'default') {
			const command = `${reader.effortCommand} ${level}`;
			const before = await this.deps.screen.read(paneId);
			await this.command(run, command);
			return this.checkEffort(paneId, command, level, 'default', before);
		}

		await this.command(run, reader.effortCommand);
		const opened = await this.until(paneId, (s) => s.kind === 'effort-picker', this.timing.openMs);
		if (opened?.kind !== 'effort-picker') return this.notOpened(run, reader.effortCommand, 'effort picker');
		const to = opened.levels.indexOf(level);
		if (to < 0) {
			return this.refuse(run, `Claude's effort picker has no ${level} for this session; "Use for new sessions too" sets it`);
		}
		if (opened.selected === null) return this.refuse(run, 'the effort picker shows no level');
		if (opened.selected === level) {
			if (!(await this.leave(run))) {
				throw new Error(`${level} is already this session's effort, but the picker did not close; ${LOOK}`);
			}
			return;
		}
		let at = opened.levels.indexOf(opened.selected);
		if (Math.abs(to - at) > MAX_MOVES) return this.refuse(run, 'the level is too far along');
		while (at !== to) {
			const key = to > at ? 'right' : 'left';
			const next = opened.levels[at + (key === 'right' ? 1 : -1)];
			await this.press(run, key);
			const moved = await this.until(paneId, (s) => s.kind === 'effort-picker' && s.selected === next, this.timing.stepMs);
			if (!moved) return this.refuse(run, 'the picker did not follow the keys');
			at += key === 'right' ? 1 : -1;
		}
		const shown = await this.read(paneId);
		if (shown.kind !== 'effort-picker' || shown.selected !== level) return this.refuse(run, `the picker is not on ${level}`);
		await this.press(run, 's');
		return this.checkEffort(paneId, reader.effortCommand, level, 'session');
	}

	private async checkEffort(
		paneId: string,
		command: string,
		level: string,
		scope: SettingScope,
		before?: string,
	): Promise<void> {
		const printed = await this.result(paneId, command, before);
		if (printed.kind === 'effort') {
			if (printed.level !== level) throw new Error(`Claude set the effort to ${printed.level}`);
			if (printed.scope !== scope) {
				throw new Error(
					scope === 'session'
						? `Claude set ${printed.level} and saved it as your default for new sessions`
						: `Claude set ${printed.level} for this session only`,
				);
			}
			return;
		}
		if (printed.kind === 'cancelled') throw new Error('Claude left the effort as it was');
		throw new Error(printed.kind === 'other' ? printed.text : 'Claude did not change the effort');
	}

	// -------------------------------------------------------------- the mode

	/**
	 * Presses `shift+tab` until the footer shows `mode`, one press at a time
	 * and each read back, each only while the agent is idle or done: a turn
	 * that starts meanwhile stops the cycle where it is, and says where.
	 * Refuses once the footer is back where it started: the cycle does not
	 * reach that mode.
	 */
	async mode(run: Run, mode: string): Promise<void> {
		const { paneId } = run;
		// A draft does not matter here: `shift+tab` sends nothing.
		const start = await this.ready(paneId, false);
		const { reader } = this.deps;
		if (start.mode === null) throw new Error(`the terminal's footer shows no mode Gjetr can read; ${UNCHANGED}`);
		let current = start.mode;
		if (reader.sameMode(current, mode)) return;
		for (let presses = 0; presses < 2 * reader.cycleModes.length + 2; presses++) {
			const status = await this.deps.status(paneId).catch(() => null);
			if (status !== 'idle' && status !== 'done') {
				const where = presses === 0 ? `the mode is ${this.modeName(current)}, ${UNCHANGED}` : `the mode is ${this.modeName(current)} now`;
				throw new Error(
					`${status === 'working' ? 'Claude started working' : 'Claude is no longer waiting for a prompt'}; Gjetr stopped pressing shift+tab and ${where}`,
				);
			}
			await this.press(run, 'shift+tab');
			const was = current;
			const next = await this.until(paneId, (s) => s.kind === 'prompt' && s.mode !== null && s.mode !== was, this.timing.stepMs);
			if (next?.kind !== 'prompt' || next.mode === null) {
				throw new Error(`the footer did not change after shift+tab; it showed ${this.modeName(current)}, ${LOOK}`);
			}
			current = next.mode;
			if (reader.sameMode(current, mode)) return;
			if (reader.sameMode(current, start.mode)) {
				throw new Error(`shift+tab does not reach ${this.modeName(mode)} in this session; it is ${this.modeName(current)} again`);
			}
		}
		throw new Error(`shift+tab did not come round; the mode is ${this.modeName(current)}`);
	}

	/** The mode the footer shows now, or null when the screen shows no footer to read. */
	async readMode(paneId: string): Promise<string | null> {
		const shown = await this.read(paneId);
		return shown.kind === 'prompt' ? shown.mode : null;
	}

	// ----------------------------------------------------------- the steps

	/**
	 * Idle or done, and the prompt on screen with nothing over it: what a
	 * change starts from. With `command`, the input must hold nothing but
	 * the agent's suggestion, since a command sent now would go after a draft
	 * as one prompt.
	 */
	private async ready(paneId: string, command: boolean): Promise<PromptScreen> {
		let status = await this.deps.status(paneId);
		// herdr calls a picker on screen `blocked` and lags its closing by a
		// moment (measured, #169): a change right after another waits that out.
		const deadline = this.clock.now() + this.timing.statusMs;
		while (status !== 'idle' && status !== 'done' && status !== 'working' && this.clock.now() < deadline) {
			await this.clock.sleep(this.timing.pollMs * 3);
			status = await this.deps.status(paneId);
		}
		if (status !== 'idle' && status !== 'done') {
			throw new Error(status === 'working' ? 'Claude is working; change it after this turn' : 'Claude is not waiting for a prompt');
		}
		const shown = await this.read(paneId);
		if (shown.kind !== 'prompt') {
			throw new Error(`the terminal shows something over the prompt; finish it there first (${UNCHANGED})`);
		}
		if (command && !(await this.inputClear(paneId, shown))) {
			throw new Error(
				`Claude's input in the terminal holds a draft, which would go with the command as a prompt; send or clear it there first (${UNCHANGED})`,
			);
		}
		return shown;
	}

	/**
	 * Whether the input holds nothing a command would be sent after: empty,
	 * or the agent's suggestion, checked dim on a styled read where the
	 * runtime has one (herdr), taken as read where it has none (hc).
	 */
	private async inputClear(paneId: string, shown: PromptScreen): Promise<boolean> {
		if (shown.input === 'empty') return true;
		if (shown.input === 'draft') return false;
		const { screen, reader } = this.deps;
		if (!screen.readStyled || !reader.placeholderStyled) return true;
		try {
			return reader.placeholderStyled(await screen.readStyled(paneId), shown.inputText) === true;
		} catch {
			return false;
		}
	}

	private async read(paneId: string): Promise<SettingsScreen> {
		return this.deps.reader.parse(await this.deps.screen.read(paneId));
	}

	/**
	 * Reads every `pollMs` until `wanted` holds, for up to `ms`; null when it
	 * never did. With `before`, a read of that same screen does not count: a
	 * command sent twice prints the same line twice, and the first is not
	 * this one's.
	 */
	private async until(
		paneId: string,
		wanted: (s: SettingsScreen) => boolean,
		ms: number,
		before?: string,
	): Promise<SettingsScreen | null> {
		const deadline = this.clock.now() + ms;
		do {
			await this.clock.sleep(this.timing.pollMs);
			let raw: string;
			try {
				raw = await this.deps.screen.read(paneId);
			} catch {
				// A read that failed shows nothing; the next one may not.
				continue;
			}
			if (before !== undefined && raw === before) continue;
			const shown = this.deps.reader.parse(raw);
			if (wanted(shown)) return shown;
		} while (this.clock.now() < deadline);
		return null;
	}

	private async press(run: Run, key: ScreenKey): Promise<void> {
		run.touched = true;
		await this.deps.screen.press(run.paneId, key);
	}

	private async command(run: Run, text: string): Promise<void> {
		run.touched = true;
		await this.deps.prompt.send(run.paneId, text);
	}

	/** Whether the prompt is back and shows what `command` printed. */
	private printed(shown: SettingsScreen, command: string): boolean {
		return shown.kind === 'prompt' && shown.last?.echo === command && shown.last.result !== null;
	}

	/** What `command` printed, once the prompt is back with it. */
	private async result(paneId: string, command: string, before?: string): Promise<CommandResult> {
		const shown = await this.until(paneId, (s) => this.printed(s, command), this.timing.openMs, before);
		if (shown?.kind !== 'prompt' || !shown.last?.result) {
			throw new Error(`Claude did not say what it made of ${command}; ${LOOK}`);
		}
		return shown.last.result;
	}

	/**
	 * The bare command went out and its picker never showed: what it did is
	 * not known, so this never says nothing changed. A turn it started is
	 * named as one; nothing is pressed on whatever is up.
	 */
	private async notOpened(run: Run, command: string, picker: string): Promise<never> {
		const status = await this.deps.status(run.paneId).catch(() => null);
		if (status === 'working') throw new Error(`Claude took ${command} as a prompt and started a turn; ${LOOK}`);
		throw new Error(`the ${picker} did not open after ${command}; ${LOOK}`);
	}

	/**
	 * Leaves a picker or confirm this run opened with `esc`, each after a read
	 * showed one, until the prompt is back. Presses nothing on any other
	 * screen: an `esc` there could answer a dialog. True when the prompt is back.
	 */
	private async leave(run: Run): Promise<boolean> {
		for (let i = 0; i <= MAX_ESCAPES; i++) {
			let shown: SettingsScreen;
			try {
				shown = await this.read(run.paneId);
			} catch {
				return false;
			}
			if (shown.kind === 'prompt') return true;
			if (shown.kind === 'unknown' || i === MAX_ESCAPES) return false;
			const before = JSON.stringify(shown);
			await this.press(run, 'esc');
			if (!(await this.until(run.paneId, (s) => JSON.stringify(s) !== before, this.timing.stepMs))) return false;
		}
		return false;
	}

	/**
	 * Leaves the picker this run opened, and refuses with `why`. Only ever
	 * after the picker showed, so what the command did is known: opening it
	 * changes nothing, and `esc` out of it is "Kept model as …" or "Cancelled".
	 */
	private async refuse(run: Run, why: string): Promise<never> {
		const left = await this.leave(run).catch(() => false);
		throw new Error(left ? `${why}; ${UNCHANGED}` : `${why}; ${LOOK}`);
	}

	private choice(model: string): SettingChoice {
		return this.deps.models?.find((choice) => choice.value === model) ?? { value: model, label: model };
	}

	private modeName(mode: string): string {
		return this.deps.modeLabels?.[mode]?.label ?? mode;
	}
}

/** Whether the picker's cursor is on `target`: its number and its name. */
function onRow(rows: readonly PickerRow[], cursor: number, target: PickerRow): boolean {
	return cursor === target.number && rows.some((row) => row.number === cursor && row.label === target.label);
}
