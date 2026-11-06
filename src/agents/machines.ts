/**
 * Which machines an agent CLI is installed on, across every configured
 * runtime, for the settings tab's Agents section (issue #125). Information
 * only: the active runtime's catalog (`catalogs.ts`) still decides the menu,
 * the default and what can start.
 *
 * A **machine** is where runtimes run, not a runtime: every local runtime is
 * "this machine", and a herdr and an hc runtime on one SSH host are that one
 * host. Each machine is probed once per opening of the settings tab
 * ({@link MachineProbes}, which the tab drops when it closes); "Check again"
 * forces it. A machine the published connection runs on reads that
 * connection's probe; any other is asked directly: this machine by
 * `probeLocal`, an SSH host by the one-shot `probeOverSsh`, with no tunnel and
 * no `hc connect`.
 *
 * The merge and the wording are pure ({@link machinesOf},
 * {@link machineLine}, {@link machineFailures}); tested in
 * `tests/agentMachines.test.ts`. No `obsidian` import.
 */

import { defaultDeps } from '../herdr/binary';
import { defaultDeps as sshDefaultDeps } from '../herdr/ssh';
import type { RuntimeConfig } from '../runtimes';
import type { AgentProbe } from './catalog';
import { probeLocal, probeOverSsh } from './probe';

/** One machine some configured runtime runs on. */
export interface Machine {
	/** `local`, or `ssh:<host>`. */
	key: string;
	/** What the settings call it: "this machine", or the SSH host. */
	label: string;
	target: 'local' | 'ssh';
	/** The SSH destination; empty for this machine. */
	host: string;
	/** The vault root the probe resolves shims from; empty on this machine (the local vault). */
	vaultRoot: string;
}

/** The label of this machine. */
export const THIS_MACHINE = 'this machine';

/** The machine a runtime runs on, by key; null for an SSH runtime without a host. */
export function machineKeyOf(runtime: Pick<RuntimeConfig, 'target' | 'host'>): string | null {
	if (runtime.target !== 'ssh') return 'local';
	const host = runtime.host.trim();
	return host ? `ssh:${host}` : null;
}

/**
 * The machines of the configured runtimes: this machine first when any
 * runtime is local, then each SSH host once, in the order of the runtimes.
 *
 * Two runtimes on one host may name different vault paths. The probe uses
 * one, deterministically: the active runtime's when it is on that host and
 * has one, else the first non-empty `remoteVaultPath` in the order of the
 * runtimes, else none (the remote home).
 */
export function machinesOf(
	runtimes: readonly Pick<RuntimeConfig, 'id' | 'target' | 'host' | 'remoteVaultPath'>[],
	activeId: string,
): Machine[] {
	const machines = new Map<string, Machine>();
	let local: Machine | null = null;
	for (const runtime of runtimes) {
		const key = machineKeyOf(runtime);
		if (key === null) continue;
		if (key === 'local') {
			local ??= { key, label: THIS_MACHINE, target: 'local', host: '', vaultRoot: '' };
			continue;
		}
		const vault = runtime.remoteVaultPath.trim();
		const known = machines.get(key);
		if (!known) {
			const host = runtime.host.trim();
			machines.set(key, { key, label: host, target: 'ssh', host, vaultRoot: vault });
		} else if (vault && (known.vaultRoot === '' || runtime.id === activeId)) {
			known.vaultRoot = vault;
		}
	}
	return [...(local ? [local] : []), ...machines.values()];
}

/** What is known of one machine: still checking, or what its probe answered. */
export type MachineState = { checking: true } | { checking: false; probe: AgentProbe };

