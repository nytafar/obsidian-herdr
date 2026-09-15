/**
 * The prompt sender (issue #97, ADR-0003).
 *
 * One rule this file exists for: the request the sender builds for
 * `agent.prompt` carries no `wait` field. `--wait` fails on local commands and
 * matches the turn already in flight while the agent is working
 * (`docs/architecture.md`, "Agent prompts and session identity"), so the plugin
 * never asks for it, and a fake client here records exactly what went out.
 */

import { describe, expect, it } from 'vitest';
import {
	agentPromptParams,
	clientPromptSender,
	NO_CONNECTION_MESSAGE,
} from '../src/native/promptSender';

/** A client that records the one call it is given. */
function recordingClient(): {
	calls: { method: string; params: unknown }[];
	request: <T>(method: string, params: unknown) => Promise<T>;
} {
	const calls: { method: string; params: unknown }[] = [];
	return {
		calls,
		request: async <T>(method: string, params: unknown): Promise<T> => {
			calls.push({ method, params });
			return undefined as T;
		},
	};
}

describe('agentPromptParams', () => {
	it('names the pane and the text, and nothing else', () => {
		const params = agentPromptParams('w4:p1', 'first line\n\nthird line');

		expect(params).toEqual({ target: 'w4:p1', text: 'first line\n\nthird line' });
		expect(Object.keys(params)).toEqual(['target', 'text']);
	});
});

describe('clientPromptSender', () => {
	it('sends agent.prompt with no wait field', async () => {
		const client = recordingClient();
		const sender = clientPromptSender(() => client);

		await sender.send('w4:p1', 'Summarise the design');

		expect(client.calls).toHaveLength(1);
		expect(client.calls[0]?.method).toBe('agent.prompt');
		const params = client.calls[0]?.params as Record<string, unknown>;
		expect(params).toEqual({ target: 'w4:p1', text: 'Summarise the design' });
		expect('wait' in params).toBe(false);
	});

	it('rejects with a readable message when nothing is connected', async () => {
		const sender = clientPromptSender(() => null);

		await expect(sender.send('w4:p1', 'hello')).rejects.toThrow(NO_CONNECTION_MESSAGE);
	});
});
