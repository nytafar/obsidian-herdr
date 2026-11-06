/**
 * The Claude Code `SessionStart` hook that names a herdr-core terminal's
 * Claude session (ADR-0006), and the one settings entry that runs it.
 *
 * The plugin ships only `main.js`, `manifest.json` and `styles.css`, so the
 * hook is generated here, on request, as herdr's own integration does it
 * (`~/.claude/hooks/herdr-agent-state.sh`). It is plain POSIX `sh` and `awk`:
 * no python3 or jq, and nothing that has to be installed first.
 *
 * What it does, in order (each measured against Claude Code 2.1.318 and hc
 * 0.1.18, `docs/architecture.md` "herdr-core: the Claude session hook"):
 *
 * - **Only inside an hc terminal**: `HC_TERMINAL_ID` is set (hc's
 *   `terminal_env`), else it exits.
 * - **Claude's pid** is `CLAUDE_PID`, which Claude sets for every hook and
 *   which equals the terminal's `foreground.pid` when Claude runs from its
 *   shell. `$PPID` is the fallback for a Claude without it.
 * - **Only the terminal's own agent.** `CLAUDE_CODE_CHILD_SESSION` cannot tell
 *   a child: Claude sets it in every hook's environment, a top-level session
 *   included. What does tell is the process group: a Claude started from
 *   another one's tool shell runs in a new session with no terminal, so its
 *   group is not the terminal's foreground group (`/proc/<pid>/stat`, else
 *   `ps -o pgid= -o tpgid=`). Unknown counts as the terminal's own; the
 *   plugin's pid check (ADR-0006) still decides.
 * - **Subagents** (`agent_id` in the hook input) are skipped, as herdr does.
 * - **The input** is read by a small JSON reader in awk: top-level string
 *   fields only, `\"`, `\\` and `\/` decoded, nested values skipped whole,
 *   and a value with a control character or a `\u` escape refused rather
 *   than guessed. No regex over the raw text, so a cwd that contains
 *   `"session_id":` cannot fool it.
 * - **The label** is `obsidian-herdr.session` = {@link SessionLabel}'s JSON,
 *   written with `hc label` (which finds its own core through
 *   `HC_TERMINAL_SOCKET`). Nothing goes to stdout: a `SessionStart` hook's
 *   stdout becomes context for the model.
 */

import { shellQuote } from '../hc/client';
import { SESSION_LABEL_KEY } from './label';

/**
 * Bumped whenever the script or the entry changes; an older one installed
 * reads as outdated and is replaced in place.
 */
export const SESSION_HOOK_VERSION = 1;

/** The script's file name, under the Claude config dir's `hooks/`. */
export const SESSION_HOOK_FILE = 'obsidian-herdr-session.sh';

/** The line that carries {@link SESSION_HOOK_VERSION} in the script. */
export const SESSION_HOOK_VERSION_MARKER = 'OBSIDIAN_HERDR_HOOK_VERSION';

/** Every start of a session, as herdr's own hook matches them. */
export const SESSION_HOOK_MATCHER = '^(startup|resume|clear|compact|fork)$';

/** Seconds Claude waits for it; `hc label` takes milliseconds. */
export const SESSION_HOOK_TIMEOUT_S = 10;

/** One command hook, as Claude's settings hold it. */
export interface ClaudeCommandHook {
	type: 'command';
	command: string;
	timeout: number;
}

/** One `SessionStart` matcher group. */
export interface ClaudeHookGroup {
	matcher: string;
	hooks: ClaudeCommandHook[];
}

/** The command line in the settings entry: run by `sh`, so no exec bit is needed. */
export function sessionHookCommand(scriptPath: string): string {
	return `sh ${shellQuote(scriptPath)}`;
}

/** The one `SessionStart` entry the installer adds. */
export function sessionHookEntry(scriptPath: string): ClaudeHookGroup {
	return {
		matcher: SESSION_HOOK_MATCHER,
		hooks: [{ type: 'command', command: sessionHookCommand(scriptPath), timeout: SESSION_HOOK_TIMEOUT_S }],
	};
}

/** The version a script says it is, or null when it carries no marker. */
export function sessionHookScriptVersion(text: string): number | null {
	const match = new RegExp(`^# ${SESSION_HOOK_VERSION_MARKER}=(\\d+)$`, 'm').exec(text);
	return match ? Number(match[1]) : null;
}

