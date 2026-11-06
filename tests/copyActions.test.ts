/**
 * Copying out of the native view (#140): a prompt, and a reply as Markdown or
 * plain text. The text is the transcript's, so the pure parts — what the reply
 * is, what plain text makes of it — are tested on their own, and the buttons
 * on the turn renderer, with a copier that records what reached it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { iconOf } from './fixtures/obsidian';
import { TurnRenderer } from '../src/native/turnRenderer';
import {
	COPY_FAILED_MESSAGE,
	COPY_FEEDBACK_MS,
	plainText,
	replyMarkdown,
	type Copier,
} from '../src/native/copyActions';
import type { ToolEntry, Turn, TurnEntry } from '../src/native/conversation';

const VAULT = '/vault';

function text(messageId: string, body: string): TurnEntry {
	return { kind: 'text', messageId, text: body };
}

function tool(id: string): ToolEntry {
	return {
		kind: 'tool',
		id,
		name: 'Read',
		input: { file_path: `${VAULT}/${id}.md` },
		result: 'ok',
		status: 'done',
		notification: null,
		report: null,
	};
}

function turn(entries: TurnEntry[], prompt = 'Summarise [[Design]]', id = 'u1'): Turn {
	return { id, prompt, entries, headings: [] };
}

/** A copier that records, and fails while `failing` is set. */
function recordingCopier() {
	const copied: string[] = [];
	const notices: string[] = [];
	const state = { failing: false };
	const copier: Copier = {
		write: (value) => {
			if (state.failing) return Promise.reject(new Error('denied'));
			copied.push(value);
			return Promise.resolve();
		},
		notify: (message) => notices.push(message),
	};
	return { copier, copied, notices, state };
}

function rendererOn() {
	const { el, host } = hostEl();
	const recorder = recordingCopier();
	const renderer = new TurnRenderer(host, {
		presentation: () => 'highlight',
		vaultPath: () => VAULT,
		renderMarkdown: (markdown, target) => {
			(target as unknown as FakeElement).appendText(markdown);
			return Promise.resolve();
		},
		resolveUri: () => null,
		copier: recorder.copier,
	});
	return { el, renderer, ...recorder };
}

/** A click, and the copy it starts given time to land. */
async function click(button: FakeElement): Promise<void> {
	button.dispatch('click');
	await Promise.resolve();
	await Promise.resolve();
}

describe('replyMarkdown', () => {
	it('is the prose of the turn as written, a blank line between blocks, and nothing else', () => {
		const reply = replyMarkdown(
			turn([
				text('m1', 'First, **bold**.\n'),
				tool('t1'),
				{ kind: 'thinking', messageId: 'm2', text: 'hidden' },
				{ kind: 'steer', text: 'and also' },
				text('m3', '  '),
				text('m4', '## Done\n\n- [[Note]]'),
			]),
		);
		expect(reply).toBe('First, **bold**.\n\n## Done\n\n- [[Note]]');
	});

	it('is empty before the agent has said anything', () => {
		expect(replyMarkdown(turn([tool('t1')]))).toBe('');
	});
});

describe('plainText', () => {
	it('drops headings, emphasis, links and wikilinks to their words', () => {
		expect(
			plainText(
				'## The plan\n\nRead **this** and *that*, see [the docs](https://x.org) and [[Note|a note]] or [[Other]].',
			),
		).toBe('The plan\n\nRead this and that, see the docs and a note or Other.');
	});

	it('keeps code exactly, fenced or inline', () => {
		expect(plainText('Run `npm **test**`:\n\n```sh\nnpm run build -- **x**\n# not a heading\n```\nDone.')).toBe(
			'Run npm **test**:\n\nnpm run build -- **x**\n# not a heading\nDone.',
		);
	});

	it('keeps a list readable, without its task boxes', () => {
		expect(plainText('- one\n  * two\n- [x] done\n1. first')).toBe('• one\n  • two\n• done\n1. first');
	});

	it('takes quotes, callouts and rules off', () => {
		expect(plainText('> [!note] Heads up\n> quoted ~~old~~ ==new==\n\n---\n\nAfter')).toBe(
			'Heads up\nquoted old new\n\nAfter',
		);
	});

	it('turns a table into tab-separated rows', () => {
		expect(plainText('| a | **b** |\n| --- | :-: |\n| 1 | 2 |')).toBe('a\tb\n1\t2');
	});

	it('leaves snake_case and lone asterisks alone', () => {
		expect(plainText('set my_var_name to 2 * 3')).toBe('set my_var_name to 2 * 3');
	});
});