/** "a", "a and b", "a, b and c". */
export function listPhrase(items: readonly string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * Whether a machine's answer covers this program: true or false once it
 * landed and was asked about it, null while it is checking, or the probe
 * was not asked about the program yet; undefined when the probe failed.
 */
function lookup(state: MachineState | undefined, program: string): boolean | null | undefined {
	if (!state || state.checking) return null;
	const { found, checked } = state.probe;
	if (found === null) return undefined;
	if (checked && !checked.has(program)) return null;
	return found.has(program);
}

/**
 * One row's line: "Found on this machine and lasse@mac. Not found on xl.
 * Checking asher…". A machine whose probe failed is left out here; the
 * section says so once ({@link machineFailures}).
 */
export function machineLine(
	program: string,
	machines: readonly Machine[],
	states: ReadonlyMap<string, MachineState>,
): string {
	const found: string[] = [];
	const missing: string[] = [];
	const checking: string[] = [];
	for (const machine of machines) {
		const answer = lookup(states.get(machine.key), program);
		if (answer === true) found.push(machine.label);
		else if (answer === false) missing.push(machine.label);
		else if (answer === null) checking.push(machine.label);
	}
	const parts: string[] = [];
	if (found.length > 0) parts.push(`Found on ${listPhrase(found)}.`);
	if (missing.length > 0) parts.push(`Not found on ${listPhrase(missing)}.`);
	if (checking.length > 0) parts.push(`Checking ${listPhrase(checking)}…`);
	return parts.join(' ');
}

/** Whether any landed machine found the program. */
export function foundOnAny(program: string, machines: readonly Machine[], states: ReadonlyMap<string, MachineState>): boolean {
	return machines.some((machine) => lookup(states.get(machine.key), program) === true);
}

/** "Could not check xl: ssh xl did not answer." once per failed machine. */
export function machineFailures(machines: readonly Machine[], states: ReadonlyMap<string, MachineState>): string {
	const lines: string[] = [];
	for (const machine of machines) {
		const state = states.get(machine.key);
		if (!state || state.checking || state.probe.found !== null) continue;
		const reason = (state.probe.error ?? '').trim().replace(/[.!?]$/, '') || 'no answer';
		lines.push(`Could not check ${machine.label}: ${reason}.`);
	}
	return lines.join(' ');
}

/** How {@link MachineProbes} asks a machine. Never expected to reject. */
export interface MachineProbesHost {
	/**
	 * The probe of the published connection when it runs on this machine and
	 * its kind probes, started or shared; null otherwise.
	 */
	live(machine: Machine): Promise<AgentProbe> | null;
	/** This machine's binary search, from the local vault. */
	local(programs: readonly string[]): Promise<AgentProbe>;
	/** One `ssh` to the machine, from its vault root. */
	ssh(machine: Machine, programs: readonly string[]): Promise<AgentProbe>;
}

/**
 * The real probes: `probeLocal` over the filesystem and the login shell,
 * `probeOverSsh` over `ssh.ts`'s runner, the same ones the herdr kind runs.
 */
export function defaultMachineProbesHost(options: {
	live: MachineProbesHost['live'];
	extraPath: () => string;
	vaultPath: () => string;
}): MachineProbesHost {
	return {
		live: options.live,
		local: (programs) =>
			probeLocal(programs, { extraPath: options.extraPath(), vaultRoot: options.vaultPath() }, defaultDeps()),
		ssh: (machine, programs) =>
			probeOverSsh(machine.host, programs, sshDefaultDeps().run, { vaultRoot: machine.vaultRoot }),
	};
}

interface Entry {
	programs: ReadonlySet<string>;
	pending: Promise<AgentProbe>;
	landed: AgentProbe | null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function covers(probe: AgentProbe, programs: readonly string[]): boolean {
	if (probe.found === null) return false;
	const checked = probe.checked;
	return !checked || programs.every((program) => checked.has(program));
}

/**
 * The probes of one opening of the settings tab, one per machine. Drawing
 * asks again only for a machine never asked, or asked about fewer programs
 * (a user entry added since); "Check again" forces every machine.
 */
export class MachineProbes {
	private readonly entries = new Map<string, Entry>();
	private generation = 0;

	constructor(private readonly host: MachineProbesHost) {}

	/** What is known of each machine now, without probing. */
	states(machines: readonly Machine[]): Map<string, MachineState> {
		const states = new Map<string, MachineState>();
		for (const machine of machines) {
			const entry = this.entries.get(machine.key);
			if (!entry) continue;
			states.set(machine.key, entry.landed ? { checking: false, probe: entry.landed } : { checking: true });
		}
		return states;
	}

	/** The machine's probe, shared until it is forced or the program list grows. */
	probe(machine: Machine, programs: readonly string[], force = false): Promise<AgentProbe> {
		const entry = this.entries.get(machine.key);
		if (entry && !force && programs.every((program) => entry.programs.has(program))) return entry.pending;
		const next: Entry = { programs: new Set(programs), pending: Promise.resolve({ found: null }), landed: null };
		next.pending = this.run(machine, programs).then((result) => {
			const landed: AgentProbe = { found: result.found, error: result.error ?? null, checked: new Set(programs) };
			if (this.entries.get(machine.key) === next) next.landed = landed;
			return landed;
		});
		this.entries.set(machine.key, next);
		return next.pending;
	}

	/** Every machine's probe, in parallel; each promise lands on its own. */
	probeAll(machines: readonly Machine[], programs: readonly string[], force = false): Promise<AgentProbe>[] {
		return machines.map((machine) => this.probe(machine, programs, force));
	}

	/** The live connection's answer when it has one for these programs, else a direct probe. */
	private async run(machine: Machine, programs: readonly string[]): Promise<AgentProbe> {
		try {
			const live = this.host.live(machine);
			if (live) {
				const probe = await live;
				if (covers(probe, programs)) return probe;
			}
			return machine.target === 'ssh' ? await this.host.ssh(machine, programs) : await this.host.local(programs);
		} catch (error) {
			return { found: null, error: message(error) };
		}
	}

	/**
	 * Starts a drawing of the section: the returned check stays true until
	 * the next drawing or {@link dispose}, so a probe landing after either
	 * touches nothing.
	 */
	beginDraw(): () => boolean {
		const drawn = ++this.generation;
		return () => this.generation === drawn;
	}

	/** The settings tab closed: nothing drawn before updates any more. */
	dispose(): void {
		this.generation++;
	}
}
