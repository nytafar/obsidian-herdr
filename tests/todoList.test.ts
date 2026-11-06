/**
 * The agent's to-do list (issue #143): read out of `TodoWrite` calls, drawn as
 * a checklist where the turn updated it with earlier updates folded, and kept
 * in reach in a chip under the transcript.
 */

import { describe, expect, it } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { TurnRenderer } from '../src/native/turnRenderer';
import { TodoChip } from '../src/native/todoList';
import {
	latestTodoList,
	openRunIndex,
	todoList,
	todoProgress,
	turnItems,
	type TodoItem,
} from '../src/native/toolCalls';
import type { ToolEntry, Turn, TurnEntry } from '../src/native/reducer';

function todoWrite(id: string, todos: unknown): ToolEntry {
	return {
		kind: 'tool',
		id,
		name: 'TodoWrite',
		input: { todos },
		result: 'ok',
		status: 'done',
		notification: null,
		report: null,
	};
}

function read(id: string): ToolEntry {
	return { ...todoWrite(id, []), name: 'Read', input: { file_path: `/vault/${id}.md` } };
}

/** A list as Claude Code writes it. */
const PLAN = [
	{ content: 'Read the issue', status: 'completed', activeForm: 'Reading the issue' },
	{ content: 'Write the tests', status: 'in_progress', activeForm: 'Writing the tests' },
	{ content: 'Run the gate', status: 'pending', activeForm: 'Running the gate' },
];

function turn(entries: TurnEntry[], id = 'u1'): Turn {
	return { id, prompt: 'Go', entries, headings: [] };
}

function rendererOn() {
	const { el, host } = hostEl();
	const renderer = new TurnRenderer(host, {
		presentation: () => 'highlight',
		vaultPath: () => '/vault',
		renderMarkdown: () => Promise.resolve(),
		resolveUri: () => null,
	});
	return { el, renderer };
}

describe('todoList', () => {
	it('reads the list a TodoWrite call sent', () => {
		expect(todoList(todoWrite('t1', PLAN))).toEqual([
			{ content: 'Read the issue', status: 'completed', activeForm: 'Reading the issue' },
			{ content: 'Write the tests', status: 'in_progress', activeForm: 'Writing the tests' },
			{ content: 'Run the gate', status: 'pending', activeForm: 'Running the gate' },
		]);
	});

	it('reads an unknown status as pending and a missing active form as none', () => {
		expect(todoList(todoWrite('t1', [{ content: 'Ship', status: 'blocked' }]))).toEqual([
			{ content: 'Ship', status: 'pending', activeForm: null },
		]);
	});

	it('is null for another tool, a list that is not one, or an item without words', () => {
		expect(todoList(read('r1'))).toBeNull();
		expect(todoList(todoWrite('t1', 'not a list'))).toBeNull();
		expect(todoList(todoWrite('t1', [{ content: ' ', status: 'pending' }]))).toBeNull();
	});
});

describe('todoProgress and latestTodoList', () => {
	it('counts what is done and names what is in progress', () => {
		const items = todoList(todoWrite('t1', PLAN)) as TodoItem[];
		const progress = todoProgress(items);
		expect([progress.done, progress.total, progress.current?.content]).toEqual([
			1,
			3,
			'Write the tests',
		]);
	});

	it('finds the latest readable list, in the latest turn that has one', () => {
		const turns = [
			turn([todoWrite('t1', PLAN)], 'u1'),
			turn([todoWrite('t2', [{ content: 'Later', status: 'pending' }]), todoWrite('t3', 'bad'), read('r1')], 'u2'),
			turn([read('r2')], 'u3'),
		];
		expect(latestTodoList(turns)?.map((item) => item.content)).toEqual(['Later']);
		expect(latestTodoList([turn([read('r1')])])).toBeNull();
	});
});

describe('turnItems: to-do list updates (#143)', () => {
	it('draws each update where it was made, outside the group, and marks the turn’s last', () => {
		const items = turnItems(
			[read('r1'), todoWrite('t1', PLAN), read('r2'), todoWrite('t2', PLAN)],
			'highlight',
		);
		expect(items.map((item) => (item.kind === 'todo' ? `todo:${item.latest}` : item.kind))).toEqual([
			'group',
			'todo:false',
			'todo:true',
		]);
		// An update does not end the run the group is in.
		expect(openRunIndex(items)).toBe(0);
	});

	it('leaves the update in the group when the setting collapses everything', () => {
		const items = turnItems([read('r1'), todoWrite('t1', PLAN)], 'collapse');
		expect(items.map((item) => item.kind)).toEqual(['group']);
	});
});

