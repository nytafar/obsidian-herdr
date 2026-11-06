/**
 * The Claude session hook (ADR-0006): the generated script, run for real by
 * `sh` against hook inputs with a fake `hc` on the PATH; the settings merge
 * and unmerge against a file shaped like this machine's (herdr's own
 * `SessionStart` entry, another `SessionStart` hook, `PreToolUse` and
 * friends, unknown keys); the install status; the installer over an
 * in-memory machine and over a fake hc API; and the label parser.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	SESSION_HOOK_FILE,
	SESSION_HOOK_MATCHER,
	SESSION_HOOK_VERSION,
	sessionHookCommand,
	sessionHookEntry,
	sessionHookScript,
	sessionHookScriptVersion,
} from '../src/sessionHook/hookScript';
import {
	addSessionHook,
	installedSessionHookGroups,
	removeSessionHook,
	sessionHookStatus,
} from '../src/sessionHook/claudeSettings';
import {
	applyInstall,
	applyRemove,
	claudePathsFor,
	hcHookMachine,
	inspectSessionHook,
	planInstall,
	planRemove,
	type HookMachine,
} from '../src/sessionHook/installer';
import { parseSessionLabel, SESSION_LABEL_KEY, sessionLabelOf } from '../src/sessionHook/label';
import { HcError } from '../src/hc/connection';

const SCRIPT_PATH = '/home/u/.claude/hooks/obsidian-herdr-session.sh';

/** A settings file shaped like a real one: herdr's entry, other hooks, unknown keys. */
const REAL_SETTINGS = {
	model: 'opus',
	permissions: { allow: ['Bash(ls:*)'], deny: [] },
	hooks: {
		SessionStart: [
			{
				matcher: '^(startup|resume|clear|compact|fork)$',
				hooks: [
					{
						type: 'command',
						command: "bash '/home/u/.claude/hooks/herdr-agent-state.sh' session",
						timeout: 10,
					},
				],
			},
			{
				matcher: 'startup|resume|clear',
				hooks: [
					{
						type: 'command',
						command: 'if command -v repowise-augment >/dev/null 2>&1; then exec repowise-augment; fi',
						timeout: 10,
						statusMessage: 'Loading repowise context...',
					},
				],
			},
		],
		PreToolUse: [
			{
				matcher: 'Write',
				hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/repo-doc-frontmatter.py', timeout: 10 }],
			},
		],
		PostToolUse: [
			{
				matcher: 'Write|Edit|MultiEdit',
				hooks: [{ type: 'command', command: 'python3 /home/u/.claude/hooks/repo-doc-frontmatter.py', timeout: 10 }],
			},
		],
	},
	statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
	unknownFutureKey: { nested: [1, 2, { x: null }] },
};

const realText = (indent: string | number = 2, newline = true): string =>
	JSON.stringify(REAL_SETTINGS, null, indent) + (newline ? '\n' : '');

const entry = sessionHookEntry(SCRIPT_PATH);

function parsed(text: string): typeof REAL_SETTINGS {
	return JSON.parse(text) as typeof REAL_SETTINGS;
}

function edited(result: ReturnType<typeof addSessionHook>): string {
	if (!result.ok) throw new Error(result.reason);
	return result.text;
}

describe('the generated script and entry', () => {
	it('carries the version marker it is checked by', () => {
		expect(sessionHookScriptVersion(sessionHookScript())).toBe(SESSION_HOOK_VERSION);
		expect(sessionHookScriptVersion('#!/bin/sh\necho hi\n')).toBeNull();
		expect(sessionHookScript().startsWith('#!/bin/sh\n')).toBe(true);
	});

	it('is one SessionStart group on herdr matcher, run by sh', () => {
		expect(entry).toEqual({
			matcher: SESSION_HOOK_MATCHER,
			hooks: [{ type: 'command', command: `sh ${SCRIPT_PATH}`, timeout: 10 }],
		});
		expect(SESSION_HOOK_MATCHER).toBe('^(startup|resume|clear|compact|fork)$');
	});

	it('quotes a script path with spaces or quotes for the shell', () => {
		expect(sessionHookCommand("/Users/a b/it's/x.sh")).toBe(`sh '/Users/a b/it'\\''s/x.sh'`);
	});

	it('parses as POSIX sh', () => {
		const result = spawnSync('sh', ['-n'], { input: sessionHookScript() });
		expect(result.status).toBe(0);
	});
});

