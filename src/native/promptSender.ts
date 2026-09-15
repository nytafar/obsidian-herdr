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

import type { AgentPromptParams } from '../herdr/types.gen';

/** What the prompt box needs; a remote adapter can satisfy the same shape. */
export interface PromptSender {
	/** Delivers `text` to the pane's agent. Rejects with a readable message. */
	send(paneId: string, text: string): Promise<void>;
}

/** The part of `HerdrClient` this uses: one call. */
export interface PromptClient {
	request<T>(method: string, params: unknown): Promise<T>;
}

/** Shown as a Notice when a prompt is typed with no herdr to send it to. */
export const NO_CONNECTION_MESSAGE = 'Not connected to herdr.';

/**
 * The `agent.prompt` request for one prompt: the pane and the text, verbatim.
 * Deliberately not spread from anything, so no caller can slip a `wait` in.
 */
export function agentPromptParams(paneId: string, text: string): AgentPromptParams {
	return { target: paneId, text };
}

/**
 * A sender over the herdr that is connected *now*: the client is read per send
 * because a reconnect replaces it, and a null one is an ordinary failure the
 * box reports rather than a crash.
 */
export function clientPromptSender(client: () => PromptClient | null): PromptSender {
	return {
		async send(paneId: string, text: string): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			await connected.request('agent.prompt', agentPromptParams(paneId, text));
		},
	};
}
