/**
 * The pane surface seam (issue #92, ADR-0002).
 *
 * A tab's view (#104) decides which surface its terminal view mounts: the
 * existing terminal lifecycle, or the native view. What is tested here is the
 * choice and the swap, with a fake surface factory in place of both adapters —
 * the terminal lifecycle has its own tests (`tests/paneTerminal.test.ts`, which
 * this change leaves alone) and the native surface needs a DOM.
 */

import { describe, expect, it } from 'vitest';
import {
	effectivePaneView,
	NATIVE_REMOTE_REASON,
	PaneSurfaceHolder,
	paneViewAvailability,
	surfaceKindFor,
	type PaneSurface,
	type PaneSurfaceKind,
} from '../src/native/surface';
import { effectiveEngine } from '../src/native/renderMode';
import type { PaneIdentity, TerminalEffect } from '../src/views/paneTerminal';

describe('surfaceKindFor (ADR-0002)', () => {
	it('sends the terminal view to the terminal lifecycle', () => {
		expect(surfaceKindFor('terminal')).toBe('terminal');
	});

	it('sends the native view to the native surface', () => {
		expect(surfaceKindFor('native')).toBe('native');
	});
});

describe('paneViewAvailability (ADR-0002)', () => {
	it('offers both views on a local pane', () => {
		for (const view of ['terminal', 'native'] as const) {
			expect(paneViewAvailability(view, { remote: false })).toEqual({
				available: true,
				reason: null,
			});
		}
	});

	it('offers native as unavailable on a remote endpoint, with the reason', () => {
		expect(paneViewAvailability('native', { remote: true })).toEqual({
			available: false,
			reason: NATIVE_REMOTE_REASON,
		});
		expect(NATIVE_REMOTE_REASON).toBe('local panes only');
	});

	it('leaves the terminal view available on a remote endpoint', () => {
		expect(paneViewAvailability('terminal', { remote: true }).available).toBe(true);
	});
});

describe('effectivePaneView (issues #92, #104)', () => {
	it('is the tab\u2019s own view once it has chosen one', () => {
		expect(effectivePaneView({ stored: 'native', fallback: 'terminal', remote: false })).toBe(
			'native',
		);
	});

	it('is the global default view while the tab has never chosen', () => {
		expect(effectivePaneView({ stored: null, fallback: 'native', remote: false })).toBe('native');
	});

	it('keeps a terminal surface on a remote endpoint, whichever side asked for native', () => {
		// ADR-0002: a remote pane keeps its terminal until an SSH transcript
		// adapter exists. The stored preference itself is untouched (#104).
		expect(effectivePaneView({ stored: 'native', fallback: 'terminal', remote: true })).toBe(
			'terminal',
		);
		expect(effectivePaneView({ stored: null, fallback: 'native', remote: true })).toBe('terminal');
	});
});

describe('effectiveEngine (issue #104)', () => {
	it('is the tab\u2019s own engine once it has chosen one', () => {
		expect(effectiveEngine('xterm.js', 'ghostty-web')).toBe('xterm.js');
	});

	it('falls back to the global engine on its own, whatever the view is', () => {
		expect(effectiveEngine(null, 'xterm.js')).toBe('xterm.js');
	});

	it('normalises an unreadable global engine instead of throwing', () => {
		expect(effectiveEngine(null, 'nonsense')).toBe('ghostty-web');
		expect(effectiveEngine(null, undefined)).toBe('ghostty-web');
	});
});

/** A surface that records what was done to it into a shared log. */
class FakeSurface implements PaneSurface {
	constructor(
		readonly kind: PaneSurfaceKind,
		private readonly log: string[],
		/** A detach a test is holding open, or null for one that returns at once. */
		private readonly gate: () => Promise<void> | null = () => null,
	) {}
	async attach(): Promise<void> {
		this.log.push(`attach:${this.kind}`);
	}
	async detach(): Promise<void> {
		const held = this.gate();
		if (held) await held;
		this.log.push(`detach:${this.kind}`);
	}
	async setVisible(visible: boolean): Promise<void> {
		this.log.push(`visible:${this.kind}:${String(visible)}`);
	}
	async setIdentity(identity: PaneIdentity): Promise<void> {
		this.log.push(`identity:${this.kind}:${identity.paneId}`);
	}
	async apply(effect: TerminalEffect): Promise<void> {
		this.log.push(`apply:${this.kind}:${effect}`);
	}
}

