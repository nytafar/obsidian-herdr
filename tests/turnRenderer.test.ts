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
import { tooltipOf, type Component } from './fixtures/obsidian';
import { TurnRenderer } from '../src/native/turnRenderer';
import { FoldMemory } from '../src/native/foldMemory';
import { nameTurnItems } from '../src/native/itemKeys';
import { turnItems, type ToolGroupPresentation } from '../src/native/toolCalls';
import type { ResumeEntry, ToolEntry, Turn, TurnEntry } from '../src/native/conversation';
import { turnTime } from '../src/native/turnTime';

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
function rendererOn(
	options: {
		folds?: FoldMemory;
		presentation?: ToolGroupPresentation;
		resolveUri?: (uri: string) => string | null;
		/** Markdown whose render never lands, as one still in flight. */
		pending?: (markdown: string) => boolean;
		/** The clock the prompt's time is labelled by (#139). */
		now?: () => number;
	} = {},
) {
	const { el, host } = hostEl();
	const rendered: Rendered[] = [];
	let presentation: ToolGroupPresentation = options.presentation ?? 'highlight';
	const renderer = new TurnRenderer(host, {
		presentation: () => presentation,
		vaultPath: () => VAULT,
		renderMarkdown: (markdown, target, component) => {
			rendered.push({ markdown, component: component as unknown as Component });
			(target as unknown as FakeElement).appendText(markdown);
			return options.pending?.(markdown) ? new Promise<void>(() => {}) : Promise.resolve();
		},
		resolveUri: options.resolveUri ?? (() => null),
		folds: options.folds,
		now: options.now,
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
		const [promptEl, blockEl, groupEl, actionsEl] = turnEl.children;

		renderer.render(turn([text('m1', 'First.'), tool('t1'), text('m2', 'Second.')]));

		expect(turnEl.children.slice(0, 3)).toEqual([promptEl, blockEl, groupEl]);
		expect(turnEl.children[3]?.textContent).toBe('Second.');
		// The reply's copy buttons stay last (#140): the one insert is the new
		// block put in front of them, and nothing that was there moves.
		expect(turnEl.children[4]).toBe(actionsEl);
		expect(turnEl.inserted).toBe(1);
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
			'herdr-native-reply-actions',
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
		renderer.render(turn([text('m1', '## Kept')]));
		// The stub writes text; give the kept block a heading as the real renderer would.
		el.find('herdr-native-block').createEl('h2', { text: 'Kept' });

		renderer.render(turn([text('m1', '## Kept'), text('m2', '## New')]));
		el.findAll('herdr-native-block')[1]?.createEl('h2', { text: 'New' });
		await Promise.resolve();
		await Promise.resolve();

		expect(renderer.headingEl('u1', 0, 2)?.textContent).toBe('Kept');
		expect(renderer.headingEl('u1', 1, 2)?.textContent).toBe('New');
	});

	it('keeps the anchors of kept prose while a later block is still rendering', async () => {
		// The last block's render has not landed: Claude is still writing it.
		const { el, renderer } = rendererOn({ pending: (markdown) => markdown.startsWith('# Stream') });
		renderer.render(turn([text('m1', '# Kept')]));
		el.find('herdr-native-block').createEl('h1', { text: 'Kept' });
		await Promise.resolve();
		await Promise.resolve();
		expect(renderer.headingEl('u1', 0, 1)?.textContent).toBe('Kept');

		renderer.render(turn([text('m1', '# Kept'), text('m2', '# Streaming')]));
		await Promise.resolve();
		await Promise.resolve();

		// The earlier heading is where it was; the one still rendering is not yet.
		expect(renderer.headingEl('u1', 0, 2)?.textContent).toBe('Kept');
		expect(renderer.headingEl('u1', 1, 2)).toBeUndefined();
	});
});

