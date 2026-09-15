/**
 * The native surface's rendering (issues #93 and #94, ADR-0002, ADR-0003).
 *
 * A fake session model in place of a transcript, the DOM harness in place of a
 * document (`tests/fixtures/dom.ts`) and the recording `MarkdownRenderer` from
 * `tests/fixtures/obsidian.ts`: what is asserted is what the surface draws per
 * turn, which is the one thing about the native view that no other test covers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostEl, type FakeElement } from './fixtures/dom';
import { MarkdownRenderer } from './fixtures/obsidian';
import { NativePaneSurface } from '../src/native/surface';
import {
	emptyTranscript,
	type ToolEntry,
	type TranscriptState,
	type Turn,
} from '../src/native/reducer';
import type { ToolGroupPresentation } from '../src/native/toolCalls';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../src/native/sessionModel';
import type { AgentStatus } from '../src/herdr/types.gen';
import type { App } from 'obsidian';

/** A session model a test drives by hand. */
class FakeModel implements SessionModelView {
	state: TranscriptState = emptyTranscript();
	path: string | null = null;
	agentSession = '';
	agentStatus: AgentStatus = 'idle';
	private readonly listeners = new Set<(change: SessionChange) => void>();

	on(listener: (change: SessionChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** What the model does when the reducer moved: new state, then the change. */
	push(turns: Turn[], change: SessionChange): void {
		this.state = { ...this.state, turns };
		this.path = this.path ?? '/transcript.jsonl';
		for (const listener of [...this.listeners]) listener(change);
	}
}

class FakeModels implements SessionModels {
	readonly acquired: string[] = [];
	released = 0;
	constructor(readonly model: FakeModel) {}
	acquire(paneId: string): SessionHandleOf<SessionModelView> {
		this.acquired.push(paneId);
		return {
			model: this.model,
			release: () => {
				this.released++;
			},
		};
	}
}

function turn(id: string, prompt: string, entries: Turn['entries'] = []): Turn {
	return { id, prompt, entries };
}

/** The vault the surface strips paths against, unless a case says otherwise. */
const VAULT = '/home/lasse/hvelv';

function surfaceOn(
	model: FakeModel,
	options: { presentation?: ToolGroupPresentation; vaultPath?: string } = {},
): {
	surface: NativePaneSurface;
	models: FakeModels;
	el: FakeElement;
	host: HTMLElement;
	openLinkText: ReturnType<typeof vi.fn>;
} {
	const { el, host } = hostEl();
	const models = new FakeModels(model);
	const openLinkText = vi.fn();
	const app = { workspace: { openLinkText } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models,
		// What a send does is `tests/promptBox.test.ts`; nothing here sends.
		sender: { send: async () => {} },
		// The waiting card is `tests/nativeWaiting.test.ts`; nothing here presses it.
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoAcceptPermissions: () => false,
		// Both read fresh on every draw: the setting can change under an open
		// view, and the vault is the app's, never a path this file invents.
		presentation: () => options.presentation ?? 'highlight',
		vaultPath: () => options.vaultPath ?? VAULT,
	});
	return { surface, models, el, host, openLinkText };
}

/**
 * A tool call as the reducer hands it over: pending until a result answers it,
 * done once one has, which is what the reducer writes (#91). A case that wants
 * another status says so.
 */
function tool(
	id: string,
	name: string,
	input: Record<string, unknown> = {},
	result: string | null = null,
): ToolEntry {
	return {
		kind: 'tool',
		id,
		name,
		input,
		result,
		status: result === null ? 'pending' : 'done',
		notification: null,
		report: null,
	};
}

beforeEach(() => {
	MarkdownRenderer.reset();
});

describe('NativePaneSurface: no session yet', () => {
	it('says so, and shows no turns', async () => {
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);

		await surface.attach(host);

		expect(models.acquired).toEqual(['w4:p1']);
		expect(el.find('herdr-native-empty').textContent).toBe('No session yet.');
		expect(el.findAll('herdr-native-turn')).toEqual([]);
	});
});

/**
 * The classes the root carries, which is what decides whether the theme's own
 * rules reach the rendered Markdown (#108).
 */
