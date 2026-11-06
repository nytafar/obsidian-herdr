/**
 * Where Claude Code keeps a session (issues #93, #132, #137): its transcript,
 * and its subagents' transcripts beside it. Behind the agent seam
 * (`../format.ts`); the transcript source above it only tails a path.
 *
 * The layout is `~/.claude/projects/<encoded cwd>/<agent session>.jsonl`, with
 * the encoding read off Claude Code 2.1.266 and checked against every project
 * folder on this machine: every character that is not a letter or a digit
 * becomes a dash, and a name longer than 200 characters is cut to 200 with a
 * hash of the whole path appended. `CLAUDE_CONFIG_DIR` moves `~/.claude`, and
 * the cwd is the real one (a symlink resolved, measured 2026-11-06).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionLocation } from '../format';

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

/**
 * Where a pane's current transcript is, or null when there is not one yet: a
 * freshly started Claude has no `agent_session` and no file until its first
 * turn begins (docs/architecture.md). The pane's cwd under `~/.claude`, for a
 * runtime that names no path.
 */
export function transcriptPath(location: SessionLocation): string | null {
	if (!location.cwd || !location.agentSession) return null;
	const home = location.home ?? homedir();
	return `${home}/.claude/projects/${encodeProjectDir(location.cwd)}/${location.agentSession}.jsonl`;
}

/**
 * Where Claude Code keeps a session's transcript, given its configuration
 * folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`) and the cwd as Claude itself
 * sees it, which is the real path: a session started in a symlinked folder is
 * filed under the folder the link points to (measured 2026-11-06).
 */
export function claudeTranscriptFile(configDir: string, realCwd: string, sessionId: string): string {
	return join(configDir, 'projects', encodeProjectDir(realCwd), `${sessionId}.jsonl`);
}

/**
 * `<session>/subagents/agent-<task id>.jsonl`, beside the session's
 * transcript, which is where Claude Code keeps a subagent's own (#96); empty
 * when either is unknown.
 */
export function subagentTranscript(transcript: string, taskId: string): string {
	if (!transcript || !taskId) return '';
	return `${transcript.replace(/\.jsonl$/, '')}/subagents/agent-${taskId}.jsonl`;
}
