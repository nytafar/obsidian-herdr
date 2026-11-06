/**
 * The agent seam (issue #137, ADR-0010): what the native view needs to know
 * of one agent CLI's sessions, beside the runtime seam (`../runtime/kind.ts`)
 * that says how a runtime reaches its panes.
 *
 * A runtime kind says where a pane is, which agent it runs and which session
 * it reports; an **agent format** says what that session's records mean. One
 * format per agent, keyed by the agent catalog's ids (`./catalog.ts`,
 * `BUILTIN_AGENTS`), supplies:
 *
 * - the **parser** into the neutral conversation model
 *   (`../native/conversation.ts`), with state carried across batches;
 * - the **transcript location** for a runtime that names no path;
 * - reading an image's bytes, a **pending request** off a dangling call,
 *   background reports and a plan file, where the agent has them;
 * - its **command catalogue** and its **tool names**;
 * - **session info** (model, effort, usage) from the records read so far.
 *
 * Everything above the seam — surface, turn renderer, table of contents,
 * waiting card, session chrome — depends on the neutral model and on this
 * interface only. Claude Code's format is `./claude/format.ts`.
 *
 * **The gate** is two things, not one (finding `agent-codex`): a format for
 * the pane's agent, and a session binding the runtime can vouch for
 * ({@link nativeSupport}). A runtime that reports a session it may have
 * misattributed (herdr's Codex under the shared daemon) is a hint, and a
 * hint is not enough to show a conversation: it may be another pane's.
 */

import type { CatalogEntry, CommandCatalogSource } from '../native/commandCatalog';
import type {
	ConversationParser,
	ConversationState,
	ImageBytes,
	ImageEntry,
	SessionInfo,
	ToolEntry,
	ToolKind,
} from '../native/conversation';
import type { PendingQuestionOption } from '../native/pendingRequest';
import type { ModeLabel, SettingChoice } from '../native/sessionSettings';
import { sessionBinding, type SessionBinding } from '../runtime/kind';
import type { RuntimeKind } from '../runtimes';
import { CLAUDE_FORMAT } from './claude/format';
import type { ScreenDialog } from './screenDialog';

export type { SessionBinding } from '../runtime/kind';

/** What a runtime reported of a pane's session, for finding its transcript. */
export interface SessionLocation {
	/** The pane's working directory, as the runtime reports it. */
	cwd: string;
	/** The session the runtime reports; empty until the agent has one. */
	agentSession: string;
	/** Home directory of the host the transcript lives on. Defaults to this one. */
	home?: string;
}

/**
 * What a call the agent is blocked on asks, read off the call itself: a
 * question with its options, a plan to approve, or a permission with the
 * reason the agent gave (Codex writes its `justification` into the call).
 */
export type PendingCall =
	| { kind: 'question'; question: string; options: PendingQuestionOption[] }
	| { kind: 'plan'; plan: string }
	| { kind: 'permission'; reason: string };

/**
 * The plan an agent waits to have approved, from a file of its own beside the
 * transcript (#148), for an agent that writes the plan there rather than into
 * the call. Fed every line as it is read, so nothing is read twice.
 */
export interface PlanReader {
	/** Reads more lines, in transcript order. */
	feed(lines: readonly string[]): void;
	/** Forgets everything, for another file or the same one replaced. */
	reset(): void;
	/** Whether the session is planning now. */
	readonly planMode: boolean;
	/** The plan file of the session whose transcript is `transcript`, or null. */
	file(transcript: string): string | null;
}

/**
 * Background work that reports in a file of its own (Claude's async
 * subagents, #96): where to look for one call's report, and how to read it.
 */
export interface BackgroundReports {
	/**
	 * The files that may hold `call`'s report, in the order to try them, on the
	 * transcript's own host; empty when the call has no report to read.
	 */
	paths(call: ToolEntry, transcript: string): string[];
	/** The report in one of those files, '' when it holds none. */
	read(lines: readonly string[]): string;
}

/** The `/` list an agent offers. */
export interface AgentCommands {
	/** The commands the agent carries itself: all a catalogue that cannot be read has. */
	builtin(): CatalogEntry[];
	/** This machine's catalogue, for a pane whose runtime reads no other. */
	local(): CommandCatalogSource;
}