describe('NativePaneSurface: reading-view classes', () => {
	it('gives the root the pair Obsidian\u2019s own reading view uses', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);

		await surface.attach(host);

		expect([...el.find('herdr-native-view').classList]).toEqual([
			'herdr-native-view',
			'markdown-preview-view',
			'markdown-rendered',
		]);
	});
});

describe('NativePaneSurface: a turn', () => {
	it('renders the human prompt as plain text and the assistant prose as Markdown', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Summarise the design', [
					{ kind: 'text', messageId: 'm1', text: 'It settles **two** seams.' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const turns = el.findAll('herdr-native-turn');
		expect(turns).toHaveLength(1);
		expect(turns[0]?.find('herdr-native-prompt').textContent).toBe('Summarise the design');
		// The prose goes through Obsidian's own renderer, so wikilinks, callouts
		// and embeds are the app's business and not this file's.
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual([
			'It settles **two** seams.',
		]);
		expect(turns[0]?.find('herdr-native-block').textContent).toBe('It settles **two** seams.');
		expect(el.findAll('herdr-native-empty')).toEqual([]);
	});

	it('linkifies a wikilink in the prompt and opens it when it is clicked', async () => {
		const model = new FakeModel();
		const { surface, el, host, openLinkText } = surfaceOn(model);
		await surface.attach(host);

		model.push([turn('u1', 'Read [[native-view-design|the design]] first')], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		const prompt = el.find('herdr-native-prompt');
		const link = prompt.find('internal-link');
		expect(link.tag).toBe('a');
		expect(link.textContent).toBe('the design');
		expect(link.attrs['data-href']).toBe('native-view-design');
		// The text around the link survives, whitespace and all.
		expect(prompt.textContent).toBe('Read the design first');

		link.dispatch('click');

		expect(openLinkText).toHaveBeenCalledWith('native-view-design', '', false);
	});

	it('shows a steer where it entered the turn', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[turn('u1', 'Run it', [{ kind: 'steer', text: 'and check the styles' }])],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(el.find('herdr-native-steer').textContent).toBe('and check the styles');
	});
});

/**
 * The tool group (#95). The transcript below is one turn's worth of calls in
 * the order Claude made them, and the expected summary is the one the issue
 * names — "Read 4 files, ran 2 commands" — for exactly these calls.
 */
