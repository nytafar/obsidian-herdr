/**
 * What Claude Code's transcript says of the session's settings (issue #160,
 * findings `native-view-session-settings` and `native-view-header`): the
 * model, the effort, the permission mode and the context, read by the parser
 * (`./transcript.ts`) record by record. The newest record that states a field
 * wins, in file order.
 *
 * Sources, all main chain (a subagent's records are not the session's):
 *
 * - the `model` attachment: the id and the name Claude shows
 *   (`identity.modelId`, `marketingName`), at the first prompt and before the
 *   first reply after a switch;
 * - every reply: `message.model`, the line's own `effort`, and its usage,
 *   whose three input counts are the context in use;
 * - `/model` and `/effort` run from the prompt: their `<local-command-stdout>`
 *   ("Set model to \`Haiku 5.5\` …", optionally "… with \`medium\` effort";
 *   "Set effort level to low (…)"). The stdout names the model by its display
 *   name, or on the `claude` kind as "\`sonnet (claude-sonnet-5-5)\`"; the id
 *   comes from the names this session's attachments gave, and is '' until one
 *   has. An invalid argument writes no such line, so it changes nothing; a
 *   `/effort` sent mid-turn writes none at all, and the next reply's `effort`
 *   is the first word of it;
 * - the prompt's `permissionMode`;
 * - `/context`'s output ("**Tokens:** 22.6k / 1m (2%)"), the `isMeta` line
 *   after a `local_command` for `context`: the window, for the model it names.
 *   It counts while that model is the session's, so a model change hides it
 *   until the next `/context` (or a change back). Nothing else in a herdr or
 *   hc transcript says the window: no model table, no default. The same
 *   output is the breakdown the session bar shows (#171,
 *   `SessionInfo.contextReport`): its headline and its category table.
 *
 * Pure. {@link SessionReader} is the working copy of one batch, as the parser's
 * branch is: the info object is replaced only when a field changed, so a batch
 * that says nothing new leaves it as it was.
 */

import type { ContextBreakdown, ContextCategory } from '../../native/contextBreakdown';
import type { SessionInfo } from '../../native/conversation';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Json, key: string): string {
	const value = source[key];
	return typeof value === 'string' ? value : '';
}

/** What the reader keeps across batches besides the info itself. */
export interface SessionReading {
	/** Model ids to the names the `model` attachments gave them, this session. */
	labels: Readonly<Record<string, string>>;
	/** A `/context` ran and its output has not been read yet. */
	contextPending: boolean;
	/** The window the newest `/context` stated, and the model it stated it for. */
	window: { model: string; tokens: number } | null;
}

/** A session nothing has been read of. */
export function emptyReading(): SessionReading {
	return { labels: {}, contextPending: false, window: null };
}

/** Terminal escape sequences, which a system line's stdout may carry. */
// eslint-disable-next-line no-control-regex -- matching terminal control characters is the point
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** The text inside `<local-command-stdout>`, or null for a line that is not one. */
function localStdout(content: string): string | null {
	const match = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(content);
	return match ? (match[1] ?? '').replace(ESCAPES, '').trim() : null;
}

/** `/model`'s stdout: the model as shown, and the effort it was set with. */
const MODEL_SET = /^Set model to `([^`]+)`(?:[\s\S]*?\bwith `([^`]+)` effort)?/;

/** `/effort`'s stdout: the level is the word after "to". */
const EFFORT_SET = /^Set effort level to ([A-Za-z]+)\b/;

/** `/context`'s window: "**Tokens:** 22.6k / 1m (2%)". */
const CONTEXT_TOKENS = /\*\*Tokens:\*\*\s*[\d.,]+\s*[km]?\s*\/\s*([\d.,]+)\s*([km]?)/i;

/** `/context`'s model: "**Model:** claude-opus-5-5". */
const CONTEXT_MODEL = /\*\*Model:\*\*\s*(\S+)/;

/** `/context`'s headline as written: used, window and share ("22.6k / 1m (2%)"). */
const CONTEXT_HEADLINE = /\*\*Tokens:\*\*\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)\s*(?:\(([^)]*)\))?/i;

/** The heading of `/context`'s category table. */
const CATEGORY_HEADING = /^#{2,4}\s*Estimated usage by category\s*$/i;

