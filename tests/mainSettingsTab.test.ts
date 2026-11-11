/**
 * The settings tab's runtime list is read when its definitions are, so a
 * change to the set of runtimes or to the active one made outside the tab
 * (the Get started flow, the agent list's switcher, the Switch runtime
 * command) calls the tab's `update()`: without it the list has no row for
 * the new runtime and no Active mark (#178, review finding 1).
 *
 * The plugin is built with `Object.create`, as in `mainGraduation.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import HerdrPlugin from '../src/main';
import { defaultLocalRuntime, newRuntime } from '../src/runtimes';

function plugin(): { plugin: HerdrPlugin; calls: string[] } {
	const calls: string[] = [];
	const plugin = Object.create(HerdrPlugin.prototype) as HerdrPlugin;
	const loose = plugin as unknown as Record<string, unknown>;
	const other = newRuntime('herdr', 'ssh', ['local']);
	loose.settings = { runtimes: [defaultLocalRuntime(), other], activeRuntime: 'local' };
	loose.saveSettings = async () => {
		calls.push('save');
	};
	loose.refreshRuntimes = () => calls.push('refreshRuntimes');
	loose.reconnect = async () => {
		calls.push('reconnect');
	};
	loose.settingTab = { update: () => calls.push('update') };
	return { plugin, calls };
}

describe('the settings tab follows runtime changes made outside it', () => {
	it('is updated when the active runtime changes, before the reconnect', async () => {
		const { plugin: p, calls } = plugin();
		const id = p.settings.runtimes[1]!.id;
		await p.switchRuntime(id);
		expect(p.settings.activeRuntime).toBe(id);
		expect(calls).toEqual(['save', 'refreshRuntimes', 'update', 'reconnect']);
	});

	it('is updated when Get started adds a runtime', async () => {
		const { plugin: p, calls } = plugin();
		const host = (p as unknown as { getStartedHost(): { addRuntime(runtime: unknown): Promise<void> } }).getStartedHost();
		const added = newRuntime('claude', 'local', p.settings.runtimes.map((runtime) => runtime.id));
		await host.addRuntime(added);
		expect(p.settings.runtimes.at(-1)).toBe(added);
		expect(calls).toEqual(['save', 'refreshRuntimes', 'update']);
	});
});
