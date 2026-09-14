/**
 * The transcript source (issue #93, ADR-0003).
 *
 * Deliberately dumb: where the file is, how to read it whole, and — from issue
 * #94 — how to follow it. Nothing here knows what a line means (that is
 * `./reducer.ts`) or which session is current (that is `./sessionModel.ts`).
 * The interface is "tail and read a path", which is the whole of what an SSH
 * adapter will have to implement later.
 *
 * The path is Claude Code's own layout, `~/.claude/projects/<encoded
 * cwd>/<agent session>.jsonl`, with the encoding read off Claude Code 2.1.266
 * and checked against every project folder on this machine: every character
 * that is not a letter or a digit becomes a dash, and a name longer than 200
 * characters is cut to 200 with a hash of the whole path appended.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

/** Claude Code's cap on a project folder name before it hashes the rest. */
const MAX_PROJECT_DIR = 200;

/**
 * Claude Code's string hash: `h = h * 31 + c`, wrapped to int32. Only used for
 * the tail of an over-long project folder name.
 */
function pathHash(path: string): number {
	let hash = 0;
	for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
	return hash;
}

/**
 * The folder under `~/.claude/projects` that holds the transcripts of sessions
 * started in `cwd`.
 */
export function encodeProjectDir(cwd: string): string {
	const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	if (encoded.length <= MAX_PROJECT_DIR) return encoded;
	return `${encoded.slice(0, MAX_PROJECT_DIR)}-${Math.abs(pathHash(cwd)).toString(36)}`;
}

export interface TranscriptLocation {
	/** The pane's working directory, as herdr reports it. */
	cwd: string;
	/** herdr's `agent_session` value; empty until the first prompt. */
	agentSession: string;
	/** Home directory of the host the transcript lives on. Defaults to this one. */
	home?: string;
}

/**
 * Where a pane's current transcript is, or null when there is not one yet: a
 * freshly started Claude has no `agent_session` and no file until its first
 * turn begins (docs/architecture.md).
 */
export function transcriptPath(location: TranscriptLocation): string | null {
	if (!location.cwd || !location.agentSession) return null;
	const home = location.home ?? homedir();
	return `${home}/.claude/projects/${encodeProjectDir(location.cwd)}/${location.agentSession}.jsonl`;
}

/**
 * Reading a transcript, on whatever host it lives. `read` is for a file wanted
 * once (a subagent's report); following a growing file is `open`, which issue
 * #94 adds.
 */
export interface TranscriptSource {
	/** The whole file, or null when it does not exist or cannot be read. */
	read(path: string): Promise<string | null>;
}

/** The transcript source for a pane on this machine. */
export class LocalTranscriptSource implements TranscriptSource {
	async read(path: string): Promise<string | null> {
		try {
			return await readFile(path, 'utf8');
		} catch {
			// A transcript that is not there yet is not an error: the session may
			// not have taken its first prompt (ADR-0003).
			return null;
		}
	}
}