/** One agent CLI's session format. */
export interface AgentFormat<S extends ConversationState = ConversationState> {
	/** The agent catalog's id (`BUILTIN_AGENTS[].kind`): `claude`. */
	readonly agent: string;
	/** What the view calls the agent in a sentence: "Claude". */
	readonly name: string;
	/** Reads the agent's transcript into the neutral model. */
	readonly parser: ConversationParser<S>;
	/**
	 * Where a session's transcript is when the runtime names no path, or null
	 * while there is none to find. Synchronous: an agent whose file is found
	 * by a search (Codex's rollouts under `$CODEX_HOME/sessions`) needs the
	 * search done by whatever reports its session.
	 */
	transcriptPath(session: SessionLocation): string | null;
	/** An image's bytes out of the transcript's text, or null (#144). */
	readImage(transcript: string, image: ImageEntry): ImageBytes | null;
	/**
	 * What the call the agent is blocked on asks, read off its input, or null
	 * when the call says nothing beyond its tool and input (a plain
	 * permission, which the view words from the call).
	 */
	pendingCall(call: ToolEntry): PendingCall | null;
	/** Reports of background work, for an agent that writes them apart. */
	readonly reports?: BackgroundReports;
	/** A fresh plan reader, for an agent that keeps its plan in a file. */
	plan?(): PlanReader;
	/** Tool name (lower-cased) to the kind it is shown as; a name not here is `other`. */
	readonly toolKinds: Readonly<Record<string, ToolKind>>;
	/** Its `/` list. */
	readonly commands: AgentCommands;
	/**
	 * What the records read so far say of the session (#110, #111). The
	 * session model puts the runtime's own word over it per field
	 * (`PaneSnapshot.sessionInfo`, `mergeSessionInfo`).
	 */
	sessionInfo(state: S): SessionInfo;
	/** The reasoning efforts the agent offers, in its own words, for a picker (#110). */
	readonly efforts: readonly string[];
	/** The permission modes the agent offers, in its own words, for a picker (#110). */
	readonly modes: readonly string[];
	/**
	 * The models a picker offers (#161), by the name the agent takes and the
	 * name to show; none for an agent whose models are not listed.
	 */
	readonly models?: readonly SettingChoice[];
	/** What a picker shows for each mode (#161); a mode not here shows its own word. */
	readonly modeLabels?: Readonly<Record<string, ModeLabel>>;
	/**
	 * Reads the dialog on a pane's visible screen (#163, ADR-0009), for an
	 * agent whose dialogs can be answered by keys. `unknown` for anything it
	 * cannot read whole.
	 */
	readonly screenDialog?: (screen: string) => ScreenDialog;
}

/** Every format this build has, one per agent. */
const FORMATS: readonly AgentFormat[] = [CLAUDE_FORMAT];

/** An agent id as runtimes and the catalog write it: trimmed, lower case. */
function agentId(agent: string | null | undefined): string {
	return agent?.trim().toLowerCase() ?? '';
}

/** The format for an agent, or null when this build reads none of its sessions. */
export function agentFormat(agent: string | null | undefined): AgentFormat | null {
	const id = agentId(agent);
	return FORMATS.find((format) => format.agent === id) ?? null;
}

/** The agents a format exists for, in registry order. */
export function formatAgents(): string[] {
	return FORMATS.map((format) => format.agent);
}

/**
 * The tool table a session's calls are shown by: its format (anything with
 * `toolKinds`, so a test's format is read like the registry's). Undefined is
 * a caller that names no format, read by every format's table; null is an
 * agent with no format, whose calls are all `other`.
 */
export type ToolTable = Pick<AgentFormat, 'toolKinds'> | null | undefined;

/**
 * The kind a tool name is shown as: by the session's format's table when the
 * caller names one, else by the tables of every format in the registry;
 * `other` for a name the table does not know.
 */
export function toolKindOf(name: string, table?: ToolTable): ToolKind {
	const key = name.trim().toLowerCase();
	if (table !== undefined) return table?.toolKinds[key] ?? 'other';
	for (const format of FORMATS) {
		const kind = format.toolKinds[key];
		if (kind) return kind;
	}
	return 'other';
}

/** What the gate found for one agent on one runtime kind. */
export interface NativeSupport {
	/** The agent's format, or null when this build has none. */
	format: AgentFormat | null;
	/** How far the runtime's report of the agent's session can be trusted. */
	binding: SessionBinding;
}

/** The format and the session binding for `agent` on a runtime of `kind`. */
export function nativeSupport(kind: RuntimeKind, agent: string | null | undefined): NativeSupport {
	const id = agentId(agent);
	return { format: agentFormat(id), binding: sessionBinding(kind, id) };
}

/**
 * Whether the native view is offered for `agent` on a runtime of `kind`: a
 * format exists for it and the runtime's session for it is trusted. The
 * one answer the + menu, the settings and the native view all read.
 */
export function offersNativeView(kind: RuntimeKind, agent: string | null | undefined): boolean {
	const support = nativeSupport(kind, agent);
	return support.format !== null && support.binding === 'trusted';
}