describe('TurnRenderer: copy actions (#140)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', globalThis);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('copies a prompt as typed, links unrendered', async () => {
		const { el, renderer, copied } = rendererOn();
		renderer.render(turn([text('m1', 'Done.')]));

		const button = el.find('herdr-native-prompt').find('herdr-native-copy-prompt');
		expect(button.attrs['aria-label']).toBe('Copy prompt');
		expect(iconOf.get(button)).toBe('copy');
		await click(button);

		expect(copied).toEqual(['Summarise [[Design]]']);
		// The button carries no text, so the prompt still reads as typed.
		expect(el.find('herdr-native-prompt').textContent).toBe('Summarise Design');
	});

	it('copies a steer as typed', async () => {
		const { el, renderer, copied } = rendererOn();
		renderer.render(turn([text('m1', 'On it.'), { kind: 'steer', text: 'also [[That]]' }]));

		await click(el.find('herdr-native-steer').find('herdr-native-copy-prompt'));

		expect(copied).toEqual(['also [[That]]']);
	});

	it('copies the reply as Markdown by default and as plain text on the other button', async () => {
		const { el, renderer, copied } = rendererOn();
		renderer.render(turn([text('m1', 'See **[[Design]]**.'), tool('t1'), text('m2', '## Next\n\n`npm test`')]));

		const actions = el.find('herdr-native-reply-actions');
		const markdown = actions.find('herdr-native-copy-markdown');
		const plain = actions.find('herdr-native-copy-plain');
		expect(markdown.attrs['aria-label']).toBe('Copy as Markdown');
		expect(plain.attrs['aria-label']).toBe('Copy as plain text');
		expect(iconOf.get(markdown)).toBe('copy');
		expect(iconOf.get(plain)).toBe('remove-formatting');

		await click(markdown);
		await click(plain);

		expect(copied).toEqual(['See **[[Design]]**.\n\n## Next\n\n`npm test`', 'See Design.\n\nNext\n\nnpm test']);
	});

	it('draws no reply actions until there is prose, and keeps them while the reply grows', async () => {
		const { el, renderer, copied } = rendererOn();
		renderer.render(turn([tool('t1')]));
		expect(el.findAll('herdr-native-reply-actions')).toEqual([]);

		renderer.render(turn([tool('t1'), text('m1', 'Half')]));
		const actions = el.find('herdr-native-reply-actions');
		renderer.render(turn([tool('t1'), text('m1', 'Half and whole.')]));

		expect(el.find('herdr-native-reply-actions')).toBe(actions);
		const turnEl = el.find('herdr-native-turn');
		expect(turnEl.children.at(-1)).toBe(actions);
		await click(actions.find('herdr-native-copy-markdown'));
		expect(copied).toEqual(['Half and whole.']);
	});

	it('shows that it copied, then goes back', async () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'Done.')]));
		const button = el.find('herdr-native-copy-markdown');

		await click(button);
		expect(button.hasClass('is-copied')).toBe(true);
		expect(iconOf.get(button)).toBe('check');
		expect(button.attrs['aria-label']).toBe('Copied');

		vi.advanceTimersByTime(COPY_FEEDBACK_MS);
		expect(button.hasClass('is-copied')).toBe(false);
		expect(iconOf.get(button)).toBe('copy');
		expect(button.attrs['aria-label']).toBe('Copy as Markdown');
	});

	it('says so when the clipboard refuses', async () => {
		const { el, renderer, notices, state } = rendererOn();
		renderer.render(turn([text('m1', 'Done.')]));
		state.failing = true;
		const button = el.find('herdr-native-copy-plain');

		await click(button);

		expect(notices).toEqual([COPY_FAILED_MESSAGE]);
		expect(button.hasClass('is-failed')).toBe(true);
		expect(iconOf.get(button)).toBe('x');
		vi.advanceTimersByTime(COPY_FEEDBACK_MS);
		expect(button.hasClass('is-failed')).toBe(false);
	});

	it('takes the reply actions away when the prose goes', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'Done.')]));
		const button = el.find('herdr-native-copy-markdown');

		renderer.render(turn([tool('t1')]));

		expect(el.findAll('herdr-native-reply-actions')).toEqual([]);
		expect(button.listeners).toEqual([]);
	});

	it('tears its listeners down with the turn', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'Done.'), { kind: 'steer', text: 'more' }]));
		const buttons = el.findAll('herdr-native-copy');
		expect(buttons).toHaveLength(4);
		expect(buttons.every((button) => button.listeners.length === 1)).toBe(true);

		renderer.clear();

		expect(buttons.every((button) => button.listeners.length === 0)).toBe(true);
	});

	it('drops the prompt’s listener when the prompt is drawn again', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([], 'first'));
		const before = el.find('herdr-native-copy-prompt');

		renderer.render(turn([], 'second'));

		expect(before.listeners).toEqual([]);
		expect(el.find('herdr-native-copy-prompt')).not.toBe(before);
	});

	it('flashes nothing on a button whose turn was cleared before the copy landed', async () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'Done.')]));
		const button = el.find('herdr-native-copy-markdown');

		button.dispatch('click');
		renderer.clear();
		await Promise.resolve();
		await Promise.resolve();

		expect(button.hasClass('is-copied')).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
