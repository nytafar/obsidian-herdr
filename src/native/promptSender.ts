/**
 * The prompt sender (issue #97, ADR-0003).
 *
 * The native view's one way of putting text into a pane's agent: herdr's
 * `agent.prompt`, which delivers the text and Enter in one operation, keeps a
 * multi-line prompt intact and executes a leading `/command` (verified
 * 2026-09-14, `docs/architecture.md`, "Agent prompts and session identity").
 *
 * **Never with `wait`.** A waiting prompt fails with `agent_prompt_stalled` on
 * a local command that changes no status, and while the agent is working its
 * result is the end of the turn already in flight, not of the prompt just sent
 * (ADR-0003). State comes from herdr's events instead, so the request this
 * builds has two fields and `tests/promptSender.test.ts` pins that it has two.
 *
 * No `obsidian` import: a failed send becomes a Notice where the box lives
 * (`./promptBox.ts`), not here, and the sender stays a plain seam a remote
 * adapter can satisfy later.
 */

import type { AgentPromptParams, AgentSendKeysParams, PaneSendTextParams } from '../herdr/types.gen';
import { imagePaste, localImageFiles, type ImageFiles, type PromptImage } from './promptImages';

/**
 * How a prompt is handed over (#159). Left out, it is typed as the prompt box
 * always typed it.
 *
 * **Where a break-in "Send now" goes.** Send now passes {@link SEND_NOW}, and
 * the agent takes the prompt in at its next tool boundary. A variant that
 * breaks into a running tool is one more field here, `breakIn?: boolean`, set
 * in {@link SEND_NOW}, and one branch per sender: herdr follows the prompt
 * with `agent.send_keys ["ctrl+enter"]`, herdr-core with `terminal.keys
 * ["ctrl+enter"]` (both move the running command to the background), and the
 * `claude` kind writes `control_request {subtype: "interrupt", send_now:
 * true, message_uuid}` after the line (which aborts it). Measured in the
 * finding `queued-prompts`; not built.
 */
export interface PromptSendOptions {
	/**
	 * A row the plugin's queue holds, going out because the agent left
	 * `working` (#159). A sender that can tell the agent started working
	 * meanwhile refuses with {@link PromptHeldBack} and types nothing, so the
	 * row stays for the next turn; one that cannot types it, and Claude queues
	 * it as it always did.
	 */
	held?: boolean;
}

/** What Send now hands over with: at the agent's next tool boundary (#159). */
export const SEND_NOW: PromptSendOptions = {};

/**
 * A held row was not typed because the agent is not ready for it: working
 * again, or blocked. Not a failure: the queue keeps the row, says nothing, and
 * tries again on the next transition out of `working` (#159).
 */
export class PromptHeldBack extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PromptHeldBack';
	}
}

/** What the prompt box needs; a remote adapter can satisfy the same shape. */
export interface PromptSender {
	/**
	 * Delivers `text` to the pane's agent, with `images` attached when there
	 * are any (#144); `text` may be empty then. Rejects with a readable message,
	 * or with {@link PromptHeldBack} for a held row the agent is not ready for.
	 */
	send(
		paneId: string,
		text: string,
		images?: readonly PromptImage[],
		options?: PromptSendOptions,
	): Promise<void>;
	/**
	 * Why images cannot go to this pane's agent, in words for the prompt box,
	 * or null when they can (#144). A sender without it takes none
	 * ({@link IMAGES_UNSUPPORTED}).
	 */
	imagesUnavailable?(paneId: string): string | null;
	/**
	 * Ends the running turn, keeping the agent for the next prompt. Only a kind
	 * with a real interrupt has it (the `claude` kind's `interrupt` control
	 * request, ADR-0007); the prompt box shows its Stop button only then.
	 */
	interrupt?(paneId: string): Promise<void>;
	/**
	 * Why nothing may be typed into the pane now, or null: on herdr and
	 * herdr-core, while the session bar drives one of Claude's pickers there,
	 * or one may still be open (`./paneGate.ts`). A send then refuses with the
	 * same words; the prompt box shows them and keeps the text.
	 */
	blocked?(paneId: string): string | null;
}

