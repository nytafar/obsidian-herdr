/**
 * Which machines have which agent CLIs (issue #125, `src/agents/machines.ts`):
 * runtimes merged into machines, the per-row wording, the failure line, and
 * the per-opening probe cache. No ssh and no CLI runs: the host is a fake.
 */

import { describe, expect, it } from 'vitest';
import type { AgentProbe } from '../src/agents/catalog';
import {
	listPhrase,
	machineFailures,
	machineKeyOf,
	machineLine,
	machinesOf,
	MachineProbes,
	type Machine,
	type MachineProbesHost,
	type MachineState,
} from '../src/agents/machines';

type R = { id: string; target: 'local' | 'ssh'; host: string; remoteVaultPath: string };
const local = (id: string): R => ({ id, target: 'local', host: '', remoteVaultPath: '' });
const ssh = (id: string, host: string, remoteVaultPath = ''): R => ({ id, target: 'ssh', host, remoteVaultPath });

const landed = (found: string[] | null, error?: string): MachineState => ({
	checking: false,
	probe: found ? { found: new Set(found) } : { found: null, error: error ?? null },
});

describe('machinesOf', () => {
	it('makes every local runtime this machine, and each SSH host one machine, this machine first', () => {
		const machines = machinesOf(
			[ssh('a', 'lasse@mac'), local('b'), ssh('c', ' lasse@mac '), local('d'), ssh('e', 'xl'), ssh('f', '  ')],
			'b',
		);
		expect(machines.map((machine) => [machine.key, machine.label])).toEqual([
			['local', 'this machine'],
			['ssh:lasse@mac', 'lasse@mac'],
			['ssh:xl', 'xl'],
		]);
		expect(machineKeyOf({ target: 'ssh', host: '' })).toBeNull();
	});

	it('takes the active runtime’s vault path on a shared host, else the first one set', () => {
		const runtimes = [ssh('a', 'xl'), ssh('b', 'xl', '/v/one'), ssh('c', 'xl', '/v/two')];
		expect(machinesOf(runtimes, 'a')[0]?.vaultRoot).toBe('/v/one');
		expect(machinesOf(runtimes, 'c')[0]?.vaultRoot).toBe('/v/two');
		expect(machinesOf([ssh('a', 'xl', '/v/a'), ssh('b', 'xl', '/v/b')], 'x')[0]?.vaultRoot).toBe('/v/a');
	});
});

describe('machine wording', () => {
	const machines: Machine[] = machinesOf([local('l'), ssh('m', 'lasse@mac'), ssh('x', 'xl'), ssh('s', 'asher')], 'l');

	it('lists like a sentence', () => {
		expect(listPhrase(['a'])).toBe('a');
		expect(listPhrase(['a', 'b'])).toBe('a and b');
		expect(listPhrase(['a', 'b', 'c'])).toBe('a, b and c');
	});

	it('says where a program was found, where not, and what is still checking', () => {
		const states = new Map<string, MachineState>([
			['local', landed(['codex'])],
			['ssh:lasse@mac', landed(['codex', 'claude'])],
			['ssh:xl', landed(['claude'])],
		]);
		expect(machineLine('codex', machines, states)).toBe(
			'Found on this machine and lasse@mac. Not found on xl. Checking asher…',
		);
		expect(machineLine('gemini', machines, new Map())).toBe('Checking this machine, lasse@mac, xl and asher…');
	});

	it('leaves a failed machine out of the rows and says it once', () => {
		const states = new Map<string, MachineState>([
			['local', landed(['codex'])],
			['ssh:lasse@mac', landed(null, 'ssh lasse@mac did not answer')],
			['ssh:xl', landed(null)],
			['ssh:asher', { checking: true }],
		]);
		expect(machineLine('codex', machines, states)).toBe('Found on this machine. Checking asher…');
		expect(machineFailures(machines, states)).toBe(
			'Could not check lasse@mac: ssh lasse@mac did not answer. Could not check xl: no answer.',
		);
	});

	it('treats a program the probe was not asked about as checking', () => {
		const states = new Map<string, MachineState>([
			['local', { checking: false, probe: { found: new Set(['codex']), checked: new Set(['codex']) } }],
		]);
		expect(machineLine('my-agent', machines.slice(0, 1), states)).toBe('Checking this machine…');
	});
});

describe('MachineProbes', () => {
	function fakeHost(live: Promise<AgentProbe> | null = null): { host: MachineProbesHost; asked: string[] } {
		const asked: string[] = [];
		return {
			asked,
			host: {
				live: (machine) => (machine.key === 'local' ? live : null),
				local: async (programs) => {
					asked.push('local');
					return { found: new Set(programs.slice(0, 1)) };
				},
				ssh: async (machine) => {
					asked.push(`ssh:${machine.host}:${machine.vaultRoot}`);
					return { found: new Set() };
				},
			},
		};
	}
	const machines = machinesOf([local('l'), ssh('a', 'xl', '/v'), ssh('b', 'xl')], 'l');

	it('asks each machine once until forced or the program list grows', async () => {
		const { host, asked } = fakeHost();
		const probes = new MachineProbes(host);
		await Promise.all(probes.probeAll(machines, ['claude']));
		await Promise.all(probes.probeAll(machines, ['claude']));
		expect(asked).toEqual(['local', 'ssh:xl:/v']);
		expect(probes.states(machines).get('local')).toMatchObject({ checking: false });

		await Promise.all(probes.probeAll(machines, ['claude', 'codex']));
		expect(asked).toHaveLength(4);
		await Promise.all(probes.probeAll(machines, ['claude'], true));
		expect(asked).toHaveLength(6);
	});

	it('reads the live connection’s probe, and probes directly when it failed', async () => {
		const good = fakeHost(Promise.resolve({ found: new Set(['codex']) }));
		const probes = new MachineProbes(good.host);
		const [answer] = probes.probeAll(machines.slice(0, 1), ['codex']);
		expect((await answer)?.found).toEqual(new Set(['codex']));
		expect(good.asked).toEqual([]);

		const bad = fakeHost(Promise.resolve({ found: null, error: 'not connected' }));
		await Promise.all(new MachineProbes(bad.host).probeAll(machines.slice(0, 1), ['codex']));
		expect(bad.asked).toEqual(['local']);
	});

	it('shows checking while a probe is out, and stops a disposed drawing', async () => {
		const { host } = fakeHost();
		const probes = new MachineProbes(host);
		const isCurrent = probes.beginDraw();
		const pending = probes.probeAll(machines, ['claude']);
		expect(probes.states(machines).get('ssh:xl')).toEqual({ checking: true });
		await Promise.all(pending);
		expect(isCurrent()).toBe(true);
		probes.dispose();
		expect(isCurrent()).toBe(false);
	});
});
