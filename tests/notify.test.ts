import { beforeEach, describe, expect, it } from 'vitest';
import {
	DEBOUNCE_MS,
	TransitionNotifier,
	decideNotification,
	isNotifiedTransition,
	paneName,
	type NotifierDeps,
	type NotifyPlan,
} from '../src/notify';
import type { PaneState } from '../src/herdr/scope';
import type { NotificationSettings } from '../src/settings';
import type { AgentStatus } from '../src/herdr/types.gen';

function pane(status: AgentStatus, overrides: Partial<PaneState> = {}): PaneState {
	return {
		paneId: 'w4:p1',
		workspaceId: 'w4',
		tabId: 'w4:t1',
		agent: 'claude',
		name: '',
		agentStatus: status,
		title: 'hvelv notes',
		label: '',
		cwd: '/Users/lasse/Vaults/hvelv',
		focused: false,
		tokens: {},
		statusChangedSeq: 0,
		...overrides,
	};
}

interface Harness {
	deps: NotifierDeps;
	notifier: TransitionNotifier;
	notices: string[];
	os: { title: string; body: string }[];
	clock: { now: number };
	terminalOpen: Set<string>;
	focused: { value: boolean };
	settings: NotificationSettings;
}

function harness(settingsOverride?: Partial<NotificationSettings>): Harness {
	const clock = { now: 1000 };
	const notices: string[] = [];
	const os: { title: string; body: string }[] = [];
	const terminalOpen = new Set<string>();
	const focused = { value: false };
	const settings: NotificationSettings = {
		statusBar: true,
		blocked: { notice: true, os: true },
		done: { notice: true, os: true },
		...settingsOverride,
	};
	const deps: NotifierDeps = {
		now: () => clock.now,
		settings: () => settings,
		isTerminalOpen: (paneId, endpointId) => terminalOpen.has(`${endpointId} ${paneId}`),
		windowFocused: () => focused.value,
		showNotice: (message: string) => notices.push(message),
		showOsNotification: (title: string, body: string) => os.push({ title, body }),
	};
	return { deps, notifier: new TransitionNotifier(deps), notices, os, clock, terminalOpen, focused, settings };
}

describe('isNotifiedTransition', () => {
	it('fires only on transitions into blocked or done', () => {
		expect(isNotifiedTransition(pane('working'), pane('blocked'))).toBe(true);
		expect(isNotifiedTransition(pane('working'), pane('done'))).toBe(true);
		expect(isNotifiedTransition(pane('blocked'), pane('working'))).toBe(false);
		expect(isNotifiedTransition(pane('idle'), pane('idle'))).toBe(false);
		expect(isNotifiedTransition(pane('done'), pane('unknown'))).toBe(false);
	});

	it('ignores a repeat of the same status', () => {
		expect(isNotifiedTransition(pane('blocked'), pane('blocked', { title: 'new title' }))).toBe(false);
	});
});

describe('paneName', () => {
	it('prefers the agent name, then the label, then the title, then the id', () => {
		expect(paneName(pane('done', { name: 'vault-maintenance', label: 'agent-a' }))).toBe(
			'vault-maintenance',
		);
		expect(paneName(pane('done', { label: 'agent-a' }))).toBe('agent-a');
		expect(paneName(pane('done', { label: '  ' }))).toBe('hvelv notes');
		expect(paneName(pane('done', { label: '', title: '' }))).toBe('w4:p1');
	});
});

describe('decideNotification', () => {
	it('escalates to an OS notification only while the window is unfocused', () => {
		const h = harness();
		h.focused.value = true;
		const focusedPlan = decideNotification(pane('working'), pane('blocked'), 'local', undefined, h.deps);
		expect(focusedPlan?.notice).toBe(true);
		expect(focusedPlan?.os).toBe(false);

		h.focused.value = false;
		const blurredPlan = decideNotification(pane('working'), pane('blocked'), 'local', undefined, h.deps);
		expect(blurredPlan?.os).toBe(true);
	});

	it('respects the per-transition settings', () => {
		const h = harness({ blocked: { notice: false, os: false }, done: { notice: false, os: true } });
		expect(decideNotification(pane('working'), pane('blocked'), 'local', undefined, h.deps)).toBeNull();
		const donePlan = decideNotification(pane('working'), pane('done'), 'local', undefined, h.deps);
		expect(donePlan).toMatchObject({ notice: false, os: true, transition: 'done' });
	});

	it('skips panes whose terminal view is open', () => {
		const h = harness();
		h.terminalOpen.add('local w4:p1');
		expect(decideNotification(pane('working'), pane('blocked'), 'local', undefined, h.deps)).toBeNull();
	});

	it('mutes only the endpoint whose terminal is open (issue #54)', () => {
		const h = harness();
		h.terminalOpen.add('local w4:p1');
		const remote = 'ssh:lasse@xl:/s.sock';
		const plan = decideNotification(pane('working'), pane('blocked'), remote, undefined, h.deps);
		expect(plan).toMatchObject({ paneId: 'w4:p1', endpointId: remote });
	});

	it('skips a pane that fired less than the debounce window ago', () => {
		const h = harness();
		h.clock.now = 5000;
		expect(decideNotification(pane('working'), pane('blocked'), 'local', 5000 - DEBOUNCE_MS + 1, h.deps)).toBeNull();
		expect(decideNotification(pane('working'), pane('blocked'), 'local', 5000 - DEBOUNCE_MS, h.deps)).not.toBeNull();
	});
});

describe('TransitionNotifier', () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it('notifies once and then mutes the pane for the debounce window', () => {
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		expect(h.notices).toHaveLength(1);
		expect(h.os).toHaveLength(1);

		// Flapping blocked -> working -> blocked inside 2 s stays quiet.
		h.clock.now += 500;
		h.notifier.onChanged(pane('blocked'), pane('working'), 'local');
		h.clock.now += 500;
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		expect(h.notices).toHaveLength(1);

		h.clock.now += DEBOUNCE_MS;
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		expect(h.notices).toHaveLength(2);
	});

	it('debounces per pane, not globally', () => {
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		h.clock.now += 10;
		const other = { paneId: 'w4:p2' };
		h.notifier.onChanged(pane('working', other), pane('blocked', other), 'local');
		expect(h.notices).toHaveLength(2);
	});

	it('debounces per endpoint too: the other herdr’s same pane id is another pane (issue #54)', () => {
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		h.clock.now += 10;
		h.notifier.onChanged(pane('working'), pane('blocked'), 'ssh:lasse@xl:/s.sock');
		expect(h.notices).toHaveLength(2);
	});

	it('forgets a pane that left the scope', () => {
		h.notifier.onChanged(pane('working'), pane('done'), 'local');
		h.notifier.forget('w4:p1', 'local');
		h.clock.now += 10;
		const plan: NotifyPlan | null = h.notifier.onChanged(pane('working'), pane('done'), 'local');
		expect(plan).not.toBeNull();
		expect(h.notices).toHaveLength(2);
	});

	it('does not start the debounce window for a suppressed transition', () => {
		h.terminalOpen.add('local w4:p1');
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		expect(h.notices).toHaveLength(0);
		h.terminalOpen.delete('local w4:p1');
		h.clock.now += 10;
		h.notifier.onChanged(pane('working'), pane('blocked'), 'local');
		expect(h.notices).toHaveLength(1);
	});
});
