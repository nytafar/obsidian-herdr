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

import { mkdtempSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	encodeProjectDir,
	DEFAULT_CHUNK_BYTES,
	LocalTranscriptSource,
	transcriptPath,
	type TailOptions,
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

	/** One delivery: the lines, and whether the tail said it started over. */
	interface Batch {
		lines: string[];
		restart: boolean;
	}

	/** Like {@link tail}, but keeping each batch and its restart flag. */
	function batches(path: string, options: TailOptions = {}): Batch[] {
		const source = new LocalTranscriptSource();
		const seen: Batch[] = [];
		streams.push(
			source.open(path, (lines, restart) => seen.push({ lines, restart: restart === true }), {
				debounceMs: 5,
				pollMs: 20,
				...options,
			}),
		);
		return seen;
	}

	/** Every line delivered since the last restart: what the model would hold. */
	function current(seen: Batch[]): string[] {
		const last = seen.map((batch) => batch.restart).lastIndexOf(true);
		return seen.slice(Math.max(0, last)).flatMap((batch) => batch.lines);
	}

	it('starts over when the file is truncated under it', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\ntwo\n');
		const seen = batches(path);
		await eventually(() => current(seen).length === 2);

		// Shorter than what was read: not the file this tail started on.
		writeFileSync(path, 'x\n');

		await eventually(() => seen.some((batch) => batch.restart));
		await eventually(() => current(seen).join() === 'x');
		expect(seen[0]?.restart).toBe(false);
	});

	it('starts over when the file is rewritten in place, longer than before', async () => {
		// Same inode, a size past the offset: only the head says it is another file.
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, '{"uuid":"a"}\n');
		const seen = batches(path);
		await eventually(() => current(seen).length === 1);

		writeFileSync(path, '{"uuid":"b"}\n{"uuid":"c"}\n{"uuid":"d"}\n');

		await eventually(() => current(seen).length === 3 && seen.some((batch) => batch.restart));
		expect(current(seen)).toEqual(['{"uuid":"b"}', '{"uuid":"c"}', '{"uuid":"d"}']);
	});

	it('starts over on a truncation that keeps the first kilobyte, which only the size tells', async () => {
		// Same inode, same head: the remembered 1 KB is all inside line 1, so
		// only the size below the offset says the file is not what was read.
		const path = join(dir, 'session.jsonl');
		const first = `{"uuid":"a","pad":"${'x'.repeat(1200)}"}`;
		writeFileSync(path, `${first}\n{"uuid":"b","pad":"${'y'.repeat(400)}"}\n{"uuid":"c"}\n`);
		const seen = batches(path);
		await eventually(() => current(seen).length === 3);

		// Rewritten in place, shorter, line 1 untouched.
		writeFileSync(path, `${first}\n{"uuid":"z"}\n`);

		await eventually(() => seen.some((batch) => batch.restart) && current(seen).length === 2);
		expect(current(seen)).toEqual([first, '{"uuid":"z"}']);
	});

	it('starts over on a same-head replacement renamed over it, which only the inode tells', async () => {
		// The replacement shares the first 1 KB and is longer than the offset,
		// so neither the head nor the size gives it away.
		const path = join(dir, 'session.jsonl');
		const first = `{"uuid":"a","pad":"${'x'.repeat(1200)}"}`;
		writeFileSync(path, `${first}\n{"uuid":"old"}\n`);
		const seen = batches(path);
		await eventually(() => current(seen).length === 2);

		const next = join(dir, 'next.jsonl');
		writeFileSync(next, `${first}\n{"uuid":"new-1"}\n{"uuid":"new-2","pad":"${'z'.repeat(200)}"}\n`);
		renameSync(next, path);

		await eventually(() => seen.some((batch) => batch.restart) && current(seen).length === 3);
		expect(current(seen)).toEqual([first, '{"uuid":"new-1"}', `{"uuid":"new-2","pad":"${'z'.repeat(200)}"}`]);
	});

	it('starts over on a file renamed over it, and does not feed the new one into the old', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'old-1\n');
		const seen = batches(path);
		await eventually(() => current(seen).length === 1);

		// A replacement longer than the offset, so size alone would not tell.
		const next = join(dir, 'next.jsonl');
		writeFileSync(next, 'new-1\nnew-2\nnew-3\n');
		renameSync(next, path);

		await eventually(() => current(seen).length === 3 && seen.some((batch) => batch.restart));
		expect(current(seen)).toEqual(['new-1', 'new-2', 'new-3']);
	});

	it('watches the replacement itself, not the inode the path used to name', async () => {
		// On Linux a watch on a file that is renamed over stays on the old inode
		// and hears nothing more. With the poll out of the way, only a watch
		// rebuilt on the rename can see the append that follows.
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'old-1\n');
		const seen = batches(path, { pollMs: 60_000 });
		await eventually(() => current(seen).length === 1);

		const next = join(dir, 'next.jsonl');
		writeFileSync(next, 'new-1\n');
		renameSync(next, path);
		await eventually(() => seen.some((batch) => batch.restart));
		appendFileSync(path, 'new-2\n');

		await eventually(() => current(seen).join() === 'new-1,new-2');
	});

	it('picks a deleted file up again when it comes back', async () => {
		const path = join(dir, 'session.jsonl');
		writeFileSync(path, 'one\n');
		const seen = batches(path);
		await eventually(() => current(seen).length === 1);

		rmSync(path);
		await new Promise((resolve) => setTimeout(resolve, 40));
		writeFileSync(path, 'again\n');

		await eventually(() => current(seen).join() === 'again');
	});

	it('reads a large first file in pieces, whole lines and characters intact', async () => {
		// Lines and multi-byte characters straddle every piece boundary here.
		const path = join(dir, 'session.jsonl');
		const written = Array.from({ length: 50 }, (_, i) => `{"n":${i},"t":"æøå–${'x'.repeat(i)}"}`);
		writeFileSync(path, `${written.join('\n')}\n`);

		const seen = batches(path, { chunkBytes: 37 });

		await eventually(() => current(seen).length === written.length);
		expect(current(seen)).toEqual(written);
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.every((batch) => !batch.restart)).toBe(true);
	});

	it('reads in pieces of about a megabyte by default', async () => {
		expect(DEFAULT_CHUNK_BYTES).toBe(1024 * 1024);
		const path = join(dir, 'session.jsonl');
		const line = `{"pad":"${'y'.repeat(1000)}"}`;
		const count = 3000;
		writeFileSync(path, `${Array.from({ length: count }, () => line).join('\n')}\n`);

		const seen = batches(path);

		await eventually(() => current(seen).length === count);
		// About 3 MB, so no fewer than three reads, and no line lost between them.
		expect(seen.length).toBeGreaterThanOrEqual(3);
		expect(current(seen).every((delivered) => delivered === line)).toBe(true);
	});
});
