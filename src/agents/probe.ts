/**
 * The probes behind the agent catalog (issue #125): which of a list of
 * programs exist on a runtime's machine, asked once per connection.
 *
 * - **This machine:** the binary search herdr's own discovery does
 *   (`herdr/binary.ts`): Homebrew, `/usr/local/bin`, `~/.local/bin`, the
 *   settings' extra PATH entries, then the login shell's PATH, which is asked
 *   once for the whole list and only when the fixed directories missed one.
 *   Filesystem checks otherwise; nothing else is spawned.
 * - **An SSH host:** one `ssh -T <host> sh -c '<script>' sh <program>…`, in
 *   the shape of `remoteHerdrCommand`: the non-interactive PATH first, then
 *   the same three directories on the remote host.
 * - **herdr-core over SSH:** the same script in one `machine.exec` over the
 *   runtime's own connection, and hc's `templates.list`.
 *
 * The script prints the 1-based index of every program it found, then `ok`,
 * so a cut-off answer is told from "nothing installed", and a `~` the remote
 * login shell might expand never has to be matched back. It holds no single
 * quote or backslash, so a fish or nu login shell reads the quoted script the
 * way `sh` does (the same rule as `remoteHerdrCommand`).
 */

import { join } from 'node:path';
import { shellQuote } from '../hc/client';
import { BINARY_DIRECTORIES, expandHome, loginShellPath, type DiscoveryDeps } from '../herdr/binary';
import type { RunCommand } from '../herdr/ssh';
import type { AgentProbe, HcTemplate } from './catalog';

/** How long the SSH probe may take before it counts as failed. */
export const SSH_PROBE_TIMEOUT_MS = 15_000;
/** `machine.exec`'s own timeout for the probe, in seconds. */
export const HC_PROBE_TIMEOUT_S = 15;

/** The probe, as `sh -c` runs it with the programs as `$1…`. */
export const PROBE_SCRIPT =
	'i=0; for p in "$@"; do i=$((i+1)); f=; ' +
	'case $p in ' +
	'"~/"*) f=$HOME/${p#??} ;; ' +
	'/*) f=$p ;; ' +
	'*) f=$(command -v "$p" 2>/dev/null) || f=; ' +
	'[ -n "$f" ] || for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do ' +
	'[ -x "$d/$p" ] && { f=$d/$p; break; }; done ;; ' +
	'esac; ' +
	'[ -n "$f" ] && [ -x "$f" ] && echo $i; ' +
	'done; echo ok';

/**
 * The programs the probe found, from its output: the indices it printed,
 * mapped back to the list it was given. Null when the answer did not end in
 * `ok`, which is a failed or cut-off probe, not an empty machine.
 */
export function parseProbeOutput(stdout: string, programs: readonly string[]): Set<string> | null {
	const lines = stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.at(-1) !== 'ok') return null;
	const found = new Set<string>();
	for (const line of lines.slice(0, -1)) {
		const index = Number(line);
		const program = Number.isInteger(index) ? programs[index - 1] : undefined;
		if (program !== undefined) found.add(program);
	}
	return found;
}

/** The remote command of the SSH probe: the script and the programs, quoted. */
export function sshProbeCommand(programs: readonly string[]): string {
	return ['sh', '-c', shellQuote(PROBE_SCRIPT), 'sh', ...programs.map(shellQuote)].join(' ');
}

/** The SSH probe's argv for `ssh`, non-interactive like every other ssh here. */
export function sshProbeArgs(host: string, programs: readonly string[]): string[] {
	return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, sshProbeCommand(programs)];
}

/**
 * Which programs exist on an SSH host, in one `ssh`. `run` is `ssh.ts`'s
 * runner: no shell on this side, killed on timeout, empty on failure.
 */
