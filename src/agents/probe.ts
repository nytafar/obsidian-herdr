/**
 * The probes behind the agent catalog (issue #125): which of a list of
 * programs exist on a runtime's machine, asked once per connection.
 *
 * - **This machine:** the binary search herdr's own discovery does
 *   (`herdr/binary.ts`): Homebrew, `/usr/local/bin`, `~/.local/bin`, the
 *   settings' extra PATH entries, then the login shell's PATH, which is asked
 *   once for the whole list and only when the fixed directories missed one.
 *   Filesystem checks otherwise; nothing else is spawned.
 * - **An SSH host:** one `ssh -T <host> sh -c '<script>' sh <vault> <program>…`, in
 *   the shape of `remoteHerdrCommand`. The script first asks the user's own
 *   shell there (`$SHELL -l -i -c 'printenv PATH'`) for its PATH, because
 *   that is where agents start: herdr runs them in an interactive pane
 *   shell, herdr-core in `"$SHELL" -ic` (`hc/actions.ts`). An nvm, bun or
 *   npm-global install is on that PATH and not on the non-interactive one.
 *   Then the non-interactive PATH, then the same three directories there.
 * - **herdr-core over SSH:** the same script in one `machine.exec` over the
 *   runtime's own connection, and hc's `templates.list`.
 *
 * The script prints the 1-based index of every program it found, then `ok`,
 * so a cut-off answer is told from "nothing installed", and a `~` the remote
 * login shell might expand never has to be matched back. It holds no single
 * quote or backslash, so a fish or nu login shell reads the quoted script the
 * way `sh` does (the same rule as `remoteHerdrCommand`).
 *
 * The user's shell is asked with `printenv PATH`, an external program in
 * every shell, so bash, zsh, fish and nu all answer in the colon form
 * without the script quoting a `$` for them. Its stdin is `/dev/null`, its
 * stderr dropped (an interactive shell without a terminal complains about
 * job control), only its last line kept (an rc file may print), and only a
 * line starting with `/` used. It runs under `timeout` where the machine has
 * one; where it has none, a shell that hangs runs into the probe's own
 * timeout, which is a failed, unverified probe rather than a wrong answer.
 *
 * Version-manager shims (mise's `~/.local/share/mise/shims/`, asdf's
 * `~/.asdf/shims/`) are executable for every tool the manager ever
 * installed, active or not, and whether one runs depends on the working
 * directory. Agents start in the vault (or a folder in it), so a shim counts
 * only when `mise which <name>` (or `asdf which`) answers from the runtime's
 * vault root: the local vault path, or `remoteVaultPath` on a remote. Measured
 * 2026-11-06: 11 of 16 programs found on one Linux machine were mise shims
 * for tools not active there. If the manager cannot answer (missing, cannot
 * run, timed out), the shim counts, as before.
 */

import { basename, dirname, join } from 'node:path';
import { shellQuote } from '../hc/client';
import { BINARY_DIRECTORIES, expandHome, loginShellPath, type DiscoveryDeps } from '../herdr/binary';
import type { RunCommand } from '../herdr/ssh';
import type { AgentProbe, HcTemplate } from './catalog';

/** How long the SSH probe may take before it counts as failed. */
export const SSH_PROBE_TIMEOUT_MS = 15_000;
/** `machine.exec`'s own timeout for the probe, in seconds. */
export const HC_PROBE_TIMEOUT_S = 15;

/** How long one local `mise which` or `asdf which` may take. */
export const SHIM_TIMEOUT_MS = 3_000;

/**
 * The probe, as `sh -c` runs it with the vault root as `$1` (empty for none,
 * which is the home directory) and the programs as `$2…`.
 *
 * A program found as a mise or asdf shim is asked of its manager from the
 * vault root (`mise which <name>`): a shim for a tool that is not active
 * there would not run where agents start, so it is not found. When the
 * manager is missing, times out (124, or killed) or cannot run (126 and up),
 * the file counts as found, as before; after one timeout no further shim is
 * asked, so the shims together add at most one `timeout 3` to the budget.
 */