/**
 * What the waiting card needs (#99): keys pressed in the pane's agent, which is
 * herdr's `agent.send_keys`. Same shape as {@link PromptSender} and the same
 * two adapters, because a remote endpoint answers the same request.
 *
 * The card decides *which* keys, and the only dialog it decides for is the
 * workspace trust prompt, where they are `Down Enter`: the first option there
 * is "No, exit", so a bare Enter would quit Claude (`docs/architecture.md`,
 * "What a bare Enter selects on each of Claude's blocking dialogs"). Tool
 * permissions, questions and plan approval are answered in the terminal.
 */
export interface KeySender {
	/** Presses `keys` in the pane's agent. Rejects with a readable message. */
	sendKeys(paneId: string, keys: readonly string[]): Promise<void>;
}

/** The part of `HerdrClient` this uses: one call. */
export interface PromptClient {
	request<T>(method: string, params: unknown): Promise<T>;
}

/** Shown as a Notice when a prompt is typed with no herdr to send it to. */
export const NO_CONNECTION_MESSAGE = 'Not connected to herdr.';

/** Why a sender that says nothing about images takes none (#144). */
export const IMAGES_UNSUPPORTED = 'this runtime cannot send images to its agents';

/** Why images cannot go out, for a sender that may say nothing about them. */
export function imagesUnavailable(sender: PromptSender, paneId: string): string | null {
	return sender.imagesUnavailable ? sender.imagesUnavailable(paneId) : IMAGES_UNSUPPORTED;
}

/**
 * The `agent.prompt` request for one prompt: the pane and the text, verbatim.
 * Deliberately not spread from anything, so no caller can slip a `wait` in.
 */
export function agentPromptParams(paneId: string, text: string): AgentPromptParams {
	return { target: paneId, text };
}

/** The `agent.send_keys` request for one press: the pane and the keys. */
export function agentSendKeysParams(paneId: string, keys: readonly string[]): AgentSendKeysParams {
	return { target: paneId, keys: [...keys] };
}

/** The `pane.send_text` request that types `text` into the pane exactly. */
export function paneSendTextParams(paneId: string, text: string): PaneSendTextParams {
	return { pane_id: paneId, text };
}

/**
 * A sender over the herdr that is connected *now*: the client is read per send
 * because a reconnect replaces it, and a null one is an ordinary failure the
 * box reports rather than a crash.
 *
 * Images (#144) go the way a person drops a file on Claude's terminal: each is
 * written to a file on this machine (`files`), the paths go in as one
 * bracketed paste with `pane.send_text`, which Claude turns into image
 * attachments, and the text follows with `agent.prompt`, whose Enter sends
 * both. herdr refuses an empty `agent.prompt` (`empty_agent_prompt`), so a
 * picture with no words is sent with a bare Enter. Only a local herdr shows
 * the native view, so this machine is the agent's (measured 2026-11-06,
 * `docs/architecture.md`, "Images in prompts").
 *
 * A held row (#159) goes the same way: herdr has no idle guard, so a turn
 * that started meanwhile gets it queued in Claude, as before the plugin held
 * any. Only `agent_blocked` holds it back.
 */
export function clientPromptSender(
	client: () => PromptClient | null,
	files: ImageFiles = localImageFiles(),
): PromptSender {
	return {
		async send(
			paneId: string,
			text: string,
			images: readonly PromptImage[] = [],
			options: PromptSendOptions = {},
		): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			try {
				if (!images.length) {
					await connected.request('agent.prompt', agentPromptParams(paneId, text));
					return;
				}
				const paths = await files.write(images);
				try {
					await connected.request('pane.send_text', paneSendTextParams(paneId, imagePaste(paths)));
					if (text.trim()) await connected.request('agent.prompt', agentPromptParams(paneId, text));
					else await connected.request('agent.send_keys', agentSendKeysParams(paneId, ['Enter']));
				} finally {
					files.release(paths);
				}
			} catch (error) {
				if (options.held && errorCode(error) === 'agent_blocked') {
					throw new PromptHeldBack(error instanceof Error ? error.message : String(error));
				}
				throw error;
			}
		},
		imagesUnavailable: () => null,
	};
}

/** A herdr error's code (`HerdrError.code`), read without importing the client. */
function errorCode(error: unknown): string | null {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' ? code : null;
}

/** The key sender's half of the same thing, over the same client. */
export function clientKeySender(client: () => PromptClient | null): KeySender {
	return {
		async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			await connected.request('agent.send_keys', agentSendKeysParams(paneId, keys));
		},
	};
}
