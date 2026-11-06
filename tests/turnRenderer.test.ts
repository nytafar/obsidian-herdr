/**
 * The turn renderer's reconciliation (issue #127): a turn that grows while
 * Claude writes draws only what changed, and a disclosure the reader opened
 * stays open through growth, a full redraw, a split and a merge.
 *
 * The renderer is driven directly, on the DOM harness, with a Markdown
 * renderer that counts what it is asked to render: the count is the cost the
 * issue is about, since every call is a pass through Obsidian's renderer.
 */

import { describe, expect, it } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import type { Component } from './fixtures/obsidian';
import { TurnRenderer } from '../src/native/turnRenderer';
import { FoldMemory } from '../src/native/foldMemory';
import { nameTurnItems } from '../src/native/itemKeys';
import { turnItems, type ToolGroupPresentation } from '../src/native/toolCalls';
import type { ToolEntry, Turn, TurnEntry } from '../src/native/reducer';

const VAULT = '/vault';

function tool(id: string, name = 'Read', status: ToolEntry['status'] = 'done'): ToolEntry {
	return {
		kind: 'tool',
		id,
		name,
		input: { file_path: `${VAULT}/${id}.md` },
		result: status === 'pending' ? null : 'ok',
		status,
		notification: null,
		report: null,
	};
}

function text(messageId: string, body: string): TurnEntry {
	return { kind: 'text', messageId, text: body };
}

function turn(entries: TurnEntry[], id = 'u1'): Turn {
	return { id, prompt: 'Go', entries, headings: [] };
}

interface Rendered {
	markdown: string;
	component: Component;
}

/** A renderer on the harness, with every Markdown render recorded. */
function rendererOn(options: { folds?: FoldMemory; presentation?: ToolGroupPresentation } = {}) {
	const { el, host } = hostEl();
	const rendered: Rendered[] = [];
	let presentation: ToolGroupPresentation = options.presentation ?? 'highlight';
	const renderer = new TurnRenderer(host, {
		presentation: () => presentation,
		vaultPath: () => VAULT,
		renderMarkdown: (markdown, target, component) => {
			rendered.push({ markdown, component: component as unknown as Component });
			(target as unknown as FakeElement).appendText(markdown);
			return Promise.resolve();
		},
		resolveUri: () => null,
		folds: options.folds,
	});
	return {
		el,
		renderer,
		rendered,
		setPresentation: (value: ToolGroupPresentation) => {
			presentation = value;
		},
	};
}

/** The reader clicking a disclosure's summary: the browser flips it, then fires `toggle`. */
function click(details: FakeElement): void {
	details.open = !details.open;
	details.dispatch('toggle');
}

describe('TurnRenderer: drawing only what changed (#127)', () => {
	it('does not render earlier prose again when the turn grows', () => {
		const { renderer, rendered } = rendererOn();
		renderer.render(turn([text('m1', 'First.'), tool('t1')]));
		expect(rendered.map((call) => call.markdown)).toEqual(['First.']);

		renderer.render(turn([text('m1', 'First.'), tool('t1'), text('m2', 'Sec')]));
		renderer.render(turn([text('m1', 'First.'), tool('t1'), text('m2', 'Second.')]));

		// The last block is drawn each time it grows; the first never again.
		expect(rendered.map((call) => call.markdown)).toEqual(['First.', 'Sec', 'Second.']);
	});

	it('leaves the earlier elements in place, and moves nothing to append', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'First.'), tool('t1')]));
		const turnEl = el.find('herdr-native-turn');
		const [promptEl, blockEl, groupEl] = turnEl.children;

		renderer.render(turn([text('m1', 'First.'), tool('t1'), text('m2', 'Second.')]));

		expect(turnEl.children.slice(0, 3)).toEqual([promptEl, blockEl, groupEl]);
		expect(turnEl.children[3]?.textContent).toBe('Second.');
		expect(turnEl.inserted).toBe(0);
	});

	it('draws a changed item where it was, not at the end', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1', 'Read', 'pending'), text('m1', 'Then.')]));

		renderer.render(turn([tool('t1', 'Read', 'done'), tool('t2'), text('m1', 'Then.')]));

		const turnEl = el.find('herdr-native-turn');
		expect(turnEl.children.map((child) => [...child.classList][0])).toEqual([
			'herdr-native-prompt',
			'herdr-native-tools',
			'herdr-native-block',
		]);
	});

	it('draws nothing again for a turn that did not change', () => {
		const { el, renderer, rendered } = rendererOn();
		const same = turn([text('m1', 'First.'), tool('t1')]);
		renderer.render(same);
		const before = el.find('herdr-native-tools');

		renderer.render(turn([text('m1', 'First.'), tool('t1')]));

		expect(rendered).toHaveLength(1);
		expect(el.find('herdr-native-tools')).toBe(before);
	});

	it('unloads the component of an item drawn again or gone, and every one on clear', () => {
		const { renderer, rendered } = rendererOn();
		renderer.render(turn([text('m1', 'One'), text('m2', 'Two')]));
		const [one, two] = rendered;

		renderer.render(turn([text('m1', 'One'), text('m2', 'Two, longer')]));
		expect(one?.component.loaded).toBe(true);
		expect(two?.component.loaded).toBe(false);

		renderer.render(turn([text('m2', 'Two, longer')]));
		expect(one?.component.loaded).toBe(false);

		const latest = rendered.at(-1);
		expect(latest?.component.loaded).toBe(true);
		renderer.clear();
		expect(latest?.component.loaded).toBe(false);
	});

	it('marks the headings of prose it kept and prose it drew (#118)', async () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([text('m1', 'Top')]));
		// The stub writes text; give the kept block a heading as the real renderer would.
		el.find('herdr-native-block').createEl('h2', { text: 'Kept' });

		renderer.render(turn([text('m1', 'Top'), text('m2', 'More')]));
		el.findAll('herdr-native-block')[1]?.createEl('h2', { text: 'New' });
		await Promise.resolve();
		await Promise.resolve();

		expect(renderer.headingEl('u1', 0, 2)?.textContent).toBe('Kept');
		expect(renderer.headingEl('u1', 1, 2)?.textContent).toBe('New');
	});
});