/** The holder, its log and how many surfaces the factory built per kind. */
function holderWithLog(): {
	holder: PaneSurfaceHolder;
	log: string[];
	built: string[];
	host: HTMLElement;
	/** Holds every detach from now on; the returned call lets them finish. */
	holdDetach: () => () => void;
} {
	const log: string[] = [];
	const built: string[] = [];
	let held: Promise<void> | null = null;
	const holder = new PaneSurfaceHolder((kind) => {
		built.push(kind);
		return new FakeSurface(kind, log, () => held);
	});
	const holdDetach = (): (() => void) => {
		let finish = (): void => {};
		held = new Promise<void>((resolve) => {
			finish = () => {
				held = null;
				resolve();
			};
		});
		return () => finish();
	};
	// The holder only passes the host element on; nothing here touches a DOM.
	return { holder, log, built, host: {} as HTMLElement, holdDetach };
}

describe('PaneSurfaceHolder (issue #92)', () => {
	it('builds and attaches the surface the view asked for', async () => {
		const { holder, log, built, host } = holderWithLog();

		await holder.show('terminal', host);

		expect(built).toEqual(['terminal']);
		expect(log).toEqual(['attach:terminal']);
		expect(holder.kind).toBe('terminal');
	});

	it('leaves the surface alone while the view stays in the same kind', async () => {
		const { holder, log, built, host } = holderWithLog();

		await holder.show('terminal', host);
		await holder.show('terminal', host);

		expect(built).toEqual(['terminal']);
		expect(log).toEqual(['attach:terminal']);
	});

	it('detaches the old surface before attaching the new one', async () => {
		const { holder, log, host } = holderWithLog();

		await holder.show('terminal', host);
		await holder.show('native', host);

		expect(log).toEqual(['attach:terminal', 'detach:terminal', 'attach:native']);
		expect(holder.kind).toBe('native');
	});

	it('gives the terminal back and takes it again on a switch there and back', async () => {
		const { holder, log, built, host } = holderWithLog();

		await holder.show('terminal', host);
		await holder.show('native', host);
		await holder.show('terminal', host);

		expect(built).toEqual(['terminal', 'native', 'terminal']);
		expect(log).toEqual([
			'attach:terminal',
			'detach:terminal',
			'attach:native',
			'detach:native',
			'attach:terminal',
		]);
	});

	it('releases the current surface and forgets it, idempotently', async () => {
		const { holder, log, built, host } = holderWithLog();

		await holder.show('native', host);
		await holder.release();
		await holder.release();

		expect(log).toEqual(['attach:native', 'detach:native']);
		expect(holder.kind).toBeNull();
		expect(holder.current).toBeNull();

		await holder.show('native', host);
		expect(built).toEqual(['native', 'native']);
	});

	it('mounts nothing when the tab closes during a switch', async () => {
		// `onClose` releases while a switch is waiting for the old surface to
		// detach. The switch must not then attach a surface nobody will ever
		// close again, subscription, tail and all (AGENTS.md teardown, #92/#94).
		const { holder, log, built, host, holdDetach } = holderWithLog();
		await holder.show('terminal', host);
		const finishDetach = holdDetach();

		const switching = holder.show('native', host);
		const closing = holder.release();
		finishDetach();
		await Promise.all([switching, closing]);

		expect(await switching).toBeNull();
		expect(log).toEqual(['attach:terminal', 'detach:terminal']);
		expect(built).toEqual(['terminal']);
		expect(holder.current).toBeNull();
		expect(holder.kind).toBeNull();
	});

	it('mounts only the last kind asked for when two switches overlap', async () => {
		const { holder, log, host, holdDetach } = holderWithLog();
		await holder.show('terminal', host);
		const finishDetach = holdDetach();

		const first = holder.show('native', host);
		const second = holder.show('terminal', host);
		finishDetach();
		await Promise.all([first, second]);

		expect(await first).toBeNull();
		expect(holder.kind).toBe('terminal');
		expect(log).toEqual(['attach:terminal', 'detach:terminal', 'attach:terminal']);
	});

	it('passes identity, visibility and setting effects to the surface in place', async () => {
		const { holder, log, host } = holderWithLog();

		await holder.show('native', host);
		await holder.current?.setIdentity({ paneId: 'w4:p1', mode: 'control', endpointId: 'local' });
		await holder.current?.setVisible(false);
		await holder.current?.apply('theme');

		expect(log).toEqual([
			'attach:native',
			'identity:native:w4:p1',
			'visible:native:false',
			'apply:native:theme',
		]);
	});
});
