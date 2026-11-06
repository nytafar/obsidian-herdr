#!/usr/bin/env node
/**
 * Stands in for `claude -p --input-format stream-json --output-format
 * stream-json …` in the `claude` kind's tests (ADR-0007).
 *
 * Every message it writes is a shape copied from the captured stream in the
 * finding `direct-claude-spike` (trimmed, ids made up): hook events and a
 * banner at start, `system:init` only once a prompt arrives, `can_use_tool`
 * control requests for the prompts below, `control_cancel_request` and the
 * interrupt's own response, `conversation_reset` and a fresh init on
 * `/clear`, and `result` lines with `is_error` the way the CLI sends them.
 *
 * A prompt picks the behaviour by keyword:
 *   WRITE  a Write permission (suggestion: setMode acceptEdits, session)
 *   BASH   a Bash permission (addRules localSettings, addDirectories and setMode session)
 *   ASK    an AskUserQuestion
 *   PLAN   an ExitPlanMode
 *   SLOW   a turn that runs until it is interrupted
 *   FAIL   `result` success with `is_error` (not logged in)
 *   HOOK   a control request of a subtype nobody declared (`hook_callback`)
 *   /clear rotates the session id
 *   anything else: one assistant text and `result` success
 *
 * A stdin line that is not JSON kills it with exit 1 and the CLI's stderr
 * line, as the real one does. stdin EOF ends it once the running turn is
 * over. Each session writes `~/.claude/projects/<enc cwd>/<id>.jsonl` under
 * `FAKE_CLAUDE_HOME` on its first prompt, so a later start can `--resume`.
 *
 * Env: FAKE_CLAUDE_LOG=<file> appends `{"argv":…,"cwd":…}` once and every
 * stdin line it reads, one JSON per line, for the tests to read back.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
const record = (value) => {
	if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
};
record({ argv, cwd: process.cwd() });

const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
let session = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const permissionMode = flag('--permission-mode') ?? 'default';

const send = (message) => process.stdout.write(`${JSON.stringify({ ...message, session_id: session })}\n`);

/** The request the fake waits on, with what it asked. */
let pending = null;
/** The running turn's interrupt hook, while one runs. */
let running = null;
let ended = false;
let busy = false;
let requestSeq = 0;
const queue = [];

function writeTranscript(prompt) {
	const home = process.env.FAKE_CLAUDE_HOME;
	if (!home) return;
	const dir = `${home}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}`;
	mkdirSync(dir, { recursive: true });
	appendFileSync(
		`${dir}/${session}.jsonl`,
		`${JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: prompt } })}\n`,
	);
}

function result(fields = {}) {
	send({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'ok',
		num_turns: 1,
		credential_expires_at: '2026-12-02T18:07:48.095Z',
		...fields,
	});
}

function finishTurn() {
	busy = false;
	running = null;
	pending = null;
	next();
}

function init() {
	send({ type: 'system', subtype: 'init', cwd: process.cwd(), permissionMode, slash_commands: ['clear', 'compact'] });
}

function ask(tool, input, extra = {}) {
	const requestId = `req-${++requestSeq}`;
	pending = { requestId, tool, input };
	send({
		type: 'control_request',
		request_id: requestId,
		request: {
			subtype: 'can_use_tool',
			tool_name: tool,
			display_name: tool,
			input,
			tool_use_id: `toolu_${requestSeq}`,
			...extra,
		},
	});
}

function startTurn(text) {
	busy = true;
	if (text === '/clear') {
		const old = session;
		send({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear', session_id: old });
		session = randomUUID();
		send({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:clear', output: '' });
		init();
		result({ result: '', num_turns: 0, total_cost_usd: 0 });
		finishTurn();
		return;
	}
	writeTranscript(text);
	init();
	if (text.includes('WRITE')) {
		ask(
			'Write',
			{ file_path: `${process.cwd()}/hello.txt`, content: 'hi\n' },
			{ permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], description: 'hello.txt' },
		);
		return;
	}
	if (text.includes('BASH')) {
		ask(
			'Bash',
			{ command: 'touch one.txt', description: 'Create one.txt' },
			{
				permission_suggestions: [
					{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch one.txt' }], behavior: 'allow', destination: 'localSettings' },
					{ type: 'addDirectories', directories: [process.cwd()], destination: 'session' },
					{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
					{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
				],
				blocked_path: `${process.cwd()}/one.txt`,
			},
		);
		return;
	}
	if (text.includes('ASK')) {
		ask(
			'AskUserQuestion',
			{
				questions: [
					{
						question: 'Which colour do you prefer?',
						header: 'Colour',
						options: [
							{ label: 'Red', description: 'Select red as your preferred colour.' },
							{ label: 'Blue', description: 'Select blue as your preferred colour.' },
						],
						multiSelect: false,
					},
				],
			},
			{ requires_user_interaction: true },
		);
		return;
	}
	if (text.includes('PLAN')) {
		ask(
			'ExitPlanMode',
			{ plan: '1. Write hello.txt.\n2. Read it back.\n', planFilePath: '/tmp/plan.md' },
			{ requires_user_interaction: true },
		);
		return;
	}
	if (text.includes('SLOW')) {
		const timer = setInterval(() => {
			send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one ' } } });
		}, 20);
		running = () => {
			clearInterval(timer);
			send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one one' }] } });
			send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
			send({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				stop_reason: null,
				terminal_reason: 'aborted_streaming',
				errors: ['[ede_diagnostic] result_type=user'],
			});
			finishTurn();
		};
		return;
	}
	if (text.includes('HOOK')) {
		send({ type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback', callback_id: 'x' } });
		result();
		finishTurn();
		return;
	}
	if (text.includes('FAIL')) {
		send({
			type: 'assistant',
			message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in' }] },
			error: 'authentication_failed',
		});
		result({ is_error: true, result: 'Not logged in · Please run /login', terminal_reason: 'api_error', api_error_status: null });
		finishTurn();
		return;
	}
	send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
	result();
	finishTurn();
}

function next() {
	if (busy) return;
	const text = queue.shift();
	if (text !== undefined) {
		startTurn(text);
		return;
	}
	if (ended) setTimeout(() => process.exit(0), 20);
}

function answer(response) {
	const request = pending;
	if (!request || response.request_id !== request.requestId) return;
	const behaviour = response.response?.behavior;
	pending = null;
	send({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					content: behaviour === 'allow' ? 'done' : (response.response?.message ?? 'denied'),
					is_error: behaviour !== 'allow',
					tool_use_id: `toolu_${requestSeq}`,
				},
			],
		},
	});
	result();
	finishTurn();
}

function control(message) {
	const request = message.request ?? {};
	if (request.subtype === 'interrupt') {
		if (pending) {
			send({ type: 'control_cancel_request', request_id: pending.requestId });
			pending = null;
			send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } });
			result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: undefined });
			finishTurn();
			return;
		}
		send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } });
		running?.();
		return;
	}
	send({
		type: 'control_response',
		response: { subtype: 'error', request_id: message.request_id, error: `Unsupported control request subtype: ${request.subtype}` },
	});
}

send({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
send({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', output: '/last30days: Ready — 9 sources active' });

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			process.stderr.write(`Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError\n`);
			process.exit(1);
		}
		record({ stdin: message });
		if (message.type === 'user') {
			queue.push(typeof message.message?.content === 'string' ? message.message.content : '');
			next();
		} else if (message.type === 'control_response') {
			answer(message.response ?? {});
		} else if (message.type === 'control_request') {
			control(message);
		}
	}
});
process.stdin.on('end', () => {
	ended = true;
	next();
});