export const PROBE_SCRIPT =
	't=; u=; if command -v timeout >/dev/null 2>&1; then t="timeout 10"; u="timeout 3"; fi; ' +
	'x=; if [ -n "${SHELL:-}" ]; then ' +
	'x=$($t "$SHELL" -l -i -c "printenv PATH" </dev/null 2>/dev/null | tail -n 1); fi; ' +
	'case $x in /*) PATH=$x:$PATH ;; esac; ' +
	'v=${1:-}; shift; case $v in "~/"*) v=$HOME/${v#??} ;; esac; [ -n "$v" ] || v=$HOME; ' +
	'cd "$v" 2>/dev/null || cd "$HOME" 2>/dev/null; s=1; ' +
	'i=0; for p in "$@"; do i=$((i+1)); f=; ' +
	'case $p in ' +
	'"~/"*) f=$HOME/${p#??} ;; ' +
	'/*) f=$p ;; ' +
	'*) f=$(command -v "$p" 2>/dev/null) || f=; ' +
	'[ -n "$f" ] || for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do ' +
	'[ -x "$d/$p" ] && { f=$d/$p; break; }; done ;; ' +
	'esac; ' +
	'[ -n "$f" ] && [ -x "$f" ] || continue; ' +
	'w=; case $f in */mise/shims/*) w=mise ;; */.asdf/shims/*) w=asdf ;; esac; ' +
	'if [ -n "$w" ] && [ -n "$s" ]; then b=$(command -v $w 2>/dev/null) || b=; ' +
	'[ -n "$b" ] || for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.asdf/bin"; do ' +
	'[ -x "$d/$w" ] && { b=$d/$w; break; }; done; ' +
	'if [ -n "$b" ]; then $u "$b" which "${f##*/}" </dev/null >/dev/null 2>&1; r=$?; ' +
	'if [ $r -eq 124 ] || [ $r -gt 128 ]; then s=; fi; ' +
	'if [ $r -ne 0 ] && [ $r -lt 124 ]; then continue; fi; fi; fi; ' +
	'echo $i; ' +
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

/** What follows `sh -c <script>`: `$0`, the vault root (`$1`), the programs. */
export function probeScriptArgs(programs: readonly string[], vaultRoot = ''): string[] {
	return ['sh', vaultRoot.trim(), ...programs];
}

/** The remote command of the SSH probe: the script, the vault root and the programs, quoted. */
export function sshProbeCommand(programs: readonly string[], vaultRoot = ''): string {
	return ['sh', '-c', PROBE_SCRIPT, ...probeScriptArgs(programs, vaultRoot)].map(shellQuote).join(' ');
}

/** The SSH probe's argv for `ssh`, non-interactive like every other ssh here. */
export function sshProbeArgs(host: string, programs: readonly string[], vaultRoot = ''): string[] {
	return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, sshProbeCommand(programs, vaultRoot)];
}

/**
 * Which programs exist on an SSH host, in one `ssh`. `run` is `ssh.ts`'s
 * runner: no shell on this side, killed on timeout, empty on failure.
 */
