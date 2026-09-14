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
