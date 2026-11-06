/**
 * A subagent's transcript, opened on request (#147): drawn the way the native
 * view draws turns, kept current while it is open, and let go when it closes.
 * The modal around it is Obsidian's; the view is driven here on the DOM
 * harness.
 */

import { describe, expect, it } from 'vitest';
import { hostEl } from './fixtures/dom';
import { SubagentTranscriptView } from '../src/native/subagentModal';
import type { SubagentTranscript } from '../src/native/subagents';
import type { ConversationState, Turn } from '../src/native/conversation';

function turn(id: string, prompt: string, text: string): Turn {
	return { id, prompt, entries: [{ kind: 'text', messageId: `m-${id}`, text }], headings: [] };
}

/** A transcript a test moves by hand. */
function transcriptOf(turns: Turn[]) {
	const listeners = new Set<() => void>();
	let released = 0;
	const value = {
		state: { turns, raw: {} } as ConversationState,
		running: true,
		on: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		release: () => {
			released++;
		},
	};
	const transcript: SubagentTranscript = value;
	return {
		transcript,
		move: (next: Turn[], running: boolean) => {
			value.state = { turns: next, raw: {} };
			value.running = running;
			for (const listener of [...listeners]) listener();
		},
		listeners: () => listeners.size,
		released: () => released,
	};
}

function viewOn(turns: Turn[]) {
	const { el, host } = hostEl();
	const handle = transcriptOf(turns);
	const rendered: string[] = [];
	const view = new SubagentTranscriptView(host, handle.transcript, {
		presentation: () => 'highlight',
		vaultPath: () => '/vault',
		renderMarkdown: (markdown, target) => {
			rendered.push(markdown);
			target.appendText(markdown);
			return Promise.resolve();
		},
		resolveUri: () => null,
	});
	return { el, view, handle, rendered };
}

describe('the subagent transcript view (#147)', () => {
	it('draws the subagent’s turns and says it is working', () => {
		const { el } = viewOn([turn('s1', 'Check the styles', 'Looking.')]);
		expect(el.find('herdr-subagent-status').textContent).toBe('Working…');
		expect(el.find('herdr-native-prompt').textContent).toBe('Check the styles');
		expect(el.find('herdr-native-block').textContent).toBe('Looking.');
	});

	it('follows it as it is read, drawing only what changed', () => {
		const { el, handle, rendered } = viewOn([turn('s1', 'Check the styles', 'Looking.')]);
		const first = { ...turn('s1', 'Check the styles', 'Looking.') };
		first.entries = [...first.entries, { kind: 'text', messageId: 'm-2', text: 'Done.' }];
		handle.move([first], false);
		expect(rendered).toEqual(['Looking.', 'Done.']);
		expect(el.find('herdr-subagent-status').textContent).toBe('Not working');
	});

	it('draws a file read again from its start afresh', () => {
		const { el, handle } = viewOn([turn('s1', 'Check the styles', 'Looking.')]);
		handle.move([turn('s9', 'Another start', 'Again.')], true);
		expect(el.findAll('herdr-native-turn')).toHaveLength(1);
		expect(el.find('herdr-native-prompt').textContent).toBe('Another start');
	});

	it('lets the transcript go when it closes, once', () => {
		const { view, handle } = viewOn([]);
		expect(handle.listeners()).toBe(1);
		view.destroy();
		view.destroy();
		expect(handle.listeners()).toBe(0);
		expect(handle.released()).toBe(1);
	});
});
