/**
 * Installing and removing the Claude session hook on the machine a
 * herdr-core runtime runs on (ADR-0006), through that runtime's connection.
 *
 * - **One code path for both targets.** A local runtime's `hc connect` and an
 *   SSH runtime's `ssh -T … connect` reach a core on the machine the
 *   terminals run on, and hc's `file.read`/`file.write` and `machine.exec`
 *   act there. Locally that is this machine's own files, so a separate
 *   `node:fs` path would only be a second way to get the same thing wrong.
 * - **Where Claude keeps its settings** is `CLAUDE_CONFIG_DIR`, else
 *   `~/.claude`, read by `machine.exec` from the core's environment: the one
 *   hc terminals inherit (`api/run.rs` `child_env`), and so the one Claude
 *   started in them sees unless a shell rc changes it. The modal shows the
 *   paths before anything is written.
 * - **Plan, show, then write what was shown.** {@link inspectSessionHook}
 *   reads both files; a plan is built from that snapshot; applying it reads
 *   the files again and refuses if either changed in between, so the user
 *   never confirms one text and gets another.
 * - **Order.** Install writes the script before the entry, so the entry never
 *   names a missing script; remove takes the entry out before the script.
 *   `file.write` is an atomic swap that keeps the file mode and follows a
 *   symlinked settings file ([[herdr-core-api]] §9).
 * - **Only ours.** Remove deletes the script only while it still carries our
 *   version marker.
 */

import { HcError } from '../hc/connection';
import {
	addSessionHook,
	installedSessionHookGroups,
	removeSessionHook,
	sessionHookStatus,
	type SessionHookStatus,
} from './claudeSettings';
import {
	SESSION_HOOK_FILE,
	sessionHookEntry,
	sessionHookScript,
	sessionHookScriptVersion,
	type ClaudeHookGroup,
} from './hookScript';

/** One JSON-RPC call on the runtime's connection (`HcClient.request`). */
export type HcRequest = <T>(method: string, params: unknown) => Promise<T>;

/** The files the hook lives in, on the runtime's machine. */
export interface ClaudePaths {
	configDir: string;
	settingsPath: string;
	scriptPath: string;
	/** True when `CLAUDE_CONFIG_DIR` chose the dir rather than `~/.claude`. */
	fromEnv: boolean;
}

/** What the installer needs of a machine; hc's API in the plugin, memory in tests. */
export interface HookMachine {
	/** `HOME` and `CLAUDE_CONFIG_DIR` ('' when unset) as hc terminals there inherit them. */
	environment(): Promise<{ home: string; claudeConfigDir: string }>;
	/** The file's text, or null when there is none. */
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
	remove(path: string): Promise<void>;
}

function trimSlashes(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * The paths for a machine's `HOME` and `CLAUDE_CONFIG_DIR`. Claude reads the
 * variable as given; a leading `~/` is taken as the home, and anything else
 * that is not absolute is refused, since it would depend on Claude's cwd.
 */
export function claudePathsFor(home: string, claudeConfigDir: string): ClaudePaths {
	const env = claudeConfigDir.trim();
	let configDir: string;
	if (env === '') {
		if (!home.startsWith('/')) throw new Error(`the home directory there is not an absolute path (${home || 'empty'})`);
		configDir = `${trimSlashes(home)}/.claude`;
	} else if (env.startsWith('/')) {
		configDir = trimSlashes(env);
	} else if (env === '~' || env.startsWith('~/')) {
		if (!home.startsWith('/')) throw new Error(`CLAUDE_CONFIG_DIR is ${env} and the home directory is unknown`);
		configDir = trimSlashes(`${trimSlashes(home)}${env.slice(1)}`);
	} else {
		throw new Error(`CLAUDE_CONFIG_DIR is not an absolute path (${env})`);
	}
	return {
		configDir,
		settingsPath: `${configDir}/settings.json`,
		scriptPath: `${configDir}/hooks/${SESSION_HOOK_FILE}`,
		fromEnv: env !== '',
	};
}

interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timed_out?: boolean;
}

function decode(b64: unknown): string {
	return typeof b64 === 'string' ? Buffer.from(b64, 'base64').toString('utf8') : '';
}

/** The machine a herdr-core connection reaches: its core's own files and environment. */
export function hcHookMachine(request: HcRequest): HookMachine {
	const exec = async (argv: string[]): Promise<ExecResult> => {
		const result = await request<ExecResult>('machine.exec', { argv, timeout: 15 });
		return { ...result, stdout: decode(result.stdout), stderr: decode(result.stderr) };
	};
	return {
		environment: async () => {
			const result = await exec(['sh', '-c', 'printf "%s\\n%s\\n" "$HOME" "${CLAUDE_CONFIG_DIR:-}"']);
			if (result.code !== 0) {
				throw new Error(`could not read the environment there: ${result.stderr.trim() || `exit ${result.code}`}`);
			}
			const [home = '', claudeConfigDir = ''] = result.stdout.split('\n');
			return { home, claudeConfigDir };
		},
		read: async (path) => {
			try {
				const result = await request<{ text?: unknown }>('file.read', { path });
				return typeof result.text === 'string' ? result.text : '';
			} catch (error) {
				if (error instanceof HcError && error.kind === 'not_found') return null;
				throw error;
			}
		},
		write: async (path, text) => {
			await request('file.write', { path, data: Buffer.from(text, 'utf8').toString('base64') });
		},
		remove: async (path) => {
			const result = await exec(['rm', '-f', '--', path]);
			if (result.code !== 0) throw new Error(`could not delete ${path}: ${result.stderr.trim() || `exit ${result.code}`}`);
		},
	};
}

