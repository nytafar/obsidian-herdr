/**
 * The form an @-mention goes out in (issue #98).
 *
 * The pane's agent reads the mention, not Obsidian, so the path in it has to
 * make sense to a process whose cwd is the pane's: relative when the file is
 * under that cwd — the main case, panes inside the vault — absolute otherwise,
 * and quoted when it has a space in it. Three cases, written out by hand.
 */

import { describe, expect, it } from 'vitest';
import { mentionFor, mentionPath, vaultFileAbsolutePath } from '../src/native/promptMentions';

const CWD = '/home/lasse/hvelv';

describe('mentionPath', () => {
	it('is relative to the cwd when the file is under it', () => {
		expect(mentionPath({ path: '/home/lasse/hvelv/repos/obsidian-herdr.md', cwd: CWD })).toBe(
			'repos/obsidian-herdr.md',
		);
	});

	it('is absolute when the file is outside the cwd', () => {
		expect(mentionPath({ path: '/home/lasse/code/notes/plan.md', cwd: CWD })).toBe(
			'/home/lasse/code/notes/plan.md',
		);
	});

	it('is absolute for a sibling whose name merely starts with the cwd', () => {
		expect(mentionPath({ path: '/home/lasse/hvelv-old/plan.md', cwd: CWD })).toBe(
			'/home/lasse/hvelv-old/plan.md',
		);
	});

	it('is absolute when the pane has no cwd to be relative to', () => {
		expect(mentionPath({ path: '/home/lasse/hvelv/plan.md', cwd: '' })).toBe(
			'/home/lasse/hvelv/plan.md',
		);
	});

	it('ignores a trailing slash on the cwd', () => {
		expect(mentionPath({ path: '/home/lasse/hvelv/plan.md', cwd: '/home/lasse/hvelv/' })).toBe(
			'plan.md',
		);
	});
});

describe('mentionFor', () => {
	it('writes a plain path bare', () => {
		expect(mentionFor({ path: '/home/lasse/hvelv/repos/plan.md', cwd: CWD })).toBe(
			'@repos/plan.md',
		);
	});

	it('quotes a path that contains a space', () => {
		expect(mentionFor({ path: '/home/lasse/hvelv/my notes/a plan.md', cwd: CWD })).toBe(
			'@"my notes/a plan.md"',
		);
		expect(mentionFor({ path: '/tmp/my notes/a plan.md', cwd: CWD })).toBe(
			'@"/tmp/my notes/a plan.md"',
		);
	});
});

describe('vaultFileAbsolutePath', () => {
	it('joins the vault base path with the vault-relative path Obsidian gives', () => {
		expect(
			vaultFileAbsolutePath({ vaultPath: '/home/lasse/hvelv', filePath: 'repos/plan.md' }),
		).toBe('/home/lasse/hvelv/repos/plan.md');
	});

	it('is nothing when the vault is not on this filesystem', () => {
		expect(vaultFileAbsolutePath({ vaultPath: '', filePath: 'repos/plan.md' })).toBe(null);
	});
});
