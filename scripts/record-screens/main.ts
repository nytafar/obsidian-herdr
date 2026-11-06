/**
 * Re-records Claude Code's dialog screens on herdr and herdr-core, and diffs
 * them against the last recorded set (issue #168). Run it as
 *
 *     npm run record-screens [-- options]
 *
 * which bundles this file with esbuild (`scripts/record-screens.mjs`) and
 * runs it under node. `--help` lists the options.
 *
 * It drives throwaway `oh-test-*` herdr tabs and hc terminals through the
 * scenario in `./scenario.ts`, with the plugin's own screen access
 * (`herdrScreenAccess`, `hcScreenAccess`), prompt senders and clients, and
 * reads each screen with the plugin's parser to know when a dialog is up.
 * When the parser cannot read a new Claude's dialog, a screen is still saved
 * once Claude says it is blocked and the screen holds still.
 *
 * Whatever happens, it closes every tab and terminal it opened, removes the
 * folders it made, and removes what its Claude sessions wrote under the
 * Claude config folder: their transcripts (and the transcript folder when
 * the run made it), their plan files, `file-history/<id>` and
 * `session-env/<id>`. It never stops or restarts herdr or hc, never touches
 * `settings.json`, and never answers a permission with anything that writes
 * a rule. Two shared files are left as Claude leaves them, because other
 * sessions write them at the same time: `~/.claude.json` (an entry per
 * folder) and `~/.claude/history.jsonl` (the prompts).
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { parseClaudeScreen } from '../../src/agents/claude/screenDialog';
import { joinWrapped, type ScreenDialog } from '../../src/agents/screenDialog';
import { TerminalSession } from '../../src/bridge/terminalSession';
import { hcPromptSender, hcScreenAccess } from '../../src/hc/actions';
import { HcClient, shellQuote } from '../../src/hc/client';
import { parseTerminal } from '../../src/hc/model';
import { HerdrClient } from '../../src/herdr/client';
import { DEFAULT_HERDR_SOCKET } from '../../src/runtimes';
import { clearTimer, setTimer } from '../../src/timers';
import { clientPromptSender } from '../../src/native/promptSender';
import type { ScreenKey } from '../../src/native/screenAccess';
import { herdrScreenAccess } from '../../src/native/screenAccess';
import { CLAUDE_ARGS, sessions, type Session, type Size, type Step } from './scenario';
import {
	dialogRegion,
	findClaude,
	fixtureText,
	HC_HEADLESS,
	hcTypingKeys,
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
} from './support';

const ROOT = resolve(process.env.RECORD_SCREENS_ROOT ?? process.cwd());
const SCREENS = join(ROOT, 'tests', 'fixtures', 'screens');

// --- Options ----------------------------------------------------------------

interface Options {
	out: string | null;
	against: string | null;
	only: RegExp | null;
	claude: string | null;
	full: boolean;
	dryRun: boolean;
	socket: string;
}

const HELP = `Usage: npm run record-screens [-- options]

Re-records Claude's dialog screens on herdr and hc into
tests/fixtures/screens/claude-<version>/ and diffs them against the last set.

  --out <dir>        write the screens here instead (must not exist)
  --against <dir>    compare with this set instead of the newest claude-* one
  --only <regex>     run only the sessions whose name matches (oh-test-…)
  --claude <path>    Claude Code's binary (default: the first on PATH that is
                     not a mise shim, else mise's installs/claude/latest)
  --herdr-socket <p> herdr's API socket (default ${DEFAULT_HERDR_SOCKET})
  --full             diff whole screens, not only the dialog under its rule
  --dry-run          check everything and print the sessions, run nothing
`;

function parseOptions(argv: string[]): Options {
	const options: Options = { out: null, against: null, only: null, claude: null, full: false, dryRun: false, socket: DEFAULT_HERDR_SOCKET };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (): string => {
			const next = argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		switch (arg) {
			case '--out': options.out = resolve(value()); break;
			case '--against': options.against = resolve(value()); break;
			case '--only': options.only = new RegExp(value()); break;
			case '--claude': options.claude = resolve(value()); break;
			case '--herdr-socket': options.socket = value(); break;
			case '--full': options.full = true; break;
			case '--dry-run': options.dryRun = true; break;
			case '--help': case '-h': process.stdout.write(HELP); process.exit(0); break;
			default: throw new Error(`unknown option ${arg}; --help lists them`);
		}
	}
	return options;
}

// --- Small things -----------------------------------------------------------

const abort = new AbortController();

function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((done, fail) => {
		if (abort.signal.aborted) {
			fail(new Error('interrupted'));
			return;
		}
		const timer = setTimer(() => {
			abort.signal.removeEventListener('abort', onAbort);
			done();
		}, ms);
		const onAbort = (): void => {
			clearTimer(timer);
			fail(new Error('interrupted'));
		};
		abort.signal.addEventListener('abort', onAbort, { once: true });
	});
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function versionOf(binary: string): string {
	const output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 });
	const version = versionIn(output);
	if (!version) throw new Error(`${binary} --version said "${output.trim()}"`);
	return version;
}

const parse = (screen: string): ScreenDialog => parseClaudeScreen(screen);

// --- One pane, either runtime -----------------------------------------------

interface Pane {
	readonly session: Session;
	read(): Promise<string>;
	readAnsi(): Promise<string | null>;
	press(key: ScreenKey): Promise<void>;
	type(text: string): Promise<void>;
	prompt(text: string): Promise<void>;
	/** Claude's status as the runtime reports it: `idle`, `working`, `blocked`, `done`, or null. */
	status(): Promise<string | null>;
	resize(size: Size): Promise<void>;
	close(): Promise<void>;
	/** Whether the runtime still has it, after `close`. */
	gone(): Promise<boolean>;
}

