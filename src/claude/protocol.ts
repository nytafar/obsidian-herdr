/**
 * Claude Code's stream-json protocol, as the `claude` runtime kind speaks it
 * (ADR-0007, finding `direct-claude-spike`).
 *
 * Pure: the argv a process starts with, the one strict writer every stdin line
 * goes through, the messages the plugin sends, and the reading of what Claude
 * sends back. No process, no Obsidian. `./process.ts` owns the child and
 * `./agents.ts` the state machine over these.
 *
 * **The writer is strict.** One malformed stdin line kills the process (the
 * spike measured exit 1 within 1.5 s), so a line is only ever
 * `JSON.stringify` of a plain object plus a newline, built here, and anything
 * that does not stringify to one JSON object is refused before it reaches the
 * pipe.
 *
 * **`updatedInput` is never altered.** An `allow` echoes the tool's input as
 * Claude sent it; the model is not told when a host rewrites it, so the only
 * change ever made is the `answers` an `AskUserQuestion` answer adds.
 *
 * **Grants are scoped by destination.** Only `session` suggestions back
 * "Allow for this session", and only `localSettings` ones back "Always allow
 * in this project", which writes `<cwd>/.claude/settings.local.json`. A
 * `userSettings` or `projectSettings` suggestion is never sent.
 */

import type {
	PendingGrant,
	PendingProjectGrant,
	PendingQuestion,
	PendingRequest,
	WaitingAnswer,
} from '../native/pendingRequest';
import type { ClaudePermissionMode } from '../runtimes';

/** What starts one agent process. */
export interface ClaudeArgvOptions {
	/** The `claude` executable, absolute or as found on PATH. */
	binary: string;
	/** The session to start (`--session-id`) or to continue (`--resume`). */
	sessionId: string;
	/** True to continue an existing conversation; false starts the given id. */
	resume: boolean;
	permissionMode: ClaudePermissionMode;
	/** Extra arguments after the fixed ones (a probe's `--model haiku`). */
	extraArgs?: readonly string[];
}

/**
 * The flags every agent process runs with: headless stream-json both ways,
 * partial messages for live progress, and permission prompts over stdio as
 * `can_use_tool` control requests, in the configured permission mode passed
 * explicitly so a user default (auto) never decides it.
 */
export const CLAUDE_STREAM_ARGS: readonly string[] = Object.freeze([
	'-p',
	'--input-format',
	'stream-json',
	'--output-format',
	'stream-json',
	'--verbose',
	'--include-partial-messages',
	'--permission-prompt-tool',
	'stdio',
]);

/** A session id as `--session-id` takes it: a UUID. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The argv of one agent process, binary first. */
export function claudeArgv(options: ClaudeArgvOptions): string[] {
	if (!SESSION_ID_RE.test(options.sessionId)) {
		throw new Error(`not a session id: ${options.sessionId}`);
	}
	return [
		options.binary,
		...CLAUDE_STREAM_ARGS,
		'--permission-mode',
		options.permissionMode,
		options.resume ? '--resume' : '--session-id',
		options.sessionId,
		...(options.extraArgs ?? []),
	];
}

/**
 * The one way a line reaches Claude's stdin: one JSON object, stringified,
 * plus a newline. Refuses anything else, so a bug here throws in the plugin
 * instead of killing the agent.
 */
export function encodeLine(message: object): string {
	if (typeof message !== 'object' || message === null || Array.isArray(message)) {
		throw new Error('a stdin line must be one JSON object');
	}
	const json = JSON.stringify(message) as string | undefined;
	// `JSON.stringify` escapes every newline inside strings, so a raw one can
	// only mean something went wrong; check anyway, it is cheap.
	if (typeof json !== 'string' || !json.startsWith('{') || json.includes('\n')) {
		throw new Error('a stdin line must be one JSON object');
	}
	return `${json}\n`;
}

/** A prompt, or a slash command, as one user message. */
export function userMessage(text: string): object {
	return { type: 'user', message: { role: 'user', content: text } };
}

/** A control request from the plugin (`interrupt`). */
export function controlRequest(requestId: string, request: Record<string, unknown>): object {
	return { type: 'control_request', request_id: requestId, request };
}

/** The `interrupt` control request: ends the running turn, keeps the process. */
export function interruptRequest(requestId: string): object {
	return controlRequest(requestId, { subtype: 'interrupt' });
}

