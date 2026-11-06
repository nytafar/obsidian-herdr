/**
 * Claude Code's agent format (issue #137, ADR-0010): everything the native
 * view knows about Claude's sessions, behind the agent seam (`../format.ts`).
 *
 * The parser is `./transcript.ts`, the session's files `./paths.ts`, the plan
 * file `./planFile.ts`, the `/` list `./commands.ts` and its dialogs as the
 * screen shows them `./screenDialog.ts`. What is here is the
 * rest: the dialogs Claude blocks on as tool calls (`AskUserQuestion`,
 * `ExitPlanMode`), its tool names and where a subagent's report is. Its
 * subagents, for following one while it works, are `./subagents.ts`.
 */

import type { AgentFormat, PendingCall, PlanReader } from '../format';
import type { PendingQuestionOption } from '../../native/pendingRequest';
import type { ToolEntry, ToolKind } from '../../native/conversation';
import type { ModeLabel, SettingChoice } from '../../native/sessionSettings';
import { builtinCatalog, LocalCommandCatalog } from './commands';
import { subagentTranscript, transcriptPath } from './paths';
import { PlanTracker, planFilePath } from './planFile';
import { CLAUDE_SCREEN_SETTINGS, parseClaudeScreen } from './screenDialog';
import { claudeSubagents, claudeWrittenAt } from './subagents';
import {
	CLAUDE_EFFORTS,
	CLAUDE_MODES,
	claudeParser,
	lastAssistantText,
	transcriptImage,
	type TranscriptState,
} from './transcript';

/** The tool a question blocks under; its answers are the dialog's options. */
const ASK_USER_QUESTION = 'AskUserQuestion';
/** The tool plan approval blocks under; its `plan` is what the dialog shows. */
const EXIT_PLAN_MODE = 'ExitPlanMode';

/**
 * Tool name (lower-cased) to kind. The names are the ones Claude Code 2.1.266
 * writes, counted over every transcript on this machine on 2026-09-15, plus the
 * older `Task` spelling of `Agent` and the edit variants.
 */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
	bash: 'bash',
	read: 'read',
	edit: 'edit',
	multiedit: 'edit',
	notebookedit: 'edit',
	write: 'write',
	grep: 'grep',
	glob: 'glob',
	webfetch: 'webfetch',
	websearch: 'websearch',
	todowrite: 'todo',
	agent: 'agent',
	task: 'agent',
	askuserquestion: 'question',
};

function firstOf(value: unknown): unknown {
	return Array.isArray(value) ? ((value as unknown[])[0] ?? null) : null;
}

/** One string field of a call's input, trimmed; empty when it is not a string. */
function textField(entry: ToolEntry, field: string): string {
	const value = entry.input[field];
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * The question an `AskUserQuestion` call is blocked on, and the answers it
 * offered.
 *
 * The **first** question: the input is a list, and a call that asks several
 * shows them one dialog at a time in the terminal, which is where the rest are
 * answered anyway. The card's job is to say what the block is, not to be the
 * dialog.
 */
function firstQuestion(entry: ToolEntry): { question: string; options: PendingQuestionOption[] } {
	const first = firstOf(entry.input.questions);
	if (!first || typeof first !== 'object') return { question: '', options: [] };
	const asked: unknown = (first as { question?: unknown }).question;
	const offered: unknown = (first as { options?: unknown }).options;
	const options: PendingQuestionOption[] = [];
	for (const option of Array.isArray(offered) ? (offered as unknown[]) : []) {
		if (!option || typeof option !== 'object') continue;
		const { label, description } = option as { label?: unknown; description?: unknown };
		if (typeof label !== 'string' || label === '') continue;
		options.push({ label, description: typeof description === 'string' ? description.trim() : '' });
	}
	return { question: typeof asked === 'string' ? asked.trim() : '', options };
}

/** What a dangling Claude call asks: a question, a plan, or nothing beyond its tool. */
function pendingCall(call: ToolEntry): PendingCall | null {
	if (call.name === ASK_USER_QUESTION) return { kind: 'question', ...firstQuestion(call) };
	if (call.name === EXIT_PLAN_MODE) return { kind: 'plan', plan: textField(call, 'plan') };
	return null;
}

/** Tool names of a subagent call. */
const AGENT_TOOL = /^(agent|task)$/i;

/** The plan file Claude writes before it asks (#148), followed line by line. */
function planReader(): PlanReader {
	const tracker = new PlanTracker();
	return {
		feed: (lines) => tracker.feed(lines),
		reset: () => tracker.reset(),
		get planMode() {
			return tracker.planMode;
		},
		file: (transcript) => planFilePath(transcript, tracker.slug),
	};
}

/**
 * The models the session bar offers (#161), by the alias `/model` and
 * `set_model` take (measured on 2.1.318, `docs/architecture.md`, "Model,
 * effort, permission mode and context"). Which ones an account may use is
 * Claude's to say: a model it refuses is a notice with Claude's words.
 */
export const CLAUDE_MODELS: readonly SettingChoice[] = [
	{ value: 'opus', label: 'Opus' },
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'haiku', label: 'Haiku' },
	{ value: 'fable', label: 'Fable' },
];

/**
 * What the session bar calls each mode: Claude's own footer says "manual
 * mode" for `default`, which `--permission-mode manual` also starts.
 */
export const CLAUDE_MODE_LABELS: Readonly<Record<string, ModeLabel>> = {
	default: { label: 'Manual', short: 'Manual' },
	manual: { label: 'Manual', short: 'Manual' },
	acceptEdits: { label: 'Accept edits', short: 'Edits' },
	plan: { label: 'Plan', short: 'Plan' },
	auto: { label: 'Auto', short: 'Auto' },
	dontAsk: { label: "Don't ask", short: "Don't ask" },
	bypassPermissions: { label: 'Bypass permissions', short: 'Bypass' },
};

/** Claude Code's format, as the registry in `../format.ts` lists it. */
export const CLAUDE_FORMAT: AgentFormat<TranscriptState> = {
	agent: 'claude',
	name: 'Claude',
	parser: claudeParser,
	transcriptPath,
	readImage: (transcript, image) => transcriptImage(transcript, image.record, image.index),
	pendingCall,
	reports: {
		// Only a subagent has a report; a background command's output file is
		// its stdout, which the tool group already accounts for. The
		// notification says whose it is (#135). The file it names first, then
		// the subagent's transcript beside the session's own.
		paths: (call, transcript) => {
			const notification = call.notification;
			if (!notification || notification.kind === 'command' || !AGENT_TOOL.test(call.name.trim())) return [];
			return [notification.outputFile, subagentTranscript(transcript, notification.taskId)].filter(Boolean);
		},
		read: lastAssistantText,
		subagents: claudeSubagents,
		writtenAt: claudeWrittenAt,
	},
	plan: planReader,
	toolKinds: TOOL_KINDS,
	commands: {
		builtin: builtinCatalog,
		local: () => new LocalCommandCatalog(),
	},
	sessionInfo: (state) => state.info,
	efforts: CLAUDE_EFFORTS,
	modes: CLAUDE_MODES,
	models: CLAUDE_MODELS,
	modeLabels: CLAUDE_MODE_LABELS,
	screenDialog: parseClaudeScreen,
	screenSettings: CLAUDE_SCREEN_SETTINGS,
	// Its output is read into `SessionInfo.contextReport`, never a turn (#171).
	contextCommand: '/context',
};