interface Tools {
	claude: string;
	herdr: string;
	hc: string;
}

async function openHerdrPane(client: HerdrClient, tools: Tools, session: Session, opened: Pane[]): Promise<Pane> {
	const screen = herdrScreenAccess(() => client);
	const sender = clientPromptSender(() => client);
	const created = await client.request<{ root_pane?: { pane_id?: string } | null }>('tab.create', {
		cwd: session.folder,
		label: session.name,
		focus: false,
	});
	const paneId = created.root_pane?.pane_id;
	if (!paneId) throw new Error('herdr created the tab without a pane');
	// The pane is held at the session's size by a control client, as the
	// narrow screens were (#163); it is the only thing that sets the grid.
	let control: TerminalSession | null = new TerminalSession({
		command: [tools.herdr],
		target: paneId,
		mode: 'control',
		cols: session.size.cols,
		rows: session.size.rows,
	});
	control.on('error', (error) => log(`  herdr control client: ${error.message}`));
	control.start();
	const pane: Pane = {
		session,
		read: () => screen.read(paneId),
		async readAnsi() {
			const result = await client.request<{ read?: { text?: unknown } }>('pane.read', {
				pane_id: paneId,
				source: 'visible',
				format: 'ansi',
			});
			return typeof result.read?.text === 'string' ? result.read.text : null;
		},
		press: (key) => screen.press(paneId, key),
		type: (text) => screen.type(paneId, text),
		prompt: (text) => sender.send(paneId, text),
		async status() {
			const result = await client.request<{ pane?: { agent_status?: string; agent?: string | null } }>('pane.get', {
				pane_id: paneId,
			});
			return result.pane?.agent ? (result.pane.agent_status ?? null) : null;
		},
		async resize(size) {
			if (!control?.resize(size.cols, size.rows)) throw new Error('the herdr control client is gone');
			await sleep(1000);
		},
		async close() {
			const holding = control;
			control = null;
			if (holding) await holding.dispose().catch(() => undefined);
			try {
				await client.request('pane.close', { pane_id: paneId });
			} catch (error) {
				if (!(await pane.gone())) throw error;
			}
		},
		async gone() {
			try {
				await client.request('pane.get', { pane_id: paneId });
				return false;
			} catch {
				return true;
			}
		},
	};
	opened.push(pane);

	// Start Claude by its path from the pane's own shell once it has a prompt.
	const shellDeadline = Date.now() + 20_000;
	while ((await pane.read()).trim() === '') {
		if (Date.now() > shellDeadline) throw new Error('the herdr pane never showed a shell prompt');
		await sleep(250);
	}
	await sleep(500);
	const line = ['exec', shellQuote(tools.claude), ...CLAUDE_ARGS.map(shellQuote)].join(' ');
	await client.request('pane.send_text', { pane_id: paneId, text: line });
	await client.request('pane.send_keys', { pane_id: paneId, keys: ['Enter'] });
	const agentDeadline = Date.now() + 30_000;
	for (;;) {
		const result = await client.request<{ pane?: { agent?: string | null } }>('pane.get', { pane_id: paneId });
		if (result.pane?.agent) break;
		if (Date.now() > agentDeadline) throw new Error('herdr never detected Claude in the pane');
		await sleep(250);
	}
	return pane;
}