describe('NativePaneSurface: tool groups', () => {
	/** The classes of a turn's own items, in the order they were drawn. */
	function itemClasses(turnEl: FakeElement): string[] {
		return turnEl.children.map((child) => [...child.classList][0] ?? '');
	}

	/** Four reads, two commands, one vault change and one web search. */
	function busyTurn(): Turn {
		return turn('u1', 'Work through it', [
			{ kind: 'text', messageId: 'm1', text: 'Reading first.' },
			tool('t1', 'Read', { file_path: `${VAULT}/a.md` }),
			// With their results in: an answered call is a change that landed (#91).
			tool('t2', 'Write', { file_path: `${VAULT}/notes/b.md` }, 'File created successfully.'),
			tool('t3', 'Read', { file_path: `${VAULT}/c.md` }),
			tool('t4', 'WebSearch', { query: 'herdr protocol' }),
			tool('t5', 'Bash', { command: 'npm test' }),
			tool('t6', 'Read', { file_path: `${VAULT}/d.md` }),
			tool('t7', 'Read', { file_path: `${VAULT}/e.md` }),
			tool('t8', 'Bash', { command: 'ls' }),
			{ kind: 'text', messageId: 'm2', text: 'Done.' },
		]);
	}

	it('summarises the group without the vault change and the source, and leaves those outside it in chronological order', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push([busyTurn()], { changedTurnIds: ['u1'], reset: false });

		const group = el.find('herdr-native-tools');
		expect(group.find('herdr-native-tools-summary').textContent).toBe(
			'Read 4 files, ran 2 commands',
		);
		expect(group.findAll('herdr-native-tool').map((row) => row.textContent)).toEqual([
			'Read a.md',
			'Read c.md',
			'Bash npm test',
			'Read d.md',
			'Read e.md',
			'Bash ls',
		]);
		// The change and the source sit between the prose blocks, where they
		// happened: the write came before the search (native-view-design.md).
		expect(itemClasses(el.find('herdr-native-turn'))).toEqual([
			'herdr-native-prompt',
			'herdr-native-block',
			'herdr-native-tools',
			'herdr-native-change',
			'herdr-native-source',
			'herdr-native-block',
		]);
		expect(el.find('herdr-native-change').textContent).toBe('Updated notes/b');
		expect(el.find('herdr-native-source').textContent).toBe('Searched the web for “herdr protocol”');
	});

	it('keeps one tool group across signature-only thinking blocks, with the counts combined', async () => {
		// The shape a real transcript has between two calls (#107, measured over
		// the last 60 transcripts on this machine): a thinking block carrying only
		// a signature, which the view draws nothing for. An entry that renders
		// nothing must not end the run, or one stretch of work reads as three
		// summaries in a row.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Work through it', [
					tool('t1', 'Read', { file_path: `${VAULT}/a.md` }),
					{ kind: 'thinking', messageId: 'm1', text: '' },
					tool('t2', 'Bash', { command: 'npm test' }),
					tool('t3', 'Read', { file_path: `${VAULT}/b.md` }),
					{ kind: 'thinking', messageId: 'm2', text: '' },
					tool('t4', 'Bash', { command: 'ls' }),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(itemClasses(el.find('herdr-native-turn'))).toEqual([
			'herdr-native-prompt',
			'herdr-native-tools',
		]);
		expect(el.find('herdr-native-tools-summary').textContent).toBe(
			'Read 2 files, ran 2 commands',
		);
	});

	it('moves the vault change and the source inside the group when the setting collapses everything', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model, { presentation: 'collapse' });
		await surface.attach(host);

		model.push([busyTurn()], { changedTurnIds: ['u1'], reset: false });

		const group = el.find('herdr-native-tools');
		expect(group.find('herdr-native-tools-summary').textContent).toBe(
			'Read 4 files, wrote 1 file, ran 1 web search, ran 2 commands',
		);
		expect(group.findAll('herdr-native-tool')).toHaveLength(8);
		expect(el.findAll('herdr-native-change')).toEqual([]);
		expect(el.findAll('herdr-native-source')).toEqual([]);
	});

	it('links a changed note inside the vault and names a file outside it plainly', async () => {
		const model = new FakeModel();
		const { surface, el, host, openLinkText } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Edit both', [
					tool(
						't1',
						'Write',
						{ file_path: `${VAULT}/repos/obsidian-herdr/CONTEXT.md` },
						'File created successfully.',
					),
					tool('t2', 'Edit', { file_path: '/etc/hosts' }, 'The file has been updated.'),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const [inside, outside] = el.findAll('herdr-native-change');
		expect(inside?.textContent).toBe('Updated repos/obsidian-herdr/CONTEXT');
		const link = inside?.find('internal-link');
		expect(link?.attrs['data-href']).toBe('repos/obsidian-herdr/CONTEXT');
		link?.dispatch('click');
		expect(openLinkText).toHaveBeenCalledWith('repos/obsidian-herdr/CONTEXT', '', false);
		// Outside the vault there is nothing to strip and nothing to link to.
		expect(outside?.textContent).toBe('Updated /etc/hosts');
		expect(outside?.findAll('internal-link')).toEqual([]);
		// Every call escaped the group, so there is no group left to draw.
		expect(el.findAll('herdr-native-tools')).toEqual([]);
	});

	it('lists the sources a web search returned, as links', async () => {
		// A search's sources are in its `tool_result`, as a `Links:` line of
		// title/url objects ahead of the prose — the shape every WebSearch result
		// on this machine has (#95, #91 story 13). The input holds only a query,
		// so a view that reads the input alone shows no source at all.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		const search = tool(
			't1',
			'WebSearch',
			{ query: 'herdr protocol' },
			[
				'Web search results for query: "herdr protocol"',
				'',
				'Links: [{"title":"Herdr documentation | herdr","url":"https://herdr.dev/docs/"},{"title":"herdr - crates.io","url":"https://crates.io/crates/herdr"}]',
				'',
				'Based on the search results, herdr is a terminal workspace manager.',
			].join('\n'),
		);

		model.push([turn('u1', 'Look it up', [search])], { changedTurnIds: ['u1'], reset: false });

		const source = el.find('herdr-native-source');
		expect(source.children[0]?.textContent).toBe('Searched the web for “herdr protocol”');
		const links = source.findAll('herdr-native-source-link');
		expect(links.map((link) => link.textContent)).toEqual([
			'Herdr documentation | herdr',
			'herdr - crates.io',
		]);
		expect(links.map((link) => link.attrs.href)).toEqual([
			'https://herdr.dev/docs/',
			'https://crates.io/crates/herdr',
		]);
		expect([...(links[0]?.classList ?? [])]).toContain('external-link');
	});

	it('shows a web search with no sources yet as the query alone', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[turn('u1', 'Look it up', [tool('t1', 'WebSearch', { query: 'herdr protocol' })])],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(el.find('herdr-native-source').textContent).toBe(
			'Searched the web for “herdr protocol”',
		);
		expect(el.find('herdr-native-source').findAll('herdr-native-source-link')).toEqual([]);
	});

	it('links only web pages, and shows any other url as text', async () => {
		// Urls come out of tool output: a `javascript:` one must never become a
		// link Obsidian would follow.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		const search = tool(
			't1',
			'WebSearch',
			{ query: 'herdr' },
			[
				'Web search results for query: "herdr"',
				'',
				'Links: [{"title":"Bad","url":"javascript:alert(1)"},{"title":"Good","url":"https://herdr.dev/"}]',
			].join('\n'),
		);
		const fetch = tool('t2', 'WebFetch', { url: 'javascript:alert(1)' }, 'ok');

		model.push([turn('u1', 'Look it up', [search, fetch])], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		const [searched, fetched] = el.findAll('herdr-native-source');
		expect(searched?.findAll('herdr-native-source-link').map((link) => link.attrs.href)).toEqual([
			'https://herdr.dev/',
		]);
		expect(fetched?.findAll('external-link')).toEqual([]);
		expect(fetched?.textContent).toBe('javascript:alert(1)');
	});

	it('says what became of a change: updated, updating or refused', async () => {
		// A vault change line reports the call's status (#91, #95): an edit that
		// failed or has not answered yet must not read as one that landed.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		const done = tool('t1', 'Write', { file_path: `${VAULT}/a.md` }, 'ok');
		const pending = tool('t2', 'Edit', { file_path: `${VAULT}/b.md` });
		const failed = tool('t3', 'Edit', { file_path: `${VAULT}/c.md` }, 'rejected');
		failed.status = 'error';

		model.push([turn('u1', 'Change three notes', [done, pending, failed])], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		const changes = el.findAll('herdr-native-change');
		expect(changes.map((line) => line.textContent)).toEqual([
			'Updated a',
			'Updating b…',
			'Could not update c',
		]);
		// The state is in the class too, so `styles.css` can say it quietly.
		expect([...(changes[1]?.classList ?? [])]).toEqual([
			'herdr-native-change',
			'is-pending',
		]);
		expect([...(changes[2]?.classList ?? [])]).toEqual(['herdr-native-change', 'is-error']);
		// A note is still a link whatever became of the change.
		expect(changes[2]?.find('internal-link').attrs['data-href']).toBe('c');
	});

	it('shows a thought collapsed, and shows nothing for a thought that is only a signature', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Think it over', [
					{ kind: 'thinking', messageId: 'm1', text: 'Weighing the rule.' },
					{ kind: 'thinking', messageId: 'm2', text: '' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		const thought = el.find('herdr-native-thinking');
		expect(thought.tag).toBe('details');
		// Collapsed by default: a disclosure is open only with the attribute.
		expect(thought.attrs.open).toBeUndefined();
		expect(thought.find('herdr-native-thinking-summary').textContent).toBe('Thought');
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual(['Weighing the rule.']);
	});
});