describe('the script, run by sh', () => {
	let dir = '';
	let script = '';
	let out = '';

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'oh-hook-test-'));
		script = join(dir, SESSION_HOOK_FILE);
		writeFileSync(script, sessionHookScript());
		const bin = join(dir, 'bin');
		execFileSync('mkdir', [bin]);
		writeFileSync(join(bin, 'hc'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_HC_OUT"\necho "would print"\n');
		chmodSync(join(bin, 'hc'), 0o755);
		out = join(dir, 'hc-args');
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Runs the hook; returns hc's argv (null when hc was not called) and the hook's stdout. */
	function run(input: string, env: Record<string, string> = {}): { args: string[] | null; stdout: string } {
		rmSync(out, { force: true });
		const result = spawnSync('sh', [script], {
			input,
			env: {
				PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
				HOME: dir,
				HC_TERMINAL_ID: 't9',
				// No such process: the foreground check cannot tell, which counts as yes.
				CLAUDE_PID: '999999999',
				FAKE_HC_OUT: out,
				...env,
			},
		});
		expect(result.status).toBe(0);
		const args = existsSync(out) ? readFileSync(out, 'utf8').split('\n').slice(0, -1) : null;
		return { args, stdout: result.stdout.toString() };
	}

	const start = (fields: Record<string, unknown>): string =>
		JSON.stringify({
			session_id: '6d53ab6a-5260-44e1-82a1-22b8231df220',
			transcript_path: '/home/u/.claude/projects/-home-u-work/6d53ab6a-5260-44e1-82a1-22b8231df220.jsonl',
			cwd: '/home/u/work',
			hook_event_name: 'SessionStart',
			source: 'startup',
			model: 'claude-opus-5-5',
			...fields,
		});

	function labelOf(args: string[] | null): unknown {
		expect(args).not.toBeNull();
		const [verb, terminal, pair] = args ?? [];
		expect(verb).toBe('label');
		expect(terminal).toBe('t9');
		expect(pair?.startsWith(`${SESSION_LABEL_KEY}=`)).toBe(true);
		return parseSessionLabel(pair?.slice(SESSION_LABEL_KEY.length + 1));
	}

	it('labels the terminal with the session, the pid and the transcript, and prints nothing', () => {
		const { args, stdout } = run(start({}));
		expect(stdout).toBe('');
		expect(labelOf(args)).toEqual({
			sessionId: '6d53ab6a-5260-44e1-82a1-22b8231df220',
			pid: 999999999,
			transcriptPath: '/home/u/.claude/projects/-home-u-work/6d53ab6a-5260-44e1-82a1-22b8231df220.jsonl',
		});
	});

	it('carries quotes, backslashes, spaces and non-ASCII in the path through unchanged', () => {
		const path = '/home/u/a "q" b\\c/æøå/x.jsonl';
		expect(labelOf(run(start({ transcript_path: path })).args)).toMatchObject({ transcriptPath: path });
		// `\/` is a legal escape for `/`.
		const escaped = start({}).replace('"/home/u/.claude/projects', '"\\/home\\/u/.claude/projects');
		const label = labelOf(run(escaped).args) as { transcriptPath: string };
		expect(label.transcriptPath).toBe('/home/u/.claude/projects/-home-u-work/6d53ab6a-5260-44e1-82a1-22b8231df220.jsonl');
	});

	it('refuses a value it would have to guess: a \\u escape or a control character', () => {
		const unicode = start({ transcript_path: '/x/PLACEHOLDER.jsonl' }).replace('PLACEHOLDER', '\\u00e6');
		expect(run(unicode).args).toBeNull();
		expect(run(start({ transcript_path: '/x/a\nb.jsonl' })).args).toBeNull();
	});

	it('reads only top-level fields: a decoy in a string or a nested object is not the session', () => {
		const input =
			'{"cwd":"\\"session_id\\":\\"evil\\"","extra":{"session_id":"evil2","a":[1,{"b":"}"}],"c":"]"},' +
			'"hook_event_name":"SessionStart","session_id":"good","transcript_path":"/t.jsonl","n":-1.5e3,"t":true}';
		expect(labelOf(run(input).args)).toMatchObject({ sessionId: 'good', transcriptPath: '/t.jsonl' });
	});

	it('skips subagents, as herdr does, but not a null or empty agent_id', () => {
		expect(run(start({ agent_id: 'a1b2', agent_type: 'Explore' })).args).toBeNull();
		expect(run(start({ agent_id: { id: 1 } })).args).toBeNull();
		expect(run(start({ agent_id: null })).args).not.toBeNull();
		expect(run(start({ agent_id: '' })).args).not.toBeNull();
	});

	it('does nothing outside an hc terminal, for other events, or on input it cannot read', () => {
		expect(run(start({}), { HC_TERMINAL_ID: '' }).args).toBeNull();
		expect(run(start({ hook_event_name: 'Stop' })).args).toBeNull();
		expect(run(start({ session_id: '' })).args).toBeNull();
		expect(run(start({ transcript_path: 42 })).args).toBeNull();
		expect(run('not json').args).toBeNull();
		expect(run('').args).toBeNull();
		expect(run('{"session_id":"x",').args).toBeNull();
		expect(run('[]').args).toBeNull();
	});

	it('checks $PPID when CLAUDE_PID is missing, and refuses a pid that is not a number', async () => {
		// The parent is a shell in a session of its own, with no terminal, so
		// the check on $PPID skips it even when the tests run in one.
		rmSync(out, { force: true });
		writeFileSync(join(dir, 'in.json'), start({}));
		const parent = spawn('sh', ['-c', `sh ${script} < "$IN"; :`], {
			detached: true,
			stdio: 'ignore',
			env: {
				PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
				HOME: dir,
				HC_TERMINAL_ID: 't9',
				FAKE_HC_OUT: out,
				IN: join(dir, 'in.json'),
			},
		});
		await new Promise((resolve) => parent.on('exit', resolve));
		expect(existsSync(out)).toBe(false);
		expect(run(start({}), { CLAUDE_PID: '12; rm -rf /' }).args).toBeNull();
		expect(run(start({}), { CLAUDE_PID: '-1' }).args).toBeNull();
	});

	it('skips a Claude outside the terminal foreground process group', async () => {
		// A detached child has a session of its own and no terminal: tpgid -1,
		// like a Claude started from another Claude's tool shell.
		const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(run(start({}), { CLAUDE_PID: String(child.pid) }).args).toBeNull();
		} finally {
			child.kill();
		}
	});

	it('finds herdr-core under ~/.local/bin when hc is not on the PATH', () => {
		const home = join(dir, 'home');
		execFileSync('mkdir', ['-p', join(home, '.local', 'bin')]);
		writeFileSync(join(home, '.local', 'bin', 'herdr-core'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_HC_OUT"\n');
		chmodSync(join(home, '.local', 'bin', 'herdr-core'), 0o755);
		expect(labelOf(run(start({}), { PATH: '/usr/bin:/bin', HOME: home }).args)).not.toBeNull();
	});
});

describe('addSessionHook', () => {
	it('appends one group and leaves everything else as it was', () => {
		const after = parsed(edited(addSessionHook(realText(), entry)));
		const { SessionStart, ...otherEvents } = after.hooks;
		expect(SessionStart).toEqual([...REAL_SETTINGS.hooks.SessionStart, entry]);
		const { SessionStart: _, ...originalEvents } = REAL_SETTINGS.hooks;
		expect(otherEvents).toEqual(originalEvents);
		expect({ ...after, hooks: null }).toEqual({ ...REAL_SETTINGS, hooks: null });
		// Key order is kept too, not just the values.
		expect(Object.keys(after)).toEqual(Object.keys(REAL_SETTINGS));
	});

	it('is idempotent', () => {
		const once = edited(addSessionHook(realText(), entry));
		const twice = addSessionHook(once, entry);
		expect(twice).toEqual({ ok: true, text: once, changed: false });
	});

	it('keeps the file indentation and its final newline, or the lack of one', () => {
		const tabs = edited(addSessionHook(realText('\t'), entry));
		expect(tabs).toBe(JSON.stringify(parsed(tabs), null, '\t') + '\n');
		const four = edited(addSessionHook(realText(4, false), entry));
		expect(four).toBe(JSON.stringify(parsed(four), null, 4));
	});

	it('replaces an outdated group of ours where it stands', () => {
		const old = structuredClone(REAL_SETTINGS);
		old.hooks.SessionStart.splice(1, 0, {
			matcher: 'startup',
			hooks: [{ type: 'command', command: `sh '/old/hooks/${SESSION_HOOK_FILE}'`, timeout: 5 }],
		});
		const after = parsed(edited(addSessionHook(JSON.stringify(old, null, 2), entry)));
		expect(after.hooks.SessionStart).toEqual([
			REAL_SETTINGS.hooks.SessionStart[0],
			entry,
			REAL_SETTINGS.hooks.SessionStart[1],
		]);
	});

	it('takes a stray hook of ours out of someone else group, and leaves their hooks', () => {
		const mixed = structuredClone(REAL_SETTINGS);
		const herdr = mixed.hooks.SessionStart[0] as { hooks: unknown[] };
		herdr.hooks.push({ type: 'command', command: `sh ${SCRIPT_PATH}`, timeout: 10 });
		const after = parsed(edited(addSessionHook(JSON.stringify(mixed), entry)));
		expect(after.hooks.SessionStart).toEqual([...REAL_SETTINGS.hooks.SessionStart, entry]);
	});

	it('creates the settings from nothing: a missing or blank file', () => {
		const expected = JSON.stringify({ hooks: { SessionStart: [entry] } }, null, 2) + '\n';
		expect(edited(addSessionHook(null, entry))).toBe(expected);
		expect(edited(addSessionHook(' \n', entry))).toBe(expected);
		expect(parsed(edited(addSessionHook('{"model":"x"}', entry)))).toEqual({ model: 'x', hooks: { SessionStart: [entry] } });
	});

	it('refuses a file it cannot read safely instead of overwriting it', () => {
		for (const text of ['{"hooks": {', '[]', '"x"', '{"hooks": []}', '{"hooks": {"SessionStart": {}}}']) {
			const result = addSessionHook(text, entry);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/^The Claude settings were left alone: /);
		}
	});
});