async function openHcTerminal(client: HcClient, tools: Tools, session: Session, opened: Pane[]): Promise<Pane> {
	const screen = hcScreenAccess(() => client);
	const sender = hcPromptSender(() => client);
	const result = await client.request<unknown>('terminal.run', {
		argv: [tools.claude, ...CLAUDE_ARGS],
		cwd: session.folder,
		name: session.name,
		size: session.size,
	});
	const address = parseTerminal(result)?.address;
	if (!address) throw new Error('hc started the terminal without an address');
	// The plugin's typing attach leaves a terminal at hc's headless size when
	// it detaches (`hcTypingKeys`), so one held at another size is typed
	// into key by key.
	const headless = session.size.cols === HC_HEADLESS.cols && session.size.rows === HC_HEADLESS.rows;
	const pane: Pane = {
		session,
		read: () => screen.read(address),
		readAnsi: () => Promise.resolve(null),
		press: (key) => screen.press(address, key),
		async type(text) {
			if (headless) return screen.type(address, text);
			await client.request('terminal.keys', { terminal: address, keys: hcTypingKeys(text) });
		},
		prompt: (text) => sender.send(address, text),
		async status() {
			return parseTerminal(await client.request<unknown>('terminal.get', { terminal: address }))?.status?.state ?? null;
		},
		resize() {
			return Promise.reject(new Error('an hc session keeps the size it was started at'));
		},
		async close() {
			try {
				await client.request('terminal.kill', { terminal: address });
			} catch {
				// Finished already, or gone: the remove below says which.
			}
			const deadline = Date.now() + 5000;
			for (;;) {
				try {
					await client.request('terminal.rm', { terminal: address });
					return;
				} catch (error) {
					if (await pane.gone()) return;
					if (Date.now() > deadline) throw error;
					await new Promise<void>((done) => setTimer(done, 200));
				}
			}
		},
		async gone() {
			try {
				await client.request('terminal.get', { terminal: address });
				return false;
			} catch {
				return true;
			}
		},
	};
	opened.push(pane);
	return pane;
}

// --- Waiting on the screen --------------------------------------------------

/** The screen once two reads 300 ms apart agree, or the last read after `ms`. */
async function steady(pane: Pane, ms = 5000): Promise<string> {
	const deadline = Date.now() + ms;
	let last = await pane.read();
	for (;;) {
		await sleep(300);
		const next = await pane.read();
		if (next === last || Date.now() > deadline) return next;
		last = next;
	}
}

/** Waits for the screen to differ from `before`, then for it to hold still. */
async function changed(pane: Pane, before: string, what: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while ((await pane.read()) === before) {
		if (Date.now() > deadline) {
			log(`  note: the screen did not change after ${what}`);
			return;
		}
		await sleep(100);
	}
	await steady(pane);
}

async function press(pane: Pane, keys: readonly ScreenKey[]): Promise<void> {
	for (const key of keys) {
		const before = await pane.read();
		await pane.press(key);
		await changed(pane, before, `"${key}"`);
	}
}

/**
 * Waits until Claude is idle with no dialog. A dialog that follows the
 * answer (Claude asking again after a denial) is cancelled with `esc` once it
 * has stood for 8 s. A trust prompt is never answered: the run stops.
 */
async function settle(pane: Pane): Promise<void> {
	const deadline = Date.now() + 240_000;
	let blockedSince: number | null = null;
	let cancelled = 0;
	for (;;) {
		const screen = await pane.read();
		const kind = parse(screen).kind;
		if (kind === 'trust') {
			throw new Error(`Claude asks whether to trust ${pane.session.folder}; the run never answers that`);
		}
		const status = await pane.status();
		if (status === 'blocked' || kind !== 'unknown') {
			blockedSince ??= Date.now();
			if (Date.now() - blockedSince > 8000 && cancelled < 4) {
				log(`  cancelling a ${kind === 'unknown' ? 'dialog' : kind} that followed`);
				await pane.press('esc');
				cancelled++;
				blockedSince = null;
			}
		} else {
			blockedSince = null;
			if (status === 'idle' || status === 'done') {
				await sleep(800);
				const again = await pane.status();
				if ((again === 'idle' || again === 'done') && parse(await pane.read()).kind === 'unknown') return;
			}
		}
		if (Date.now() > deadline) throw new Error(`Claude did not go idle (status ${status ?? 'none'})`);
		await sleep(300);
	}
}