/**
 * Steers and subagent results (#96). A steer is a prompt taken while the agent
 * was working; a subagent's report is prose the transcript keeps somewhere else.
 */
describe('NativePaneSurface: steers and subagent reports', () => {
	/** The classes of a turn's own items, in the order they were drawn. */
	function itemClasses(turnEl: FakeElement): string[] {
		return turnEl.children.map((child) => [...child.classList][0] ?? '');
	}

	it('keeps a steer out of the tool group, at the point it entered the turn', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Start the long job', [
					tool('t1', 'Read', { file_path: `${VAULT}/a.md` }),
					{ kind: 'steer', text: 'also check the styles' },
					tool('t2', 'Bash', { command: 'npm test' }),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		// Two groups, not one: the steer entered the context between the calls
		// and is never inside a group (CONTEXT.md, #96).
		expect(itemClasses(el.find('herdr-native-turn'))).toEqual([
			'herdr-native-prompt',
			'herdr-native-tools',
			'herdr-native-steer',
			'herdr-native-tools',
		]);
		expect(el.findAll('herdr-native-tools-summary').map((line) => line.textContent)).toEqual([
			'Read 1 file',
			'Ran 1 command',
		]);
		expect(el.find('herdr-native-steer').textContent).toBe('also check the styles');
	});

	it('renders a synchronous subagent report as prose, with the call still in the group', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Ask the researcher', [
					tool('t1', 'Agent', { description: 'Research it' }, 'It settles **two** seams.'),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(el.find('herdr-native-tools-summary').textContent).toBe('Ran 1 subagent');
		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual([
			'It settles **two** seams.',
		]);
		expect(el.find('herdr-native-report').textContent).toBe('It settles **two** seams.');
	});

	it('ends the tool group at a subagent report, so a later call reads after it', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.push(
			[
				turn('u1', 'Ask the researcher', [
					tool('t1', 'Agent', { description: 'Research it' }, 'It settles it.'),
					tool('t2', 'Read', { file_path: '/tmp/a.md' }, 'ok'),
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(el.findAll('herdr-native-tools-summary').map((summary) => summary.textContent)).toEqual([
			'Ran 1 subagent',
			'Read 1 file',
		]);
	});

	it('shows nothing for an asynchronous subagent that is still running', async () => {
		// Between the launch and the completion notification there is no
		// notification to recognise the call by, and its `tool_result` is the
		// launch notice: internal metadata that says in so many words not to
		// quote it (docs/architecture.md, #96). The text below is a real one,
		// trimmed.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		const launched = tool(
			't1',
			'Agent',
			{ description: 'Check the styles' },
			[
				'Async agent launched successfully. (This tool result is internal metadata —',
				'never quote or paste any part of it, including the agentId below, into a',
				'user-facing reply.)',
				'agentId: a043ce14b28b68b90 (internal ID - do not mention to user.)',
				'The agent is working in the background. You will be notified automatically',
				'when it completes.',
			].join('\n'),
		);
		// What the reducer says of a call whose work went to the background.
		launched.status = 'running';

		model.push([turn('u1', 'Start the long job', [launched])], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		expect(el.findAll('herdr-native-report')).toEqual([]);
		expect(MarkdownRenderer.calls).toEqual([]);
		// The call itself is still in the group, as any other call is.
		expect(el.find('herdr-native-tools-summary').textContent).toBe('Ran 1 subagent');
	});

	it('renders an asynchronous subagent report once it has been read, and never the launch notice', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		const launched = tool(
			't1',
			'Agent',
			{ description: 'Check the styles' },
			'Async agent launched successfully. agentId: a1f2',
		);
		launched.notification = { taskId: 'a1f2', outputFile: '/tmp/a1f2.output' };

		model.push([turn('u1', 'Start the long job', [launched])], {
			changedTurnIds: ['u1'],
			reset: false,
		});

		// While it runs there is nothing to show: the launch result is internal
		// metadata, not the report (docs/architecture.md).
		expect(el.findAll('herdr-native-report')).toEqual([]);
		expect(MarkdownRenderer.calls).toEqual([]);

		// The session model read the report and fed it back (#96).
		model.push(
			[
				turn('u1', 'Start the long job', [
					{ ...launched, report: 'The styles are **fine**.' },
				]),
			],
			{ changedTurnIds: ['u1'], reset: false },
		);

		expect(MarkdownRenderer.calls.map((call) => call.markdown)).toEqual([
			'The styles are **fine**.',
		]);
		expect(el.find('herdr-native-report').textContent).toBe('The styles are **fine**.');
	});
});