/** The hook script, exactly as it is written to disk. */
export function sessionHookScript(): string {
	// String.raw keeps every backslash as the shell and awk read it. The
	// script has no `${` of its own, so the only interpolations are these.
	return String.raw`#!/bin/sh
# obsidian-herdr session hook, written by the Herdr plugin for Obsidian.
# ${SESSION_HOOK_VERSION_MARKER}=${SESSION_HOOK_VERSION}
# Claude Code runs it on SessionStart. Inside a herdr-core terminal it labels
# the terminal with this session: ${SESSION_LABEL_KEY}={"v":1,"session":...,
# "pid":...,"transcript":...}. The plugin's remove deletes this file and its
# settings entry, and reinstalling overwrites it: add your own hooks beside it.

input=$(cat 2>/dev/null)

# Only in a herdr-core terminal.
[ -n "$HC_TERMINAL_ID" ] || exit 0

# Claude's own pid. The plugin accepts the label only while it is the
# terminal's foreground pid.
pid=$CLAUDE_PID
[ -n "$pid" ] || pid=$PPID
case $pid in '' | *[!0-9]*) exit 0 ;; esac

# Only the terminal's own agent: a Claude started by another one, from its
# tool shell, has no terminal and so is not in the foreground process group.
# Unknown counts as yes, and the plugin's pid check still holds.
if [ -r "/proc/$pid/stat" ]; then
	groups=$(awk '{ sub(/.*\) /, ""); print $3, $6 }' "/proc/$pid/stat" 2>/dev/null)
else
	groups=$(ps -o pgid= -o tpgid= -p "$pid" 2>/dev/null)
fi
set -f
set -- $groups
set +f
if [ $# -eq 2 ] && [ "$1" != "$2" ]; then exit 0; fi

hc=$(command -v hc 2>/dev/null || command -v herdr-core 2>/dev/null) || hc=$HOME/.local/bin/herdr-core
[ -x "$hc" ] || exit 0

# A small JSON reader: top-level string fields, escapes decoded, nested values
# skipped whole. A value with a control character or a \u escape is refused.
label=$(printf '%s\n' "$input" | LC_ALL=C awk -v pid="$pid" '
function ws() { while (i <= n && index(" \t\r\n", substr(s, i, 1)) > 0) i++ }
function str(   c, out) {
	i++; out = ""
	while (i <= n) {
		c = substr(s, i, 1)
		if (c == "\"") { i++; return out }
		if (c == "\\") {
			i++; c = substr(s, i, 1)
			if (c == "\"" || c == "\\" || c == "/") out = out c
			else bad = 1
			i++; continue
		}
		if (c < " ") bad = 1
		out = out c; i++
	}
	err = 1; return out
}
function skip(   c, d) {
	c = substr(s, i, 1)
	if (c == "\"") { str(); return }
	if (c == "{" || c == "[") {
		d = 0
		while (i <= n) {
			c = substr(s, i, 1)
			if (c == "\"") { str(); continue }
			if (c == "{" || c == "[") d++
			else if (c == "}" || c == "]") { d--; if (d == 0) { i++; return } }
			i++
		}
		err = 1; return
	}
	while (i <= n && index(",}] \t\r\n", substr(s, i, 1)) == 0) i++
}
function esc(v,   k, c, out) {
	out = ""
	for (k = 1; k <= length(v); k++) {
		c = substr(v, k, 1)
		if (c == "\"" || c == "\\") out = out "\\"
		out = out c
	}
	return out
}
{ s = s $0 "\n" }
END {
	n = length(s); i = 1; err = 0
	ws(); if (substr(s, i, 1) != "{") exit
	i++
	while (!err) {
		ws(); ch = substr(s, i, 1)
		if (ch == "}") break
		if (ch != "\"") exit
		key = str(); ws()
		if (substr(s, i, 1) != ":") exit
		i++; ws()
		if (substr(s, i, 1) == "\"") {
			bad = 0; got = str()
			if (bad) lit[key] = "?"; else val[key] = got
		} else { st = i; skip(); lit[key] = substr(s, st, i - st) }
		ws(); ch = substr(s, i, 1)
		if (ch == ",") { i++; continue }
		if (ch == "}") break
		exit
	}
	if (err) exit
	if (val["hook_event_name"] != "SessionStart") exit
	# A subagent, skipped the way herdr skips it.
	if (val["agent_id"] != "") exit
	if (("agent_id" in lit) && lit["agent_id"] != "null" && lit["agent_id"] != "false") exit
	if (val["session_id"] == "" || val["transcript_path"] == "") exit
	printf "{\"v\":1,\"session\":\"%s\",\"pid\":%s,\"transcript\":\"%s\"}", esc(val["session_id"]), pid, esc(val["transcript_path"])
}')
[ -n "$label" ] || exit 0

"$hc" label "$HC_TERMINAL_ID" "${SESSION_LABEL_KEY}=$label" >/dev/null 2>&1
exit 0
`;
}