/** One Markdown table row's cells, or null for a line that is no row. */
function tableCells(line: string): string[] | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('|')) return null;
	return trimmed
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

/** The rows of `/context`'s category table: the table after its heading, header and rule left out. */
function contextCategories(content: string): ContextCategory[] {
	const lines = content.split('\n');
	const start = lines.findIndex((line) => CATEGORY_HEADING.test(line.trim()));
	if (start < 0) return [];
	const categories: ContextCategory[] = [];
	let header = true;
	for (const line of lines.slice(start + 1)) {
		const cells = tableCells(line);
		if (!cells) {
			// Blank lines before the table; anything else after it ends it.
			if (line.trim() === '' && header) continue;
			break;
		}
		if (header) {
			header = false;
			continue;
		}
		if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
		const [name = '', tokens = '', share = ''] = cells;
		if (name) categories.push({ name, tokens, share });
	}
	return categories;
}

/**
 * `/context`'s Markdown as the breakdown the session bar shows (#171), or
 * null for a line that has no "**Tokens:**" headline. `id` tells this report
 * from the next one.
 */
export function contextReportOf(content: string, id: string): ContextBreakdown | null {
	const headline = CONTEXT_HEADLINE.exec(content);
	if (!headline) return null;
	return {
		id,
		model: CONTEXT_MODEL.exec(content)?.[1] ?? '',
		used: (headline[1] ?? '').replace(/\s+/g, ''),
		window: (headline[2] ?? '').replace(/\s+/g, ''),
		percent: (headline[3] ?? '').trim(),
		categories: contextCategories(content),
	};
}

/** "1m", "200k", "128000" as tokens; null when it is no number. */
function tokenCount(value: string, unit: string): number | null {
	const number = Number.parseFloat(value.replace(/,/g, ''));
	if (!Number.isFinite(number) || number <= 0) return null;
	const scale = unit.toLowerCase() === 'm' ? 1_000_000 : unit.toLowerCase() === 'k' ? 1_000 : 1;
	return Math.round(number * scale);
}

/** `/context` run at the prompt, as its `<command-name>` envelope. */
export const CONTEXT_NAME = /^\s*(?:<command-message>context<\/command-message>\s*)?<command-name>\s*\/context\s*<\/command-name>/;

/** A `system` line that is a local command named `/context`, its name or its output. */
function isContextCommand(line: Json): boolean {
	const run = isRecord(line.commandRun) ? line.commandRun : null;
	if (run && stringField(run, 'command') === 'context') return true;
	return /<command-name>\s*\/context\s*<\/command-name>/.test(stringField(line, 'content'));
}

/** The working copy of one batch's reading. */
export class SessionReader {
	private info: SessionInfo;
	private labels: Readonly<Record<string, string>>;
	private contextPending: boolean;
	private window: SessionReading['window'];

	constructor(info: SessionInfo, reading: SessionReading) {
		this.info = info;
		this.labels = reading.labels;
		this.contextPending = reading.contextPending;
		this.window = reading.window;
	}

	/** A `model` attachment's `identity`: the id and the name Claude shows. */
	identity(identity: Json): void {
		const id = stringField(identity, 'modelId');
		if (!id) return;
		const label = stringField(identity, 'marketingName') || id;
		if (this.labels[id] !== label) this.labels = { ...this.labels, [id]: label };
		this.setModel(id, label);
	}

	/**
	 * A main-chain reply: its model, the effort it ran with (the line's
	 * `effort`) and its usage. `<synthetic>` is what Claude writes on an answer
	 * no model gave (an API error), with every count 0: neither its model nor
	 * its usage is the session's, so the context in use stays what the last
	 * real answer said.
	 */
	reply(message: Json, effort: string): void {
		this.contextPending = false;
		const model = stringField(message, 'model');
		if (model === '<synthetic>') return;
		if (model && model !== this.info.model?.id) this.setModel(model, this.labels[model] ?? model);
		if (effort) this.set('effort', effort);
		const usage = isRecord(message.usage) ? message.usage : null;
		if (!usage) return;
		const count = (key: string): number => {
			const value = usage[key];
			return typeof value === 'number' && Number.isFinite(value) ? value : 0;
		};
		const cached = count('cache_read_input_tokens');
		const input = count('input_tokens') + count('cache_creation_input_tokens') + cached;
		const output = count('output_tokens');
		this.set('contextUsed', input);
		const was = this.info.usage;
		if (was?.input !== input || was.output !== output || was.cached !== (cached || undefined)) {
			this.info = { ...this.info, usage: { input, output, ...(cached ? { cached } : {}) } };
		}
	}