/**
 * Waits until a dialog is up: the parser reads one, or, for a dialog it
 * cannot read, Claude says it is blocked; then until the screen holds still.
 */
async function dialogUp(pane: Pane): Promise<void> {
	const deadline = Date.now() + 240_000;
	for (;;) {
		if (parse(await pane.read()).kind !== 'unknown' || (await pane.status()) === 'blocked') {
			await steady(pane);
			return;
		}
		if (Date.now() > deadline) throw new Error('no dialog came up after the prompt');
		await sleep(250);
	}
}

/** Cycles `shift+tab` until the footer shows `mode`. */
async function setMode(pane: Pane, mode: 'plan' | 'default'): Promise<void> {
	await settle(pane);
	for (let i = 0; i < 6; i++) {
		const screen = await steady(pane);
		if (modeOf(screen) === mode) return;
		await press(pane, ['shift+tab']);
	}
	throw new Error(`the footer never showed ${mode} mode`);
}

// --- Recording --------------------------------------------------------------

/** What scrubbing found across the run, reported at the end. */
interface Recorded {
	plans: Set<string>;
	editors: Set<string>;
	leaks: string[];
}

function save(out: string, name: string, extension: 'txt' | 'ansi', screen: string, recorded: Recorded): void {
	const scrubbed = scrubScreen(screen, homedir());
	if (scrubbed.plan) recorded.plans.add(scrubbed.plan);
	if (scrubbed.editor) recorded.editors.add(scrubbed.editor);
	const file = `${name}.${extension}`;
	if (namesUser(scrubbed.text, userInfo().username)) recorded.leaks.push(file);
	writeFileSync(join(out, file), extension === 'txt' ? fixtureText(scrubbed.text) : scrubbed.text);
}

async function record(pane: Pane, step: Extract<Step, { do: 'record' }>, out: string, recorded: Recorded): Promise<string[]> {
	const started = Date.now();
	// A torn repaint never reads as the dialog, and herdr may not call it
	// blocked either: it is saved once it holds still, whatever the status.
	const softAfter = step.torn ? 3000 : 20_000;
	const deadline = started + 180_000;
	let screen: string | null = null;
	let fallback = false;
	while (screen === null) {
		const read = await pane.read();
		if (step.until !== undefined) {
			if (read.includes(step.until)) screen = await steady(pane, 3000);
		} else if (step.expect && parse(read).kind === step.expect) {
			await sleep(300);
			if ((await pane.read()) === read) screen = read;
		} else if (Date.now() - started > softAfter) {
			const status = await pane.status();
			if (status === 'blocked' || pane.session.trust || step.torn) {
				const still = await steady(pane, 3000);
				await sleep(2000);
				if ((await pane.read()) === still) {
					screen = still;
					fallback = true;
				}
			}
		}
		if (screen === null) {
			if (Date.now() > deadline) throw new Error(`no ${step.expect ?? `"${step.until}"`} screen for ${step.name}`);
			await sleep(250);
		}
	}
	const kind = parse(screen).kind;
	const name = step.torn && kind !== step.expect ? `${step.name}-torn` : step.name;
	save(out, name, 'txt', screen, recorded);
	const files = [`${name}.txt`];
	if (step.ansi) {
		const ansi = await pane.readAnsi();
		if (ansi !== null) {
			save(out, name, 'ansi', ansi, recorded);
			files.push(`${name}.ansi`);
		}
	}
	const note = fallback && !step.torn ? ` (the parser reads ${kind}; saved because Claude is blocked and the screen held)` : '';
	log(`  saved ${files.join(', ')}: ${kind}${note}`);
	return files;
}

