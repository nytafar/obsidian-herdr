/**
 * The agent seam's registry and gate (issue #137, ADR-0010): which agents
 * have a format, which runtime kinds can vouch for which agent's session,
 * and that the + menu's catalog, the settings and the native view read the
 * one answer. Also Claude's format: the parts that moved behind the seam
 * from the view (the dialogs Claude blocks on, its background reports) and
 * the session info it reads.
 */

import { describe, expect, it } from 'vitest';
import {
	agentFormat,
	formatAgents,
	nativeSupport,
	offersNativeView,
	toolKindOf,
} from '../src/agents/format';
import { CLAUDE_FORMAT } from '../src/agents/claude/format';
import { emptyTranscript, reduce } from '../src/agents/claude/transcript';
import { AGENT_SESSIONS, sessionBinding } from '../src/runtime/kind';
import { buildCatalog, defaultAgentFormat, type AgentCatalogSettings } from '../src/agents/catalog';
import { nativeAgentReason } from '../src/native/agentSupport';
import { mergeSessionInfo, type ToolEntry } from '../src/native/conversation';
import type { RuntimeKind } from '../src/runtimes';

const SETTINGS: AgentCatalogSettings = { agentProfiles: [], hiddenAgents: [], defaultAgents: {} };

function call(name: string, input: Record<string, unknown> = {}, extra: Partial<ToolEntry> = {}): ToolEntry {
	return { kind: 'tool', id: 't1', name, input, result: null, status: 'pending', notification: null, report: null, ...extra };
}

describe('the registry', () => {
	it('has a format for Claude alone, keyed by the agent catalog’s id', () => {
		expect(formatAgents()).toEqual(['claude']);
		expect(agentFormat('claude')).toBe(CLAUDE_FORMAT);
		expect(agentFormat(' Claude ')).toBe(CLAUDE_FORMAT);
		expect(agentFormat('codex')).toBeNull();
		expect(agentFormat(null)).toBeNull();
		expect(defaultAgentFormat()).toBe(CLAUDE_FORMAT);
	});

	it('shows a tool by the tables of the formats, and anything else as other', () => {
		expect(toolKindOf('TodoWrite')).toBe('todo');
		expect(toolKindOf(' task ')).toBe('agent');
		expect(toolKindOf('exec')).toBe('other');
	});
});

describe('the gate: a format, and a session the runtime can vouch for', () => {
	it('takes Claude’s session as trusted on every runtime kind', () => {
		for (const kind of ['herdr', 'herdr-core', 'claude'] as RuntimeKind[]) {
			expect(sessionBinding(kind, 'claude')).toBe('trusted');
			expect(offersNativeView(kind, 'claude')).toBe(true);
		}
	});

	it('holds herdr’s Codex session a hint and herdr-core’s absent, so neither is offered', () => {
		expect(AGENT_SESSIONS.herdr.codex).toBe('hint');
		expect(nativeSupport('herdr', 'codex')).toEqual({ format: null, binding: 'hint' });
		expect(nativeSupport('herdr-core', 'codex')).toEqual({ format: null, binding: 'absent' });
		expect(sessionBinding('herdr', 'opencode')).toBe('absent');
		expect(offersNativeView('herdr', 'codex')).toBe(false);
		expect(offersNativeView('herdr', '')).toBe(false);
	});

	it('words the terminal fallback for an agent with no format, as before', () => {
		expect(nativeAgentReason('herdr', 'codex')).toBe('this pane runs Codex, and the native view reads only Claude');
		expect(nativeAgentReason('herdr-core', 'gemini')).toBe('this pane runs Gemini, and the native view reads only Claude');
		expect(nativeAgentReason('herdr', 'claude')).toBeNull();
		expect(nativeAgentReason('herdr', undefined)).toBeNull();
	});
});

