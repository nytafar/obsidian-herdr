/**
 * The `claude` kind's stream-json protocol (ADR-0007): the argv, the strict
 * writer, the reading of Claude's lines and the JSON each waiting-card answer
 * becomes. The lines read here are the spike's captured ones
 * (`findings/direct-claude-spike.md`), trimmed.
 */

import { describe, expect, it } from 'vitest';
import {
	claudeArgv,
	controlResponse,
	describeUpdate,
	encodeLine,
	interruptRequest,
	localSettingsFile,
	parseStreamLine,
	pendingRequestOf,
	permissionResponse,
	userMessage,
	type ToolPermissionRequest,
} from '../src/claude/protocol';

const SESSION = '3b3ad50c-0000-4000-8000-000000000001';
const CWD = '/tmp/oh-direct-perms2';

function permission(line: object): ToolPermissionRequest {
	const event = parseStreamLine(JSON.stringify(line));
	if (event?.type !== 'permission') throw new Error(`not a permission: ${JSON.stringify(event)}`);
	return event.request;
}

const BASH_REQUEST = {
	type: 'control_request',
	request_id: 'bash-1',
	request: {
		subtype: 'can_use_tool',
		tool_name: 'Bash',
		display_name: 'Bash',
		input: { command: 'touch one.txt' },
		tool_use_id: 'toolu_01',
		permission_suggestions: [
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch one.txt' }], behavior: 'allow', destination: 'localSettings' },
			{ type: 'addDirectories', directories: [CWD], destination: 'session' },
			{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
			{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
		],
		blocked_path: `${CWD}/one.txt`,
	},
};

const QUESTION_REQUEST = {
	type: 'control_request',
	request_id: 'bec16b12',
	request: {
		subtype: 'can_use_tool',
		tool_name: 'AskUserQuestion',
		display_name: 'AskUserQuestion',
		input: {
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
		tool_use_id: 'toolu_01L2',
		requires_user_interaction: true,
	},
};

const PLAN_REQUEST = {
	type: 'control_request',
	request_id: '9c9462c1',
	request: {
		subtype: 'can_use_tool',
		tool_name: 'ExitPlanMode',
		input: { plan: '1. Write hello.txt.\n2. Read it back.\n', planFilePath: '/home/lasse/.claude/plans/x.md' },
		tool_use_id: 'toolu_014M',
		requires_user_interaction: true,
	},
};

describe('claudeArgv', () => {
	it('starts a new session with the plugin-generated id and every stream flag', () => {
		expect(claudeArgv({ binary: '/usr/bin/claude', sessionId: SESSION, resume: false, permissionMode: 'default' })).toEqual([
			'/usr/bin/claude',
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--permission-prompt-tool',
			'stdio',
			'--permission-mode',
			'default',
			'--session-id',
			SESSION,
		]);
	});

	it('resumes with --resume, in the configured mode, extra arguments last', () => {
		const argv = claudeArgv({
			binary: 'claude',
			sessionId: SESSION,
			resume: true,
			permissionMode: 'acceptEdits',
			extraArgs: ['--model', 'haiku'],
		});
		expect(argv.slice(-6)).toEqual(['--permission-mode', 'acceptEdits', '--resume', SESSION, '--model', 'haiku']);
		expect(argv).not.toContain('--session-id');
	});

	it('refuses an id that is not a UUID', () => {
		expect(() => claudeArgv({ binary: 'claude', sessionId: 'x; rm -rf', resume: false, permissionMode: 'default' })).toThrow();
	});
});

describe('the strict writer', () => {
	it('is one JSON object and a newline, newlines inside strings escaped', () => {
		const line = encodeLine(userMessage('two\nlines'));
		expect(line).toBe('{"type":"user","message":{"role":"user","content":"two\\nlines"}}\n');
		expect(line.indexOf('\n')).toBe(line.length - 1);
		expect(JSON.parse(line)).toEqual(userMessage('two\nlines'));
	});

	it('refuses anything that is not one object', () => {
		expect(() => encodeLine([])).toThrow();
		expect(() => encodeLine(null as unknown as object)).toThrow();
		expect(() => encodeLine('text' as unknown as object)).toThrow();
		expect(() => encodeLine({ toJSON: () => undefined })).toThrow();
	});

	it('builds the interrupt request the SDK sends', () => {
		expect(interruptRequest('int-1')).toEqual({
			type: 'control_request',
			request_id: 'int-1',
			request: { subtype: 'interrupt' },
		});
	});
});

describe('parseStreamLine', () => {
	it('reads the session from system:init', () => {
		expect(
			parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: '392262aa', permissionMode: 'default' })),
		).toEqual({ type: 'init', sessionId: '392262aa', permissionMode: 'default' });
	});

	it('keys errors on is_error, not on subtype', () => {
		const event = parseStreamLine(
			JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: true,
				result: 'Not logged in · Please run /login',
				terminal_reason: 'api_error',
				api_error_status: null,
			}),
		);
		expect(event).toMatchObject({ type: 'result', isError: true, terminalReason: 'api_error', message: 'Not logged in · Please run /login' });
	});

	it('takes the first of errors when a result has no text', () => {
		const event = parseStreamLine(
			JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (1)'], terminal_reason: 'max_turns' }),
		);
		expect(event).toMatchObject({ isError: true, message: 'Reached maximum number of turns (1)' });
	});

	it('reads can_use_tool, cancels, other control requests, and drops the rest', () => {
		expect(permission(BASH_REQUEST)).toMatchObject({ requestId: 'bash-1', toolName: 'Bash', toolUseId: 'toolu_01' });
		expect(parseStreamLine('{"type":"control_cancel_request","request_id":"d93e1a56"}')).toEqual({ type: 'cancel', requestId: 'd93e1a56' });
		expect(parseStreamLine('{"type":"control_request","request_id":"h1","request":{"subtype":"hook_callback"}}')).toEqual({
			type: 'control',
			requestId: 'h1',
			subtype: 'hook_callback',
		});
		expect(parseStreamLine('{"type":"system","subtype":"hook_response","output":"/last30days: Ready"}')).toEqual({ type: 'other' });
		expect(parseStreamLine('{"type":"stream_event","event":{"type":"message_start"}}')).toEqual({ type: 'other' });
		expect(parseStreamLine('not json')).toBeNull();
	});
});