async function awaitPlan(pane: Pane, planContains: string): Promise<void> {
	const deadline = Date.now() + 240_000;
	for (;;) {
		const dialog = parse(await pane.read());
		if (dialog.kind === 'plan' && joinWrapped(dialog.plan).includes(planContains) && dialog.feedback === null) {
			await steady(pane);
			return;
		}
		if (Date.now() > deadline) throw new Error(`no plan naming ${planContains}`);
		await sleep(300);
	}
}

async function runSession(pane: Pane, out: string, recorded: Recorded, files: string[]): Promise<void> {
	if (!pane.session.trust) await settle(pane);
	for (const step of pane.session.steps) {
		switch (step.do) {
			case 'prompt': {
				await settle(pane);
				const before = await pane.read();
				await pane.prompt(step.text);
				await changed(pane, before, 'the prompt');
				// Every prompt asks for a dialog; keys pressed before it is up
				// would land in the composer.
				await dialogUp(pane);
				break;
			}
			case 'mode':
				await setMode(pane, step.mode);
				break;
			case 'keys':
				await press(pane, step.keys);
				break;
			case 'type': {
				const before = await pane.read();
				await pane.type(step.text);
				await changed(pane, before, 'typing');
				break;
			}
			case 'record':
				files.push(...(await record(pane, step, out, recorded)));
				break;
			case 'await':
				await awaitPlan(pane, step.planContains);
				break;
			case 'answer':
				await press(pane, step.keys);
				await settle(pane);
				break;
			case 'resize':
				await pane.resize(step.size);
				await steady(pane);
				break;
		}
	}
}

// --- Leaving nothing behind -------------------------------------------------

interface Footprint {
	/** Folders this run made, top-most first. */
	folders: string[];
	/** Per transcript folder: whether it existed, and what it held, before the run. */
	projects: Map<string, Set<string> | null>;
	plansBefore: Set<string>;
}

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
}

function listing(dir: string): Set<string> | null {
	try {
		return new Set(readdirSync(dir));
	} catch {
		return null;
	}
}

function makeFolders(planned: Session[], footprint: Footprint): void {
	for (const session of planned) {
		const parts = session.folder.split('/');
		for (let i = 2; i <= parts.length; i++) {
			const dir = parts.slice(0, i).join('/');
			if (existsSync(dir)) continue;
			if (!/\/oh-test-/.test(dir)) throw new Error(`refusing to create ${dir}: not an oh-test-* folder`);
			mkdirSync(dir);
			footprint.folders.push(dir);
		}
	}
}

/** Removes what the run's Claude sessions wrote; returns what could not be removed. */
function removeClaudeFiles(footprint: Footprint): string[] {
	const config = claudeDir();
	const problems: string[] = [];
	const remove = (path: string): void => {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (error) {
			problems.push(`${path}: ${describe(error)}`);
		}
	};
	const slugs = new Set<string>();
	for (const [dir, before] of footprint.projects) {
		const now = listing(dir);
		if (!now) continue;
		for (const entry of now) {
			if (before?.has(entry)) continue;
			const id = sessionIdOf(entry);
			if (id) {
				try {
					for (const slug of slugsIn(readFileSync(join(dir, entry), 'utf8'))) slugs.add(slug);
				} catch {
					// Unreadable: its plan, if any, stays; reported below if it does.
				}
				remove(join(config, 'file-history', id));
				remove(join(config, 'session-env', id));
			}
			remove(join(dir, entry));
		}
		if (before === null) remove(dir);
	}
	for (const slug of slugs) {
		const file = `${slug}.md`;
		if (!footprint.plansBefore.has(file)) remove(join(config, 'plans', file));
	}
	return problems;
}

// --- The diff ---------------------------------------------------------------