/** The success answer to one of Claude's control requests. */
export function controlResponse(requestId: string, response: Record<string, unknown>): object {
	return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

/** The error answer to a control request this plugin does not handle. */
export function controlError(requestId: string, error: string): object {
	return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}

/** What a stopped agent's pending requests are denied with. */
export const STOPPED_DENIAL = 'The agent was stopped before this was answered.';

/** The deny answer to a `can_use_tool` request. */
export function denyResponse(message: string): Record<string, unknown> {
	return { behavior: 'deny', message };
}

/** A permission update as Claude suggests it; only the fields read here are typed. */
export interface PermissionUpdate {
	type: string;
	destination?: string;
	rules?: { toolName?: unknown; ruleContent?: unknown }[];
	behavior?: unknown;
	mode?: unknown;
	directories?: unknown;
}

/** One `can_use_tool` control request, as read off stdout. */
export interface ToolPermissionRequest {
	requestId: string;
	toolName: string;
	displayName: string;
	input: Record<string, unknown>;
	toolUseId: string;
	suggestions: PermissionUpdate[];
	description: string;
	decisionReason: string;
	blockedPath: string;
}

/** What one stdout line is, for the agent state machine. */
export type StreamEvent =
	/** `system:init`: sent at the start of every turn, with the session id. */
	| { type: 'init'; sessionId: string; permissionMode: string }
	/** `system:status`: a permission mode change, or compacting. */
	| { type: 'status'; permissionMode: string | null }
	/** The end of a turn. */
	| {
			type: 'result';
			isError: boolean;
			subtype: string;
			terminalReason: string;
			/** The text a result carries, or the first of `errors`; empty for none. */
			message: string;
			sessionId: string;
	  }
	| { type: 'permission'; request: ToolPermissionRequest }
	/** Some other control request; it must be answered, with an error. */
	| { type: 'control'; requestId: string; subtype: string }
	/** Claude withdrew a request (an interrupt landed while it was pending). */
	| { type: 'cancel'; requestId: string }
	/** The answer to one of the plugin's own requests. */
	| { type: 'response'; requestId: string; ok: boolean }
	/** Anything else: assistant and user messages, hooks, partials, rate limits. */
	| { type: 'other' };

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * Reads one stdout line. Unknown types and fields are ignored, a line that is
 * not JSON is `null`. Nothing here keeps or logs a line: the `initialize`
 * response, which carries the account email, is never asked for, and anything
 * that is not one of the events above is dropped as `other`.
 */
export function parseStreamLine(line: string): StreamEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	const message = record(value);
	if (!message) return null;
	switch (message.type) {
		case 'system': {
			if (message.subtype === 'init') {
				return {
					type: 'init',
					sessionId: text(message.session_id),
					permissionMode: text(message.permissionMode),
				};
			}
			if (message.subtype === 'status') {
				return { type: 'status', permissionMode: text(message.permissionMode) || null };
			}
			return { type: 'other' };
		}
		case 'result': {
			const errors = Array.isArray(message.errors) ? (message.errors as unknown[]) : [];
			const first = errors.find((entry): entry is string => typeof entry === 'string');
			return {
				type: 'result',
				// Keyed on `is_error`, never on `subtype`: auth, key and model errors
				// arrive as `subtype: "success"`.
				isError: message.is_error === true,
				subtype: text(message.subtype),
				terminalReason: text(message.terminal_reason),
				message: text(message.result) || first || '',
				sessionId: text(message.session_id),
			};
		}
		case 'control_request': {
			const requestId = text(message.request_id);
			const request = record(message.request);
			if (!requestId || !request) return { type: 'other' };
			if (request.subtype === 'can_use_tool') {
				return { type: 'permission', request: toolRequest(requestId, request) };
			}
			return { type: 'control', requestId, subtype: text(request.subtype) };
		}
		case 'control_cancel_request': {
			const requestId = text(message.request_id);
			return requestId ? { type: 'cancel', requestId } : { type: 'other' };
		}
		case 'control_response': {
			const response = record(message.response);
			const requestId = text(response?.request_id);
			return requestId ? { type: 'response', requestId, ok: response?.subtype === 'success' } : { type: 'other' };
		}
		default:
			return { type: 'other' };
	}
}

function toolRequest(requestId: string, request: Record<string, unknown>): ToolPermissionRequest {
	const toolName = text(request.tool_name);
	const suggestions = Array.isArray(request.permission_suggestions)
		? (request.permission_suggestions as unknown[]).filter(
				(entry): entry is PermissionUpdate => record(entry) !== null && typeof record(entry)?.type === 'string',
			)
		: [];
	return {
		requestId,
		toolName,
		displayName: text(request.display_name) || toolName,
		input: record(request.input) ?? {},
		toolUseId: text(request.tool_use_id),
		suggestions,
		description: text(request.description),
		decisionReason: text(request.decision_reason),
		blockedPath: text(request.blocked_path),
	};
}

/** The tool a question arrives under. */
const ASK_USER_QUESTION = 'AskUserQuestion';
/** The tool plan approval arrives under. */
const EXIT_PLAN_MODE = 'ExitPlanMode';

/** Session-scoped suggestions: what "Allow for this session" sends. */
export function sessionSuggestions(request: ToolPermissionRequest): PermissionUpdate[] {
	return request.suggestions.filter((update) => update.destination === 'session');
}