describe('the rewrite of the settings file', () => {
	const big = '{"env": {"BIG": 12345678901234567890}, "hooks": {}}';

	it('refuses, in install and in remove, a number the rewrite could not keep exactly', () => {
		for (const number of ['12345678901234567890', '9007199254740993', '1e400', '0.12345678901234567890123', '-1e-400']) {
			const text = `{"env": {"N": ${number}}}`;
			const result = addSessionHook(text, entry);
			expect(result.ok, number).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(new RegExp(`left alone: .*${number.replace(/[.+-]/g, '\\$&')}.*env\\.N`));
		}
		const installed = edited(addSessionHook('{"env": {"N": 1}}', entry)).replace('"N": 1', '"N": 12345678901234567890');
		const removal = removeSessionHook(installed);
		expect(removal.ok).toBe(false);
		if (!removal.ok) expect(removal.reason).toMatch(/12345678901234567890/);
		expect(addSessionHook(big, entry).ok).toBe(false);
	});

	it('refuses a key that appears twice, which the rewrite would drop', () => {
		const result = addSessionHook('{"model": "a", "env": {"X": "1", "X": "2"}}', entry);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/"X" appears twice in env/);
		expect(addSessionHook('{"model": "a", "model": "b"}', entry).ok).toBe(false);
	});

	it('takes numbers it keeps exactly, whatever their spelling, and the same key in different objects', () => {
		const text = '{"a": 1.0, "b": 1e2, "c": -0, "d": 0.1, "e": 9007199254740991, "f": 1.5E-7, "x": {"a": 1}, "l": [{"a": 1}, {"a": 2}]}';
		const after = parsed(edited(addSessionHook(text, entry))) as unknown as Record<string, unknown>;
		expect(after).toMatchObject({ a: 1, b: 100, d: 0.1, e: 9007199254740991, f: 1.5e-7, x: { a: 1 } });
	});

	it('rewrites the formatting, as Claude does, but keeps every value', () => {
		const text = '{"env":{"2":"two","a":"x"},"permissions":{"allow":["Bash(ls:*)","Read"]},"hooks":{}}';
		const after = edited(addSessionHook(text, entry));
		expect(JSON.parse(after)).toEqual({ ...(JSON.parse(text) as object), hooks: { SessionStart: [entry] } });
	});

	it('keeps CRLF line endings', () => {
		const text = realText().replace(/\n/g, '\r\n');
		const after = edited(addSessionHook(text, entry));
		expect(after.match(/\r\n/g)?.length).toBe(after.match(/\n/g)?.length);
		expect(after.endsWith('\r\n')).toBe(true);
		expect(removeSessionHook(after)).toEqual({ ok: true, text, changed: true });
		expect(edited(addSessionHook('{\n  "a": 1\n}\n', entry))).not.toMatch(/\r/);
	});
});