describe('NativePaneSurface: keeping up', () => {
	it('redraws the turns that changed and leaves the rest standing', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'First')], { changedTurnIds: ['u1'], reset: false });
		const first = el.find('herdr-native-turn');

		model.push([turn('u1', 'First'), turn('u2', 'Second')], {
			changedTurnIds: ['u2'],
			reset: false,
		});

		const turns = el.findAll('herdr-native-turn');
		expect(turns).toHaveLength(2);
		expect(turns[0]).toBe(first);
		expect(turns[1]?.find('herdr-native-prompt').textContent).toBe('Second');
	});

	it('starts from empty on a reset', async () => {
		// Session following is strict: `/clear` empties the view (ADR-0003).
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'Before the clear')], { changedTurnIds: ['u1'], reset: false });

		model.push([], { changedTurnIds: [], reset: true });

		expect(el.findAll('herdr-native-turn')).toEqual([]);
		// The pane does have a session — a new one — so the empty line says that
		// rather than "no session yet".
		expect(el.find('herdr-native-empty').textContent).toBe('No turns in this session yet.');
	});
});

describe('NativePaneSurface: detach', () => {
	it('gives the model back and takes its element with it', async () => {
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'First')], { changedTurnIds: ['u1'], reset: false });

		await surface.detach();

		expect(models.released).toBe(1);
		expect(el.children).toEqual([]);
		// Nothing arrives after a detach, and nothing is drawn if it does.
		model.push([turn('u2', 'After')], { changedTurnIds: ['u2'], reset: false });
		expect(el.children).toEqual([]);
	});
});

