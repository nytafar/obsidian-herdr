/**
 * "Trust new folders automatically" through the answer driver (#167): a tab
 * watches its pane while the agent has no session and answers the trust
 * prompt once the screen shows it for the pane's own folder. herdr-core
 * reports no status there at all, so it starts from the screen; herdr
 * reports a plain `blocked`. Against the scripted fake screen.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseClaudeScreen } from '../src/agents/claude/screenDialog';
import { ScreenAnswerer, type AnswerTiming } from '../src/native/screenAnswer';
import { ScreenAnswerers, type ScreenAnswering } from '../src/native/screenAnswerers';
import type { PaneSnapshot } from '../src/native/sessionWatcher';
import { beforeSession, sessionStarted, trustReceipt, TrustWatch } from '../src/native/trustWatch';
import { FakeClaudeScreen, trustDialog, type SimOptions } from './fixtures/fakeClaudeScreen';

const CWD = '/var/tmp/oh-test-trust';
const FAST: AnswerTiming = { pollMs: 1, stepMs: 300, confirmMs: 10, quietMs: 60, lateMs: 600, receiptMs: 300 };

interface Setup {
	sim: FakeClaudeScreen;
	pane: PaneSnapshot;
	notices: string[];
	watch: (claims?: ScreenAnswerers, answerer?: ScreenAnswerer) => TrustWatch;
	answerer: ScreenAnswerer;
	claims: ScreenAnswerers;
	clock: { now: number };
}

/** An hc terminal at the trust prompt: no session, no status (`unknown`). */
function setup(folder = CWD, options: SimOptions = {}, enabled = true): Setup {
	const pane: PaneSnapshot = { paneId: 't1', cwd: CWD, agentSession: '', agentStatus: 'unknown' };
	const sim = new FakeClaudeScreen(trustDialog(folder), {
		...options,
		// Trusted, Claude reports `idle` (measured on hc 0.1.18).
		next: (received) => {
			if (received.kind === 'started') pane.agentStatus = 'idle';
			return { kind: 'composer' };
		},
	});
	const answerer = new ScreenAnswerer({ screen: sim, parse: parseClaudeScreen, timing: FAST });
	const claims = new ScreenAnswerers();
	const notices: string[] = [];
	const clock = { now: 0 };
	const watch = (shared = claims, driver = answerer): TrustWatch => {
		const answering: ScreenAnswering = {
			answerer: driver,
			screen: sim,
			parse: parseClaudeScreen,
			statusMessage: () => null,
			cwd: () => pane.cwd,
		};
		return new TrustWatch({
			enabled: () => enabled,
			pane: () => pane,
			answering: () => answering,
			claim: () => shared.claimTrust('local\nt1'),
			release: () => shared.releaseTrust('local\nt1'),
			notify: (message) => notices.push(message),
			maxReads: 4,
			settleMs: 1000,
			now: () => clock.now,
		});
	};
	return { sim, pane, notices, watch, answerer, claims, clock };
}

/** One tick, a second after the last, until the watch is idle again (its look and any answer done). */
async function tick(watch: TrustWatch, clock?: { now: number }): Promise<void> {
	if (clock) clock.now += 1000;
	watch.tick();
	await vi.waitFor(() => expect((watch as unknown as { running: boolean }).running).toBe(false));
}

describe('trust watch (#167)', () => {
	it('trusts the pane’s own folder with down enter, once, through the driver, after the prompt stayed up', async () => {
		const s = setup();
		const watch = s.watch();
		// Claude draws the prompt twice at startup: the first sighting presses nothing.
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual([]);
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual(['down', 'enter']);
		expect(s.pane.agentStatus).toBe('idle');
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual(['down', 'enter']);
		expect(s.notices).toEqual([]);
	});

	it('answers a herdr pane, which reports a plain blocked', async () => {
		const s = setup();
		s.pane.agentStatus = 'blocked';
		const watch = s.watch();
		await tick(watch, s.clock);
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('starts the wait again when the prompt was not on screen in between', async () => {
		const s = setup();
		const watch = s.watch();
		const prompt = s.sim.dialog;
		await tick(watch, s.clock);
		s.sim.dialog = { kind: 'composer' };
		await tick(watch, s.clock);
		s.sim.dialog = prompt;
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual([]);
		await tick(watch, s.clock);
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('never presses anything when the prompt names another folder, and gives up after its reads', async () => {
		const s = setup('/var/tmp/oh-test-trust-other');
		const watch = s.watch();
		for (let i = 0; i < 6; i++) await tick(watch, s.clock);
		expect(s.sim.keys).toEqual([]);
		expect(s.sim.reads).toBe(4);
	});

	it('does nothing with the setting off, past the prompt, or for a pane with a session', async () => {
		const off = setup(CWD, {}, false);
		await tick(off.watch());
		expect(off.sim.reads).toBe(0);
		const idle = setup();
		idle.pane.agentStatus = 'idle';
		await tick(idle.watch());
		const session = setup();
		session.pane.agentSession = 's-1';
		await tick(session.watch());
		expect(idle.sim.reads + session.sim.reads).toBe(0);
	});

	it('answers once for two tabs on one pane: the claim is the plugin’s', async () => {
		const s = setup();
		const first = s.watch();
		const second = s.watch();
		await tick(first, s.clock);
		await tick(second);
		s.clock.now += 1000;
		first.tick();
		second.tick();
		await vi.waitFor(() => expect(s.pane.agentStatus).toBe('idle'));
		await tick(first);
		await tick(second);
		expect(s.sim.keys).toEqual(['down', 'enter']);
	});

	it('says so when the key did not take, and never presses it again', async () => {
		const s = setup(CWD, { drop: (key) => key === 'enter' });
		const watch = s.watch();
		await tick(watch, s.clock);
		await tick(watch, s.clock);
		expect(s.notices).toEqual([`Gjetr: trusting ${CWD}: The terminal did not take the answer. Answer it in the terminal.`]);
		await tick(watch, s.clock);
		await tick(watch, s.clock);
		expect(s.sim.keys.filter((key) => key === 'enter')).toHaveLength(1);
	});

	it('reads the session starting as the receipt, and a pane gone as Claude exiting', async () => {
		const pane: PaneSnapshot = { paneId: 't1', cwd: CWD, agentSession: '', agentStatus: 'unknown' };
		expect(beforeSession(pane)).toBe(true);
		let now: PaneSnapshot | null = pane;
		const started = trustReceipt(() => now, new AbortController().signal, 1);
		now = { ...pane, agentStatus: 'idle' };
		expect(sessionStarted(now)).toBe(true);
		await expect(started).resolves.toEqual({ kind: 'started' });
		now = null;
		await expect(trustReceipt(() => now, new AbortController().signal, 1)).resolves.toEqual({ kind: 'exited' });
	});
});
