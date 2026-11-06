/**
 * The waiting card as DOM (#99, ADR-0007): the half of `./waitingCard.ts` that
 * draws the card and acts on it.
 *
 * `./waitingCard.ts` says which block the agent is in, as a value; this draws
 * that value under the turns, wires its buttons, and is the one place in the
 * native view that answers anything: the workspace trust prompt (`Down Enter`
 * through the key sender), a request the runtime itself holds (through the
 * kind's responder), and on herdr and herdr-core the dialog on the pane's
 * screen, read and answered through the shared answer driver (ADR-0009,
 * `./screenCard.ts`, `./screenAnswer.ts`). It holds the guards that make each
 * answer go out once.
 */

import { Component, setIcon } from 'obsidian';
import type { AgentStatus } from '../herdr/types.gen';
import type { KeySender } from './promptSender';
import {
	danglingToolUse,
	isTypedAnswerKey,
	optionName,
	questionAnswer,
	waitingCard,
	type WaitingCardModel,
} from './waitingCard';
import { joinWrapped, type ScreenDialog } from '../agents/screenDialog';
import { defaultAgentFormat } from '../agents/catalog';
import type { AgentFormat } from '../agents/format';
import {
	withShown,
	type AnswerOutcome,
	type AnswerReceipt,
	type AnswerRun,
	type ScreenAnswer,
	type ScreenExpectation,
} from './screenAnswer';
import type { ScreenAnswering } from './screenAnswerers';
import {
	findReceipt,
	knownCalls,
	outcomeView,
	ownCall,
	permissionOption2,
	planAgrees,
	screenRequests,
	type CallKind,
	type FoundReceipt,
} from './screenCard';
import { sessionStarted } from './trustWatch';
import { setTimer } from '../timers';
import {
	projectGrantText,
	type PendingQuestion,
	type PendingQuestionOption,
	type PendingRequest,
	type WaitingAnswer,
	type WaitingResponder,
} from './pendingRequest';
import type { SessionModelView } from './sessionModel';