	/**
	 * A main-chain `user` line: a prompt's `permissionMode`, a slash command's
	 * stdout, or the `/context` output a `local_command` announced.
	 */
	user(line: Json): void {
		const pending = this.contextPending;
		this.contextPending = false;
		const mode = stringField(line, 'permissionMode');
		if (mode) this.set('permissionMode', mode);
		const message = isRecord(line.message) ? line.message : null;
		const content = message?.content;
		if (typeof content !== 'string') return;
		if (line.isMeta === true) {
			if (pending) this.contextOutput(content, stringField(line, 'uuid') || stringField(line, 'timestamp'));
			return;
		}
		// `/context` written as a `user` line instead of a `system` one: its
		// name and its coloured stdout still announce the output that follows.
		if (CONTEXT_NAME.test(content) || (pending && localStdout(content) !== null)) {
			this.contextPending = true;
			return;
		}
		const stdout = localStdout(content);
		if (stdout !== null) this.commandOutput(stdout);
	}

	/**
	 * A main-chain `system` `local_command` line: `/context` announcing the
	 * output that follows, or a command's stdout written there.
	 */
	localCommand(line: Json): void {
		if (isContextCommand(line)) {
			this.contextPending = true;
			return;
		}
		const stdout = localStdout(stringField(line, 'content'));
		if (stdout !== null) this.commandOutput(stdout);
	}

	/** The info and the reading as the batch leaves them. */
	finish(): { info: SessionInfo; reading: SessionReading } {
		const id = this.info.model?.id;
		const tokens = this.window && id && this.window.model === id ? this.window.tokens : undefined;
		const shown = this.info.contextWindow;
		if (tokens === undefined) {
			if (shown?.source === 'context-command') {
				const { contextWindow: _gone, ...rest } = this.info;
				this.info = rest;
			}
		} else if (shown?.tokens !== tokens || shown.source !== 'context-command') {
			this.info = { ...this.info, contextWindow: { tokens, source: 'context-command' } };
		}
		return {
			info: this.info,
			reading: { labels: this.labels, contextPending: this.contextPending, window: this.window },
		};
	}

	/** `/model` and `/effort` stdout; anything else a command printed says nothing here. */
	private commandOutput(stdout: string): void {
		const model = MODEL_SET.exec(stdout);
		if (model) {
			const shown = (model[1] ?? '').trim();
			// The `claude` kind's echo: "sonnet (claude-sonnet-5-5)".
			const echo = /^(.*?)\s*\(([^()\s]+)\)$/.exec(shown);
			if (echo) {
				const id = echo[2] ?? '';
				this.setModel(id, this.labels[id] ?? id);
			} else {
				const id = Object.keys(this.labels).find((key) => this.labels[key] === shown) ?? '';
				this.setModel(id, shown);
			}
			if (model[2]) this.set('effort', model[2]);
			return;
		}
		const effort = EFFORT_SET.exec(stdout);
		if (effort?.[1]) this.set('effort', effort[1].toLowerCase());
	}

	/** `/context`'s Markdown: the window, for the model it names, and the breakdown (#171). */
	private contextOutput(content: string, id: string): void {
		const report = contextReportOf(content, id);
		if (report && this.info.contextReport?.id !== id) this.info = { ...this.info, contextReport: report };
		const tokens = CONTEXT_TOKENS.exec(content);
		const count = tokens ? tokenCount(tokens[1] ?? '', tokens[2] ?? '') : null;
		if (count === null) return;
		const model = CONTEXT_MODEL.exec(content)?.[1] ?? this.info.model?.id ?? '';
		if (this.window?.model === model && this.window.tokens === count) return;
		this.window = { model, tokens: count };
	}

	private setModel(id: string, label: string): void {
		if (this.info.model?.id === id && this.info.model.label === label) return;
		this.info = { ...this.info, model: { id, label } };
	}

	private set<K extends 'effort' | 'permissionMode' | 'contextUsed'>(key: K, value: SessionInfo[K]): void {
		if (this.info[key] === value) return;
		this.info = { ...this.info, [key]: value };
	}
}