describe('removeSessionHook', () => {
	it('gives back a file in standard formatting as it was before install, byte for byte', () => {
		for (const text of [realText(), realText('\t'), realText(4, false)]) {
			const installed = edited(addSessionHook(text, entry));
			expect(removeSessionHook(installed)).toEqual({ ok: true, text, changed: true });
		}
	});

	it('removes only ours: herdr and every other hook stay', () => {
		const installed = edited(addSessionHook(realText(), entry));
		const after = parsed(edited(removeSessionHook(installed)));
		expect(after).toEqual(REAL_SETTINGS);
		expect(installedSessionHookGroups(installed)).toEqual([entry]);
		expect(installedSessionHookGroups(realText())).toEqual([]);
	});

	it('keeps the other hooks of a group it shares with ours', () => {
		const mixed = structuredClone(REAL_SETTINGS);
		const herdr = mixed.hooks.SessionStart[0] as { hooks: unknown[] };
		herdr.hooks.push({ type: 'command', command: `sh ${SCRIPT_PATH}`, timeout: 10 });
		const after = parsed(edited(removeSessionHook(JSON.stringify(mixed, null, 2))));
		expect(after).toEqual(REAL_SETTINGS);
	});

	it('drops the list and the object it leaves empty, and only those', () => {
		const created = edited(addSessionHook(null, entry));
		expect(edited(removeSessionHook(created))).toBe('{}\n');
		const withOther = edited(addSessionHook('{"hooks":{"Stop":[]}}', entry));
		expect(parsed(edited(removeSessionHook(withOther)))).toEqual({ hooks: { Stop: [] } });
	});

	it('has nothing to do without our entry or without a file', () => {
		expect(removeSessionHook(realText())).toEqual({ ok: true, text: realText(), changed: false });
		expect(removeSessionHook(null)).toEqual({ ok: true, text: '', changed: false });
	});

	it('refuses a file it cannot read', () => {
		expect(removeSessionHook('{nope').ok).toBe(false);
		expect(removeSessionHook('{"hooks":{"SessionStart":"x"}}').ok).toBe(false);
	});
});