/** What a failed trust answer says, with herdr's message in the tail (#99). */
export function trustFailureMessage(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Gjetr: could not trust this folder (${reason})`;
}

/**
 * What a question card says when the view cannot answer it: the runtime only
 * reports that a question is waiting (herdr, herdr-core), so the answer — a
 * typed one included — is given in the terminal.
 */
export const QUESTION_IN_TERMINAL =
	'Answer it in the terminal, where you can also type an answer of your own: this runtime does not take answers from the view.';

/**
 * What a plan card says when the view cannot answer it (#148): approving
 * picks a permission mode, and changing the plan is typed, both in the
 * terminal.
 */
export const PLAN_IN_TERMINAL = 'Approve the plan or tell Claude what to change in the terminal.';

/**
 * One option as the card draws it, inside `parent` (a button or a line): the
 * label with Claude's "(Recommended)" suffix drawn as a tag, and the
 * description on the line under it — never a tooltip alone, which neither a
 * touch screen nor a screen reader shows.
 */
export function drawOption(parent: HTMLElement, option: PendingQuestionOption): void {
	const { text, recommended } = optionName(option.label);
	const line = parent.createSpan({ cls: 'herdr-native-waiting-choice-line' });
	line.createSpan({ cls: 'herdr-native-waiting-choice-label', text });
	if (recommended) line.createSpan({ cls: 'herdr-native-waiting-tag', text: 'Recommended' });
	if (option.description) {
		parent.createSpan({ cls: 'herdr-native-waiting-choice-description', text: option.description });
	}
}

/** A button under a failed answer's words: read the terminal again, open it, show the line. */
interface CardAction {
	text: string;
	run: () => void;
}

/** What the card disables while an answer is on its way: its buttons and its text fields. */
type Control = HTMLButtonElement | HTMLInputElement;

/** What the card's live status says while an answer is on its way (#142). */
export const SENDING_TEXT = 'Sending your answer…';

/**
 * What the card says, in place, when an answer did not get through (#142).
 * The card stays as it was, with what was chosen and typed, so the user can
 * answer again; `stillWaiting` is whether the runtime still holds this very
 * request, read again after the failure, since a request that went or was
 * replaced meanwhile is a different thing to say than a failed send.
 */
export function answerFailureText(error: unknown, stillWaiting: boolean): string {
	if (!stillWaiting) {
		return 'The request changed or was answered elsewhere before this answer arrived. Check the card and answer again.';
	}
	const reason = error instanceof Error ? error.message : String(error);
	return `Could not send the answer (${reason}). The request is still waiting, so you can answer again.`;
}

/**
 * Which block a card is about, so a fold lasts while the card is drawn again
 * for the same block and a new block opens unfolded.
 */
function foldKey(card: WaitingCardModel): string {
	return card.request ? `request:${card.request.id}` : `${card.kind}:${card.toolUseId}`;
}

/**
 * The card's live status and its error line (#142): what an answer on its way
 * says, and where a failed one says why. The status is in the card from its
 * first draw, clipped while it is empty rather than left out, because a live
 * region that appears together with its words is not read and one that is
 * there and gets them is.
 */
interface CardFeedback {
	/** The answer is on its way: say so, and mark the options busy. */
	sending(): void;
	/** The answer is in; `message` says how, when there is more to say than that. */
	sent(message?: string): void;
	/** The answer failed: say why, in place, with what can be done about it, and free the options. */
	failed(message: string, actions?: readonly CardAction[]): void;
	/** Option groups to mark `aria-busy` while an answer is on its way. */
	busy: HTMLElement[];
}

/** Draws one action button of a request card; the answer is null for "not yet". */
type ButtonMaker<T = WaitingAnswer> = (
	parent: HTMLElement,
	text: string,
	cls: string[],
	answer: () => T | null,
) => HTMLButtonElement;

/** One question's answer as the card holds it: the labels picked and the typed words. */
export interface QuestionPicks {
	options: string[];
	text: string;
}

/**
 * How the question card's presses become an answer of a kind's own: the
 * `claude` kind's {@link WaitingAnswer} or the screen driver's
 * {@link ScreenAnswer}. One renderer draws both, so they read the same.
 */
interface QuestionAnswers<T> {
	/** A lone single choice's option, pressed. */
	one(question: PendingQuestion, label: string): T;
	/** A lone single choice's own words, sent. */
	own(question: PendingQuestion, text: string): T;
	/** Every question answered; null while one has neither an option nor words. */
	all(picks: readonly QuestionPicks[]): T | null;
	/** The button that declines, and its answer. */
	decline: { text: string; answer: T };
}

/** The `claude` kind's answers: keyed by question text, options and words joined as Claude joins them. */
function requestAnswers(questions: readonly PendingQuestion[]): QuestionAnswers<WaitingAnswer> {
	return {
		one: (question, label) => ({ type: 'answer', answers: { [question.question]: label } }),
		own: (question, text) => ({ type: 'answer', answers: { [question.question]: text } }),
		all: (picks) => {
			const answers: Record<string, string> = {};
			for (const [i, question] of questions.entries()) {
				const pick = picks[i];
				const answer = questionAnswer(question.options, new Set(pick?.options ?? []), pick?.text ?? '');
				if (answer === '') return null;
				answers[question.question] = answer;
			}
			return { type: 'answer', answers };
		},
		decline: { text: 'Dismiss', answer: { type: 'dismiss' } },
	};
}

/** The screen driver's answers: one pick per question, in the call's order (ADR-0009 §3). */
function screenAnswers(): QuestionAnswers<ScreenAnswer> {
	return {
		one: (_question, label) => ({ kind: 'questions', picks: [{ options: [label], text: '' }] }),
		own: (_question, text) => ({ kind: 'questions', picks: [{ options: [], text }] }),
		all: (picks) =>
			picks.every((pick) => pick.options.length > 0 || pick.text.trim() !== '')
				? { kind: 'questions', picks: picks.map((pick) => ({ options: [...pick.options], text: pick.text.trim() })) }
				: null,
		decline: { text: 'Cancel', answer: { kind: 'cancel-question' } },
	};
}

/** What {@link WaitingCardView} needs from the surface around it. */
export interface WaitingCardViewOptions {
	/** The pane's session model, or null while none is held. */
	model: () => SessionModelView | null;
	/** The pane the answers go to. */
	paneId: () => string;
	/** How "Trust this folder" reaches the agent (#99). */
	keySender: KeySender;
	/** How a request the runtime is waiting on is answered (ADR-0007), if it can be. */
	responder?: WaitingResponder;
	/**
	 * Reading the pane's dialog off its screen and answering it with keys
	 * (ADR-0009), read per block: herdr and herdr-core, for an agent whose
	 * format reads its dialogs. Null or absent: the card only describes the
	 * block, as before.
	 */
	screen?: () => ScreenAnswering | null;
	/** Brings a turn of the conversation into view: a misfire's "Show in the conversation". */
	revealTurn?: (turnId: string) => void;
	/** The "Trust new folders automatically" setting, read on every block (#99). */
	autoTrustFolders: () => boolean;
	/** Switches the tab back to the terminal view, where every block can be answered. */
	openInTerminal: () => void;
	/** The vault's absolute path, for the tool's one-line detail. */
	vaultPath: () => string;
	/** Markdown as the surface renders it, for a plan. */
	renderMarkdown: (markdown: string, el: HTMLElement, component: Component) => Promise<void>;
	/** Hides or shows the prompt box, whose place the card takes while blocked. */
	setPromptHidden: (hidden: boolean) => void;
	/** How a failure reaches the user. */
	notify: (message: string) => void;
}

/** How many times a screen that shows no dialog yet is read before the card says so. */
const READ_ATTEMPTS = 5;
/** Between those reads: Claude draws its dialog shortly after it reports the block. */
const READ_RETRY_MS = 700;
/** How long the trust prompt must stay up before the card offers it (`./trustWatch.ts`). */
const TRUST_SETTLE_MS = 1500;
/** After an answer went through, how long before the card reads what the terminal shows next. */
const NEXT_READ_MS = 1500;

/**
 * A card read off the pane's screen (ADR-0009), for one block: kept while the
 * card is the same block, so what was chosen and typed on it stays.
 */
interface ScreenState {
	/** The block it was read for: everything in {@link ScreenState.session} and the block's own marks. */
	key: string;
	/** The block without its dangling call: the session, the plan, the block kind. */
	block: string;
	/** The session and its transcript; a change stops an answer before its next key. */
	session: string;
	/** The newest dangling call when the card was built, or ''. */
	dangling: string;
	phase: 'reading' | 'ready' | 'none';
	/** Why the card offers no answer, while `none`. */
	reason: string;
	/** The request, completed with what the card's read showed, once `ready`. */
	expectation: ScreenExpectation | null;
	/** That read's dialog: what the card shows and offers. */
	dialog: ScreenDialog | null;
	/** The calls the transcript held when the card was built: none of them is the answer. */
	known: Set<string>;
	callKind: CallKind;
	/** The card as described before the screen was read; its title changes with what was read. */
	card: WaitingCardModel;
	/** The answer in flight, or null. */
	run: AnswerRun | null;
	/** The last answer's outcome, once one has run. */
	outcome: AnswerOutcome | null;
	/** The transcript line an outcome was judged by. */
	found: FoundReceipt | null;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The format a model's session is read with: absent is the default agent's (ADR-0010). */
function modelFormat(model: SessionModelView | null): AgentFormat | null {
	return model?.format === undefined ? defaultAgentFormat() : model.format;
}

/**
 * The card a `blocked` agent gets instead of the prompt box. One per surface,
 * kept across attaches, because its guards are about the block and not about
 * the element it was drawn on.
 */
export class WaitingCardView {
	/** The card (#99); null whenever the agent is not blocked. */
	private waitingEl: HTMLElement | null = null;
	/** The card's listeners, unloaded whenever it is drawn again or goes. */
	private waitingComponent: Component | null = null;
	/** Whether this surface has already answered the block it is in (#99). */
	private trustSent = false;
	/**
	 * The runtime request the card on screen answers, so a redraw for anything
	 * else keeps the card — and what was chosen or typed on it — as it is.
	 */
	private waitingRequest: PendingRequest | null = null;
	/** The request an answer has been sent for, so a second press sends nothing. */
	private answeredRequest = '';
	/** Whether the card is folded to its one-line bar (#142). */
	private folded = false;
	/** The block the fold belongs to; a card for another block opens unfolded. */
	private foldedFor = '';
	/** The card read off the screen, while the block is one (ADR-0009); null otherwise. */
	private screenState: ScreenState | null = null;
	/** Where the card was last drawn, for a redraw an answer or a read asks for. */
	private rootEl: HTMLElement | null = null;

	constructor(private readonly options: WaitingCardViewOptions) {}

	/**
	 * The waiting card (#99), which is what a `blocked` agent gets instead of
	 * the prompt box: only `blocked` refuses a prompt, and the card is the way
	 * past it. The box is hidden rather than dropped, so the draft in it
	 * survives the block.
	 */
	update(root: HTMLElement, status: AgentStatus): void {
		this.rootEl = root;
		if (status !== 'blocked') {
			// ADR-0009 §5: an answer still before its first commit key stops.
			this.screenState?.run?.cancel('Claude is no longer waiting');
			this.screenState = null;
			this.clear();
			// The block is over: the next one is an answer of its own.
			this.trustSent = false;
			this.foldedFor = '';
			this.folded = false;
			this.options.setPromptHidden(false);
			return;
		}
		const model = this.options.model();
		const request = this.options.responder ? (model?.request ?? null) : null;
		const screen = request ? null : (this.options.screen?.() ?? null);
		if (screen && this.updateScreen(root, model, screen)) return;
		this.screenState?.run?.cancel('the card changed');
		this.screenState = null;
		// The same request still waiting: the card on screen is already it.
		if (request && request === this.waitingRequest && this.waitingEl) {
			this.options.setPromptHidden(true);
			return;
		}
		const card = waitingCard({
			request,
			// The runtime's own word on the block when it has one (ADR-0006);
			// else no transcript at all reads as the workspace trust prompt, as a
			// freshly started Claude writes no file until its first turn
			// (ADR-0003) — a guess the view shows but never answers by itself.
			blockKind: model?.blockKind ?? null,
			hasTranscript: model?.path != null,
			turns: model?.state.turns ?? [],
			vaultPath: this.options.vaultPath(),
			plan: model?.plan ?? null,
			// What a dangling call asks, and what the card calls the agent (ADR-0010).
			// Undefined while no pane has named its agent yet: the default's.
			format: model?.format,
		});
		this.render(root, card);
		this.options.setPromptHidden(true);
		this.autoTrust(card);
	}

	/** Drops the card and its listeners. Safe to call when there is none. */
	clear(): void {
		this.waitingRequest = null;
		this.waitingComponent?.unload();
		this.waitingComponent = null;
		this.waitingEl?.remove();
		this.waitingEl = null;
	}

	/**
	 * Draws the card: what the block is, and the one or two things to do about
	 * it.
	 *
	 * **The startup prompt is the one block with a button of its own.** A
	 * permission is Claude's to decide, through its permission mode, and a
	 * question and a plan are the user's; all three get "Open in terminal"
	 * alone. The workspace trust prompt is what stands between a fresh Claude
	 * in a new directory and a session that can be used from this view at all,
	 * so it gets "Trust this folder". Measured 2026-09-15
	 * (`docs/architecture.md`, "What a bare Enter selects on each of Claude's
	 * blocking dialogs"): the cursor sits on the first option, which here is
	 * "No, exit", so the keys are `Down Enter` and never a bare Enter.
	 *
	 * **It folds** (#142): the title is a bar with a fold button, and folded the
	 * card is that bar alone, so a long plan stops covering a narrow pane. The
	 * fold lasts while the same block is drawn again; the next block opens.
	 * The live status and the error line sit outside what folds.
	 */
	private render(root: HTMLElement, card: WaitingCardModel): void {
		this.clear();
		const component = new Component();
		component.load();
		this.waitingComponent = component;
		const key = foldKey(card);
		if (key !== this.foldedFor) {
			this.foldedFor = key;
			this.folded = false;
		}
		const el = root.createDiv({
			cls: ['herdr-native-waiting', 'herdr-native-sizer'],
			attr: { role: 'region', 'aria-label': card.title },
		});
		this.waitingEl = el;
		const head = el.createDiv({ cls: 'herdr-native-waiting-head' });
		head.createDiv({ cls: 'herdr-native-waiting-title', text: card.title });
		const foldEl = head.createEl('button', { cls: ['clickable-icon', 'herdr-native-waiting-fold'] });
		const content = el.createDiv({ cls: 'herdr-native-waiting-content' });
		const feedback = this.feedback(el);
		const applyFold = (): void => {
			el.toggleClass('is-folded', this.folded);
			content.toggleClass('herdr-is-hidden', this.folded);
			foldEl.setAttr('aria-expanded', String(!this.folded));
			foldEl.setAttr('aria-label', this.folded ? 'Expand the card' : 'Collapse the card');
			setIcon(foldEl, this.folded ? 'chevron-up' : 'chevron-down');
		};
		applyFold();
		component.registerDomEvent(foldEl, 'click', () => {
			this.folded = !this.folded;
			applyFold();
		});
		this.renderContent(content, card, component, feedback);
	}

	/**
	 * The card's status line and error line, after what folds. The status line
	 * is there from the first draw (see {@link CardFeedback}); the error line
	 * comes when there is an error and goes with the next answer.
	 */
	private feedback(el: HTMLElement): CardFeedback {
		const statusEl = el.createDiv({
			cls: ['herdr-native-waiting-status', 'herdr-native-visually-hidden'],
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		let errorEl: HTMLElement | null = null;
		const busy: HTMLElement[] = [];
		const say = (text: string): void => {
			statusEl.setText(text);
			statusEl.toggleClass('herdr-native-visually-hidden', text === '');
		};
		const setBusy = (value: boolean): void => {
			for (const group of busy) group.setAttr('aria-busy', String(value));
		};
		return {
			busy,
			sending: () => {
				errorEl?.remove();
				errorEl = null;
				say(SENDING_TEXT);
				setBusy(true);
			},
			sent: (message) => {
				say(message ?? 'Answer sent.');
				setBusy(false);
			},
			failed: (message, actions = []) => {
				say('');
				setBusy(false);
				errorEl?.remove();
				errorEl = el.createDiv({ cls: 'herdr-native-waiting-error', attr: { role: 'alert' } });
				errorEl.createDiv({ text: message });
				if (actions.length === 0) return;
				const row = errorEl.createDiv({ cls: 'herdr-native-waiting-actions' });
				for (const action of actions) {
					const buttonEl = row.createEl('button', { cls: 'herdr-native-waiting-action', text: action.text });
					this.waitingComponent?.registerDomEvent(buttonEl, 'click', action.run);
				}
			},
		};
	}

	/** Everything on the card under its title bar: what folds. */
	private renderContent(el: HTMLElement, card: WaitingCardModel, component: Component, feedback: CardFeedback): void {
		const state = this.screenState;
		if (state && state.card === card) {
			this.renderScreen(el, state, component, feedback);
			return;
		}
		if (card.request && this.options.responder) {
			this.waitingRequest = card.request;
			this.renderRequest(el, card, card.request, component, feedback);
			return;
		}
		if (card.kind === 'plan') {
			// A plan is Markdown, as the runtime's own plan card draws it (#148).
			if (card.body) {
				void this.options.renderMarkdown(card.body, el.createDiv({ cls: 'herdr-native-waiting-plan' }), component);
			}
			el.createDiv({ cls: 'herdr-native-waiting-hint', text: PLAN_IN_TERMINAL });
		} else if (card.body) {
			el.createDiv({ cls: 'herdr-native-waiting-body', text: card.body });
		}
		for (const option of card.options) {
			drawOption(el.createDiv({ cls: 'herdr-native-waiting-option' }), option);
		}
		// Shown, not answered: say where it is answered, typed answers included.
		if (card.kind === 'question') el.createDiv({ cls: 'herdr-native-waiting-hint', text: QUESTION_IN_TERMINAL });
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		// The startup kind is the trust prompt the runtime reported, or, where
		// the runtime says nothing of kinds, "no transcript at all", which is
		// what a Claude sitting at its trust prompt looks like: it has written no
		// file yet (ADR-0003). Every other kind is a session past this prompt,
		// or a block the runtime named as something else (`auth` included).
		if (card.kind === 'startup') {
			const trustEl = actions.createEl('button', {
				cls: ['herdr-native-waiting-action', 'herdr-native-waiting-trust', 'mod-cta'],
				text: 'Trust this folder',
			});
			component.registerDomEvent(trustEl, 'click', () => {
				void this.trust();
			});
		}
		const terminalEl = actions.createEl('button', {
			cls: ['herdr-native-waiting-action', 'herdr-native-waiting-terminal'],
			text: 'Open in terminal',
		});
		component.registerDomEvent(terminalEl, 'click', () => this.options.openInTerminal());
	}

	/**
	 * Answers the trust prompt when the setting says to, once (#99). The kind is
	 * checked here as well as where the button is drawn, because this is the
	 * path with nobody looking at it: every other block stays on screen,
	 * whatever the setting says.
	 *
	 * **Only a trust prompt the runtime identified.** A startup card guessed
	 * from "no transcript yet" is also what an auth prompt, or any dialog
	 * before the session exists, looks like, and `Down Enter` there picks
	 * whatever its second option is. The guess keeps its button, which the
	 * user presses having been told to check; nothing presses it for them.
	 */
	private autoTrust(card: WaitingCardModel): void {
		if (card.kind !== 'startup' || !card.reported) return;
		if (!this.options.autoTrustFolders()) return;
		// One answer per block for the pane, not one per view: the claim is the
		// model's, which is the thing two tabs on one pane share (ADR-0003). It
		// is also what makes this once per block at all, since the card is drawn
		// again for every change that lands under it. The startup block names no
		// call, so the claim it is made under is the empty one.
		if (this.options.model()?.claimBlock(card.toolUseId) !== true) return;
		void this.trust();
	}

	/**
	 * Trust: `Down Enter` in the pane's agent, which moves off the trust
	 * prompt's first option — "No, exit", which would quit Claude — onto the one
	 * that trusts the folder (`docs/architecture.md`, measured 2026-09-15).
	 * Only ever called for the startup block.
	 *
	 * One answer per block, whoever asks and however often. A second press —
	 * two clicks before the status moves, or a click on a card the setting has
	 * already answered — would land on whatever Claude showed next. The guard is
	 * dropped when the agent leaves `blocked`.
	 */
	private async trust(): Promise<void> {
		if (this.trustSent) return;
		this.trustSent = true;
		try {
			await this.options.keySender.sendKeys(this.options.paneId(), ['Down', 'Enter']);
		} catch (error) {
			this.options.notify(trustFailureMessage(error));
		}
	}

	/**
	 * The card for a request the runtime is waiting on (ADR-0007), with the
	 * answers it can take. Nothing here is pressed for the user: every answer
	 * is a click, and none times out (the agent stays blocked until one comes).
	 *
	 * - **Permission:** Allow, Deny, and — only when Claude suggested them —
	 *   "Allow for this session" and "Always allow in this project", each with
	 *   what it grants on the line under it, the project one naming the
	 *   settings file it writes.
	 * - **Question:** the options as buttons, each with its description under
	 *   it, and a field for an answer of the user's own (the dialog's "Other",
	 *   delivered as the answer's text: measured on Claude Code 2.1.318, the
	 *   `tool_result` quotes it verbatim). One single-choice question is
	 *   answered by its button, or by the typed answer and Send or Enter;
	 *   several, or a multiple choice, by "Send answers" once each has an
	 *   option or a typed answer. "Dismiss" declines.
	 * - **Plan:** the plan as Markdown, "Approve plan", and "Reject" with the
	 *   feedback typed above it.
	 */
	private renderRequest(
		el: HTMLElement,
		card: WaitingCardModel,
		request: PendingRequest,
		component: Component,
		feedback: CardFeedback,
	): void {
		const controls: Control[] = [];
		// A stopping agent has denied the request already: shown, not answerable.
		const stopping = request.stopping === true;
		if (stopping) {
			el.createDiv({ cls: 'herdr-native-waiting-stopping', text: 'The agent is stopping, so this request is being denied.' });
		}
		// Which controls are usable given what is typed and chosen; the question
		// card sets it, and it runs again whenever a failed answer frees them.
		let refresh = (): void => {};
		const send = (answer: WaitingAnswer): void => {
			void this.answer(request, answer, { controls, refresh: () => refresh(), feedback });
		};
		const button: ButtonMaker = (parent, text, cls, answer) => {
			const buttonEl = parent.createEl('button', { cls: ['herdr-native-waiting-action', ...cls], text });
			buttonEl.disabled = stopping;
			controls.push(buttonEl);
			component.registerDomEvent(buttonEl, 'click', () => {
				const chosen = answer();
				if (chosen) send(chosen);
			});
			return buttonEl;
		};
		if (request.kind === 'plan') {
			const planEl = el.createDiv({ cls: 'herdr-native-waiting-plan' });
			void this.options.renderMarkdown(request.plan || 'Claude did not include a plan.', planEl, component);
			const feedbackEl = el.createEl('textarea', {
				cls: 'herdr-native-waiting-feedback',
				attr: { rows: '2', placeholder: 'What should change, if you reject it', 'aria-label': 'Plan feedback' },
			});
			const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
			button(actions, 'Approve plan', ['mod-cta', 'herdr-native-waiting-allow'], () => ({ type: 'approve-plan' }));
			button(actions, 'Reject', ['herdr-native-waiting-deny'], () => ({
				type: 'reject-plan',
				feedback: feedbackEl.value,
			}));
			return;
		}
		if (request.kind === 'question') {
			refresh = this.renderQuestions(
				el,
				request.questions,
				{ button, send, stopping, controls, component, busy: feedback.busy },
				requestAnswers(request.questions),
			);
			return;
		}
		if (card.body) el.createDiv({ cls: 'herdr-native-waiting-body', text: card.body });
		if (request.reason) el.createDiv({ cls: 'herdr-native-waiting-reason', text: request.reason });
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		button(actions, 'Allow', ['mod-cta', 'herdr-native-waiting-allow'], () => ({ type: 'allow' }));
		button(actions, 'Deny', ['herdr-native-waiting-deny'], () => ({ type: 'deny' }));
		if (request.session) {
			const grant = el.createDiv({ cls: 'herdr-native-waiting-grant' });
			button(grant, 'Allow for this session', ['herdr-native-waiting-session'], () => ({ type: 'allow-session' }));
			grant.createSpan({ cls: 'herdr-native-waiting-grant-text', text: request.session.lines.join('; ') });
		}
		if (request.project) {
			const grant = el.createDiv({ cls: 'herdr-native-waiting-grant' });
			button(grant, 'Always allow in this project', ['herdr-native-waiting-project'], () => ({
				type: 'allow-project',
			}));
			grant.createSpan({
				cls: 'herdr-native-waiting-grant-text',
				text: projectGrantText(request.project),
			});
		}
	}

	/**
	 * The questions of an `AskUserQuestion`, and how they are answered. Returns
	 * what sets the Send buttons from what is chosen and typed, which the card
	 * runs again when a failed answer gives the controls back.
	 */
	private renderQuestions<T>(
		el: HTMLElement,
		questions: readonly PendingQuestion[],
		parts: {
			button: ButtonMaker<T>;
			send: (answer: T) => void;
			stopping: boolean;
			controls: Control[];
			component: Component;
			/** Where the option groups go to be marked busy while an answer is on its way. */
			busy: HTMLElement[];
		},
		answers: QuestionAnswers<T>,
	): () => void {
		const { button, send, stopping, controls, component, busy } = parts;
		const single = questions.length === 1 && questions[0]?.multiSelect !== true;
		const picked = new Map<PendingQuestion, Set<string>>();
		const typed = new Map<PendingQuestion, HTMLInputElement>();
		const all = (): T | null =>
			answers.all(
				questions.map((question) => ({
					// In the order Claude offered them, as the answer is written.
					options: question.options.map((o) => o.label).filter((label) => picked.get(question)?.has(label) === true),
					text: typed.get(question)?.value ?? '',
				})),
			);
		const own = (question: PendingQuestion): T | null => {
			const text = typed.get(question)?.value.trim() ?? '';
			return text ? answers.own(question, text) : null;
		};
		let submit: HTMLButtonElement | null = null;
		const sendOwn = new Map<PendingQuestion, HTMLButtonElement>();
		const refresh = (): void => {
			if (stopping) return;
			if (submit) submit.disabled = all() === null;
			for (const [question, sendEl] of sendOwn) sendEl.disabled = own(question) === null;
		};
		for (const question of questions) {
			const block = el.createDiv({ cls: 'herdr-native-waiting-question' });
			if (question.header) block.createDiv({ cls: 'herdr-native-waiting-header', text: question.header });
			block.createDiv({ cls: 'herdr-native-waiting-body', text: question.question });
			// A group named by its question, busy on its own and never on the card:
			// a live region inside an `aria-busy` subtree is not read (Chromium).
			const choices = block.createDiv({
				cls: 'herdr-native-waiting-choices',
				attr: { role: 'group', 'aria-label': question.question, 'aria-busy': 'false' },
			});
			busy.push(choices);
			const optionEls = new Map<string, HTMLButtonElement>();
			// Options that toggle say whether they are on; one that answers at once
			// is a plain button and says nothing of the kind.
			const mark = (): void => {
				if (single) return;
				const chosen = picked.get(question);
				for (const [label, optionEl] of optionEls) {
					const on = chosen?.has(label) === true;
					optionEl.toggleClass('is-selected', on);
					optionEl.setAttr('aria-pressed', String(on));
				}
			};
			for (const option of question.options) {
				const optionEl = button(choices, '', ['herdr-native-waiting-choice'], () => {
					if (single) return answers.one(question, option.label);
					const chosen = picked.get(question) ?? new Set<string>();
					if (question.multiSelect) {
						if (chosen.has(option.label)) chosen.delete(option.label);
						else chosen.add(option.label);
					} else {
						// One choice: an option replaces the typed answer, and the other way round.
						const had = chosen.has(option.label);
						chosen.clear();
						if (!had) chosen.add(option.label);
						const field = typed.get(question);
						if (field) field.value = '';
					}
					picked.set(question, chosen);
					mark();
					refresh();
					return null;
				});
				drawOption(optionEl, option);
				optionEls.set(option.label, optionEl);
			}
			mark();
			// The dialog's "Other": the user's own words, sent as the answer's text.
			const other = block.createDiv({ cls: 'herdr-native-waiting-other' });
			const field = other.createEl('input', {
				cls: 'herdr-native-waiting-other-input',
				type: 'text',
				attr: {
					placeholder: question.options.length > 0 ? 'Or type your own answer' : 'Type your answer',
					'aria-label': `Your own answer: ${question.question}`,
				},
			});
			field.disabled = stopping;
			controls.push(field);
			typed.set(question, field);
			component.registerDomEvent(field, 'input', () => {
				if (!question.multiSelect && field.value.trim()) {
					picked.get(question)?.clear();
					mark();
				}
				refresh();
			});
			component.registerDomEvent(field, 'keydown', (event: KeyboardEvent) => {
				if (!isTypedAnswerKey(event)) return;
				event.preventDefault();
				const answer = single ? own(question) : all();
				if (answer) send(answer);
			});
			if (single) {
				sendOwn.set(question, button(other, 'Send', ['herdr-native-waiting-other-send'], () => own(question)));
			}
		}
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		if (!single) {
			submit = button(actions, 'Send answers', ['mod-cta', 'herdr-native-waiting-allow'], all);
		}
		button(actions, answers.decline.text, ['herdr-native-waiting-deny'], () => answers.decline.answer);
		refresh();
		return refresh;
	}

	/**
	 * Sends one answer to the request on the card, once: the controls go
	 * disabled and the card says it is sending until the runtime has it (#142).
	 * A failure is said on the card, not in a notice, and gives the controls
	 * back with what was chosen and typed still on them.
	 */
	private async answer(
		request: PendingRequest,
		answer: WaitingAnswer,
		card: { controls: Control[]; refresh: () => void; feedback: CardFeedback },
	): Promise<void> {
		const responder = this.options.responder;
		if (!responder || request.stopping || this.answeredRequest === request.id) return;
		this.answeredRequest = request.id;
		for (const control of card.controls) control.disabled = true;
		card.feedback.sending();
		try {
			await responder.respond(this.options.paneId(), request.id, answer);
			card.feedback.sent();
		} catch (error) {
			this.answeredRequest = '';
			for (const control of card.controls) control.disabled = false;
			card.refresh();
			// Read again: the request may have gone, or another taken its place.
			const stillWaiting = this.options.model()?.request?.id === request.id;
			card.feedback.failed(answerFailureText(error, stillWaiting));
		}
	}

	// ------------------------------------------------------------ the screen

	/**
	 * The card for a herdr or herdr-core pane whose dialog can be read off the
	 * screen (ADR-0009). True when it drew the card (or kept the one drawn);
	 * false leaves the block to the card that only describes it: a sign-in.
	 * The trust prompt is one of these cards (#167): its button is offered
	 * only once the screen shows the prompt for the pane's own folder, and
	 * answering it unasked is the tab's trust watch (`./trustWatch.ts`).
	 *
	 * The card is built once per block and kept while the block is the same,
	 * so what was chosen and typed on it stays. While an answer runs nothing
	 * redraws it, and a new session or a newer request stops that answer
	 * before its next key (ADR-0009 §5); the card's own call landing late (a
	 * Bash or Write call lags its dialog) is the same request.
	 */
	private updateScreen(root: HTMLElement, model: SessionModelView | null, screen: ScreenAnswering): boolean {
		const format = modelFormat(model);
		const card = waitingCard({
			request: null,
			blockKind: model?.blockKind ?? null,
			hasTranscript: model?.path != null,
			turns: model?.state.turns ?? [],
			vaultPath: this.options.vaultPath(),
			plan: model?.plan ?? null,
			format: model?.format,
		});
		if (card.kind === 'auth' || !format?.screenDialog) return false;
		const turns = model?.state.turns ?? [];
		const dangling = danglingToolUse(turns);
		const session = `${model?.agentSession ?? ''}\n${model?.path ?? ''}`;
		const block = [session, model?.plan ?? '', model?.blockKind ?? ''].join('\n');
		const key = `${block}\n${dangling?.id ?? ''}`;
		const state = this.screenState;
		if (state && this.waitingEl) {
			if (state.run) {
				if (state.session !== session) state.run.cancel('the session changed');
				else if (
					dangling &&
					dangling.id !== state.dangling &&
					state.expectation &&
					!ownCall(dangling, state.expectation, state.callKind)
				) {
					state.run.cancel('Claude asked something new');
				}
				this.options.setPromptHidden(true);
				return true;
			}
			// The card's own call landing late is the same request, not a new one.
			const ownLanded =
				dangling !== null &&
				state.outcome === null &&
				state.expectation !== null &&
				state.block === block &&
				ownCall(dangling, state.expectation, state.callKind);
			if (state.key === key || ownLanded) {
				state.key = key;
				this.options.setPromptHidden(true);
				return true;
			}
		}
		const fresh: ScreenState = {
			key,
			block,
			session,
			dangling: dangling?.id ?? '',
			phase: 'reading',
			reason: '',
			expectation: null,
			dialog: null,
			known: knownCalls(turns),
			callKind: (call) => format.pendingCall(call)?.kind ?? null,
			card,
			run: null,
			outcome: null,
			found: null,
		};
		this.screenState = fresh;
		this.render(root, card);
		this.options.setPromptHidden(true);
		void this.readScreen(fresh, screen, 0);
		return true;
	}

	/**
	 * Reads the screen and finds the request on it (ADR-0009 §1): which dialog
	 * is up, the requests it may be (the dangling call's first), and the first
	 * one `ScreenAnswerer.inspect` finds, completed with what that read showed.
	 * That read is what the card shows and what an answer must find again. A
	 * screen with no dialog yet is read again a few times: Claude reports the
	 * block a moment before it draws the dialog.
	 */
	private async readScreen(state: ScreenState, screen: ScreenAnswering, attempt: number): Promise<void> {
		const paneId = this.options.paneId();
		const again = (reason: string): void => {
			if (attempt + 1 >= READ_ATTEMPTS) {
				this.screenNone(state, reason);
				return;
			}
			setTimer(() => {
				if (this.screenState === state) void this.readScreen(state, screen, attempt + 1);
			}, screen.retryMs ?? READ_RETRY_MS);
		};
		let raw: string;
		try {
			raw = await screen.screen.read(paneId);
		} catch (error) {
			this.screenNone(state, `Could not read the terminal (${messageOf(error)}).`);
			return;
		}
		if (this.screenState !== state) return;
		const dialog = screen.parse(raw);
		const requests = screenRequests(dialog, raw, {
			dangling: danglingToolUse(this.options.model()?.state.turns ?? []),
			callKind: state.callKind,
			cwd: screen.cwd(),
			statusMessage: screen.statusMessage(),
		});
		if (!requests.ok) {
			if (dialog.kind === 'unknown') again(requests.reason);
			else this.screenNone(state, requests.reason);
			return;
		}
		if (dialog.kind === 'trust' && attempt === 0) {
			// Claude draws the trust prompt twice at startup, the cursor back on
			// "No, exit" the second time (#167): offer it once it has stayed up.
			setTimer(() => {
				if (this.screenState === state) void this.readScreen(state, screen, attempt + 1);
			}, screen.retryMs ?? TRUST_SETTLE_MS);
			return;
		}
		let detail = '';
		for (const expectation of requests.expectations) {
			const inspection = await screen.answerer.inspect(paneId, expectation, screen.statusMessage);
			if (this.screenState !== state) return;
			if (inspection.ok) {
				state.expectation = withShown(expectation, inspection.dialog);
				state.dialog = inspection.dialog;
				state.phase = 'ready';
				this.redrawScreen(state);
				return;
			}
			detail = inspection.detail;
		}
		again(`The terminal changed while Gjetr read it (${detail}).`);
	}

	private screenNone(state: ScreenState, reason: string): void {
		if (this.screenState !== state) return;
		state.phase = 'none';
		state.reason = reason;
		this.redrawScreen(state);
	}

	/** Draws the screen card again, its title from what the read showed. */
	private redrawScreen(state: ScreenState): void {
		if (this.screenState !== state || !this.rootEl) return;
		state.card = { ...state.card, title: this.screenTitle(state) };
		this.render(this.rootEl, state.card);
	}

	private screenTitle(state: ScreenState): string {
		const name = modelFormat(this.options.model())?.name ?? 'The agent';
		const expectation = state.phase === 'ready' ? state.expectation : null;
		switch (expectation?.kind) {
			case 'question':
				return `${name} asked a question`;
			case 'permission':
				return `${name} wants to use ${expectation.tool}`;
			case 'plan':
				return `${name} is ready to code`;
			case 'trust':
				return `${name} is asking whether to trust this folder`;
			default:
				return state.card.title;
		}
	}

	/** Builds the card again from a fresh read: "Read the terminal again", and after an answer went. */
	private rereadScreen(state: ScreenState): void {
		if (this.screenState !== state || state.run || !this.rootEl) return;
		this.screenState = null;
		this.update(this.rootEl, this.options.model()?.agentStatus ?? 'unknown');
	}

	/** The card's content for a screen card: reading, nothing to offer, or the request with its answers. */
	private renderScreen(el: HTMLElement, state: ScreenState, component: Component, feedback: CardFeedback): void {
		if (state.phase === 'ready' && state.dialog && state.expectation) {
			this.renderScreenRequest(el, state, state.dialog, component, feedback);
		} else {
			this.describe(el, state.card, component);
			el.createDiv({
				cls: 'herdr-native-waiting-hint',
				text: state.phase === 'reading' ? 'Reading the terminal…' : `${state.reason} Answer it in the terminal.`,
			});
		}
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		if (state.phase === 'none') {
			const again = actions.createEl('button', { cls: 'herdr-native-waiting-action', text: 'Read the terminal again' });
			component.registerDomEvent(again, 'click', () => this.rereadScreen(state));
		}
		const terminalEl = actions.createEl('button', {
			cls: ['herdr-native-waiting-action', 'herdr-native-waiting-terminal'],
			text: 'Open in terminal',
		});
		component.registerDomEvent(terminalEl, 'click', () => this.options.openInTerminal());
	}

	/** What the card says of a block before (or without) a read: the body, a plan, a question's options. */
	private describe(el: HTMLElement, card: WaitingCardModel, component: Component): void {
		if (card.kind === 'plan' && card.body) {
			void this.options.renderMarkdown(card.body, el.createDiv({ cls: 'herdr-native-waiting-plan' }), component);
		} else if (card.body) {
			el.createDiv({ cls: 'herdr-native-waiting-body', text: card.body });
		}
		for (const option of card.options) drawOption(el.createDiv({ cls: 'herdr-native-waiting-option' }), option);
	}

	/**
	 * The request as the card's read showed it, with the answers the screen
	 * offers (ADR-0009 §3), each labelled as Claude labels it:
	 *
	 * - **Question:** as the `claude` kind's card (options, own words, Send
	 *   answers), with Cancel for `esc`.
	 * - **Permission:** what the dialog shows between its rules, then row 1,
	 *   row 2 in Claude's words (not when it switches to auto mode), and the
	 *   last row (`esc`); and the words for "No, and tell Claude what to do
	 *   differently".
	 * - **Plan:** the plan file's Markdown when it says what the screen shows,
	 *   else the screen's lines; rows 2 and 1, and the words for row 3.
	 *   Approve-with-feedback is not offered: it switches to auto mode.
	 */
	private renderScreenRequest(
		el: HTMLElement,
		state: ScreenState,
		dialog: ScreenDialog,
		component: Component,
		feedback: CardFeedback,
	): void {
		const controls: Control[] = [];
		let refresh = (): void => {};
		const send = (answer: ScreenAnswer): void => {
			void this.answerScreen(state, answer, { controls, refresh: () => refresh(), feedback });
		};
		const button: ButtonMaker<ScreenAnswer> = (parent, text, cls, answer) => {
			const buttonEl = parent.createEl('button', { cls: ['herdr-native-waiting-action', ...cls], text });
			controls.push(buttonEl);
			component.registerDomEvent(buttonEl, 'click', () => {
				const chosen = answer();
				if (chosen) send(chosen);
			});
			return buttonEl;
		};
		/** A field for words to Claude and the button that sends them, which waits for words. */
		const words = (placeholder: string, text: string, cls: string, answer: (typed: string) => ScreenAnswer): void => {
			const row = el.createDiv({ cls: 'herdr-native-waiting-other' });
			const field = row.createEl('input', {
				cls: 'herdr-native-waiting-other-input',
				type: 'text',
				attr: { placeholder, 'aria-label': placeholder },
			});
			controls.push(field);
			const sendEl = button(row, text, [cls], () => (field.value.trim() ? answer(field.value.trim()) : null));
			const sync = (): void => {
				sendEl.disabled = field.value.trim() === '';
			};
			const before = refresh;
			refresh = () => {
				before();
				sync();
			};
			component.registerDomEvent(field, 'input', sync);
			component.registerDomEvent(field, 'keydown', (event: KeyboardEvent) => {
				if (!isTypedAnswerKey(event)) return;
				event.preventDefault();
				if (field.value.trim() && !sendEl.disabled) send(answer(field.value.trim()));
			});
			sync();
		};
		const expectation = state.expectation;
		if (dialog.kind === 'question' && expectation?.kind === 'question') {
			refresh = this.renderQuestions(
				el,
				expectation.questions,
				{ button, send, stopping: false, controls, component, busy: feedback.busy },
				screenAnswers(),
			);
			return;
		}
		if (dialog.kind === 'permission') {
			el.createDiv({ cls: 'herdr-native-waiting-header', text: dialog.title });
			if (dialog.content.length > 0) {
				el.createDiv({ cls: 'herdr-native-waiting-screen', text: dialog.content.join('\n') });
			}
			const prompt = joinWrapped(dialog.prompt);
			if (prompt) el.createDiv({ cls: 'herdr-native-waiting-body', text: prompt });
			const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
			const first = joinWrapped(dialog.options[0]?.lines ?? []) || 'Yes';
			button(actions, first, ['mod-cta', 'herdr-native-waiting-allow'], () => ({ kind: 'allow' }));
			const second = permissionOption2(dialog);
			if (second) {
				button(actions, second, ['herdr-native-waiting-session'], () => ({ kind: 'allow-option-2', label: second }));
			}
			const last = joinWrapped(dialog.options[dialog.options.length - 1]?.lines ?? []) || 'No';
			button(actions, last, ['herdr-native-waiting-deny'], () => ({ kind: 'deny' }));
			words('Tell Claude what to do differently', 'No, and tell Claude', 'herdr-native-waiting-deny', (typed) => ({
				kind: 'deny-with-feedback',
				feedback: typed,
			}));
			return;
		}
		if (dialog.kind === 'trust' && expectation?.kind === 'trust') {
			// The folder as the pane reports it, which the prompt was matched against.
			el.createDiv({ cls: 'herdr-native-waiting-body', text: expectation.cwd });
			const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
			button(actions, 'Yes, I trust this folder', ['mod-cta', 'herdr-native-waiting-trust'], () => ({ kind: 'trust' }));
			return;
		}
		if (dialog.kind === 'plan') {
			const planEl = el.createDiv({ cls: 'herdr-native-waiting-plan' });
			const markdown = this.options.model()?.plan ?? null;
			if (markdown && planAgrees(markdown, dialog.plan)) {
				void this.options.renderMarkdown(markdown, planEl, component);
			} else {
				planEl.createDiv({ cls: 'herdr-native-waiting-screen', text: dialog.plan.join('\n') });
				el.createDiv({ cls: 'herdr-native-waiting-hint', text: 'The plan as the terminal shows it.' });
			}
			const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
			const manual = joinWrapped(dialog.options[1]?.lines ?? []);
			const auto = joinWrapped(dialog.options[0]?.lines ?? []);
			if (manual) {
				button(actions, manual, ['mod-cta', 'herdr-native-waiting-allow'], () => ({
					kind: 'approve-plan',
					mode: 'manual',
					label: manual,
				}));
			}
			if (auto) {
				button(actions, auto, ['herdr-native-waiting-session'], () => ({ kind: 'approve-plan', mode: 'auto', label: auto }));
			}
			const change = joinWrapped(dialog.options[2]?.lines ?? []) || 'Tell Claude what to change';
			words('What should change', change, 'herdr-native-waiting-deny', (typed) => ({ kind: 'reject-plan', feedback: typed }));
		}
	}

	/**
	 * Runs one answer through the shared driver (ADR-0009 §2–§5) and says on
	 * the card how it went. The controls stay disabled unless nothing reached
	 * the terminal and the card still holds (an answer that cannot be sent,
	 * another answer in flight). A misfire is also a notice: the card may be
	 * gone by the time the transcript says it.
	 */
	private async answerScreen(
		state: ScreenState,
		answer: ScreenAnswer,
		ui: { controls: Control[]; refresh: () => void; feedback: CardFeedback },
	): Promise<void> {
		const screen = this.options.screen?.() ?? null;
		const expectation = state.expectation;
		if (!screen || !expectation || state.run) return;
		for (const control of ui.controls) control.disabled = true;
		ui.feedback.sending();
		const run = screen.answerer.answer({
			paneId: this.options.paneId(),
			expectation,
			answer,
			statusMessage: screen.statusMessage,
			receipt: (signal) => this.screenReceipt(state, expectation, signal),
		});
		state.run = run;
		const outcome = await run.done;
		state.run = null;
		state.outcome = outcome;
		const view = outcomeView(outcome);
		if (outcome.kind === 'misfire') this.options.notify(`Gjetr: ${view.text}`);
		if (this.screenState !== state || !this.waitingEl) return;
		if (view.tone === 'done') {
			ui.feedback.sent(view.text);
			// The next dialog may follow without the block ending: read what is up then.
			setTimer(() => this.rereadScreen(state), screen.nextReadMs ?? NEXT_READ_MS);
			return;
		}
		if (view.retry) {
			state.outcome = null;
			for (const control of ui.controls) control.disabled = false;
			ui.refresh();
		}
		const actions: CardAction[] = [];
		const found = state.found;
		const reveal = this.options.revealTurn;
		if (outcome.kind === 'misfire' && found && reveal) {
			actions.push({ text: 'Show in the conversation', run: () => reveal(found.turnId) });
		}
		if (view.reread) actions.push({ text: 'Read the terminal again', run: () => this.rereadScreen(state) });
		ui.feedback.failed(view.text, actions);
	}

	/**
	 * What Claude received, from the transcript (ADR-0009 §4): resolves once
	 * the session model holds the card's result (`findReceipt`), and stops
	 * listening when the driver stops waiting.
	 */
	private screenReceipt(state: ScreenState, expectation: ScreenExpectation, signal: AbortSignal): Promise<AnswerReceipt> {
		return new Promise((resolve) => {
			const model = this.options.model();
			if (!model) return;
			let off: (() => void) | null = null;
			const check = (): void => {
				if (expectation.kind === 'trust') {
					// No transcript: the session starting is the receipt (#167).
					if (!sessionStarted(model)) return;
					off?.();
					off = null;
					resolve({ kind: 'started' });
					return;
				}
				const found = findReceipt(model.state.turns, expectation, state.known, state.callKind);
				if (!found) return;
				off?.();
				off = null;
				state.found = found;
				resolve(found.receipt);
			};
			off = model.on(() => check());
			signal.addEventListener('abort', () => {
				off?.();
				off = null;
			});
			check();
		});
	}
}