/** `localSettings` suggestions: what "Always allow in this project" sends. */
export function projectSuggestions(request: ToolPermissionRequest): PermissionUpdate[] {
	return request.suggestions.filter((update) => update.destination === 'localSettings');
}

/** The file a `localSettings` grant is written to (spike: measured). */
export function localSettingsFile(cwd: string): string {
	return `${cwd.replace(/\/+$/, '')}/.claude/settings.local.json`;
}

function rule(entry: { toolName?: unknown; ruleContent?: unknown }): string {
	const tool = text(entry.toolName);
	const content = text(entry.ruleContent);
	return content ? `${tool}(${content})` : tool;
}

/** One permission update in words, for the line under its button. */
export function describeUpdate(update: PermissionUpdate): string {
	switch (update.type) {
		case 'addRules': {
			const rules = (update.rules ?? []).map(rule).filter(Boolean).join(', ');
			return `${text(update.behavior) || 'allow'} ${rules}`.trim();
		}
		case 'setMode':
			return text(update.mode) === 'acceptEdits' ? 'accept file edits' : `switch to ${text(update.mode)} mode`;
		case 'addDirectories': {
			const directories = Array.isArray(update.directories)
				? (update.directories as unknown[]).filter((entry) => typeof entry === 'string').join(', ')
				: '';
			return `allow access to ${directories}`;
		}
		default:
			return update.type;
	}
}

function grant(updates: PermissionUpdate[]): PendingGrant | null {
	return updates.length > 0 ? { lines: updates.map(describeUpdate) } : null;
}

function questionsOf(input: Record<string, unknown>): PendingQuestion[] {
	const list = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
	const questions: PendingQuestion[] = [];
	for (const entry of list) {
		const question = record(entry);
		if (!question || typeof question.question !== 'string') continue;
		const options = (Array.isArray(question.options) ? (question.options as unknown[]) : [])
			.map(record)
			.filter((option): option is Record<string, unknown> => option !== null && typeof option.label === 'string')
			.map((option) => ({ label: text(option.label), description: text(option.description) }));
		questions.push({
			question: question.question,
			header: text(question.header),
			options,
			multiSelect: question.multiSelect === true,
		});
	}
	return questions;
}

/** A `can_use_tool` request as the waiting card shows it. */
export function pendingRequestOf(request: ToolPermissionRequest, cwd: string): PendingRequest {
	const kind =
		request.toolName === ASK_USER_QUESTION
			? 'question'
			: request.toolName === EXIT_PLAN_MODE
				? 'plan'
				: 'permission';
	const project = grant(projectSuggestions(request));
	const projectGrant: PendingProjectGrant | null = project && cwd ? { ...project, file: localSettingsFile(cwd) } : null;
	const reason = [request.decisionReason, request.blockedPath ? `Path: ${request.blockedPath}` : '']
		.filter(Boolean)
		.join(' ');
	return {
		id: request.requestId,
		kind,
		toolName: request.displayName,
		toolUseId: request.toolUseId,
		input: request.input,
		reason,
		questions: kind === 'question' ? questionsOf(request.input) : [],
		plan: kind === 'plan' ? text(request.input.plan).trim() : '',
		// Questions and plans are the user's to answer; "remember" makes no sense.
		session: kind === 'permission' ? grant(sessionSuggestions(request)) : null,
		project: kind === 'permission' ? projectGrant : null,
	};
}

/**
 * The `can_use_tool` response for an answer, or null when the answer does not
 * fit the request (a grant it was never offered, a plan answer to a question).
 */
export function permissionResponse(
	request: ToolPermissionRequest,
	answer: WaitingAnswer,
): Record<string, unknown> | null {
	// The input exactly as Claude sent it, never rewritten (ADR-0007).
	const updatedInput = request.input;
	switch (answer.type) {
		case 'allow':
		case 'approve-plan':
			return { behavior: 'allow', updatedInput };
		case 'allow-session': {
			const updates = sessionSuggestions(request);
			return updates.length > 0 ? { behavior: 'allow', updatedInput, updatedPermissions: updates } : null;
		}
		case 'allow-project': {
			const updates = projectSuggestions(request);
			return updates.length > 0 ? { behavior: 'allow', updatedInput, updatedPermissions: updates } : null;
		}
		case 'deny':
			return denyResponse(`The user denied permission to use ${request.displayName}.`);
		case 'answer':
			// The one change ever made to the input: the answers, keyed by question.
			return { behavior: 'allow', updatedInput: { ...updatedInput, answers: { ...answer.answers } } };
		case 'dismiss':
			return denyResponse('The user dismissed the question.');
		case 'reject-plan': {
			const feedback = answer.feedback.trim();
			return denyResponse(feedback ? `The user rejected the plan: ${feedback}` : 'The user rejected the plan.');
		}
	}
}