export async function probeOverSsh(
	host: string,
	programs: readonly string[],
	run: RunCommand,
	options: { sshBinary?: string; timeoutMs?: number; vaultRoot?: string } = {},
): Promise<AgentProbe> {
	if (programs.length === 0) return { found: new Set() };
	const trimmed = host.trim();
	if (!trimmed) return { found: null, error: 'the runtime has no SSH host' };
	const controller = new AbortController();
	const stdout = await run(options.sshBinary ?? 'ssh', sshProbeArgs(trimmed, programs, options.vaultRoot), {
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

/** A version manager whose shims resolve per working directory. */
export type ShimManager = 'mise' | 'asdf';

/**
 * The manager behind a shim, or null for an ordinary program. mise's shims
 * are symlinks to `mise` itself, in `…/mise/shims/`; asdf's are scripts in
 * `~/.asdf/shims/`, or `$ASDF_DATA_DIR/shims/`.
 */
export function shimManagerOf(
	path: string,
	realPath: string | null,
	env: NodeJS.ProcessEnv = {},
): ShimManager | null {
	if (path.includes('/mise/shims/')) return 'mise';
	if (realPath && basename(realPath) === 'mise' && basename(path) !== 'mise') return 'mise';
	if (path.includes('/.asdf/shims/')) return 'asdf';
	const asdfData = env.ASDF_DATA_DIR?.trim();
	if (asdfData && dirname(path) === join(asdfData, 'shims')) return 'asdf';
	return null;
}

/**
 * Which programs exist on this machine. A path (absolute or `~/`) is checked
 * as it is; a name in the fixed directories and the extras, then on the
 * login shell's PATH, asked once and only when needed.
 *
 * A program found as a mise or asdf shim is asked of its manager, `mise which
 * <name>` with the vault root as working directory and no shell: a tool that
 * is not active there would not run where agents start, so it is not found.
 * When the manager cannot be found, cannot be spawned or times out, the file
 * counts as found, as it did before.
 */
export async function probeLocal(
	programs: readonly string[],
	options: { extraPath?: string; vaultRoot?: string; skipLoginShell?: boolean; loginShellTimeoutMs?: number },
	deps: DiscoveryDeps,
): Promise<AgentProbe> {
	const hits = new Map<string, string>();
	const missing: string[] = [];
	const directories = [...BINARY_DIRECTORIES, ...splitPath(options.extraPath ?? '')].map((dir) =>
		expandHome(dir, deps.home),
	);
	const inAny = (program: string, dirs: readonly string[]): string | null => {
		for (const dir of dirs) {
			const path = join(dir, program);
			if (deps.isExecutable(path)) return path;
		}
		return null;
	};
	for (const program of programs) {
		if (program.includes('/')) {
			const path = expandHome(program, deps.home);
			if (deps.isExecutable(path)) hits.set(program, path);
			continue;
		}
		const path = inAny(program, directories);
		if (path) hits.set(program, path);
		else missing.push(program);
	}
	let shellDirs: string[] = [];
	if (missing.length > 0 && !options.skipLoginShell) {
		const shellPath = await loginShellPath(deps, options.loginShellTimeoutMs);
		shellDirs = splitPath(shellPath ?? '').map((dir) => expandHome(dir, deps.home));
		for (const program of missing) {
			const path = inAny(program, shellDirs);
			if (path) hits.set(program, path);
		}
	}
	// Where a manager is looked for when the shim does not name it.
	const managerDirs = (manager: ShimManager): string[] => [
		...(manager === 'asdf' ? [join(expandHome(deps.env.ASDF_DIR?.trim() || '~/.asdf', deps.home), 'bin')] : []),
		...directories,
		...splitPath(deps.env.PATH ?? ''),
		...shellDirs,
	];
	const cwd = options.vaultRoot?.trim() || deps.home;
	const active = async (path: string): Promise<boolean> => {
		const real = deps.realPath?.(path) ?? null;
		const manager = shimManagerOf(path, real, deps.env);
		if (!manager) return true;
		const binary =
			manager === 'mise' && real && basename(real) === 'mise' ? real : inAny(manager, managerDirs(manager));
		if (!binary) return true;
		const result = await deps.run(binary, ['which', basename(path)], {
			timeoutMs: SHIM_TIMEOUT_MS,
			env: deps.env,
			cwd,
		});
		return result.failed === true || result.code === 0;
	};
	const entries = [...hits];
	const answers = await Promise.all(entries.map(([, path]) => active(path)));
	const found = new Set<string>();
	entries.forEach(([program], index) => {
		if (answers[index]) found.add(program);
	});
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
export async function probeOverHc(
	requester: HcProbeRequester,
	programs: readonly string[],
	vaultRoot = '',
): Promise<AgentProbe> {
	if (programs.length === 0) return { found: new Set() };
	try {
		const result = await requester.request<{ stdout?: unknown; truncated?: boolean; timed_out?: boolean } | null>(
			'machine.exec',
			{ argv: ['sh', '-c', PROBE_SCRIPT, ...probeScriptArgs(programs, vaultRoot)], timeout: HC_PROBE_TIMEOUT_S },
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
