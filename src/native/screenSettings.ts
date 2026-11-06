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

import type { CommandResult, PickerRow, ScreenSettingsReader, SettingsScreen } from '../agents/settingsScreen';
import type { PromptSender } from './promptSender';
import type { ScreenAccess, ScreenKey } from './screenAccess';
import { ANSWER_TIMING, SYSTEM_CLOCK, type AnswerClock } from './screenAnswer';
import type { ModeLabel, SessionSettingsSender, SettingChoice, SettingQuestion, SettingScope } from './sessionSettings';

export interface ScreenSettingsTiming {
	/** Between reads while waiting for the screen. */
	pollMs: number;
	/** How long one key has to show (hc may hold keys while a person types). */
	stepMs: number;
	/** How long a command has to open its picker, or to print what it did. */
	openMs: number;
	/** How long a status that is neither idle, done nor working may take to settle first. */
	statusMs: number;
}

export const SETTINGS_TIMING: ScreenSettingsTiming = {
	pollMs: ANSWER_TIMING.pollMs,
	stepMs: ANSWER_TIMING.stepMs,
	openMs: 15000,
	statusMs: 5000,
};

/** The most `up`/`down`/`left`/`right` one change sends; past it, it refuses. */
const MAX_MOVES = 30;
/** How many `esc`s leaving a picker may take: the confirm, then the picker. */
const MAX_ESCAPES = 3;

/** What the sender needs of the runtime and the agent's format. */
export interface ScreenSettingsDeps {
	screen: ScreenAccess;
	/** The prompt path the prompt box uses: how a command reaches the agent. */
	prompt: Pick<PromptSender, 'send'>;
	/** The agent format's reader (`AgentFormat.screenSettings`). */
	reader: ScreenSettingsReader;
	/** The agent's status as the runtime reports it now: `idle`, `done`, `working`, …, or null. */
	status(paneId: string): Promise<string | null>;
	/** The runtime connection the pane is on, for the one-change-per-pane guard; null when none. */
	owner(): object | null;
	/** The format's model choices and mode names, for the words of a refusal. */
	models?: readonly SettingChoice[];
	modeLabels?: Readonly<Record<string, ModeLabel>>;
	clock?: AnswerClock;
	timing?: Partial<ScreenSettingsTiming>;
}

/** Panes with a change in flight, per runtime connection. */
const RUNNING = new WeakMap<object, Set<string>>();

/** Why a change cannot start: another on the same pane. */
export const BUSY_REASON = 'Another change is on its way to this pane.';

/** The words a refusal ends with when the run left the terminal as it found it. */
const UNCHANGED = 'nothing was changed';

/**
 * The herdr and herdr-core sender for an agent whose format reads its
 * settings screens. Idle or done only (`midTurn: false`); both scopes for the
 * model and the effort.
 */
export function screenSettingsSender(deps: ScreenSettingsDeps): SessionSettingsSender {
	const driver = new SettingsDriver(deps);
	return {
		scopes: ['session', 'default'],
		settings: ['model', 'effort'],
		midTurn: false,
		unavailable: (paneId) => (driver.busy(paneId) ? BUSY_REASON : null),
		setModel: (paneId, model, scope, ask) => driver.locked(paneId, () => driver.model(paneId, model, scope, ask)),
		setEffort: (paneId, effort, scope) => driver.locked(paneId, () => driver.effort(paneId, effort, scope)),
		setMode: () => Promise.reject(new Error('this runtime cannot change the mode yet')),
	};
}

class SettingsDriver {
	private readonly clock: AnswerClock;
	private readonly timing: ScreenSettingsTiming;

	constructor(private readonly deps: ScreenSettingsDeps) {
		this.clock = deps.clock ?? SYSTEM_CLOCK;
		this.timing = { ...SETTINGS_TIMING, ...deps.timing };
	}

	busy(paneId: string): boolean {
		const owner = this.deps.owner();
		return owner !== null && (RUNNING.get(owner)?.has(paneId) ?? false);
	}

	/** Runs `work` as the pane's one change in flight. */
	async locked<T>(paneId: string, work: () => Promise<T>): Promise<T> {
		const owner = this.deps.owner();
		if (!owner) throw new Error('not connected');
		let running = RUNNING.get(owner);
		if (!running) {
			running = new Set();
			RUNNING.set(owner, running);
		}
		if (running.has(paneId)) throw new Error(BUSY_REASON);
		running.add(paneId);
		try {
			return await work();
		} finally {
			running.delete(paneId);
		}
	}

	// ------------------------------------------------------------- the model

