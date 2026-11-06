/**
 * Claude's plan file for a herdr or herdr-core pane (#148).
 *
 * `ExitPlanMode` reaches the transcript only with its answer (measured on
 * Claude Code 2.1.286, `docs/architecture.md`), so a pane waiting on plan
 * approval says nothing of its plan in the transcript. Claude has written it
 * to `<config dir>/plans/<slug>.md` by then, and every message line carries
 * the session's `"slug"`. The lines below are cut from real transcripts on
 * this machine (2.1.281 and 2.1.286), keeping the fields read here.
 */

import { describe, expect, it } from 'vitest';
import { isSafeSlug, PlanTracker, planFilePath } from '../src/native/planFile';

const TRANSCRIPT = '/home/lasse/.claude/projects/-home-lasse-code/363fde6f-2e65-4ff8-a20c-f30cb8777164.jsonl';

/** A message line carrying the session's slug, as Claude writes every one once it has one. */
function message(slug: string): string {
	return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, slug });
}

/** The line Claude writes when its permission mode is (re)stated. */
function mode(permissionMode: string): string {
	return JSON.stringify({ type: 'permission-mode', permissionMode, sessionId: 's' });
}

/** The attachment Claude writes on entering (`plan_mode`) or leaving (`plan_mode_exit`) plan mode. */
function attachment(type: 'plan_mode' | 'plan_mode_exit', slug: string): string {
	return JSON.stringify({
		type: 'attachment',
		attachment: { type, planFilePath: `/home/lasse/.claude/plans/${slug}.md`, planExists: false },
		slug,
	});
}

describe('plan file path (#148)', () => {
	it('is the plans folder of the transcript’s own config dir, three levels up', () => {
		expect(planFilePath(TRANSCRIPT, 'wondrous-roaming-charm')).toBe(
			'/home/lasse/.claude/plans/wondrous-roaming-charm.md',
		);
		// A CLAUDE_CONFIG_DIR elsewhere (#132) is the folder the transcript is under.
		expect(planFilePath('/srv/cc/projects/-work/s.jsonl', 'mellow-purring-pike')).toBe(
			'/srv/cc/plans/mellow-purring-pike.md',
		);
	});

	it('names no file for a slug that could leave the plans folder', () => {
		for (const slug of ['../secret', '..', 'a/b', 'a\\b', '/etc/passwd', 'Upper', 'a--b', '-a', 'a-', '', 'a.b', 'a b']) {
			expect(isSafeSlug(slug), slug).toBe(false);
			expect(planFilePath(TRANSCRIPT, slug), slug).toBeNull();
		}
	});

	it('takes the slugs Claude makes, a prompt-derived prefix included', () => {
		for (const slug of ['wondrous-roaming-charm', 'use-the-askuserquestion-tool-cozy-liskov', 'a1']) {
			expect(isSafeSlug(slug), slug).toBe(true);
		}
	});

	it('names no file for a transcript path too short to have a config dir', () => {
		expect(planFilePath('s.jsonl', 'a')).toBeNull();
		expect(planFilePath('/s.jsonl', 'a')).toBeNull();
		expect(planFilePath('', 'a')).toBeNull();
	});
});

describe('plan tracker (#148)', () => {
	it('knows no slug and no plan mode before any line', () => {
		const tracker = new PlanTracker();
		expect(tracker.slug).toBe('');
		expect(tracker.planMode).toBe(false);
	});

	it('takes the last slug when the session’s slug changed', () => {
		const tracker = new PlanTracker();
		tracker.feed([message('old-slug'), message('old-slug')]);
		expect(tracker.slug).toBe('old-slug');
		tracker.feed([message('new-slug')]);
		expect(tracker.slug).toBe('new-slug');
	});

	it('keeps an unsafe slug out', () => {
		const tracker = new PlanTracker();
		tracker.feed([message('fine-slug'), message('../secret')]);
		expect(tracker.slug).toBe('');
	});

	it('follows plan mode in and out, as 2.1.286 writes it', () => {
		// The order of the real session 363fde6f: auto, EnterPlanMode's
		// attachment, `plan` restated at the next flush, then the exit after the
		// plan was approved and `auto` again.
		const tracker = new PlanTracker();
		tracker.feed([mode('auto')]);
		expect(tracker.planMode).toBe(false);
		tracker.feed([attachment('plan_mode', 'wondrous-roaming-charm')]);
		expect(tracker.planMode).toBe(true);
		tracker.feed([mode('plan'), message('wondrous-roaming-charm')]);
		expect(tracker.planMode).toBe(true);
		tracker.feed([attachment('plan_mode_exit', 'wondrous-roaming-charm')]);
		expect(tracker.planMode).toBe(false);
		tracker.feed([mode('auto')]);
		expect(tracker.planMode).toBe(false);
	});

	it('reads a prompt sent in plan mode, which carries the mode on the user line', () => {
		const tracker = new PlanTracker();
		tracker.feed([
			JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan it' }, permissionMode: 'plan' }),
		]);
		expect(tracker.planMode).toBe(true);
	});

	it('reads only top-level fields, not a mode named inside a tool’s result', () => {
		const tracker = new PlanTracker();
		tracker.feed([
			JSON.stringify({ type: 'user', toolUseResult: { permissionMode: 'plan', attachment: { type: 'plan_mode' } } }),
		]);
		expect(tracker.planMode).toBe(false);
	});

	it('skips a line that is not JSON', () => {
		const tracker = new PlanTracker();
		tracker.feed(['{"permissionMode":"plan"', mode('plan')]);
		expect(tracker.planMode).toBe(true);
	});

	it('forgets everything on reset', () => {
		const tracker = new PlanTracker();
		tracker.feed([mode('plan'), message('a-slug')]);
		tracker.reset();
		expect(tracker.slug).toBe('');
		expect(tracker.planMode).toBe(false);
	});
});
