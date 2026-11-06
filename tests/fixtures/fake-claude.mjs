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
 *   STEER  a tool call that runs until the next message arrives, which is
 *          absorbed into this turn at the tool's end: one `result` answers
 *          both (`user_message_uuids` names them), as Claude 2.1.318 does
 *   DROPPED a message cancelled while queued (`command_lifecycle`
 *          `cancelled`), as when another client withdraws it; it never runs
 *          and gets no result, and a STEER turn waiting for it ends alone
 *   FAIL   `result` success with `is_error` (not logged in)
 *   HOOK   a control request of a subtype nobody declared (`hook_callback`)
 *   /clear rotates the session id
 *   anything else: one assistant text and `result` success
 *
 * A stdin line that is not JSON kills it with exit 1 and the CLI's stderr
 * line, as the real one does. stdin EOF ends it once the running turn is
 * over. Each session writes `<config>/projects/<enc real cwd>/<id>.jsonl` on
 * its first prompt (and on `/clear`, for the new id), where `<config>` is
 * `CLAUDE_CONFIG_DIR`, else `.claude` under `FAKE_CLAUDE_HOME`, so a later
 * start can `--resume`. With a transcript directory, startup fails the way
 * Claude 2.1.318 does (measured 2026-11-06): `--session-id` of a session that
 * has a transcript exits 1 with "Session ID … is already in use.", and
 * `--resume` of one with none says "No conversation found …" on stderr and
 * in an error `result`, then exits 1, both before reading stdin.
 *
 * A user message sent with a `uuid` gets `command_lifecycle` `queued`, then
 * `started` when its turn takes it, and after its turn's `result` (which
 * lists it in `user_message_uuids`) `completed`, or `cancelled` when the
 * turn failed or was interrupted: the order and shapes of the finding
 * `queued-prompts`. One without a uuid gets none of these.
 *
 * Env: FAKE_CLAUDE_LOG=<file> appends `{"argv":…,"cwd":…}` once and every
 * stdin line it reads, one JSON per line, for the tests to read back.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

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

const configDir =
	process.env.CLAUDE_CONFIG_DIR || (process.env.FAKE_CLAUDE_HOME ? `${process.env.FAKE_CLAUDE_HOME}/.claude` : '');
const transcriptOf = (id) => `${configDir}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`;

const send = (message) => process.stdout.write(`${JSON.stringify({ ...message, session_id: session })}\n`);

/** The request the fake waits on, with what it asked. */
let pending = null;
/** The running turn's interrupt hook, while one runs. */
let running = null;
let ended = false;
let busy = false;
let requestSeq = 0;
/** Messages waiting for a turn: `{ text, uuid }`, uuid null when sent without one. */
const queue = [];
/** The uuids of the messages the running turn has taken, in order. */
let members = [];
/** The running turn's result was an error. */
let failed = false;
/** A STEER turn waiting at its tool call for the next message: called with it. */
let steering = null;

const lifecycle = (uuid, state) => {
	if (uuid) send({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID() });
};

function writeTranscript(prompt) {
	if (!configDir) return;
	const file = transcriptOf(session);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(
		file,
		`${JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: prompt } })}\n`,
	);
}

function result(fields = {}) {
	const named = members.filter(Boolean);
	const answered = named.length ? { user_message_uuid: named[named.length - 1], user_message_uuids: named } : {};
	const line = {
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'ok',
		num_turns: 1,
		credential_expires_at: '2026-12-02T18:07:48.095Z',
		modelUsage: { 'claude-haiku-5-5': { inputTokens: 3, contextWindow: 1000000 } },
		...answered,
		...fields,
	};
	failed = line.is_error === true;
	send(line);
}

function finishTurn() {
	for (const uuid of members) lifecycle(uuid, failed ? 'cancelled' : 'completed');
	members = [];
	failed = false;
	busy = false;
	running = null;
	pending = null;
	steering = null;
	next();
}

function init() {
	send({ type: 'system', subtype: 'init', cwd: process.cwd(), permissionMode, model: 'claude-haiku-5-5', slash_commands: ['clear', 'compact'] });
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

function startTurn({ text, uuid }) {
	busy = true;
	members = [uuid];
	lifecycle(uuid, 'started');
	if (text === '/clear') {
		const old = session;
		send({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear', session_id: old });
		session = randomUUID();
		writeTranscript('/clear');
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
			result({
				subtype: 'error_during_execution',
				is_error: true,
				result: undefined,
				num_turns: undefined,
				credential_expires_at: undefined,
				stop_reason: null,
				terminal_reason: 'aborted_streaming',
				errors: ['[ede_diagnostic] result_type=user'],
			});
			finishTurn();
		};
		return;
	}
	if (text.includes('STEER')) {
		send({
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_steer', name: 'Bash', input: { command: 'sleep 30' } }] },
		});
		steering = (message) => {
			steering = null;
			send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '', tool_use_id: 'toolu_steer' }] } });
			if (message) {
				// Taken in at the tool boundary: the steer.
				queue.splice(queue.indexOf(message), 1);
				lifecycle(message.uuid, 'started');
				members.push(message.uuid);
			}
			running = null;
			send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
			result();
			finishTurn();
		};
		running = () => {
			steering = null;
			result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: undefined });
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
	const message = queue.shift();
	if (message !== undefined) {
		startTurn(message);
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

/** Claude's startup refusals, before it reads anything; null when it starts. */
function refusal() {
	if (!configDir) return null;
	if (flag('--session-id') && existsSync(transcriptOf(session))) {
		return { stderr: `Error: Session ID ${session} is already in use.`, result: false };
	}
	if (flag('--resume') && !existsSync(transcriptOf(session))) {
		return { stderr: `No conversation found with session ID: ${session}`, result: true };
	}
	return null;
}

const refused = refusal();
if (refused) {
	process.stderr.write(`${refused.stderr}\n`);
	if (refused.result) send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [] });
	process.stdout.write('', () => process.exit(1));
} else {
	start();
}

function start() {
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
				const queued = {
					text: typeof message.message?.content === 'string' ? message.message.content : '',
					uuid: typeof message.uuid === 'string' ? message.uuid : null,
				};
				queue.push(queued);
				lifecycle(queued.uuid, 'queued');
				if (busy && queued.text.includes('DROPPED')) {
					queue.splice(queue.indexOf(queued), 1);
					lifecycle(queued.uuid, 'cancelled');
					steering?.(null);
				} else if (steering) {
					steering(queued);
				}
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
}