export async function probeOverSsh(
	host: string,
	programs: readonly string[],
	run: RunCommand,
	options: { sshBinary?: string; timeoutMs?: number } = {},
): Promise<AgentProbe> {
	if (programs.length === 0) return { found: new Set() };
	const trimmed = host.trim();
	if (!trimmed) return { found: null, error: 'the runtime has no SSH host' };
	const controller = new AbortController();
	const stdout = await run(options.sshBinary ?? 'ssh', sshProbeArgs(trimmed, programs), {
		signal: controller.signal,
		timeoutMs: options.timeoutMs ?? SSH_PROBE_TIMEOUT_MS,
	});
	const found = parseProbeOutput(stdout, programs);
	return found ? { found } : { found: null, error: `ssh ${trimmed} did not answer` };
}

function splitPath(value: string): string[] {
	return value
		.split(':')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Which programs exist on this machine. A path (absolute or `~/`) is checked
 * as it is; a name in the fixed directories and the extras, then on the
 * login shell's PATH, asked once and only when needed.
 */
export async function probeLocal(
	programs: readonly string[],
	options: { extraPath?: string; skipLoginShell?: boolean; loginShellTimeoutMs?: number },
	deps: DiscoveryDeps,
): Promise<AgentProbe> {
	const found = new Set<string>();
	const missing: string[] = [];
	const directories = [...BINARY_DIRECTORIES, ...splitPath(options.extraPath ?? '')].map((dir) =>
		expandHome(dir, deps.home),
	);
	const inAny = (program: string, dirs: readonly string[]): boolean =>
		dirs.some((dir) => deps.isExecutable(join(dir, program)));
	for (const program of programs) {
		if (program.includes('/')) {
			if (deps.isExecutable(expandHome(program, deps.home))) found.add(program);
			continue;
		}
		if (inAny(program, directories)) found.add(program);
		else missing.push(program);
	}
	if (missing.length > 0 && !options.skipLoginShell) {
		const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
		const dirs = splitPath(shellPath ?? '').map((dir) => expandHome(dir, deps.home));
		for (const program of missing) if (inAny(program, dirs)) found.add(program);
	}
	return { found };
}

/** The slice of `HcClient` the herdr-core probe asks through. */
export interface HcProbeRequester {
	request<T>(method: string, params: unknown): Promise<T>;
}

/** hc's `templates.list` answer as templates; anything unreadable is left out. */
export function parseTemplates(value: unknown): HcTemplate[] {
	const list = (value as { templates?: unknown } | null)?.templates;
	if (!Array.isArray(list)) return [];
	const templates: HcTemplate[] = [];
	for (const entry of list) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.name !== 'string' || record.name.trim() === '') continue;
		templates.push({
			name: record.name.trim(),
			...(typeof record.description === 'string' ? { description: record.description } : {}),
			...(typeof record.error === 'string' && record.error.trim() ? { error: record.error } : {}),
		});
	}
	return templates;
}

/** hc's templates, or none on a core without the method or on any failure. */
export async function readHcTemplates(requester: HcProbeRequester): Promise<HcTemplate[]> {
	try {
		return parseTemplates(await requester.request<unknown>('templates.list', {}));
	} catch {
		return [];
	}
}

/** Which programs exist on the core's machine, in one `machine.exec`. */
export async function probeOverHc(requester: HcProbeRequester, programs: readonly string[]): Promise<AgentProbe> {
	if (programs.length === 0) return { found: new Set() };
	try {
		const result = await requester.request<{ stdout?: unknown; truncated?: boolean; timed_out?: boolean } | null>(
			'machine.exec',
			{ argv: ['sh', '-c', PROBE_SCRIPT, 'sh', ...programs], timeout: HC_PROBE_TIMEOUT_S },
		);
		if (!result || result.truncated || result.timed_out || typeof result.stdout !== 'string') {
			return { found: null, error: 'herdr-core did not finish the check' };
		}
		const found = parseProbeOutput(Buffer.from(result.stdout, 'base64').toString('utf8'), programs);
		return found ? { found } : { found: null, error: 'herdr-core did not finish the check' };
	} catch (error) {
		return { found: null, error: error instanceof Error ? error.message : String(error) };
	}
}
