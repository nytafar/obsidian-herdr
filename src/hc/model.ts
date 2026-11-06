/**
 * herdr-core's terminal model, reduced to what the plugin shows (ADR-0005;
 * [[herdr-core-api]] §4-§6), with no I/O:
 *
 * - {@link parseTerminal}: a Terminal record, unknown fields ignored.
 * - {@link TerminalStore}: herdr-app's reducer (`src/hc.rs`): store the
 *   snapshot, apply events whose seq is above it, replace everything on
 *   `missed`.
 * - {@link hcAgentStatus}: the status mapping, with herdr-app's "done until
 *   seen" rule over `turn` and the shared `herdr.seen` label.
 * - {@link agentKindOf}: what counts as an agent: a terminal that reported a
 *   `status.app`, or whose foreground program is a known agent.
 * - {@link parseSpaces} and {@link resolveHcScope}: the `herdr-app` document's
 *   spaces, and the scope order — the runtime's space override, the space
 *   named like the vault, then terminals whose cwd is under the vault root.
 */

import { isUnder, stripTitleSpinner, type PaneState, type ResolutionMethod } from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';
import type { HcEvent } from './streams';

/** Labels herdr clients share (herdr-app `docs/labels.md`). */
export const LABEL_SPACE = 'herdr.space';
export const LABEL_TAB = 'herdr.tab';
export const LABEL_SEEN = 'herdr.seen';
export const LABEL_PINNED = 'herdr.pinned';
/**
 * This plugin's own label: the agent kind a terminal was started as, set by
 * `terminal.run` and read only as {@link agentKindOf}'s last resort, so a
 * foreground it does not recognise never drops a row it started.
 */
export const LABEL_AGENT = 'obsidian-herdr.agent';

export interface HcForeground {
	pid: number | null;
	name: string;
	argv: string[];
	cwd: string;
}

export interface HcStatus {
	/** `idle`, `working`, `done`, `blocked`, `error`; anything else is kept as sent. */
	state: string;
	app: string;
	/**
	 * What a `blocked` program is waiting for, when it said: `permission`,
	 * `question` or `auth` (OSC 7501 `kind=`, [[herdr-core-api]] §6). Absent
	 * otherwise; anything else is kept as sent.
	 */
	kind?: string;
}

/** The Terminal record fields the plugin reads. */
export interface HcTerminal {
	/** `t7`, or `machine/t7` for a federated one. */
	address: string;
	name: string | null;
	argv: string[];
	cwd: string;
	/** `live` or `finished`. */
	state: string;
	labels: Record<string, string>;
	foreground: HcForeground | null;
	/** Null when the program never reported, or cleared it on exit. */
	status: HcStatus | null;
	reported: boolean;
	turn: number;
	title: string;
	parent: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function labelsOf(value: unknown): Record<string, string> {
	const source = record(value);
	const labels: Record<string, string> = {};
	if (!source) return labels;
	for (const [key, entry] of Object.entries(source)) {
		if (typeof entry === 'string') labels[key] = entry;
	}
	return labels;
}

export function parseForeground(value: unknown): HcForeground | null {
	const source = record(value);
	if (!source) return null;
	return {
		pid: typeof source.pid === 'number' ? source.pid : null,
		name: str(source.name),
		argv: strings(source.argv),
		cwd: str(source.cwd),
	};
}

export function parseStatus(value: unknown): HcStatus | null {
	const source = record(value);
	if (!source || typeof source.state !== 'string') return null;
	const kind = str(source.kind);
	return { state: source.state, app: str(source.app), ...(kind ? { kind } : {}) };
}

/** A Terminal record, or null when it has no address. */
export function parseTerminal(value: unknown): HcTerminal | null {
	const source = record(value);
	if (!source || typeof source.address !== 'string' || source.address.length === 0) return null;
	return {
		address: source.address,
		name: typeof source.name === 'string' && source.name.length > 0 ? source.name : null,
		argv: strings(source.argv),
		cwd: str(source.cwd),
		state: str(source.state, 'live'),
		labels: labelsOf(source.labels),
		foreground: parseForeground(source.foreground),
		status: parseStatus(source.status),
		reported: source.reported === true,
		turn: typeof source.turn === 'number' ? source.turn : 0,
		title: str(source.title),
		parent: typeof source.parent === 'string' ? source.parent : null,
	};
}

/**
 * The terminal list kept live from one subscription. Seq restarts with each
 * core process, so a reconnect starts again from a fresh {@link reset}.
 */
export class TerminalStore {
	private terminals = new Map<string, HcTerminal>();
	private seq = 0;