	async model(paneId: string, model: string, scope: SettingScope, ask?: (q: SettingQuestion) => Promise<boolean>): Promise<void> {
		const choice = this.choice(model);
		await this.ready(paneId);
		const { reader } = this.deps;
		if (scope === 'default') {
			const command = `${reader.modelCommand} ${choice.value}`;
			const before = await this.deps.screen.read(paneId);
			await this.deps.prompt.send(paneId, command);
			const after = await this.until(
				paneId,
				(s) => s.kind === 'switch-model' || this.printed(s, command),
				this.timing.openMs,
				before,
			);
			if (after?.kind === 'switch-model') {
				if (!reader.isModel(choice, after.target)) {
					return this.refuse(paneId, `Claude asks to switch to ${after.target}, not ${choice.label}`);
				}
				const done = await this.confirmSwitch(paneId, after.target, ask);
				if (!done) return;
			} else if (!after) {
				throw new Error(`Claude did not say what it made of ${command}; look in the terminal`);
			}
			return this.checkModel(paneId, command, choice, 'default', before);
		}

		await this.deps.prompt.send(paneId, reader.modelCommand);
		const opened = await this.until(paneId, (s) => s.kind === 'model-picker', this.timing.openMs);
		if (opened?.kind !== 'model-picker') return this.refuse(paneId, 'the model picker did not open');
		const target = reader.modelRow(choice, opened.rows);
		if (!target) return this.refuse(paneId, `Claude's model picker lists no ${choice.label} model`);
		if (target.current) {
			// Already the session's model: leave the picker as it was opened.
			await this.leave(paneId);
			return;
		}
		await this.moveModel(paneId, opened.cursor, target);
		const shown = await this.read(paneId);
		if (shown.kind !== 'model-picker' || !onRow(shown.rows, shown.cursor, target)) {
			return this.refuse(paneId, `the picker is not on ${target.label}`);
		}
		await this.press(paneId, 's');
		const after = await this.until(
			paneId,
			(s) => s.kind === 'switch-model' || this.printed(s, reader.modelCommand),
			this.timing.openMs,
		);
		if (after?.kind === 'switch-model') {
			if (after.target !== target.label) return this.refuse(paneId, `Claude asks to switch to ${after.target}, not ${target.label}`);
			const done = await this.confirmSwitch(paneId, after.target, ask);
			if (!done) return;
		} else if (!after) {
			// `s` is never sent again; whatever is up, the user finishes it.
			throw new Error('the picker did not take the key; look in the terminal');
		}
		return this.checkModel(paneId, reader.modelCommand, choice, 'session', undefined, target.label);
	}

	/** Moves the model picker's cursor to `target`, one key and one read at a time. */
	private async moveModel(paneId: string, from: number, target: PickerRow): Promise<void> {
		let at = from;
		if (Math.abs(target.number - at) > MAX_MOVES) return this.refuse(paneId, 'the row is too far down the list');
		while (at !== target.number) {
			const key = target.number > at ? 'down' : 'up';
			const next = at + (key === 'down' ? 1 : -1);
			await this.press(paneId, key);
			const moved = await this.until(paneId, (s) => s.kind === 'model-picker' && s.cursor === next, this.timing.stepMs);
			if (!moved) return this.refuse(paneId, 'the picker did not follow the keys');
			at = next;
		}
	}

	/**
	 * "Switch model?" is up, naming the model the user picked: asks the user
	 * with Claude's own words, then `enter` on yes after a read showed it, or
	 * goes back with `esc`. True when the switch was confirmed.
	 */
	private async confirmSwitch(paneId: string, target: string, ask?: (q: SettingQuestion) => Promise<boolean>): Promise<boolean> {
		const shown = await this.read(paneId);
		if (shown.kind !== 'switch-model' || shown.target !== target) {
			return this.refuse(paneId, 'the switch confirm changed under the run');
		}
		const yes = ask ? await ask({ title: shown.title, body: shown.body.join(' '), confirm: shown.yes, cancel: shown.no }) : true;
		if (!yes) {
			if (!(await this.leave(paneId))) throw new Error('could not go back from Claude\'s confirm; look in the terminal');
			return false;
		}
		const again = await this.read(paneId);
		if (again.kind !== 'switch-model' || again.target !== target || again.cursor !== 'yes') {
			return this.refuse(paneId, `the confirm no longer shows "${shown.yes}" under the cursor`);
		}
		await this.press(paneId, 'enter');
		return true;
	}