describe('sessionHookStatus', () => {
	const script = sessionHookScript();
	const installed = edited(addSessionHook(realText(), entry));

	it('reads absent, with a leftover script noted', () => {
		expect(sessionHookStatus(realText(), null, SCRIPT_PATH)).toMatchObject({ state: 'absent', detail: 'Not installed.' });
		expect(sessionHookStatus(null, null, SCRIPT_PATH).state).toBe('absent');
		expect(sessionHookStatus(realText(), script, SCRIPT_PATH).detail).toMatch(/script is still on disk/);
	});

	it('reads installed for our exact entry and script', () => {
		expect(sessionHookStatus(installed, script, SCRIPT_PATH)).toEqual({
			state: 'installed',
			detail: `Installed (version ${SESSION_HOOK_VERSION}).`,
			scriptVersion: SESSION_HOOK_VERSION,
		});
	});

	it('reads outdated by the version marker, and for anything else of ours that differs', () => {
		const older = script.replace(`=${SESSION_HOOK_VERSION}\n`, `=0\n`);
		expect(sessionHookStatus(installed, older, SCRIPT_PATH)).toMatchObject({ state: 'outdated', scriptVersion: 0 });
		expect(sessionHookStatus(installed, null, SCRIPT_PATH).detail).toMatch(/script is missing/);
		expect(sessionHookStatus(installed, '#!/bin/sh\n', SCRIPT_PATH).detail).toMatch(/no version marker/);
		expect(sessionHookStatus(installed, `${script}# mine\n`, SCRIPT_PATH).detail).toMatch(/changed after/);
		expect(sessionHookStatus(installed, script, '/elsewhere/obsidian-herdr-session.sh').detail).toMatch(/entry differs/);
	});

	it('reads a newer version as installed, and says so', () => {
		const newer = script.replace(`=${SESSION_HOOK_VERSION}\n`, `=${SESSION_HOOK_VERSION + 1}\n`);
		expect(sessionHookStatus(installed, newer, SCRIPT_PATH).detail).toMatch(/newer version/);
	});

	it('reads unreadable settings as such, not as absent', () => {
		expect(sessionHookStatus('{', null, SCRIPT_PATH).state).toBe('unreadable');
	});
});

