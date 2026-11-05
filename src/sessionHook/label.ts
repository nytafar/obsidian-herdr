/**
 * The label a herdr-core terminal's Claude session is carried on (ADR-0006),
 * as the session hook (`./hookScript.ts`) writes it and the plugin reads it.
 *
 * The value is one JSON object:
 *
 *     {"v":1,"session":"<session id>","pid":<Claude's pid>,"transcript":"<transcript path>"}
 *
 * Unknown fields are ignored and any later `v` is read the same way, so a
 * newer hook adding a field does not blind an older plugin; a change of
 * meaning would take a new key. Parsing only says what the label claims.
 * Whether to believe it is the caller's: ADR-0006 accepts it only while
 * `pid` equals the terminal's `foreground.pid`.
 */

/** Our own namespace; herdr-app owns `herdr.` (ADR-0006). */
export const SESSION_LABEL_KEY = 'obsidian-herdr.session';

export interface SessionLabel {
	sessionId: string;
	/** Claude's pid when the hook ran. */
	pid: number;
	/** Absolute path of the transcript on the terminal's own machine. */
	transcriptPath: string;
}

/** A string with no control characters, which no id or path of ours has. */
function plainString(value: unknown): value is string {
	// eslint-disable-next-line no-control-regex -- finding control characters is the point
	return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The label's value, or null when it is not one the hook writes. */
export function parseSessionLabel(value: unknown): SessionLabel | null {
	if (typeof value !== 'string' || value === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const { v, session, pid, transcript } = record;
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null;
	if (!plainString(session)) return null;
	if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
	// Read through hc's file API, where a relative path would start at the
	// core's cwd: only an absolute one names the transcript.
	if (!plainString(transcript) || !transcript.startsWith('/')) return null;
	return { sessionId: session, pid, transcriptPath: transcript };
}

/** The session a terminal's labels carry, or null without a valid one. */
export function sessionLabelOf(labels: Readonly<Record<string, unknown>> | null | undefined): SessionLabel | null {
	if (!labels || typeof labels !== 'object') return null;
	return parseSessionLabel(labels[SESSION_LABEL_KEY]);
}