describe('TurnRenderer: what the reader opened stays open (#127)', () => {
	it('keeps an opened tool group open while its turn grows and the group with it', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1')]));
		click(el.find('herdr-native-tools'));

		renderer.render(turn([tool('t1'), tool('t2')]));
		expect(el.find('herdr-native-tools').open).toBe(true);

		renderer.render(turn([tool('t1'), tool('t2'), text('m1', 'Done.')]));
		expect(el.find('herdr-native-tools').open).toBe(true);
	});

	it('keeps an opened thought open while the turn grows', () => {
		const { el, renderer } = rendererOn();
		const thought: TurnEntry = { kind: 'thinking', messageId: 'm0', text: 'Hmm.' };
		renderer.render(turn([thought]));
		click(el.find('herdr-native-thinking'));

		renderer.render(turn([thought, text('m1', 'So.')]));

		expect(el.find('herdr-native-thinking').open).toBe(true);
	});

	it('keeps a group the reader closed again closed', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1')]));
		click(el.find('herdr-native-tools'));
		click(el.find('herdr-native-tools'));

		renderer.render(turn([tool('t1'), tool('t2')]));

		expect(el.find('herdr-native-tools').open).toBe(false);
	});

	it('does not take its own opening of a disclosure for the reader’s choice', () => {
		const folds = new FoldMemory();
		const { el, renderer } = rendererOn({ folds });
		renderer.render(turn([tool('t1')]));
		// The browser fires `toggle` for a change the view made too.
		el.find('herdr-native-tools').dispatch('toggle');

		expect(folds.turn('u1').open.size).toBe(0);
	});

	it('opens both halves of an opened group that splits', () => {
		const { el, renderer } = rendererOn();
		// An empty text block between two calls draws nothing and ends no run.
		renderer.render(turn([tool('t1'), text('m1', ''), tool('t2')]));
		click(el.find('herdr-native-tools'));

		renderer.render(turn([tool('t1'), text('m1', 'Between.'), tool('t2')]));

		const groups = el.findAll('herdr-native-tools');
		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.open)).toEqual([true, true]);
	});

	it('opens a merged group when the reader had either part open', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1'), text('m1', 'Between.'), tool('t2')]));
		click(el.findAll('herdr-native-tools')[1] as FakeElement);

		renderer.render(turn([tool('t1'), tool('t2')]));

		expect(el.find('herdr-native-tools').open).toBe(true);
	});

	it('keeps the reader’s choices across a full redraw and a new renderer', () => {
		const folds = new FoldMemory();
		const first = rendererOn({ folds });
		first.renderer.render(turn([tool('t1'), text('m1', 'x')]));
		click(first.el.find('herdr-native-tools'));

		// A setting change draws everything again from empty.
		first.renderer.clear();
		first.renderer.render(turn([tool('t1'), text('m1', 'x')]));
		expect(first.el.find('herdr-native-tools').open).toBe(true);

		// A detach and attach builds another renderer on the surface's memory.
		const second = rendererOn({ folds });
		second.renderer.render(turn([tool('t1'), text('m1', 'x')]));
		expect(second.el.find('herdr-native-tools').open).toBe(true);
	});

	it('forgets nothing of another turn', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1')], 'u1'));
		renderer.render(turn([tool('t9')], 'u2'));
		click(el.findAll('herdr-native-tools')[0] as FakeElement);

		renderer.render(turn([tool('t9'), tool('t10')], 'u2'));

		expect(el.findAll('herdr-native-tools').map((group) => group.open)).toEqual([true, false]);
	});
});