describe('claudePathsFor', () => {
	it('uses ~/.claude without CLAUDE_CONFIG_DIR', () => {
		expect(claudePathsFor('/home/u', '')).toEqual({
			configDir: '/home/u/.claude',
			settingsPath: '/home/u/.claude/settings.json',
			scriptPath: `/home/u/.claude/hooks/${SESSION_HOOK_FILE}`,
			fromEnv: false,
		});
	});

	it('respects CLAUDE_CONFIG_DIR, trailing slashes and a leading ~/', () => {
		expect(claudePathsFor('/home/u', '/srv/claude-b/').settingsPath).toBe('/srv/claude-b/settings.json');
		expect(claudePathsFor('/home/u', '~/alt').configDir).toBe('/home/u/alt');
		expect(claudePathsFor('/home/u', '/x').fromEnv).toBe(true);
	});

	it('refuses a relative CLAUDE_CONFIG_DIR or a home it cannot use', () => {
		expect(() => claudePathsFor('/home/u', 'rel/dir')).toThrow(/not an absolute path/);
		expect(() => claudePathsFor('', '')).toThrow(/home directory/);
	});
});

/** An in-memory machine that records every write and delete. */
function memoryMachine(files: Record<string, string>, env = { home: '/home/u', claudeConfigDir: '' }) {
	const ops: string[] = [];
	const machine: HookMachine = {
		environment: () => Promise.resolve(env),
		read: (path) => Promise.resolve(path in files ? (files[path] ?? null) : null),
		write: (path, text) => {
			ops.push(`write ${path}`);
			files[path] = text;
			return Promise.resolve();
		},
		remove: (path) => {
			ops.push(`remove ${path}`);
			delete files[path];
			return Promise.resolve();
		},
	};
	return { machine, files, ops };
}