describe('TurnRenderer: the to-do list in the turn (#143)', () => {
	/** Every to-do update on screen: open or not, and the rows of its checklist. */
	function updates(el: FakeElement): { open: boolean; rows: string[] }[] {
		return el.findAll('herdr-native-todo').map((update) => ({
			open: update.open,
			rows: update.findAll('herdr-native-checklist-item').map((row) => row.textContent),
		}));
	}

	it('shows the latest list as a checklist, with each state in words too', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([todoWrite('t1', PLAN)]));

		expect(updates(el)).toEqual([
			{
				open: true,
				rows: [
					'✓Read the issue (done)',
					'●Write the tests (in progress)',
					'○Run the gate (to do)',
				],
			},
		]);
		expect(el.find('herdr-native-todo-summary').textContent).toBe(
			'Updated the to-do list · 1 of 3 done',
		);
		const glyphs = el.findAll('herdr-native-checklist-glyph');
		expect(glyphs.every((glyph) => glyph.attrs['aria-hidden'] === 'true')).toBe(true);
	});

	it('folds an update once a later one arrives, unless the reader opened it', () => {
		const { el, renderer } = rendererOn();
		const done = PLAN.map((item) => ({ ...item, status: 'completed' }));
		renderer.render(turn([todoWrite('t1', PLAN)]));
		renderer.render(turn([todoWrite('t1', PLAN), todoWrite('t2', done)]));
		expect(updates(el).map((update) => update.open)).toEqual([false, true]);

		// The reader opens the first again; a third update leaves it open.
		const first = el.findAll('herdr-native-todo')[0] as FakeElement;
		first.open = true;
		first.dispatch('toggle');
		renderer.render(turn([todoWrite('t1', PLAN), todoWrite('t2', done), todoWrite('t3', done)]));
		expect(updates(el).map((update) => update.open)).toEqual([true, false, true]);
	});

	it('shows a list it cannot read as the line alone', () => {
		const { el, renderer } = rendererOn();
		renderer.render(turn([todoWrite('t1', 'garbled')]));
		expect(el.find('herdr-native-todo').textContent).toBe('Updated the to-do list');
		expect(el.findAll('herdr-native-checklist')).toEqual([]);
	});
});

describe('TodoChip (#143)', () => {
	function chipOn() {
		const { el, host } = hostEl();
		return { el, chip: new TodoChip(host) };
	}

	it('is hidden while the agent keeps no list', () => {
		const { el, chip } = chipOn();
		chip.update(null);
		expect(el.find('herdr-native-plan').hasClass('herdr-is-hidden')).toBe(true);
	});

	it('says how far the list has got and what is being done now, folded to one line', () => {
		const { el, chip } = chipOn();
		chip.update(todoList(todoWrite('t1', PLAN)));

		const plan = el.find('herdr-native-plan');
		expect(plan.hasClass('herdr-is-hidden')).toBe(false);
		expect(plan.open).toBe(false);
		expect(plan.find('herdr-native-plan-progress').textContent).toBe('1 of 3 done');
		expect(plan.find('herdr-native-plan-current').textContent).toBe('Writing the tests');
		expect(plan.find('herdr-native-plan-summary').attrs['aria-label']).toBe(
			'To-do, 1 of 3 done, Writing the tests',
		);
		expect(plan.findAll('herdr-native-checklist-item')).toHaveLength(3);
	});

	it('keeps the reader’s open across updates, and draws nothing for the same list', () => {
		const { el, chip } = chipOn();
		chip.update(todoList(todoWrite('t1', PLAN)));
		const plan = el.find('herdr-native-plan');
		plan.open = true;
		const list = plan.find('herdr-native-checklist');

		chip.update(todoList(todoWrite('t2', PLAN)));
		expect(plan.find('herdr-native-checklist')).toBe(list);

		chip.update(todoList(todoWrite('t3', PLAN.map((item) => ({ ...item, status: 'in_progress' })))));
		expect(el.find('herdr-native-plan')).toBe(plan);
		expect(plan.open).toBe(true);
	});

	it('hides once every item is done', () => {
		const { el, chip } = chipOn();
		chip.update(todoList(todoWrite('t1', PLAN)));
		chip.update(todoList(todoWrite('t2', PLAN.map((item) => ({ ...item, status: 'completed' })))));
		expect(el.find('herdr-native-plan').hasClass('herdr-is-hidden')).toBe(true);
	});
});