function compare(baseline: string, out: string, files: string[], full: boolean, partial: boolean): void {
	log(`\nCompared with ${baseline}:`);
	const rows: string[] = [];
	const diffs: string[] = [];
	const before = new Set(readdirSync(baseline).filter((file) => /\.(txt|ansi)$/.test(file)));
	const kindOf = (text: string | null): string => (text === null ? '-' : parse(text).kind);
	let same = 0;
	for (const file of [...new Set([...files, ...before])].sort()) {
		const old = before.has(file) ? readFileSync(join(baseline, file), 'utf8') : null;
		const now = files.includes(file) ? readFileSync(join(out, file), 'utf8') : null;
		const sibling = files.some((recorded) => recorded.replace(/-torn(?=\.)/, '') === file.replace(/-torn(?=\.)/, ''));
		// A screen of a session this run left out (`--only`).
		if (now === null && partial && !sibling) continue;
		let status: string;
		if (old === null) status = 'new';
		else if (now === null) status = 'not recorded';
		else if (old === now) status = 'same';
		else status = 'changed';
		if (status === 'same') {
			same++;
			continue;
		}
		const kinds = file.endsWith('.txt') ? `  ${kindOf(old)} -> ${kindOf(now)}` : '';
		rows.push(`  ${status.padEnd(13)}${file}${kinds}`);
		if (status === 'changed' && file.endsWith('.txt') && old !== null && now !== null) {
			const regionOld = full ? null : dialogRegion(old, parse);
			const regionNow = full ? null : dialogRegion(now, parse);
			const whole = full || !regionOld || !regionNow;
			const a = whole ? old.split('\n') : regionOld;
			const b = whole ? now.split('\n') : regionNow;
			const body = unifiedDiff(a, b, [`${file} (${baseline.split('/').pop()})`, `${file} (new)`]);
			diffs.push(body || `(${file}: the dialog is the same; only the history above it changed)\n`);
		}
	}
	log(`  ${same} screen${same === 1 ? '' : 's'} the same`);
	for (const row of rows) log(row);
	if (diffs.length) {
		log(full ? '\nDiffs:\n' : '\nDiffs of the dialog under its rule (--full for whole screens):\n');
		for (const diff of diffs) process.stdout.write(`${diff}\n`);
	}
}