describe('nameTurnItems (#127)', () => {
	const items = (entries: TurnEntry[]) => turnItems(entries, 'highlight');

	it('names items by their entries, and a group by its first call', () => {
		const names = nameTurnItems(
			items([
				text('m1', 'a'),
				tool('t1'),
				tool('t2'),
				{ kind: 'steer', text: 'and' },
				{ kind: 'steer', text: 'also' },
			]),
			new Map(),
		);
		expect(names.keys).toEqual(['text:m1', 'group:t1', 'steer#1', 'steer#2']);
		expect([...names.members]).toEqual([
			['t1', 'group:t1'],
			['t2', 'group:t1'],
		]);
		expect(names.related.size).toBe(0);
	});

	it('keeps a group’s name when calls before it join it', () => {
		const previous = new Map([['t2', 'group:t2']]);
		const names = nameTurnItems(items([tool('t1'), tool('t2')]), previous);
		expect(names.keys).toEqual(['group:t2']);
		expect(names.related.size).toBe(0);
	});

	it('gives the half split off a new name, related to the old one', () => {
		const previous = new Map([
			['t1', 'group:t1'],
			['t2', 'group:t1'],
		]);
		const names = nameTurnItems(items([tool('t1'), text('m1', 'x'), tool('t2')]), previous);
		expect(names.keys).toEqual(['group:t1', 'text:m1', 'group:t2']);
		expect([...names.related]).toEqual([['group:t2', ['group:t1']]]);
	});

	it('never mints a name a kept group still has', () => {
		// The second group kept `group:t3`; the first, new, would be `group:t3`
		// by its first call if it were not taken.
		const previous = new Map([['t4', 'group:t3']]);
		const names = nameTurnItems(
			items([tool('t3'), text('m1', 'x'), tool('t4')]),
			previous,
		);
		expect(names.keys).toEqual(['group:t3+', 'text:m1', 'group:t3']);
	});
});

describe('TurnRenderer: the tool group header and its default fold (#128)', () => {
	it('opens the running group, says so, and folds it once the turn settles', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1'), tool('t2', 'Bash', 'pending')]), 'working');
		const running = el.find('herdr-native-tools');
		expect(running.open).toBe(true);
		expect(running.hasClass('is-live')).toBe(true);
		expect(running.find('herdr-native-tools-title').textContent).toBe('Working…');

		renderer.render(turn([tool('t1'), tool('t2', 'Bash', 'done')]), null);

		const settled = el.find('herdr-native-tools');
		expect(settled.open).toBe(false);
		expect(settled.find('herdr-native-tools-title').textContent).toBe('Worked');
	});

	it('says the group needs you while the agent is blocked in it', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1', 'Bash', 'pending')]), 'blocked');

		const group = el.find('herdr-native-tools');
		expect(group.open).toBe(true);
		expect(group.hasClass('is-waiting')).toBe(true);
		expect(group.find('herdr-native-tools-title').textContent).toBe('Needs you');
	});

	it('settles a group once prose follows it, and leaves the reader’s choice alone', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1')]), 'working');
		// The reader folds the running group: theirs wins over the rule.
		click(el.find('herdr-native-tools'));
		renderer.render(turn([tool('t1'), tool('t2')]), 'working');
		expect(el.find('herdr-native-tools').open).toBe(false);

		renderer.render(turn([tool('t1'), tool('t2'), text('m1', 'So.'), tool('t3')]), 'working');
		const [first, second] = el.findAll('herdr-native-tools');
		expect(first?.find('herdr-native-tools-title').textContent).toBe('Worked');
		expect(first?.open).toBe(false);
		expect(second?.find('herdr-native-tools-title').textContent).toBe('Working…');
		expect(second?.open).toBe(true);
	});

	it('keeps a running group open once the reader has clicked inside it', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1')]), 'working');
		el.find('herdr-native-tool').dispatch('click');

		renderer.render(turn([tool('t1')]), null);

		expect(el.find('herdr-native-tools').open).toBe(true);
	});

	it('takes a click on the summary for a toggle, not for reading', () => {
		const folds = new FoldMemory();
		const { el, renderer } = rendererOn({ folds });
		renderer.render(turn([tool('t1')]), 'working');
		el.find('herdr-native-tools-title').dispatch('click');

		expect(folds.turn('u1').open.size).toBe(0);
	});

	it('counts the failures apart from the counts, and marks the failed rows', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1'), tool('t2', 'Bash', 'error')]));

		const group = el.find('herdr-native-tools');
		expect(group.find('herdr-native-tools-counts').textContent).toBe('read 1 file, ran 1 command');
		expect(group.find('herdr-native-tools-failed').textContent).toBe('1 failed');
		expect(group.find('herdr-native-tools-summary').attrs['aria-label']).toBe(
			'Worked, read 1 file, ran 1 command, 1 failed',
		);
		expect(group.findAll('herdr-native-tool').map((row) => row.hasClass('is-error'))).toEqual([
			false,
			true,
		]);
	});

	it('draws nothing again when the status moves and no group’s state does', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([tool('t1'), text('m1', 'Done.')]), 'working');
		const group = el.find('herdr-native-tools');

		renderer.render(turn([tool('t1'), text('m1', 'Done.')]), null);

		expect(el.find('herdr-native-tools')).toBe(group);
	});
});