describe('TurnRenderer: links resolved at draw time (#114, #127)', () => {
	const URI = 'obsidian://open?vault=hvelv&file=Later';

	it('draws a steer again once the note its link names exists', () => {
		const notes = new Set<string>();
		const { el, renderer } = rendererOn({ resolveUri: () => (notes.has('Later') ? 'Later.md' : null) });
		const steered = turn([{ kind: 'steer', text: `See ${URI}` }]);
		renderer.render(steered);
		expect(el.find('herdr-native-steer').find('external-link').textContent).toBe(URI);

		notes.add('Later');
		renderer.render(turn([{ kind: 'steer', text: `See ${URI}` }]));

		expect(el.find('herdr-native-steer').find('internal-link').textContent).toBe('Later.md');
	});

	it('draws the prompt again once the note its link names exists', () => {
		const notes = new Set<string>();
		const { el, renderer } = rendererOn({ resolveUri: () => (notes.has('Later') ? 'Later.md' : null) });
		renderer.render({ id: 'u1', prompt: `See ${URI}`, entries: [], headings: [] });

		notes.add('Later');
		renderer.render({ id: 'u1', prompt: `See ${URI}`, entries: [], headings: [] });

		expect(el.find('herdr-native-prompt').find('internal-link').textContent).toBe('Later.md');
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

describe('TurnRenderer: when, and for how long (#139)', () => {
	/** Noon, local time, on the day the turns were written. */
	const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
	const at = (seconds: number): string => new Date(new Date(2026, 10, 6, 9, 0, 0).getTime() + seconds * 1000).toISOString();
	const timed = (entries: TurnEntry[], endTs = at(7)): Turn => ({ ...turn(entries), ts: at(0), endTs });
	const resume = (fields: Partial<ResumeEntry> = {}): ResumeEntry => ({
		kind: 'resume',
		id: 'r1',
		cause: 'hook',
		text: 'Check the build before you stop.',
		ts: at(10),
		endTs: at(82),
		...fields,
	});

	it('says over the prompt when it was sent and how long the agent worked, the full time on hover', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(timed([text('m1', 'Done.')]), null);

		const meta = el.find('herdr-native-turn-meta');
		const label = turnTime(at(0), NOW)?.label ?? '';
		expect(meta.textContent).toBe(`${label} · worked 7s`);
		// First in the turn, over the prompt.
		expect(el.find('herdr-native-turn').children[0]).toBe(meta);
		const [time] = meta.querySelectorAll('time');
		expect(time?.getAttribute('datetime')).toBe(at(0));
		expect(tooltipOf.get(time as object)).toBe(turnTime(at(0), NOW)?.full);
		expect(tooltipOf.get(meta.find('herdr-native-turn-duration') as object)).toContain('Worked for 7s');
	});

	it('shows no duration while the turn runs, and redraws the line when it ends', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(timed([text('m1', 'Working on it.')], at(3)), 'working');
		expect(el.find('herdr-native-turn-meta').textContent).toBe(turnTime(at(0), NOW)?.label);

		renderer.render(timed([text('m1', 'Working on it.')], at(65)), null);
		expect(el.find('herdr-native-turn-meta').textContent).toContain('worked 1m 5s');
	});

	it('shows nothing for a turn whose time the agent did not write', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(turn([text('m1', 'Done.')]), null);
		expect(el.findAll('herdr-native-turn-meta')).toHaveLength(0);
	});

	it('marks resumed work with its cause, its time and its own duration, and times the prompt’s answer apart', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(timed([text('m1', 'Done.'), resume(), text('m2', 'Checked.')]), null);

		const divider = el.find('herdr-native-resume');
		expect(divider.find('herdr-native-resume-label').textContent).toBe('Resumed by a hook');
		expect(divider.find('herdr-native-turn-meta').textContent).toBe(`${turnTime(at(10), NOW)?.label} · worked 1m 12s`);
		const words = divider.find('herdr-native-resume-text');
		expect(words.textContent).toBe('Check the build before you stop.');
		expect(tooltipOf.get(words as object)).toBe('Check the build before you stop.');
		// The prompt's own line keeps the prompt's answer: 7 seconds.
		const [meta] = el.find('herdr-native-turn').children;
		expect(meta?.textContent).toContain('worked 7s');
		// Between the answer and the resumed work, where it happened.
		const children = el.find('herdr-native-turn').children;
		const place = (cls: string) => children.findIndex((child) => child.classList.has(cls));
		expect(place('herdr-native-resume')).toBeGreaterThan(place('herdr-native-prompt'));
	});

	it('times the answer while the resumed work still runs, and the resumed work only once it is over', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(timed([text('m1', 'Done.'), resume({ endTs: at(12) }), text('m2', 'Checking…')]), 'working');
		expect(el.find('herdr-native-resume').find('herdr-native-turn-meta').textContent).toBe(turnTime(at(10), NOW)?.label);
		const [meta] = el.find('herdr-native-turn').children;
		expect(meta?.textContent).toContain('worked 7s');
	});

	it('draws the divider again when what it says changes, and nothing else', () => {
		const { el, renderer, rendered } = rendererOn({ now: () => NOW });
		renderer.render(timed([text('m1', 'Done.'), resume({ endTs: at(12) }), text('m2', 'Checking.')]), 'working');
		const first = el.find('herdr-native-resume');
		const renders = rendered.length;

		renderer.render(timed([text('m1', 'Done.'), resume({ endTs: at(12) }), text('m2', 'Checking.')]), 'working');
		expect(el.find('herdr-native-resume')).toBe(first);

		renderer.render(timed([text('m1', 'Done.'), resume({ endTs: at(40) }), text('m2', 'Checking.')]), null);
		expect(el.find('herdr-native-resume')).not.toBe(first);
		expect(el.find('herdr-native-resume').textContent).toContain('worked 30s');
		// The prose around it was not rendered again.
		expect(rendered.length).toBe(renders);
	});

	it('says each cause in words of its own', () => {
		const { el, renderer } = rendererOn({ now: () => NOW });
		renderer.render(
			timed([
				text('m1', 'Done.'),
				resume({ id: 'a', cause: 'notification', text: 'Background command "build" completed' }),
				text('m2', 'Built.'),
				resume({ id: 'b', cause: 'meta', text: '' }),
				text('m3', 'Again.'),
				resume({ id: 'c', cause: 'other', text: '', ts: undefined }),
				text('m4', 'More.'),
			]),
			null,
		);
		expect(el.findAll('herdr-native-resume-label').map((label) => label.textContent)).toEqual([
			'Resumed by a notification',
			'Resumed by a runtime message',
			'Resumed on its own',
		]);
		// Nothing to say, nothing drawn: no empty line, no time it does not have.
		expect(el.findAll('herdr-native-resume-text')).toHaveLength(1);
		expect(el.findAll('herdr-native-resume')[2]?.findAll('herdr-native-turn-meta')).toHaveLength(0);
	});
});