describe('NativePaneSurface: what the agent is doing (#94)', () => {
	it('says the agent is working, between blocks and while nothing arrives', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.push([turn('u1', 'Run it')], { changedTurnIds: ['u1'], reset: false });

		// herdr's `agent_status`, not anything read out of the transcript.
		model.agentStatus = 'working';
		model.push([turn('u1', 'Run it')], { changedTurnIds: [], reset: false });

		expect(el.find('herdr-native-status').textContent).toBe('Working…');
	});

	it('says nothing once the agent is idle or done', async () => {
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);
		model.agentStatus = 'working';
		model.push([], { changedTurnIds: [], reset: false });
		expect(el.findAll('herdr-native-status')).toHaveLength(1);

		model.agentStatus = 'done';
		model.push([], { changedTurnIds: [], reset: false });

		expect(el.findAll('herdr-native-status')).toEqual([]);
	});

	it('says the agent is waiting when it is blocked', async () => {
		// The waiting card itself comes later; what #94 owes is that the state
		// shows at all.
		const model = new FakeModel();
		const { surface, el, host } = surfaceOn(model);
		await surface.attach(host);

		model.agentStatus = 'blocked';
		model.push([], { changedTurnIds: [], reset: false });

		expect(el.find('herdr-native-status').textContent).toBe('Waiting for you.');
	});

	it('keeps its model and keeps up while the leaf is hidden', async () => {
		// A hidden tab keeps its subscription and catches up on reveal (ADR-0003);
		// there is no process to hand back, so hiding costs nothing to keep.
		const model = new FakeModel();
		const { surface, el, host, models } = surfaceOn(model);
		await surface.attach(host);

		await surface.setVisible(false);
		model.push([turn('u1', 'Arrived while hidden')], { changedTurnIds: ['u1'], reset: false });
		await surface.setVisible(true);

		expect(models.released).toBe(0);
		expect(el.find('herdr-native-prompt').textContent).toBe('Arrived while hidden');
	});
});
