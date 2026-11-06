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
import { waitingCard, type WaitingCardModel } from './waitingCard';
import {
	projectGrantText,
	type PendingQuestion,
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
			el.createDiv({ cls: 'herdr-native-waiting-option', text: option });
		}
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
	 * - **Question:** the options as buttons; one single-choice question is
	 *   answered by its button, several (or a multiple choice) by "Send
	 *   answers" once each has one. "Dismiss" declines.
	 * - **Plan:** the plan as Markdown, "Approve plan", and "Reject" with the
	 *   feedback typed above it.
	 */
	private renderRequest(
		el: HTMLElement,
		card: WaitingCardModel,
		request: PendingRequest,
		component: Component,
	): void {
		const buttons: HTMLButtonElement[] = [];
		// A stopping agent has denied the request already: shown, not answerable.
		const stopping = request.stopping === true;
		if (stopping) {
			el.createDiv({ cls: 'herdr-native-waiting-stopping', text: 'The agent is stopping, so this request is being denied.' });
		}
		const send = (answer: WaitingAnswer): void => {
			void this.answer(request, answer, buttons);
		};
		const button: ButtonMaker = (parent, text, cls, answer) => {
			const buttonEl = parent.createEl('button', { cls: ['herdr-native-waiting-action', ...cls], text });
			buttonEl.disabled = stopping;
			buttons.push(buttonEl);
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
			this.renderQuestions(el, request.questions, button);
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

	/** The questions of an `AskUserQuestion`, and how they are answered. */
	private renderQuestions(
		el: HTMLElement,
		questions: readonly PendingQuestion[],
		button: ButtonMaker,
	): void {
		const single = questions.length === 1 && questions[0]?.multiSelect !== true;
		const chosen = new Map<string, Set<string>>();
		let submit: HTMLButtonElement | null = null;
		const complete = (): boolean => questions.every((question) => (chosen.get(question.question)?.size ?? 0) > 0);
		for (const question of questions) {
			const block = el.createDiv({ cls: 'herdr-native-waiting-question' });
			if (question.header) block.createDiv({ cls: 'herdr-native-waiting-header', text: question.header });
			block.createDiv({ cls: 'herdr-native-waiting-body', text: question.question });
			const options = block.createDiv({ cls: 'herdr-native-waiting-actions' });
			for (const option of question.options) {
				const optionEl = button(options, option.label, ['herdr-native-waiting-choice'], () => {
					if (single) return { type: 'answer', answers: { [question.question]: option.label } };
					const picked = chosen.get(question.question) ?? new Set<string>();
					if (!question.multiSelect) picked.clear();
					if (picked.has(option.label)) picked.delete(option.label);
					else picked.add(option.label);
					chosen.set(question.question, picked);
					for (const sibling of Array.from(options.children)) {
						sibling.toggleClass('is-selected', picked.has(sibling.textContent ?? ''));
					}
					if (submit) submit.disabled = !complete();
					return null;
				});
				if (option.description) optionEl.setAttr('title', option.description);
			}
		}
		const actions = el.createDiv({ cls: 'herdr-native-waiting-actions' });
		if (!single) {
			submit = button(actions, 'Send answers', ['mod-cta', 'herdr-native-waiting-allow'], () => {
				if (!complete()) return null;
				const answers: Record<string, string> = {};
				for (const question of questions) {
					answers[question.question] = [...(chosen.get(question.question) ?? [])].join(', ');
				}
				return { type: 'answer', answers };
			});
			submit.disabled = submit.disabled || !complete();
		}
		button(actions, 'Dismiss', ['herdr-native-waiting-deny'], () => ({ type: 'dismiss' }));
	}

	/**
	 * Sends one answer to the request on the card, once: the buttons go
	 * disabled until the runtime has it, and come back only if it failed.
	 */
	private async answer(request: PendingRequest, answer: WaitingAnswer, buttons: HTMLButtonElement[]): Promise<void> {
		const responder = this.options.responder;
		if (!responder || request.stopping || this.answeredRequest === request.id) return;
		this.answeredRequest = request.id;
		for (const buttonEl of buttons) buttonEl.disabled = true;
		try {
			await responder.respond(this.options.paneId(), request.id, answer);
		} catch (error) {
			this.answeredRequest = '';
			for (const buttonEl of buttons) buttonEl.disabled = false;
			const reason = error instanceof Error ? error.message : String(error);
			this.options.notify(`Herdr: could not answer Claude (${reason})`);
		}
	}
}