describe('the waiting card model of a request', () => {
	it('offers the session grants and names the local settings file for the project one', () => {
		const pending = pendingRequestOf(permission(BASH_REQUEST), CWD);
		expect(pending.kind).toBe('permission');
		expect(pending.session?.lines).toEqual([`allow access to ${CWD}`, 'accept file edits']);
		expect(pending.project).toEqual({ lines: ['allow Bash(touch one.txt)'], file: `${CWD}/.claude/settings.local.json` });
		expect(pending.reason).toContain(`${CWD}/one.txt`);
		expect(localSettingsFile(`${CWD}/`)).toBe(`${CWD}/.claude/settings.local.json`);
	});

	it('reads the questions and the plan, and offers no grants for them', () => {
		const question = pendingRequestOf(permission(QUESTION_REQUEST), CWD);
		expect(question.kind).toBe('question');
		expect(question.questions).toEqual([
			{
				question: 'Which colour do you prefer?',
				header: 'Colour',
				options: [
					{ label: 'Red', description: 'Select red as your preferred colour.' },
					{ label: 'Blue', description: 'Select blue as your preferred colour.' },
				],
				multiSelect: false,
			},
		]);
		expect(question.session).toBeNull();
		const plan = pendingRequestOf(permission(PLAN_REQUEST), CWD);
		expect(plan.kind).toBe('plan');
		expect(plan.plan).toBe('1. Write hello.txt.\n2. Read it back.');
	});

	it('describes a mode change other than accept edits', () => {
		expect(describeUpdate({ type: 'setMode', mode: 'plan', destination: 'session' })).toBe('switch to plan mode');
	});
});

describe('the response JSON of each answer', () => {
	const bash = permission(BASH_REQUEST);
	interface Sent {
		type: string;
		response: { subtype: string; request_id: string; response: Record<string, unknown> & { updatedPermissions?: unknown; message?: unknown } };
	}
	const respond = (request: ToolPermissionRequest, answer: Parameters<typeof permissionResponse>[1]): Sent => {
		const response = permissionResponse(request, answer);
		if (!response) throw new Error('no response');
		return JSON.parse(encodeLine(controlResponse(request.requestId, response))) as Sent;
	};

	it('allows with the input unchanged', () => {
		expect(respond(bash, { type: 'allow' })).toEqual({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: 'bash-1',
				response: { behavior: 'allow', updatedInput: { command: 'touch one.txt' } },
			},
		});
	});

	it('denies with a message', () => {
		expect(respond(bash, { type: 'deny' }).response.response).toEqual({
			behavior: 'deny',
			message: 'The user denied permission to use Bash.',
		});
	});

	it('allows for the session with the session suggestions only', () => {
		expect(respond(bash, { type: 'allow-session' }).response.response).toEqual({
			behavior: 'allow',
			updatedInput: { command: 'touch one.txt' },
			updatedPermissions: [
				{ type: 'addDirectories', directories: [CWD], destination: 'session' },
				{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
			],
		});
	});

	it('always allows in the project with the localSettings suggestion only, never userSettings', () => {
		const response = respond(bash, { type: 'allow-project' }).response.response;
		expect(response.updatedPermissions).toEqual([
			{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch one.txt' }], behavior: 'allow', destination: 'localSettings' },
		]);
		expect(JSON.stringify(response)).not.toContain('userSettings');
	});

	it('refuses a grant that was not suggested', () => {
		const write = permission({
			...BASH_REQUEST,
			request: { ...BASH_REQUEST.request, tool_name: 'Write', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
		});
		expect(permissionResponse(write, { type: 'allow-project' })).toBeNull();
	});

	it('answers a question by adding answers and nothing else', () => {
		const question = permission(QUESTION_REQUEST);
		const response = respond(question, { type: 'answer', answers: { 'Which colour do you prefer?': 'Blue' } }).response.response;
		expect(response).toEqual({
			behavior: 'allow',
			updatedInput: { ...QUESTION_REQUEST.request.input, answers: { 'Which colour do you prefer?': 'Blue' } },
		});
		// The request's own input is not written to.
		expect(question.input).not.toHaveProperty('answers');
	});

	it('dismisses a question with a deny', () => {
		expect(respond(permission(QUESTION_REQUEST), { type: 'dismiss' }).response.response).toEqual({
			behavior: 'deny',
			message: 'The user dismissed the question.',
		});
	});

	it('approves a plan with its input, and rejects it with the feedback', () => {
		const plan = permission(PLAN_REQUEST);
		expect(respond(plan, { type: 'approve-plan' }).response.response).toEqual({
			behavior: 'allow',
			updatedInput: PLAN_REQUEST.request.input,
		});
		expect(respond(plan, { type: 'reject-plan', feedback: ' also add a second line ' }).response.response).toEqual({
			behavior: 'deny',
			message: 'The user rejected the plan: also add a second line',
		});
		expect(respond(plan, { type: 'reject-plan', feedback: '' }).response.response.message).toBe('The user rejected the plan.');
	});
});