describe('the installer', () => {
	const settingsPath = '/home/u/.claude/settings.json';

	it('installs script first, then the entry; a second install writes nothing', async () => {
		const { machine, files, ops } = memoryMachine({ [settingsPath]: realText() });
		const plan = planInstall(await inspectSessionHook(machine));
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.createsSettings).toBe(false);
		await applyInstall(machine, plan);
		expect(ops).toEqual([`write ${SCRIPT_PATH}`, `write ${settingsPath}`]);
		expect(files[SCRIPT_PATH]).toBe(sessionHookScript());
		const again = await inspectSessionHook(machine);
		expect(again.status.state).toBe('installed');
		const replan = planInstall(again);
		if (!replan.ok) throw new Error(replan.reason);
		await applyInstall(machine, replan);
		expect(ops).toHaveLength(2);
	});

	it('removes the entry first, then its script, and gives the file back', async () => {
		const { machine, files, ops } = memoryMachine({ [settingsPath]: realText() });
		const install = planInstall(await inspectSessionHook(machine));
		if (!install.ok) throw new Error(install.reason);
		await applyInstall(machine, install);
		ops.length = 0;
		const remove = planRemove(await inspectSessionHook(machine));
		if (!remove.ok) throw new Error(remove.reason);
		expect(remove.entries).toEqual([entry]);
		await applyRemove(machine, remove);
		expect(ops).toEqual([`write ${settingsPath}`, `remove ${SCRIPT_PATH}`]);
		expect(files[settingsPath]).toBe(realText());
		expect((await inspectSessionHook(machine)).status.state).toBe('absent');
	});

	it('does not delete a file at the script path that is not ours', async () => {
		const { machine } = memoryMachine({ [settingsPath]: realText(), [SCRIPT_PATH]: '#!/bin/sh\n# mine\n' });
		const plan = planRemove(await inspectSessionHook(machine));
		expect(plan).toMatchObject({ ok: false, reason: 'There is nothing of the hook to remove.' });
	});

	it('refuses to write when a file changed after it was shown', async () => {
		const { machine, files, ops } = memoryMachine({ [settingsPath]: realText() });
		const plan = planInstall(await inspectSessionHook(machine));
		if (!plan.ok) throw new Error(plan.reason);
		files[settingsPath] = realText(4);
		await expect(applyInstall(machine, plan)).rejects.toThrow(/changed since it was shown/);
		expect(ops).toEqual([]);
	});

	it('refuses to remove when the settings changed after they were shown', async () => {
		const { machine, files, ops } = memoryMachine({ [settingsPath]: realText() });
		const install = planInstall(await inspectSessionHook(machine));
		if (!install.ok) throw new Error(install.reason);
		await applyInstall(machine, install);
		ops.length = 0;
		const plan = planRemove(await inspectSessionHook(machine));
		if (!plan.ok) throw new Error(plan.reason);
		files[settingsPath] = (files[settingsPath] ?? '').replace('"opus"', '"sonnet"');
		await expect(applyRemove(machine, plan)).rejects.toThrow(/settings\.json changed since it was shown/);
		expect(ops).toEqual([]);
		expect(files[settingsPath]).toMatch(/"sonnet"/);
	});

	it('refuses to remove when the script changed after it was shown', async () => {
		const { machine, files, ops } = memoryMachine({ [settingsPath]: realText() });
		const install = planInstall(await inspectSessionHook(machine));
		if (!install.ok) throw new Error(install.reason);
		await applyInstall(machine, install);
		ops.length = 0;
		const plan = planRemove(await inspectSessionHook(machine));
		if (!plan.ok) throw new Error(plan.reason);
		files[SCRIPT_PATH] = `${files[SCRIPT_PATH] ?? ''}# edited by hand\n`;
		await expect(applyRemove(machine, plan)).rejects.toThrow(/obsidian-herdr-session\.sh changed since it was shown/);
		expect(ops).toEqual([]);
	});

	it('refuses to plan over unreadable settings, and writes nothing', async () => {
		const { machine, ops } = memoryMachine({ [settingsPath]: '{"hooks": [' });
		const plan = planInstall(await inspectSessionHook(machine));
		expect(plan.ok).toBe(false);
		expect(ops).toEqual([]);
	});

	it('creates the settings file when Claude has none yet', async () => {
		const { machine, files } = memoryMachine({}, { home: '/home/u', claudeConfigDir: '/tmp/cfg' });
		const plan = planInstall(await inspectSessionHook(machine));
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.createsSettings).toBe(true);
		expect(plan.snapshot.paths.scriptPath).toBe(`/tmp/cfg/hooks/${SESSION_HOOK_FILE}`);
		await applyInstall(machine, plan);
		expect(JSON.parse(files['/tmp/cfg/settings.json'] ?? '')).toEqual({
			hooks: { SessionStart: [sessionHookEntry(`/tmp/cfg/hooks/${SESSION_HOOK_FILE}`)] },
		});
	});
});

