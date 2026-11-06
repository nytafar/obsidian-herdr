/**
 * The pure half of the screen re-recording script (issue #168,
 * `scripts/record-screens/`): tools found without a mise shim, screens
 * scrubbed the way the committed ones were, what Claude leaves behind named
 * exactly, and the diff against the last set.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import { hcTextKeys } from '../src/hc/actions';
import { NARROW_TEXTS, sessions } from '../scripts/record-screens/scenario';
import {
	dialogRegion,
	findClaude,
	fixtureText,
	isMiseIndirection,
	latestSet,
	modeOf,
	namesUser,
	onPath,
	projectDirName,
	scrubScreen,
	sessionIdOf,
	slugsIn,
	trustedIn,
	unifiedDiff,
	versionIn,
} from '../scripts/record-screens/support';

const DIR = join(__dirname, 'fixtures', 'screens', 'claude-2.1.318');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');

describe('finding the tools', () => {
	const exists = (paths: string[]) => (path: string) => paths.includes(path);

	it('skips mise shims and command wrappers', () => {
		expect(isMiseIndirection('/home/u/.local/share/mise/shims/claude')).toBe(true);
		expect(isMiseIndirection('/home/u/.local/share/mise/command-wrappers/bin/claude')).toBe(true);
		expect(isMiseIndirection('/home/u/.local/share/mise/installs/claude/latest/claude')).toBe(false);
		const path = [
			'/home/u/.local/share/mise/command-wrappers/bin',
			'/home/u/.local/share/mise/installs/claude/latest',
			'/home/u/.local/share/mise/shims',
		].join(':');
		const all = [
			'/home/u/.local/share/mise/command-wrappers/bin/claude',
			'/home/u/.local/share/mise/installs/claude/latest/claude',
			'/home/u/.local/share/mise/shims/claude',
		];
		expect(onPath('claude', path, exists(all))).toEqual(['/home/u/.local/share/mise/installs/claude/latest/claude']);
		expect(findClaude(path, '/home/u', exists(all))).toBe('/home/u/.local/share/mise/installs/claude/latest/claude');
	});

	it("falls back to mise's install of the latest Claude when only shims are on the PATH", () => {
		const latest = '/home/u/.local/share/mise/installs/claude/latest/claude';
		expect(findClaude('/home/u/.local/share/mise/shims', '/home/u', exists(['/home/u/.local/share/mise/shims/claude', latest]))).toBe(latest);
		expect(findClaude('/usr/bin', '/home/u', exists([]))).toBeNull();
	});

	it('lists PATH entries in order, once each', () => {
		expect(onPath('hc', '/a::/b:/a', exists(['/a/hc', '/b/hc']))).toEqual(['/a/hc', '/b/hc']);
	});

	it('reads the version from each tool', () => {
		expect(versionIn('2.1.318 (Claude Code)\n')).toBe('2.1.318');
		expect(versionIn('hc 0.1.18\n')).toBe('0.1.18');
		expect(versionIn('herdr 0.9.5\n')).toBe('0.9.5');
		expect(versionIn('nothing')).toBeNull();
	});
});

describe('typing on hc key by key', () => {
	it('can type everything a narrow hc session types, so its size stays (#172)', () => {
		const texts = NARROW_TEXTS.hc;
		for (const text of [texts.ownAnswer, texts.mango, texts.feedback, texts.planFeedback]) {
			expect(hcTextKeys(text), text).not.toBeNull();
		}
	});
});

describe('the last set', () => {
	it('is the newest claude-<version> folder other than the one being written', () => {
		const names = ['claude-2.1.318', 'claude-2.1.40', 'claude-2.1.400', 'README.md', 'claude-next'];
		expect(latestSet(names, null)).toBe('claude-2.1.400');
		expect(latestSet(names, 'claude-2.1.400')).toBe('claude-2.1.318');
		expect(latestSet(['README.md'], null)).toBeNull();
	});
});

describe('scrubbing', () => {
	const raw = [
		' ▐▛███▛█   Claude Code v2.1.318',
		'▝▜██████▀  Haiku 5.5 · Claude Max · someone@example.com’s Organization',
		' ▝▝   ▝▝   /tmp/oh-test-ask-herdr',
		'…/tmp/x ❯ exec /home/someone/.local/share/mise/installs/claude/latest/claude',
		'Enter to select · ↑/↓ to navigate · ctrl+g to edit in zeditor · Esc to cancel',
	].join('\n');

	it('replaces home, plan and editor as the committed screens show them', () => {
		const scrubbed = scrubScreen(raw, '/home/someone');
		expect(scrubbed.text.split('\n')).toEqual([
			' ▐▛███▛█   Claude Code v2.1.318',
			'▝▜██████▀  Haiku 5.5 · Claude Pro',
			' ▝▝   ▝▝   /tmp/oh-test-ask-herdr',
			'…/tmp/x ❯ exec /home/user/.local/share/mise/installs/claude/latest/claude',
			'Enter to select · ↑/↓ to navigate · ctrl+g to edit in nvim · Esc to cancel',
		]);
		expect(scrubbed.plan).toBe('Claude Max · someone@example.com’s Organization');
		expect(scrubbed.editor).toBe('zeditor');
		expect(namesUser(scrubbed.text, 'someone')).toBe(false);
		expect(namesUser(raw, 'someone')).toBe(true);
	});

	it('finds the editor on the next line when the hint wraps before it, without re-wrapping', () => {
		const wrapped = 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in\nzeditor · Esc to cancel';
		expect(scrubScreen(wrapped, '/home/someone').text).toBe(
			'Enter to select · ↑/↓ to navigate · ctrl+g to edit in\nnvim · Esc to cancel',
		);
	});

	it('scrubs an ANSI read, where colour codes end the span', () => {
		const ansi =
			'\u001b[0m\u001b[38;2;215;119;87m▝▜██████▀  \u001b[0m\u001b[38;2;153;153;153mHaiku 5.5 · Claude Max\u001b[0m\r\n' +
			'   \u001b[0m\u001b[38;2;153;153;153mctrl+g to edit in zeditor · ~/.claude/plans/x.md\u001b[0m';
		const scrubbed = scrubScreen(ansi, '/home/someone');
		expect(scrubbed.text).toBe(
			'\u001b[0m\u001b[38;2;215;119;87m▝▜██████▀  \u001b[0m\u001b[38;2;153;153;153mHaiku 5.5 · Claude Pro\u001b[0m\r\n' +
				'   \u001b[0m\u001b[38;2;153;153;153mctrl+g to edit in nvim · ~/.claude/plans/x.md\u001b[0m',
		);
		expect(scrubbed.plan).toBe('Claude Max');
	});

	it('leaves every committed screen as it is: they are scrubbed already', () => {
		for (const name of readdirSync(DIR).filter((file) => /\.(txt|ansi)$/.test(file))) {
			const text = screen(name);
			expect(scrubScreen(text, '/home/someone').text, name).toBe(text);
		}
	});

	it('saves a text read with one line break at its end', () => {
		expect(fixtureText('a\nb')).toBe('a\nb\n');
		expect(fixtureText('a\n')).toBe('a\n');
	});
});

describe("what Claude leaves in its config folder", () => {
	it('names the transcript folder as Claude does', () => {
		expect(projectDirName('/tmp/oh-test-ask-herdr')).toBe('-tmp-oh-test-ask-herdr');
		expect(projectDirName('/var/tmp/oh-test-trust-narrow-hc/a-nested')).toBe('-var-tmp-oh-test-trust-narrow-hc-a-nested');
	});

	it('reads plan slugs and session ids, and nothing that is not one', () => {
		const transcript = [
			'{"type":"user","slug":"plan-a-one-step-change-tidy-unicorn"}',
			'{"type":"assistant","slug":"plan-a-one-step-change-tidy-unicorn"}',
			'{"type":"user","slug":"../../settings"}',
			'{"type":"user"}',
			'{"type":"user","slug":"half',
		].join('\n');
		expect(slugsIn(transcript)).toEqual(['plan-a-one-step-change-tidy-unicorn']);
		expect(sessionIdOf('086459c3-be63-48e4-8166-01d54368cbce.jsonl')).toBe('086459c3-be63-48e4-8166-01d54368cbce');
		expect(sessionIdOf('memory')).toBeNull();
	});

	it('knows a folder Claude trusts already, or one under it', () => {
		const json = {
			projects: {
				'/tmp': { hasTrustDialogAccepted: true },
				'/var/tmp/oh-test-trust-herdr': { hasTrustDialogAccepted: true },
				'/var/tmp/oh-test-trust-narrow-hc': { hasTrustDialogAccepted: false },
			},
		};
		expect(trustedIn(json, '/tmp/oh-test-ask-herdr')).toBe('/tmp');
		expect(trustedIn(json, '/var/tmp/oh-test-trust-herdr')).toBe('/var/tmp/oh-test-trust-herdr');
		expect(trustedIn(json, '/var/tmp/oh-test-trust-narrow-hc/a-nested')).toBeNull();
		expect(trustedIn({}, '/tmp')).toBeNull();
	});
});

describe('comparing sets', () => {
	it('cuts a screen to its dialog, from the rule that opens it', () => {
		const region = dialogRegion(screen('herdr-ask-single.txt'), parseClaudeScreen);
		expect(region?.[0]).toMatch(/^─+$/);
		expect(region?.[1]).toBe(' ☐ Drink');
		const plan = dialogRegion(screen('herdr-60-plan.txt'), parseClaudeScreen);
		expect(plan?.[1]).toBe('   Ready to code?');
		const afterPlan = dialogRegion(screen('hc-write-after-plan.txt'), parseClaudeScreen);
		expect(afterPlan?.[1]).toBe(' Create file');
		expect(dialogRegion(screen('hc-plan-after-approve-feedback.txt'), parseClaudeScreen)).toBeNull();
	});

	it('diffs lines with context, and says nothing when they agree', () => {
		const a = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
		const b = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
		expect(unifiedDiff(a, b, ['old', 'new'], 1)).toBe(
			['--- old', '+++ new', '@@ -2,3 +2,3 @@', ' two', '-three', '+THREE', ' four', '@@ -8,1 +8,2 @@', ' eight', '+nine', ''].join('\n'),
		);
		expect(unifiedDiff(a, a, ['old', 'new'])).toBe('');
	});

	it('reads the mode from the footer', () => {
		expect(modeOf(screen('hc-plan-after-approve-feedback.txt'))).toBe('auto');
		expect(modeOf('x\n  ⏸ plan mode on (shift+tab to cycle)\n')).toBe('plan');
		expect(modeOf('x\n  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits');
		expect(modeOf('❯ \n  ? for shortcuts')).toBe('default');
	});
});

describe('the scenario', () => {
	const all = sessions();
	const recorded = all.flatMap((session) =>
		session.steps.flatMap((step) => (step.do === 'record' ? [step.name, ...(step.ansi ? [`${step.name}.ansi`] : [])] : [])),
	);

	it('records every committed screen, under the name it has', () => {
		const committed = readdirSync(DIR)
			.filter((file) => /\.(txt|ansi)$/.test(file))
			.map((file) => file.replace(/\.txt$/, '').replace(/-torn$/, ''));
		const names = recorded.map((name) => name.replace(/-torn$/, ''));
		for (const name of committed) expect(names, name).toContain(name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('runs only oh-test-* panes, each in its own throwaway folder', () => {
		for (const session of all) {
			expect(session.name).toMatch(/^oh-test-/);
			expect(session.folder).toMatch(/^\/(?:var\/)?tmp\/oh-test-/);
		}
		expect(new Set(all.map((session) => session.name)).size).toBe(all.length);
		expect(new Set(all.map((session) => session.folder)).size).toBe(all.length);
	});

	it('never chooses option 2 or 3 of a permission, which can write a rule or switch modes', () => {
		for (const session of all) {
			let dialog: string | null = null;
			for (const step of session.steps) {
				if (step.do === 'record') dialog = step.expect;
				if ((step.do === 'answer' || step.do === 'keys') && dialog === 'permission') {
					expect(step.keys, session.name).not.toContain('2');
					expect(step.keys, session.name).not.toContain('3');
				}
			}
		}
	});

	it('never answers a trust prompt', () => {
		for (const session of all.filter((s) => s.trust)) {
			expect(session.steps.every((step) => step.do === 'record' || step.do === 'resize'), session.name).toBe(true);
		}
	});
});
