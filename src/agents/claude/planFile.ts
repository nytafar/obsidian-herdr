/**
 * Claude's plan file, for a pane whose runtime does not hold the plan (#148).
 *
 * `ExitPlanMode` reaches the transcript only with its answer (measured on
 * Claude Code 2.1.286, `docs/architecture.md`, "Plan approval and the plan
 * file"), so a herdr or herdr-core pane waiting on "Ready to code?" says
 * nothing of its plan there. The plan file is there in time: Claude writes it
 * to `<config dir>/plans/<slug>.md` before it asks, and every message line
 * carries the session's `"slug"`. The transcript is
 * `<config dir>/projects/<project>/<session>.jsonl`, so its config dir,
 * `CLAUDE_CONFIG_DIR` or not (#132), is three levels up.
 *
 * A session has a slug whether or not it ever plans, and keeps its plan file
 * after plan mode ends, so the tracker also follows whether the session is in
 * plan mode now: the top-level `permissionMode` Claude writes on its
 * `permission-mode` lines and on a prompt, and the `plan_mode` and
 * `plan_mode_exit` attachments it writes on entering and leaving.
 *
 * The slug is not looked up in the file afterwards: the session model hands
 * every line over as it reads them, so nothing is read twice.
 *
 * Pure: no file is read here. The session model reads the file through the
 * transcript's own source, which is the transcript's own host.
 */

import { posix } from 'node:path';

/**
 * The slugs Claude makes: lowercase words joined by single hyphens. Nothing
 * else names a file, so no slug leaves the plans folder.
 */
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A `"slug"` key and its value, as JSON writes it; a quote inside a string is escaped. */
const SLUG_RE = /"slug":"([^"\\]*)"/g;

/** Whether `slug` is one Claude makes, and so names a file in the plans folder and nowhere else. */
export function isSafeSlug(slug: string): boolean {
	return SAFE_SLUG.test(slug);
}

/**
 * The plan file of the session whose transcript is `transcript`, or null when
 * the slug is not one Claude makes or the path has no config dir above it.
 * POSIX paths: herdr and herdr-core run on Linux and macOS, and a remote
 * runtime's transcript path is its own machine's.
 */
export function planFilePath(transcript: string, slug: string): string | null {
	if (!isSafeSlug(slug)) return null;
	const parts = transcript.split('/');
	// `<config dir>/projects/<project>/<session>.jsonl`: a config dir that is a
	// folder of its own, so at least one name before `projects`.
	if (parts.length < 4 || parts.slice(0, -3).join('/') === '') return null;
	const configDir = posix.dirname(posix.dirname(posix.dirname(transcript)));
	return posix.join(configDir, 'plans', `${slug}.md`);
}

/** Whether a line can say anything of the permission mode; only those are parsed. */
function namesMode(line: string): boolean {
	return line.includes('"permissionMode":"') || line.includes('"plan_mode');
}

/**
 * What a transcript's lines say about its plan, kept as they are read: the
 * session's current slug and whether it is in plan mode now.
 */
export class PlanTracker {
	private lastSlug = '';
	private inPlanMode = false;

	/** The session's current slug, or empty when it has none or the last one is not safe. */
	get slug(): string {
		return isSafeSlug(this.lastSlug) ? this.lastSlug : '';
	}

	/** Whether the last word on the permission mode was plan mode. */
	get planMode(): boolean {
		return this.inPlanMode;
	}

	/** Reads more lines, in transcript order. */
	feed(lines: readonly string[]): void {
		for (const line of lines) {
			if (line.includes('"slug":"')) {
				// The last one in the line: Claude writes the top-level slug after
				// the message, so a tool's own `slug` field comes before it.
				let found: string | null = null;
				for (const match of line.matchAll(SLUG_RE)) found = match[1] ?? null;
				if (found !== null) this.lastSlug = found;
			}
			if (namesMode(line)) this.readMode(line);
		}
	}

	/** Forgets everything, for another file or the same one replaced. */
	reset(): void {
		this.lastSlug = '';
		this.inPlanMode = false;
	}

	/** The mode a line states at its top level, if it states one. */
	private readMode(line: string): void {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		if (!entry || typeof entry !== 'object') return;
		const { permissionMode, type, attachment } = entry as {
			permissionMode?: unknown;
			type?: unknown;
			attachment?: unknown;
		};
		if (typeof permissionMode === 'string') this.inPlanMode = permissionMode === 'plan';
		if (type === 'attachment' && attachment && typeof attachment === 'object') {
			const kind = (attachment as { type?: unknown }).type;
			if (kind === 'plan_mode') this.inPlanMode = true;
			else if (kind === 'plan_mode_exit') this.inPlanMode = false;
		}
	}
}