	/** Reads what Claude printed under `command` and checks it is the change asked for. */
	private async checkModel(
		paneId: string,
		command: string,
		choice: SettingChoice,
		scope: SettingScope,
		before?: string,
		label?: string,
	): Promise<void> {
		const printed = await this.result(paneId, command, before);
		if (printed.kind === 'model') {
			const right = label === undefined ? this.deps.reader.isModel(choice, printed.label) : printed.label === label;
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

	async effort(paneId: string, level: string, scope: SettingScope): Promise<void> {
		await this.ready(paneId);
		const { reader } = this.deps;
		if (scope === 'default') {
			const command = `${reader.effortCommand} ${level}`;
			const before = await this.deps.screen.read(paneId);
			await this.deps.prompt.send(paneId, command);
			return this.checkEffort(paneId, command, level, 'default', before);
		}

		await this.deps.prompt.send(paneId, reader.effortCommand);
		const opened = await this.until(paneId, (s) => s.kind === 'effort-picker', this.timing.openMs);
		if (opened?.kind !== 'effort-picker') return this.refuse(paneId, 'the effort picker did not open');
		const to = opened.levels.indexOf(level);
		if (to < 0) {
			return this.refuse(paneId, `Claude's effort picker has no ${level} for this session; "Use for new sessions too" sets it`);
		}
		if (opened.selected === null) return this.refuse(paneId, 'the effort picker shows no level');
		if (opened.selected === level) {
			await this.leave(paneId);
			return;
		}
		let at = opened.levels.indexOf(opened.selected);
		if (Math.abs(to - at) > MAX_MOVES) return this.refuse(paneId, 'the level is too far along');
		while (at !== to) {
			const key = to > at ? 'right' : 'left';
			const next = opened.levels[at + (key === 'right' ? 1 : -1)];
			await this.press(paneId, key);
			const moved = await this.until(paneId, (s) => s.kind === 'effort-picker' && s.selected === next, this.timing.stepMs);
			if (!moved) return this.refuse(paneId, 'the picker did not follow the keys');
			at += key === 'right' ? 1 : -1;
		}
		const shown = await this.read(paneId);
		if (shown.kind !== 'effort-picker' || shown.selected !== level) return this.refuse(paneId, `the picker is not on ${level}`);
		await this.press(paneId, 's');
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

	// ----------------------------------------------------------- the steps

	/** Idle or done, and the prompt on screen with nothing over it: what a change starts from. */
	private async ready(paneId: string): Promise<Extract<SettingsScreen, { kind: 'prompt' }>> {
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
		return shown;
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

	private async press(paneId: string, key: ScreenKey): Promise<void> {
		await this.deps.screen.press(paneId, key);
	}

	/** Whether the prompt is back and shows what `command` printed. */
	private printed(shown: SettingsScreen, command: string): boolean {
		return shown.kind === 'prompt' && shown.last?.echo === command && shown.last.result !== null;
	}

	/** What `command` printed, once the prompt is back with it. */
	private async result(paneId: string, command: string, before?: string): Promise<CommandResult> {
		const shown = await this.until(paneId, (s) => this.printed(s, command), this.timing.openMs, before);
		if (shown?.kind !== 'prompt' || !shown.last?.result) {
			throw new Error(`Claude did not say what it made of ${command}; look in the terminal`);
		}
		return shown.last.result;
	}

	/**
	 * Leaves a picker or confirm this run opened with `esc`, each after a read
	 * showed one, until the prompt is back. Presses nothing on any other
	 * screen: an `esc` there could answer a dialog. True when the prompt is back.
	 */
	private async leave(paneId: string): Promise<boolean> {
		for (let i = 0; i <= MAX_ESCAPES; i++) {
			let shown: SettingsScreen;
			try {
				shown = await this.read(paneId);
			} catch {
				return false;
			}
			if (shown.kind === 'prompt') return true;
			if (shown.kind === 'unknown' || i === MAX_ESCAPES) return false;
			const before = JSON.stringify(shown);
			await this.press(paneId, 'esc');
			if (!(await this.until(paneId, (s) => JSON.stringify(s) !== before, this.timing.stepMs))) return false;
		}
		return false;
	}

	/** Leaves what this run opened, and refuses with `why`. */
	private async refuse(paneId: string, why: string): Promise<never> {
		const left = await this.leave(paneId).catch(() => false);
		throw new Error(left ? `${why}; ${UNCHANGED}` : `${why}; look in the terminal`);
	}

	private choice(model: string): SettingChoice {
		return this.deps.models?.find((choice) => choice.value === model) ?? { value: model, label: model };
	}
}

/** Whether the picker's cursor is on `target`: its number and its name. */
function onRow(rows: readonly PickerRow[], cursor: number, target: PickerRow): boolean {
	return cursor === target.number && rows.some((row) => row.number === cursor && row.label === target.label);
}