describe('hcHookMachine', () => {
	function fakeRequest(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
		const calls: [string, Record<string, unknown>][] = [];
		const request = <T,>(method: string, params: unknown): Promise<T> => {
			calls.push([method, params as Record<string, unknown>]);
			try {
				return Promise.resolve(handlers[method]?.(params as Record<string, unknown>) as T);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
		};
		return { request, calls };
	}
	const b64 = (text: string): string => Buffer.from(text).toString('base64');

	it('reads the environment through machine.exec', async () => {
		const { request, calls } = fakeRequest({
			'machine.exec': () => ({ code: 0, stdout: b64('/home/u\n/srv/c\n'), stderr: '' }),
		});
		await expect(hcHookMachine(request).environment()).resolves.toEqual({ home: '/home/u', claudeConfigDir: '/srv/c' });
		expect(calls[0]?.[1].argv).toEqual(['sh', '-c', 'printf "%s\\n%s\\n" "$HOME" "${CLAUDE_CONFIG_DIR:-}"']);
	});

	it('reads a missing file as null and passes other errors on', async () => {
		const missing = fakeRequest({
			'file.read': () => {
				throw new HcError('file.read', { code: -32000, message: 'no file /x', data: { kind: 'not_found' } });
			},
		});
		await expect(hcHookMachine(missing.request).read('/x')).resolves.toBeNull();
		const binary = fakeRequest({
			'file.read': () => {
				throw new HcError('file.read', { code: -32000, message: '/x is not UTF-8 text', data: { kind: 'not_text' } });
			},
		});
		await expect(hcHookMachine(binary.request).read('/x')).rejects.toThrow(/not UTF-8/);
	});

	it('writes base64 through file.write and deletes through rm', async () => {
		const { request, calls } = fakeRequest({
			'file.write': () => ({ path: '/x', bytes: 3 }),
			'machine.exec': () => ({ code: 0, stdout: '', stderr: '' }),
		});
		const machine = hcHookMachine(request);
		await machine.write('/x', 'æ\n');
		await machine.remove('/x');
		expect(calls).toEqual([
			['file.write', { path: '/x', data: b64('æ\n') }],
			['machine.exec', { argv: ['rm', '-f', '--', '/x'], timeout: 15 }],
		]);
	});
});

describe('parseSessionLabel', () => {
	const good = { v: 1, session: 's-1', pid: 4242, transcript: '/home/u/.claude/projects/p/s-1.jsonl' };

	it('reads the label the hook writes', () => {
		expect(parseSessionLabel(JSON.stringify(good))).toEqual({
			sessionId: 's-1',
			pid: 4242,
			transcriptPath: '/home/u/.claude/projects/p/s-1.jsonl',
		});
	});

	it('ignores unknown fields and reads a later version the same way', () => {
		expect(parseSessionLabel(JSON.stringify({ ...good, v: 2, source: 'clear' }))).toMatchObject({ sessionId: 's-1' });
	});

	it('returns null for anything else', () => {
		const bad: unknown[] = [
			undefined,
			'',
			'nope',
			'[]',
			'null',
			JSON.stringify({ ...good, v: undefined }),
			JSON.stringify({ ...good, v: 0 }),
			JSON.stringify({ ...good, session: '' }),
			JSON.stringify({ ...good, session: 'a\nb' }),
			JSON.stringify({ ...good, pid: '4242' }),
			JSON.stringify({ ...good, pid: 0 }),
			JSON.stringify({ ...good, pid: 1.5 }),
			JSON.stringify({ ...good, transcript: 'relative/s.jsonl' }),
			JSON.stringify({ ...good, transcript: undefined }),
			42,
		];
		for (const value of bad) expect(parseSessionLabel(value)).toBeNull();
	});

	it('finds it among a terminal labels', () => {
		expect(sessionLabelOf({ 'herdr.space': 'x', [SESSION_LABEL_KEY]: JSON.stringify(good) })).toMatchObject({ pid: 4242 });
		expect(sessionLabelOf({ 'herdr.space': 'x' })).toBeNull();
		expect(sessionLabelOf(null)).toBeNull();
	});
});