/** Both files as they are now, and what that means. */
export interface SessionHookSnapshot {
	paths: ClaudePaths;
	settingsText: string | null;
	scriptText: string | null;
	status: SessionHookStatus;
}

export async function inspectSessionHook(
	machine: HookMachine,
	paths?: ClaudePaths,
): Promise<SessionHookSnapshot> {
	let resolved: ClaudePaths;
	if (paths) {
		resolved = paths;
	} else {
		const env = await machine.environment();
		resolved = claudePathsFor(env.home, env.claudeConfigDir);
	}
	const [settingsText, scriptText] = await Promise.all([
		machine.read(resolved.settingsPath),
		machine.read(resolved.scriptPath),
	]);
	return {
		paths: resolved,
		settingsText,
		scriptText,
		status: sessionHookStatus(settingsText, scriptText, resolved.scriptPath),
	};
}

/** What install would write, from one snapshot. */
export type InstallPlan =
	| {
			ok: true;
			snapshot: SessionHookSnapshot;
			script: string;
			entry: ClaudeHookGroup;
			settingsAfter: string;
			/** False when the settings already hold exactly our entry. */
			settingsChanged: boolean;
			/** The settings file does not exist yet. */
			createsSettings: boolean;
	  }
	| { ok: false; snapshot: SessionHookSnapshot; reason: string };

export function planInstall(snapshot: SessionHookSnapshot): InstallPlan {
	const entry = sessionHookEntry(snapshot.paths.scriptPath);
	const edit = addSessionHook(snapshot.settingsText, entry);
	if (!edit.ok) return { ok: false, snapshot, reason: edit.reason };
	return {
		ok: true,
		snapshot,
		script: sessionHookScript(),
		entry,
		settingsAfter: edit.text,
		settingsChanged: edit.changed,
		createsSettings: snapshot.settingsText === null,
	};
}

/** What remove would do, from one snapshot. */
export type RemovePlan =
	| {
			ok: true;
			snapshot: SessionHookSnapshot;
			/** Our groups as they stand in the file, shown before removing. */
			entries: unknown[];
			settingsAfter: string;
			settingsChanged: boolean;
			/** The script is there and carries our marker. */
			deletesScript: boolean;
	  }
	| { ok: false; snapshot: SessionHookSnapshot; reason: string };

export function planRemove(snapshot: SessionHookSnapshot): RemovePlan {
	const edit = removeSessionHook(snapshot.settingsText);
	if (!edit.ok) return { ok: false, snapshot, reason: edit.reason };
	const deletesScript = snapshot.scriptText !== null && sessionHookScriptVersion(snapshot.scriptText) !== null;
	if (!edit.changed && !deletesScript) return { ok: false, snapshot, reason: 'There is nothing of the hook to remove.' };
	return {
		ok: true,
		snapshot,
		entries: installedSessionHookGroups(snapshot.settingsText),
		settingsAfter: edit.text,
		settingsChanged: edit.changed,
		deletesScript,
	};
}

/** Refuses when either file changed since the snapshot the user confirmed. */
async function assertUnchanged(machine: HookMachine, snapshot: SessionHookSnapshot): Promise<void> {
	const { settingsPath, scriptPath } = snapshot.paths;
	const [settingsText, scriptText] = await Promise.all([machine.read(settingsPath), machine.read(scriptPath)]);
	if (settingsText !== snapshot.settingsText) {
		throw new Error(`${settingsPath} changed since it was shown; nothing was written. Open it again to see the change.`);
	}
	if (scriptText !== snapshot.scriptText) {
		throw new Error(`${scriptPath} changed since it was shown; nothing was written. Open it again to see the change.`);
	}
}

export async function applyInstall(machine: HookMachine, plan: Extract<InstallPlan, { ok: true }>): Promise<void> {
	await assertUnchanged(machine, plan.snapshot);
	const { settingsPath, scriptPath } = plan.snapshot.paths;
	if (plan.snapshot.scriptText !== plan.script) await machine.write(scriptPath, plan.script);
	if (plan.settingsChanged) await machine.write(settingsPath, plan.settingsAfter);
}

export async function applyRemove(machine: HookMachine, plan: Extract<RemovePlan, { ok: true }>): Promise<void> {
	await assertUnchanged(machine, plan.snapshot);
	const { settingsPath, scriptPath } = plan.snapshot.paths;
	if (plan.settingsChanged) await machine.write(settingsPath, plan.settingsAfter);
	if (plan.deletesScript) await machine.remove(scriptPath);
}
