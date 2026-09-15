/**
 * What a long session costs the native view (issue #101).
 *
 * Not part of the gate: `vitest.config.ts` runs `tests/**\/*.test.ts`, and this
 * is a `.bench.ts`. Run it by hand:
 *
 * ```
 * npx vitest bench tests/perf/nativePerformance.bench.ts
 * ```
 *
 * Three corpora, all built from real transcripts, because an invented one has
 * none of the shapes that cost anything — the tool results, the subagent
 * reports, the hundred-kilobyte `tool_result` blocks:
 *
 * - **(a)** one large real session: the largest transcript on this machine, or
 *   the one `HERDR_BENCH_TRANSCRIPT` names.
 * - **(b)** the three largest transcripts on this machine concatenated, about
 *   600 `user` lines. Concatenating sessions is not a thing Claude Code does,
 *   but the reducer and the surface only ever see lines, and what is measured
 *   is how many of them there are.
 * - **(c)** (b) ten times over, every id in a copy made that copy's own, which
 *   is the only way to reach the several hundred **turns** the issue is about:
 *   a `user` line is mostly a tool result or a task notification, so (b)'s 600
 *   of them are only a few dozen human turns (`CONTEXT.md`: a turn is a human
 *   prompt and everything the agent did until it stopped). Repeating without
 *   rewriting the ids would not add turns at all — the reducer keys a turn by
 *   its `user` line's uuid, so the copies would land on top of each other.
 *
 * The transcripts are read-only and none of them is a fixture: they are
 * whatever is on this machine, so the numbers belong to the run that made
 * them. The ones this
 * file was written for are in the vault, `findings/native-view-performance.md`.
 *
 * What is measured is the two things that happen when a tab opens — `reduce`
 * over every line, then the surface's draw of every turn — with Obsidian
 * stubbed the way `tests/nativeSurface.test.ts` stubs it. The real DOM is not
 * here: `MarkdownRenderer` is the recording stub and the elements are the DOM
 * harness, so this is the plugin's own work, not the browser's layout. Open
 * time in Obsidian is a hand check.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { hostEl, type FakeElement } from '../fixtures/dom';
import { MarkdownRenderer } from '../fixtures/obsidian';
import { NativePaneSurface } from '../../src/native/surface';
import { emptyTranscript, reduce, type TranscriptState } from '../../src/native/reducer';
import type {
	SessionChange,
	SessionHandleOf,
	SessionModels,
	SessionModelView,
} from '../../src/native/sessionModel';
import type { AgentStatus } from '../../src/herdr/types.gen';
import type { App } from 'obsidian';

/**
 * Corpus (a): one large real session, read where it lies — the largest
 * transcript this machine has, or the file named in `HERDR_BENCH_TRANSCRIPT`.
 *
 * Discovered rather than named in the file: a path into one developer's home
 * is a path that is empty on every other checkout and after that session is
 * rotated away, and a benchmark that silently measures nothing is worse than
 * one that does not run. So this throws when there is no corpus to measure.
 */
const TRANSCRIPT_ENV = 'HERDR_BENCH_TRANSCRIPT';

/** Under this, a tab opens without the user seeing it happen. */
const BUDGET_MS = { large: 500, longest: 2000 };

/** How many times (c) repeats (b). */
const COPIES = 10;

/** Above this many elements, the issue's unmounting is back on the table. */
const NODE_BUDGET = 50_000;

/** A model that only ever hands over one already-reduced state. */
class StaticModel implements SessionModelView {
	path: string | null = '/transcript.jsonl';
	/** The tail has delivered the file's lines, as a read transcript has (#99). */
	loaded = true;
	agentSession = 'bench';
	agentStatus: AgentStatus = 'idle';
	constructor(readonly state: TranscriptState) {}
	on(_listener: (change: SessionChange) => void): () => void {
		return () => {};
	}
	/** Nothing here is blocked, so the claim is always free (#99). */
	claimBlock(): boolean {
		return true;
	}
}

class StaticModels implements SessionModels {
	constructor(readonly model: StaticModel) {}
	acquire(): SessionHandleOf<SessionModelView> {
		return { model: this.model, release: () => {} };
	}
}

/** Every transcript on this machine, largest first. */
function transcripts(): string[] {
	const root = join(homedir(), '.claude/projects');
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const project of readdirSync(root)) {
		const dir = join(root, project);
		if (!statSync(dir).isDirectory()) continue;
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.jsonl')) files.push(join(dir, name));
		}
	}
	return files.sort((a, b) => statSync(b).size - statSync(a).size);
}

function linesOf(paths: string[]): string[] {
	return paths.flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean));
}

