/**
 * The transcript source (issues #93 and #94, ADR-0003).
 *
 * Two halves. The path: where Claude Code puts the transcript of a session
 * started in a directory, which is a pure function and is asserted against
 * folders that exist on this machine. And the local adapter: `read` for a whole
 * file, `open` for a tail, driven here against a real temp file because a
 * partial trailing line and the order of appends are the only things that can
 * go wrong and neither shows up in a fake.
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	encodeProjectDir,
	LocalTranscriptSource,
	transcriptPath,
	type TranscriptStream,
} from '../src/native/transcriptSource';

describe('encodeProjectDir (ADR-0003)', () => {
	it('replaces everything that is not a letter or a digit with a dash', () => {
		// Ground truth: folders under ~/.claude/projects on this machine, each
		// checked against the `cwd` its own transcript records.
		expect(encodeProjectDir('/home/lasse/code/nytafar/obsidian-herdr')).toBe(
			'-home-lasse-code-nytafar-obsidian-herdr',
		);
		// A dot is a separator too, so `.claude` doubles the dash before it.
		expect(encodeProjectDir('/home/lasse/.claude')).toBe('-home-lasse--claude');
		// Case survives; hyphens already in the path stay single.
		expect(encodeProjectDir('/home/lasse/Work/regnskap/nyta-mai-juni')).toBe(
			'-home-lasse-Work-regnskap-nyta-mai-juni',
		);
		expect(encodeProjectDir('/tmp/claude-1000/-home-lasse/f1a289e0/scratchpad')).toBe(
			'-tmp-claude-1000--home-lasse-f1a289e0-scratchpad',
		);
	});

	it('truncates a long path to 200 characters and appends Claude Code’s hash', () => {
		// Claude Code 2.1.266 caps the folder name at 200 and appends
		// `Math.abs(hash).toString(36)` of the whole path, hash being the usual
		// `h = h * 31 + c` over int32. Worked out by hand, not by this code.
		const path = `/home/lasse/hvelv/${`${'a'.repeat(60)}/`.repeat(4)}leaf`;
		expect(path).toHaveLength(266);

		const encoded = encodeProjectDir(path);

		expect(encoded).toBe(`-home-lasse-hvelv-${`${'a'.repeat(60)}-`.repeat(3)}1axedw`);
	});
});

describe('transcriptPath (ADR-0003)', () => {
	it('is the session’s file in the project folder of the pane’s cwd', () => {
		expect(
			transcriptPath({
				cwd: '/home/lasse/hvelv',
				agentSession: '707d574b-94b9-432c-8962-027f8e1350e4',
				home: '/home/lasse',
			}),
		).toBe(
			'/home/lasse/.claude/projects/-home-lasse-hvelv/707d574b-94b9-432c-8962-027f8e1350e4.jsonl',
		);
	});

	it('has no path at all without a cwd or without an agent session', () => {
		// A freshly started Claude has no `agent_session` and no file until the
		// first prompt (docs/architecture.md); that is "no session yet", not an
		// error.
		expect(transcriptPath({ cwd: '', agentSession: 'abc', home: '/home/lasse' })).toBeNull();
		expect(transcriptPath({ cwd: '/home/lasse', agentSession: '', home: '/home/lasse' })).toBeNull();
	});
});

describe('LocalTranscriptSource.read', () => {
	let dir = '';

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'herdr-transcript-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('reads a whole file and answers null for one that is not there', async () => {
		const source = new LocalTranscriptSource();
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, '{"type":"mode"}\n');

		expect(await source.read(path)).toBe('{"type":"mode"}\n');
		expect(await source.read(join(dir, 'gone.jsonl'))).toBeNull();
	});

	it('appending after a read is visible to the next read', async () => {
		const source = new LocalTranscriptSource();
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\n');
		await source.read(path);
		appendFileSync(path, 'two\n');

		expect(await source.read(path)).toBe('one\ntwo\n');
	});
});

describe('LocalTranscriptSource.open: following a growing transcript (#94)', () => {
	let dir = '';
	const streams: TranscriptStream[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'herdr-tail-'));
	});

	afterEach(() => {
		for (const stream of streams.splice(0)) stream.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Follows `path`, collecting every line delivered, closed by the hook above. */
	function tail(path: string): string[] {
		const source = new LocalTranscriptSource();
		const lines: string[] = [];
		// Short enough that a test finishes quickly, long enough that a burst of
		// appends still coalesces the way it does in the app.
		streams.push(source.open(path, (batch) => lines.push(...batch), { debounceMs: 5, pollMs: 20 }));
		return lines;
	}

	/** Waits for `check` to hold, up to a second, polling the way a human would. */
	async function eventually(check: () => boolean): Promise<void> {
		for (let waited = 0; waited < 1000; waited += 10) {
			if (check()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(check()).toBe(true);
	}

	it('delivers what the file already holds, then what is appended, in order', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\ntwo\n');

		const lines = tail(path);
		await eventually(() => lines.length === 2);
		appendFileSync(path, 'three\n');
		await eventually(() => lines.length === 3);
		appendFileSync(path, 'four\nfive\n');
		await eventually(() => lines.length === 5);

		expect(lines).toEqual(['one', 'two', 'three', 'four', 'five']);
	});

	it('holds a partial trailing line until its newline arrives', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\n');
		const lines = tail(path);
		await eventually(() => lines.length === 1);

		// Claude writes a transcript line in pieces; half a line is not a line.
		appendFileSync(path, '{"type":"assis');
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(lines).toEqual(['one']);

		appendFileSync(path, 'tant"}\n');
		await eventually(() => lines.length === 2);
		expect(lines[1]).toBe('{"type":"assistant"}');
	});

	it('follows a file that does not exist yet', async () => {
		// The transcript is created when the first prompt lands (ADR-0003), which
		// can be after the view opened.
		const path = join(dir, 'later.jsonl');
		const lines = tail(path);

		writeFileSync(path, 'first\n');

		await eventually(() => lines.length === 1);
		expect(lines).toEqual(['first']);
	});

	it('delivers nothing more once it is closed', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\n');
		const source = new LocalTranscriptSource();
		const lines: string[] = [];
		const stream = source.open(path, (batch) => lines.push(...batch), {
			debounceMs: 5,
			pollMs: 20,
		});
		await eventually(() => lines.length === 1);

		stream.close();
		appendFileSync(path, 'two\n');
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(lines).toEqual(['one']);
	});

	it('reads a second path from its own beginning', async () => {
		// What a rotation does: the old stream is closed and the new file is read
		// whole, so nothing of the old session survives (ADR-0003).
		const first = join(dir, 'first.jsonl');
		const second = join(dir, 'second.jsonl');
		writeFileSync(first, 'old\n');
		writeFileSync(second, 'new\n');
		const before = tail(first);
		await eventually(() => before.length === 1);

		const after = tail(second);

		await eventually(() => after.length === 1);
		expect(after).toEqual(['new']);
	});
});