describe('TurnRenderer: a subagent at work (#147)', () => {
	function agentCall(progress?: ToolEntry['subagent']): ToolEntry {
		return {
			kind: 'tool',
			id: 'toolu_a1',
			name: 'Agent',
			input: { description: 'Check the styles' },
			result: 'Async agent launched successfully.',
			status: 'running',
			notification: null,
			report: null,
			...(progress ? { subagent: progress } : {}),
		};
	}

	function on() {
		const { el, host } = hostEl();
		const opened: string[] = [];
		const renderer = new TurnRenderer(host, {
			presentation: () => 'highlight',
			vaultPath: () => VAULT,
			renderMarkdown: () => Promise.resolve(),
			resolveUri: () => null,
			openSubagent: (call) => opened.push(call.id),
		});
		return { el, renderer, opened };
	}

	it('says what it did last under the group that holds its call, and opens its transcript', () => {
		const { el, renderer, opened } = on();
		const read = tool('r1');
		renderer.render(turn([agentCall({ running: true, latest: read, calls: 3 })]), 'working');

		const line = el.find('herdr-native-subagent');
		expect(line.find('herdr-native-subagent-title').textContent).toBe('Subagent working: Check the styles');
		expect(line.find('herdr-native-subagent-count').textContent).toBe('3 calls');
		expect(line.find('herdr-native-subagent-activity').textContent).toBe('Read r1.md');
		// It does not end the run: the group above is still the one at work.
		expect(el.find('herdr-native-tools').classList.has('is-live')).toBe(true);

		line.find('herdr-native-subagent-open').dispatch('click');
		expect(opened).toEqual(['toolu_a1']);
	});

	it('draws the line again when the subagent moves on, and nothing else', () => {
		const { el, renderer } = on();
		renderer.render(turn([agentCall({ running: true, latest: null, calls: 0 })]), 'working');
		const group = el.find('herdr-native-tools');
		expect(el.find('herdr-native-subagent-activity').textContent).toBe('Starting');

		const said = { kind: 'text' as const, messageId: 's1', text: 'Checking the colours first.\nThen the fonts.' };
		renderer.render(turn([agentCall({ running: true, latest: said, calls: 0 })]), 'working');
		expect(el.find('herdr-native-subagent-activity').textContent).toBe('Checking the colours first.');
		expect(el.find('herdr-native-tools')).toBe(group);
	});

	it('draws no line for a subagent no one follows, or one that stopped', () => {
		const { el, renderer } = on();
		renderer.render(turn([agentCall()]), 'working');
		expect(el.findAll('herdr-native-subagent')).toHaveLength(0);
		renderer.render(turn([agentCall({ running: false, latest: null, calls: 2 })]), 'working');
		expect(el.findAll('herdr-native-subagent')).toHaveLength(0);
	});
});