	get lastSeq(): number {
		return this.seq;
	}

	all(): HcTerminal[] {
		return [...this.terminals.values()];
	}

	get(address: string): HcTerminal | undefined {
		return this.terminals.get(address);
	}

	/** The subscribe snapshot, or a `missed` one: replaces everything. */
	reset(seq: number, terminals: readonly unknown[]): void {
		const next = new Map<string, HcTerminal>();
		for (const raw of terminals) {
			const terminal = parseTerminal(raw);
			if (terminal) next.set(terminal.address, terminal);
		}
		this.terminals = next;
		this.seq = seq;
	}

	/** Drops one terminal, for an answer that says it is gone. */
	delete(address: string): void {
		this.terminals.delete(address);
	}

	/**
	 * Applies one event. Returns true when the store changed. Events at or
	 * below the snapshot's seq are already in it, and so are ignored.
	 */
	apply(event: HcEvent): boolean {
		if (event.seq > 0 && event.seq <= this.seq) return false;
		if (event.seq > this.seq) this.seq = event.seq;
		const address = event.terminal;
		if (!address) return false;
		const data = record(event.data) ?? {};
		if (event.type === 'created' || event.type === 'restarted') {
			const terminal = parseTerminal(event.data);
			if (!terminal) return false;
			this.terminals.set(terminal.address, terminal);
			return true;
		}
		if (event.type === 'removed') return this.terminals.delete(address);
		const current = this.terminals.get(address);
		if (!current) return false;
		let next: HcTerminal;
		switch (event.type) {
			case 'foreground':
				next = { ...current, foreground: parseForeground(event.data) };
				break;
			case 'status':
				next = { ...current, status: parseStatus(data.status), reported: data.reported === true };
				break;
			case 'turn':
				next = { ...current, turn: typeof data.turn === 'number' ? data.turn : current.turn };
				break;
			case 'title':
				next = { ...current, title: str(data.title) };
				break;
			case 'labels':
				next = { ...current, labels: labelsOf(data.labels) };
				break;
			case 'lost':
				next = { ...current, foreground: null };
				break;
			case 'finished':
				next = { ...current, state: 'finished', foreground: null, status: null };
				break;
			default:
				// `size`, `keep` and anything newer: nothing the rows read.
				return false;
		}
		this.terminals.set(address, next);
		return true;
	}
}

/**
 * Agent programs by the name they report (`status.app`) or run as
 * (`foreground.name`), mapped to the kind the row marks use
 * (`views/kindIcons.ts`). From herdr-app's `defaults/programs.json` agents and
 * the plugin's own `AGENT_KINDS`.
 */
const AGENT_PROGRAMS: Record<string, string> = {
	claude: 'claude',
	'claude-code': 'claude',
	codex: 'codex',
	gemini: 'gemini',
	opencode: 'opencode',
	pi: 'pi',
	pig: 'pig',
	cursor: 'cursor',
	'cursor-agent': 'cursor',
	amp: 'amp',
	copilot: 'copilot',
	'github-copilot': 'copilot',
	kimi: 'kimi',
	droid: 'droid',
	grok: 'grok',
	'grok-build': 'grok',
	qwen: 'qwen',
	kiro: 'kiro',
	'kiro-cli': 'kiro',
	crush: 'crush',
	hermes: 'hermes',
	agy: 'antigravity',
	antigravity: 'antigravity',
	qodercli: 'qoder',
	qoder: 'qoder',
	'dsh-tui': 'dsh-tui',
};

/** Launchers whose next non-flag argument names the real program. */
const INTERPRETERS = new Set(['node', 'bun', 'bunx', 'deno', 'python', 'python3', 'npx', 'uv', 'uvx', 'env']);

function baseName(path: string): string {
	const last = path.split('/').pop() ?? path;
	return last.replace(/\.(m?js|cjs|ts|py)$/, '');
}

/** The agent kind a program name stands for, or null. */
export function agentProgram(name: string): string | null {
	const key = baseName(name.trim()).toLowerCase();
	if (!key) return null;
	return Object.prototype.hasOwnProperty.call(AGENT_PROGRAMS, key) ? (AGENT_PROGRAMS[key] ?? null) : null;
}

/**
 * The agent kind of a terminal, or null when it is not an agent. A reported
 * `status.app` wins, known or not (an unknown app keeps its own name); then
 * the foreground program: its name, its `argv[0]` (the process title, which
 * node sets: pi runs as `{name: 'node', argv: ['pi', '']}`, measured on hc
 * 2026-11-06), then through a known launcher (`node …/gemini.js`); last, the
 * kind this plugin started the terminal as ({@link LABEL_AGENT}). herdr's own
 * detection (`src/detect/mod.rs`) looks at argv0 the same way.
 */
export function agentKindOf(terminal: HcTerminal): string | null {
	const app = terminal.status?.app.trim() ?? '';
	if (app) return agentProgram(app) ?? app.toLowerCase();
	return foregroundKind(terminal.foreground) ?? startedKind(terminal.labels);
}

function foregroundKind(foreground: HcForeground | null): string | null {
	if (!foreground) return null;
	const direct = agentProgram(foreground.name);
	if (direct) return direct;
	const title = foreground.argv[0];
	const titled = title ? agentProgram(title) : null;
	if (titled) return titled;
	if (INTERPRETERS.has(baseName(foreground.name))) {
		for (const arg of foreground.argv.slice(1)) {
			if (arg.startsWith('-')) continue;
			const kind = agentProgram(arg);
			if (kind) return kind;
		}
	}
	return null;
}

/** The kind this plugin started the terminal as, or null. */
function startedKind(labels: Record<string, string>): string | null {
	const started = labels[LABEL_AGENT]?.trim() ?? '';
	if (!started) return null;
	return agentProgram(started) ?? started.toLowerCase();
}

/** `herdr.seen` as a turn, or null when missing or unreadable. A missing label is not 0. */
export function seenTurn(labels: Record<string, string>): number | null {
	const raw = labels[LABEL_SEEN];
	if (raw === undefined || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isInteger(value) ? value : null;
}

/**
 * ADR-0005's mapping. `working` is working; `blocked` and `error` are blocked
 * (herdr-app's "needs you"); `done` and `idle` are done when `turn` is past
 * `herdr.seen`, else idle, and as reported when that label is missing; a
 * terminal that never reported, or cleared it, is unknown.
 */
export function hcAgentStatus(terminal: Pick<HcTerminal, 'status' | 'turn' | 'labels'>): AgentStatus {
	const state = terminal.status?.state;
	if (!state) return 'unknown';
	if (state === 'working') return 'working';
	if (state === 'blocked' || state === 'error') return 'blocked';
	if (state === 'done' || state === 'idle') {
		const seen = seenTurn(terminal.labels);
		if (seen === null) return state;
		return terminal.turn > seen ? 'done' : 'idle';
	}
	return 'unknown';
}

/** The terminal's working directory now: the foreground's, else where it started. */
export function cwdOf(terminal: HcTerminal): string {
	return terminal.foreground?.cwd || terminal.cwd;
}

/** A federated terminal (`machine/t7`), which a target's own scope leaves out (ADR-0004). */
export function isFederated(address: string): boolean {
	return address.includes('/');
}

export function isPinned(terminal: Pick<HcTerminal, 'labels'>): boolean {
	return (terminal.labels[LABEL_PINNED] ?? '') !== '';
}

/** The row for an agent terminal, or null when it is not one. */
export function toHcPaneState(
	terminal: HcTerminal,
	scopeId: string,
	statusChangedSeq = 0,
): PaneState | null {
	if (terminal.state === 'finished') return null;
	const agent = agentKindOf(terminal);
	if (!agent) return null;
	return {
		paneId: terminal.address,
		workspaceId: scopeId,
		tabId: terminal.labels[LABEL_TAB] ?? '',
		agent,
		name: terminal.name ?? '',
		agentStatus: hcAgentStatus(terminal),
		title: stripTitleSpinner(terminal.title),
		label: '',
		cwd: cwdOf(terminal),
		focused: false,
		tokens: {},
		statusChangedSeq,
		pinned: isPinned(terminal),
	};
}

/** One space of the `herdr-app` document, as far as the scope reads it. */
export interface HcSpace {
	id: string;
	name: string;
	folder: string;
	tabs: { id: string; name: string }[];
}

/** The `herdr-app` document's spaces; anything malformed is skipped. */
export function parseSpaces(value: unknown): HcSpace[] {
	const spaces = record(value)?.spaces;
	if (!Array.isArray(spaces)) return [];
	const out: HcSpace[] = [];
	for (const raw of spaces) {
		const space = record(raw);
		if (!space || typeof space.id !== 'string' || space.id.length === 0) continue;
		const tabs: { id: string; name: string }[] = [];
		if (Array.isArray(space.tabs)) {
			for (const rawTab of space.tabs) {
				const tab = record(rawTab);
				if (tab && typeof tab.id === 'string') tabs.push({ id: tab.id, name: str(tab.name) });
			}
		}
		out.push({ id: space.id, name: str(space.name), folder: str(space.folder), tabs });
	}
	return out;
}

/**
 * Tab labels of a space: the tab's name, or its 1-based position when it has
 * none, which is how herdr-app writes `where` ("sysadmin / 1").
 */
export function spaceTabLabels(space: HcSpace | null): Map<string, string> {
	const labels = new Map<string, string>();
	space?.tabs.forEach((tab, index) => labels.set(tab.id, tab.name.trim() || String(index + 1)));
	return labels;
}

export type HcScopeResolution =
	| { kind: 'space'; id: string; name: string | null; method: Extract<ResolutionMethod, 'setting' | 'label'> }
	| { kind: 'cwd'; root: string; method: 'cwd' }
	| { kind: 'none'; method: 'none' };

export interface HcScopeOptions {
	/** The runtime's space override: an id or a name. Empty resolves. */
	space?: string;
	/** Compared against space names. */
	vaultName: string;
	/** The vault root on the target, for the cwd rule. */
	root: string;
}

/** ADR-0005's scope order: override, space named like the vault, then cwd under the root. */
export function resolveHcScope(spaces: readonly HcSpace[], options: HcScopeOptions): HcScopeResolution {
	const override = options.space?.trim() ?? '';
	if (override) {
		const match =
			spaces.find((space) => space.id === override) ?? spaces.find((space) => space.name === override);
		return match
			? { kind: 'space', id: match.id, name: match.name || null, method: 'setting' }
			: { kind: 'space', id: override, name: null, method: 'setting' };
	}
	const name = options.vaultName.trim();
	if (name) {
		const lower = name.toLowerCase();
		const match =
			spaces.find((space) => space.name === name) ??
			spaces.find((space) => space.name.toLowerCase() === lower);
		if (match) return { kind: 'space', id: match.id, name: match.name || null, method: 'label' };
	}
	const root = options.root.trim();
	if (root) return { kind: 'cwd', root, method: 'cwd' };
	return { kind: 'none', method: 'none' };
}

/** Whether a terminal belongs to a resolved scope (agent or not). */
export function inHcScope(terminal: HcTerminal, resolution: HcScopeResolution): boolean {
	if (isFederated(terminal.address)) return false;
	if (resolution.kind === 'space') return terminal.labels[LABEL_SPACE] === resolution.id;
	if (resolution.kind === 'cwd') return isUnder(cwdOf(terminal), resolution.root);
	return false;
}