/** Where a new set came from; the last set's README says what each file is. */
function readmeFor(versions: { claude: string; herdr: string; hc: string }, baseline: string | null, partial: boolean): string {
	const date = new Date().toISOString().slice(0, 10);
	const index = baseline ? ` File names, states and scrubbing as in \`../${baseline.split('/').pop()}/README.md\`.` : '';
	return [
		`# Claude Code ${versions.claude} dialogs, as the screen reads show them`,
		'',
		`Recorded ${date} by \`npm run record-screens\` (\`scripts/record-screens/\`, issue #168)`,
		`against herdr ${versions.herdr} and hc ${versions.hc}, from the prompts, keys, folders and`,
		`sizes in \`scripts/record-screens/scenario.ts\`.${index}${partial ? ' Only some sessions were run (`--only`).' : ''}`,
		'',
	].join('\n');
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	const pathEnv = process.env.PATH ?? '';
	const claude = options.claude ?? findClaude(pathEnv, homedir(), isExecutable);
	const herdr = onPath('herdr', pathEnv, isExecutable)[0];
	const hc = onPath('hc', pathEnv, isExecutable)[0];
	if (!claude) throw new Error('Claude Code not found on PATH (mise shims do not count); pass --claude');
	if (!herdr) throw new Error('herdr not found on PATH');
	if (!hc) throw new Error('hc not found on PATH');
	const tools: Tools = { claude, herdr, hc };
	const version = versionOf(claude);
	const versions = { claude: version, herdr: versionOf(herdr), hc: versionOf(hc) };
	log(`Claude Code ${version} (${claude})\nherdr ${versions.herdr} (${herdr})\nhc ${versions.hc} (${hc})`);

	const out = options.out ?? join(SCREENS, `claude-${version}`);
	if (existsSync(out)) throw new Error(`${out} exists; pass --out to record elsewhere`);
	const baseline =
		options.against ??
		(() => {
			const name = latestSet(listing(SCREENS) ? [...listing(SCREENS)!] : [], out.startsWith(SCREENS) ? out.split('/').pop()! : null);
			return name ? join(SCREENS, name) : null;
		})();

	const planned = sessions().filter((session) => !options.only || options.only.test(session.name));
	if (planned.length === 0) throw new Error('--only matches no session');
	const problems: string[] = [];
	let claudeJson: unknown = null;
	try {
		claudeJson = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
	} catch {
		// No such file: nothing is trusted yet.
	}
	for (const session of planned) {
		if (existsSync(session.folder)) problems.push(`${session.folder} exists (left from an earlier run?); remove it first`);
		const trusted = session.trust ? trustedIn(claudeJson, session.folder) : null;
		if (trusted) problems.push(`Claude already trusts ${trusted}, so ${session.name} would see no trust prompt`);
	}
	if (problems.length) throw new Error(`cannot start:\n  ${problems.join('\n  ')}`);
	log(`\nSessions: ${planned.map((session) => session.name).join(', ')}`);
	log(`Screens to: ${out}${baseline ? `\nCompared with: ${baseline}` : ''}`);
	if (options.dryRun) return 0;

	const herdrClient = new HerdrClient({ socketPath: options.socket, requestTimeoutMs: 15_000 });
	const hcClient = new HcClient({ argv: [hc, 'connect'] });
	const opened: Pane[] = [];
	const footprint: Footprint = {
		folders: [],
		projects: new Map(),
		plansBefore: listing(join(claudeDir(), 'plans')) ?? new Set(),
	};
	for (const session of planned) {
		const dir = join(claudeDir(), 'projects', projectDirName(session.folder));
		if (!footprint.projects.has(dir)) footprint.projects.set(dir, listing(dir));
	}
	const recorded: Recorded = { plans: new Set(), editors: new Set(), leaks: [] };
	const files: string[] = [];
	let failure: unknown = null;

	let interrupts = 0;
	const onSignal = (): void => {
		interrupts++;
		if (interrupts === 1) log('\nInterrupted: closing what the run opened…');
		abort.abort();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	try {
		if (planned.some((session) => session.runtime === 'herdr')) await herdrClient.ping();
		if (planned.some((session) => session.runtime === 'hc')) await hcClient.ping();
		makeFolders(planned, footprint);
		mkdirSync(out, { recursive: true });
		for (const session of planned) {
			if (abort.signal.aborted) throw new Error('interrupted');
			log(`\n${session.name} (${session.runtime}, ${session.size.cols}x${session.size.rows}, ${session.folder})`);
			const pane =
				session.runtime === 'herdr'
					? await openHerdrPane(herdrClient, tools, session, opened)
					: await openHcTerminal(hcClient, tools, session, opened);
			try {
				await runSession(pane, out, recorded, files);
			} finally {
				await pane.close().catch((error) => log(`  could not close ${session.name}: ${describe(error)}`));
			}
		}
		if (abort.signal.aborted) throw new Error('interrupted');
	} catch (error) {
		failure = error;
	} finally {
		// Cleanup runs to the end even after a second interrupt.
		const left: string[] = [];
		for (const pane of opened) {
			await pane.close().catch(() => undefined);
			if (!(await pane.gone().catch(() => false))) left.push(`${pane.session.runtime} ${pane.session.name}`);
		}
		// Claude may still be writing as it is killed.
		await new Promise<void>((done) => setTimer(done, 1500));
		for (const dir of [...footprint.folders].reverse()) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch (error) {
				left.push(`${dir}: ${describe(error)}`);
			}
		}
		left.push(...removeClaudeFiles(footprint));
		for (const dir of footprint.folders) if (existsSync(dir)) left.push(dir);
		for (const [dir, before] of footprint.projects) {
			const now = listing(dir);
			if (before === null ? now !== null : [...(now ?? [])].some((entry) => !before.has(entry))) left.push(dir);
		}
		herdrClient.dispose();
		hcClient.dispose();
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		log(left.length ? `\nLEFT BEHIND:\n  ${left.join('\n  ')}` : '\nCleaned up: no test panes, terminals, folders or Claude files left.');
		if (left.length && !failure) failure = new Error('the run left things behind');
	}

	if (recorded.plans.size || recorded.editors.size) {
		log(
			`Scrubbed: plan name ${[...recorded.plans].map((p) => `"${p}"`).join(', ') || '-'}, editor ${[...recorded.editors].map((e) => `"${e}"`).join(', ') || '-'}.`,
		);
	}
	if (recorded.leaks.length) log(`WARNING: these still name the user ${userInfo().username}: ${recorded.leaks.join(', ')}`);
	if (failure) {
		log(`\nFAILED: ${describe(failure)}`);
		if (files.length) log(`The ${files.length} screens recorded so far are in ${out}.`);
		return 1;
	}
	log(`\nRecorded ${files.length} screens in ${out}.`);
	const readme = join(out, 'README.md');
	if (!existsSync(readme)) writeFileSync(readme, readmeFor(versions, baseline, options.only !== null));
	if (baseline && existsSync(baseline)) compare(baseline, out, files, options.full, options.only !== null);
	else log('No earlier set to compare with.');
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`record-screens: ${describe(error)}\n`);
		process.exit(1);
	},
);
