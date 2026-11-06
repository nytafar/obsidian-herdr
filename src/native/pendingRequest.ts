/**
 * A dialog the runtime itself is waiting on, and the answers the waiting card
 * can give it (ADR-0007).
 *
 * herdr and herdr-core only say that an agent is blocked, and the card can do
 * no more than describe the block and send the user to the terminal
 * (`./waitingCard.ts`). A runtime that owns the dialog — the `claude` kind,
 * whose permission prompts arrive as `can_use_tool` control requests on the
 * process's stdout — reports the request itself, with what it asks, and takes
 * a {@link WaitingAnswer} back through its {@link WaitingResponder}. The kind
 * turns the answer into its own wire format; the view never builds one.
 *
 * Kind-neutral and pure: no Obsidian, no process.
 */

/** One option of an `AskUserQuestion` question. */
export interface PendingQuestionOption {
	label: string;
	description: string;
}

/** One question of an `AskUserQuestion` call, as Claude asked it. */
export interface PendingQuestion {
	/** The question text, which is also the key its answer is sent under. */
	question: string;
	/** A short tag Claude gives the question; empty for none. */
	header: string;
	options: PendingQuestionOption[];
	/** Whether more than one option may be chosen. */
	multiSelect: boolean;
}

/**
 * What a "remember this" choice would grant, in words, for the card to say
 * before it is pressed.
 */
export interface PendingGrant {
	/** One line per permission update, e.g. `allow Bash(touch two.txt)`. */
	lines: string[];
}

/** The project-wide grant: what is written, to which file, and how far it reaches. */
export interface PendingProjectGrant extends PendingGrant {
	/** The settings file the grant is written to, absolute: the one the runtime itself writes. */
	file: string;
	/** The folder that file belongs to. */
	root: string;
	/**
	 * `repository`: the rule applies to every agent in the git repository at
	 * `root`, its worktrees included, not just the agent's own folder.
	 * `folder`: only to agents started in `root` itself.
	 */
	scope: 'repository' | 'folder';
}

/** The line under "Always allow in this project": the file, the rule, and its reach. */
export function projectGrantText(grant: PendingProjectGrant): string {
	const reach =
		grant.scope === 'repository'
			? `It applies to the whole project at ${grant.root}, every agent in it and its worktrees, not just this folder.`
			: 'It applies to agents started in this folder.';
	return `Writes ${grant.file}: ${grant.lines.join('; ')}. ${reach}`;
}

/** A request the runtime is waiting on. */
export interface PendingRequest {
	/** The runtime's own id for the request; what an answer is sent under. */
	id: string;
	/** Which card answers it. */
	kind: 'permission' | 'question' | 'plan';
	/** The tool asking, as the runtime names it. */
	toolName: string;
	/** The `tool_use` this request is about; empty when the runtime gave none. */
	toolUseId: string;
	/** The tool's input, exactly as the runtime sent it. Never written to. */
	input: Readonly<Record<string, unknown>>;
	/** Why the runtime is asking, when it says (a path outside the cwd). Empty for none. */
	reason: string;
	/** The questions, for a `question` request; empty for every other kind. */
	questions: PendingQuestion[];
	/** The plan, for a `plan` request; empty for every other kind. */
	plan: string;
	/** "Allow for this session", or null when the runtime suggested no such grant. */
	session: PendingGrant | null;
	/** "Always allow in this project", or null when the runtime suggested none. */
	project: PendingProjectGrant | null;
}

/** What the user chose on the card. */
export type WaitingAnswer =
	| { type: 'allow' }
	| { type: 'allow-session' }
	| { type: 'allow-project' }
	| { type: 'deny' }
	/** Answers keyed by question text; a multi-select answer joins its labels. */
	| { type: 'answer'; answers: Record<string, string> }
	| { type: 'dismiss' }
	| { type: 'approve-plan' }
	| { type: 'reject-plan'; feedback: string };

/** How a card's answer reaches the runtime that asked. */
export interface WaitingResponder {
	/** Sends the answer to request `requestId` of the pane's agent. Rejects with a readable message. */
	respond(paneId: string, requestId: string, answer: WaitingAnswer): Promise<void>;
}