describe('the catalog’s native flag', () => {
	it('comes from the gate for the runtime’s kind: Claude has it, Codex does not', () => {
		const runtime = { id: 'local', kind: 'herdr' as const, target: 'local' as const, host: '' };
		const catalog = buildCatalog({ runtime, settings: SETTINGS, probe: null });
		const byId = new Map(catalog.map((entry) => [entry.profile.id, entry]));
		expect(byId.get('claude')?.native).toBe(true);
		expect(byId.get('codex')?.native).toBe(false);
	});

	it('follows the agent of a user entry, on every kind that can start it', () => {
		const settings: AgentCatalogSettings = {
			...SETTINGS,
			agentProfiles: [
				{ id: 'user-a', name: 'Wrapped', agent: 'claude', command: 'claude-wrap', args: [] },
				{ id: 'user-b', name: 'Work', agent: 'codex', command: '', args: ['--profile', 'work'] },
			],
		};
		const runtime = { id: 'rt', kind: 'herdr-core' as const, target: 'local' as const, host: '' };
		const catalog = buildCatalog({ runtime, settings, probe: null });
		expect(catalog.find((entry) => entry.profile.id === 'user-a')?.native).toBe(true);
		expect(catalog.find((entry) => entry.profile.id === 'user-b')?.native).toBe(false);
	});
});

describe('Claude’s format', () => {
	it('reads the dialogs Claude blocks on off the call', () => {
		const question = call('AskUserQuestion', {
			questions: [{ question: ' Which one? ', options: [{ label: 'A', description: ' first ' }, { label: '' }] }],
		});
		expect(CLAUDE_FORMAT.pendingCall(question)).toEqual({
			kind: 'question',
			question: 'Which one?',
			options: [{ label: 'A', description: 'first' }],
		});
		expect(CLAUDE_FORMAT.pendingCall(call('ExitPlanMode', { plan: ' 1. Do it. ' }))).toEqual({
			kind: 'plan',
			plan: '1. Do it.',
		});
		expect(CLAUDE_FORMAT.pendingCall(call('Bash', { command: 'ls' }))).toBeNull();
	});

	it('finds a background subagent’s report where Claude keeps it, and no command’s', () => {
		const transcript = '/home/u/.claude/projects/-p/s1.jsonl';
		const notified = call('Agent', {}, { notification: { taskId: 'a1', kind: 'agent', outputFile: '/tmp/a1.output' } });
		expect(CLAUDE_FORMAT.reports?.paths(notified, transcript)).toEqual([
			'/tmp/a1.output',
			'/home/u/.claude/projects/-p/s1/subagents/agent-a1.jsonl',
		]);
		const command = call('Bash', {}, { notification: { taskId: 'b1', kind: 'command', outputFile: '/tmp/b1' } });
		expect(CLAUDE_FORMAT.reports?.paths(command, transcript)).toEqual([]);
		expect(CLAUDE_FORMAT.reports?.paths(call('Agent'), transcript)).toEqual([]);
	});

	it('reads model, effort, mode and the context in use from the main chain (#110, #111)', () => {
		const lines = [
			{ type: 'user', uuid: 'u1', permissionMode: 'acceptEdits', origin: {}, message: { role: 'user', content: 'Go' } },
			{ type: 'attachment', uuid: 'm1', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5', marketingName: 'Opus 5.5' } } },
			{
				type: 'assistant',
				uuid: 'a1',
				effort: 'high',
				message: {
					id: 'msg_1',
					model: 'claude-opus-5-5',
					content: [{ type: 'text', text: 'Done.' }],
					usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 22340, output_tokens: 5 },
				},
			},
			{
				type: 'assistant',
				uuid: 'a2',
				isSidechain: true,
				message: { id: 'msg_2', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
			},
		].map((line) => JSON.stringify(line));
		const { state } = reduce(emptyTranscript(), lines);
		expect(CLAUDE_FORMAT.sessionInfo(state)).toEqual({
			model: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
			effort: 'high',
			permissionMode: 'acceptEdits',
			contextUsed: 22550,
			usage: { input: 22550, output: 5, cached: 22340 },
		});
		expect(CLAUDE_FORMAT.efforts).toContain('xhigh');
		expect(CLAUDE_FORMAT.modes).toContain('plan');
	});

	it('lets the runtime’s word win per field, and keeps the reading where it says nothing', () => {
		const read = { model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }, effort: 'high' };
		expect(mergeSessionInfo(read, undefined)).toBe(read);
		expect(mergeSessionInfo(read, { effort: undefined })).toBe(read);
		expect(mergeSessionInfo(read, { effort: 'low', contextWindow: { tokens: 1000000, source: 'runtime' } })).toEqual({
			model: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
			effort: 'low',
			contextWindow: { tokens: 1000000, source: 'runtime' },
		});
	});
});
