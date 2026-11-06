/**
 * The waiting card as DOM (#99, ADR-0007): the half of `./waitingCard.ts` that
 * draws the card and acts on it.
 *
 * `./waitingCard.ts` says which block the agent is in, as a value; this draws
 * that value under the turns, wires its buttons, and is the one place in the
 * native view that answers anything: the workspace trust prompt (`Down Enter`
 * through the key sender) and a request the runtime itself holds (through the
 * kind's responder). It holds the guards that make each answer go out once.
 */

import { Component } from 'obsidian';
import type { AgentStatus } from '../herdr/types.gen';
import type { KeySender } from './promptSender';
import { isTypedAnswerKey, optionName, questionAnswer, waitingCard, type WaitingCardModel } from './waitingCard';
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
	return `Herdr: could not trust this folder (${reason})`;
}

/**
 * What a question card says when the view cannot answer it: the runtime only
 * reports that a question is waiting (herdr, herdr-core), so the answer — a
 * typed one included — is given in the terminal.
 */
export const QUESTION_IN_TERMINAL =
	'Answer it in the terminal, where you can also type an answer of your own: this runtime does not take answers from the view.';

/**
 * One option as the card draws it, inside `parent` (a button or a line): the
 * label with Claude's "(Recommended)" suffix drawn as a tag, and the
 * description on the line under it — never a tooltip alone, which neither a
 * touch screen nor a screen reader shows (after Ovis's `PromptCard.tsx`, MIT).
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

/** What the card disables while an answer is on its way: its buttons and its text fields. */
type Control = HTMLButtonElement | HTMLInputElement;

/** Draws one action button of a request card; the answer is null for "not yet". */
type ButtonMaker = (
	parent: HTMLElement,
	text: string,
	cls: string[],
	answer: () => WaitingAnswer | null,
) => HTMLButtonElement;

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

	constructor(private readonly options: WaitingCardViewOptions) {}

	/**
	 * The waiting card (#99), which is what a `blocked` agent gets instead of
	 * the prompt box: only `blocked` refuses a prompt, and the card is the way
	 * past it. The box is hidden rather than dropped, so the draft in it
	 * survives the block.
	 */
	update(root: HTMLElement, status: AgentStatus): void {
		if (status !== 'blocked') {
			this.clear();
			// The block is over: the next one is an answer of its own.
			this.trustSent = false;
			this.options.setPromptHidden(false);
			return;
		}
		const model = this.options.model();
		const request = this.options.responder ? (model?.request ?? null) : null;
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
	 */
	private render(root: HTMLElement, card: WaitingCardModel): void {
		this.clear();
		const component = new Component();
		component.load();
		this.waitingComponent = component;
		const el = root.createDiv({ cls: ['herdr-native-waiting', 'herdr-native-sizer'] });
		this.waitingEl = el;
		el.createDiv({ cls: 'herdr-native-waiting-title', text: card.title });
		if (card.request && this.options.responder) {
			this.waitingRequest = card.request;
			this.renderRequest(el, card, card.request, component);
			return;
		}
		if (card.body) el.createDiv({ cls: 'herdr-native-waiting-body', text: card.body });
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
			void this.answer(request, answer, controls, () => refresh());
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
			refresh = this.renderQuestions(el, request.questions, { button, send, stopping, controls, component });
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
	private renderQuestions(
		el: HTMLElement,
		questions: readonly PendingQuestion[],
		parts: {
			button: ButtonMaker;
			send: (answer: WaitingAnswer) => void;
			stopping: boolean;
			controls: Control[];
			component: Component;
		},
	): () => void {
		const { button, send, stopping, controls, component } = parts;
		const single = questions.length === 1 && questions[0]?.multiSelect !== true;
		const picked = new Map<PendingQuestion, Set<string>>();
		const typed = new Map<PendingQuestion, HTMLInputElement>();
		const answerTo = (question: PendingQuestion): string =>
			questionAnswer(question.options, picked.get(question) ?? new Set(), typed.get(question)?.value ?? '');
		const all = (): WaitingAnswer | null => {
			if (!questions.every((question) => answerTo(question) !== '')) return null;
			const answers: Record<string, string> = {};
			for (const question of questions) answers[question.question] = answerTo(question);
			return { type: 'answer', answers };
		};
		const own = (question: PendingQuestion): WaitingAnswer | null => {
			const text = typed.get(question)?.value.trim() ?? '';
			return text ? { type: 'answer', answers: { [question.question]: text } } : null;
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
			const choices = block.createDiv({ cls: 'herdr-native-waiting-choices' });
			const optionEls = new Map<string, HTMLButtonElement>();
			const mark = (): void => {
				const chosen = picked.get(question);
				for (const [label, optionEl] of optionEls) optionEl.toggleClass('is-selected', chosen?.has(label) === true);
			};
			for (const option of question.options) {
				const optionEl = button(choices, '', ['herdr-native-waiting-choice'], () => {
					if (single) return { type: 'answer', answers: { [question.question]: option.label } };
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
		button(actions, 'Dismiss', ['herdr-native-waiting-deny'], () => ({ type: 'dismiss' }));
		refresh();
		return refresh;
	}

	/**
	 * Sends one answer to the request on the card, once: the controls go
	 * disabled until the runtime has it, and come back only if it failed, with
	 * what was chosen and typed still on them.
	 */
	private async answer(
		request: PendingRequest,
		answer: WaitingAnswer,
		controls: Control[],
		refresh: () => void,
	): Promise<void> {
		const responder = this.options.responder;
		if (!responder || request.stopping || this.answeredRequest === request.id) return;
		this.answeredRequest = request.id;
		for (const control of controls) control.disabled = true;
		try {
			await responder.respond(this.options.paneId(), request.id, answer);
		} catch (error) {
			this.answeredRequest = '';
			for (const control of controls) control.disabled = false;
			refresh();
			const reason = error instanceof Error ? error.message : String(error);
			this.options.notify(`Herdr: could not answer Claude (${reason})`);
		}
	}
}