/** The file corpus (a) is read from; throws when there is none to read. */
function largeTranscript(): string {
	const named = process.env[TRANSCRIPT_ENV];
	if (named !== undefined && named !== '') {
		if (!existsSync(named)) throw new Error(`${TRANSCRIPT_ENV} names no file: ${named}`);
		return named;
	}
	const [largest] = transcripts();
	if (largest === undefined) {
		throw new Error(
			`no transcripts under ~/.claude/projects; name one in ${TRANSCRIPT_ENV} to benchmark`,
		);
	}
	return largest;
}

/** The corpora. Both are real transcripts, so both fail loudly without any. */
function corpora(): { large: string[]; longest: string[] } {
	const longest = transcripts().slice(0, 3);
	if (longest.length === 0) {
		throw new Error('no transcripts under ~/.claude/projects to build corpus (b) from');
	}
	return { large: linesOf([largeTranscript()]), longest: linesOf(longest) };
}

/** Every uuid in a transcript line, and every tool call id beside them. */
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolu_[A-Za-z0-9]+/g;

/**
 * `lines` repeated, each copy carrying ids of its own, so the copies are
 * separate turns rather than the same ones reduced again. The suffix is
 * appended, never substituted, so distinct ids stay distinct and a reference
 * inside a copy still points where it did.
 */
function multiplied(lines: string[], copies: number): string[] {
	const out: string[] = [];
	for (let copy = 0; copy < copies; copy++) {
		if (copy === 0) {
			out.push(...lines);
			continue;
		}
		for (const line of lines) out.push(line.replace(IDS, (id) => `${id}-c${copy}`));
	}
	return out;
}

const { large, longest } = corpora();
const repeated = multiplied(longest, COPIES);

/** The surface's draw of a whole session: what `attach` does before it returns. */
async function draw(state: TranscriptState): Promise<FakeElement> {
	MarkdownRenderer.reset();
	const { el, host } = hostEl();
	const app = { workspace: { openLinkText: () => {} } } as unknown as App;
	const surface = new NativePaneSurface({
		app,
		identity: { paneId: 'w4:p1', mode: 'control', endpointId: 'local' },
		onStatus: () => {},
		models: new StaticModels(new StaticModel(state)),
		sender: { send: async () => {} },
		// The waiting card is `tests/nativeWaiting.test.ts`; nothing here presses it.
		keySender: { sendKeys: async () => {} },
		openInTerminal: () => {},
		autoAcceptPermissions: () => false,
		presentation: () => 'highlight',
		vaultPath: () => '',
	});
	await surface.attach(host);
	return el;
}

/** Every element the draw left behind, the root included. */
function countNodes(el: FakeElement): number {
	let total = 1;
	for (const child of el.children) total += countNodes(child);
	return total;
}

/** Human prompts, which is the count of turns the reducer found. */
function shape(name: string, lines: string[], state: TranscriptState): string {
	const bytes = lines.reduce((sum, line) => sum + line.length, 0);
	return `${name}: ${lines.length} lines, ${(bytes / 1e6).toFixed(1)} MB, ${state.turns.length} turns`;
}

const reduced = (lines: string[]): TranscriptState =>
	lines.length > 0 ? reduce(emptyTranscript(), lines).state : emptyTranscript();

const largeState = reduced(large);
const longestState = reduced(longest);
const repeatedState = reduced(repeated);

const options = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 };

describe('reduce over a whole transcript', () => {
	bench('(a) one large real session', () => void reduce(emptyTranscript(), large), options);
	bench(
		'(b) the three largest, concatenated',
		() => void reduce(emptyTranscript(), longest),
		options,
	);
	bench(
		`(c) (b) ${COPIES} times over, several hundred turns`,
		() => void reduce(emptyTranscript(), repeated),
		options,
	);
});

describe('the surface drawing every turn', () => {
	bench('(a) one large real session', async () => void (await draw(largeState)), options);
	bench(
		'(b) the three largest, concatenated',
		async () => void (await draw(longestState)),
		options,
	);
	bench(
		`(c) (b) ${COPIES} times over, several hundred turns`,
		async () => void (await draw(repeatedState)),
		options,
	);
});

/**
 * What the bench table cannot report: the shape of each corpus, the elements a
 * draw leaves behind, and the budgets to read the table against.
 *
 * Straight to stdout rather than through `console`, which the plugin lint bans
 * for good reason — this is a node benchmark, but it sits under `tests/` and is
 * linted with everything else.
 */
function say(line: string): void {
	process.stdout.write(`${line}\n`);
}

afterAll(async () => {
	for (const [name, lines, state] of [
		['(a)', large, largeState],
		['(b)', longest, longestState],
		['(c)', repeated, repeatedState],
	] as const) {
		const nodes = countNodes(await draw(state));
		say(`${shape(name, lines, state)}, ${nodes} elements after the draw`);
	}
	say(`budgets: (a) reduce+draw < ${BUDGET_MS.large} ms, (b) and (c) < ${BUDGET_MS.longest} ms`);
	say(`elements: under ${NODE_BUDGET} or unmounting goes back on the table`);
});
