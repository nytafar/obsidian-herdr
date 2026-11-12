/**
 * The pane context (issue #184): what a terminal tab's pane is, asked of a
 * fake endpoint resolver and fake kinds, with no view, no DOM and no plugin.
 */

import { describe, expect, it } from 'vitest';
import { endpointOf, type Endpoint } from '../src/connection';
import { PaneContext, NATIVE_UNKNOWN_RUNTIME_REASON, type PaneContextHost } from '../src/views/paneContext';
import { HERDR_CAPABILITIES, type RuntimeKindAdapter } from '../src/runtime/kind';
import { ScreenAnswerers } from '../src/native/screenAnswerers';
import { defaultLocalRuntime, newRuntime, type RuntimeConfig, type RuntimeKind } from '../src/runtimes';
import { DEFAULT_SETTINGS, type HerdrSettings } from '../src/settings';
import type { PaneGlance, PaneSnapshot, SessionWatcher } from '../src/native/sessionWatcher';
import type { PromptClient } from '../src/native/promptSender';

const LOCAL = defaultLocalRuntime();
const XL: RuntimeConfig = {
	...newRuntime('herdr', 'ssh', [], () => 0.5),
	id: 'rt-xl',
	host: 'xl',
	remoteVaultPath: '/home/lasse/hvelv/',
};
const CLAUDE: RuntimeConfig = { ...newRuntime('claude', 'local', [], () => 0.3), id: 'rt-claude' };
const CORE: RuntimeConfig = { ...newRuntime('herdr-core', 'local', [], () => 0.1), id: 'rt-core' };

const NATIVE = {
	transcriptAccess: (endpoint: Endpoint) => (endpoint.runtime.target === 'ssh' ? null : 'local'),
};

/** A kind adapter with only what the context reads, and a log of what it was asked. */
function fakeKind(kind: RuntimeKind, extra: Partial<Record<keyof RuntimeKindAdapter, unknown>> = {}) {
	const sent: string[] = [];
	const keys: string[][] = [];
	const adapter = {
		kind,
		unavailable: null,
		terminalUnavailable: null,
		nativeUnavailable: null,
		capabilities: HERDR_CAPABILITIES,
		native: NATIVE,
		promptSender: (client: () => PromptClient | null) => ({
			send: (paneId: string, text: string) => {
				sent.push(`${kind}:${paneId}:${text}:${client() === null ? 'no client' : 'client'}`);
				return Promise.resolve();
			},
		}),
		keySender: () => ({
			sendKeys: (_paneId: string, pressed: string[]) => {
				keys.push([kind, ...pressed]);
				return Promise.resolve();
			},
		}),
		...extra,
	};
	return { adapter: adapter as unknown as RuntimeKindAdapter, sent, keys };
}

interface Pane {
	snapshot?: Partial<PaneSnapshot>;
	glance?: Partial<PaneGlance>;
	unavailable?: string;
}

function harness(
	options: {
		runtimes?: RuntimeConfig[];
		kinds?: Partial<Record<RuntimeKind, RuntimeKindAdapter>>;
		panes?: Record<string, Pane>;
		identity?: { paneId: string; endpointId: string };
	} = {},
) {
	const settings: HerdrSettings = {
		...structuredClone(DEFAULT_SETTINGS),
		runtimes: options.runtimes ?? [LOCAL, XL, CLAUDE, CORE],
	};
	const herdr = fakeKind('herdr', { screen: () => ({ read: () => Promise.resolve('') }) });
	const kinds: Record<string, RuntimeKindAdapter> = {
		herdr: herdr.adapter,
		'herdr-core': fakeKind('herdr-core').adapter,
		claude: fakeKind('claude').adapter,
		...options.kinds,
	};
	const panes = options.panes ?? {};
	const reads: string[] = [];
	const watcher: SessionWatcher = {
		snapshot: (paneId) => {
			reads.push(`snapshot ${paneId}`);
			const pane = panes[paneId];
			return pane
				? { paneId, cwd: '', agentSession: '', agentStatus: 'idle', ...pane.snapshot }
				: null;
		},
		glance: (paneId) => {
			reads.push(`glance ${paneId}`);
			const pane = panes[paneId];
			return pane ? { paneId, cwd: '', agent: null, agentSession: '', agentStatus: 'idle', ...pane.glance } : null;
		},
		unavailable: (paneId) => panes[paneId]?.unavailable ?? null,
	} as SessionWatcher;
	const identity = { paneId: 'w1:p1', endpointId: 'local', ...options.identity };
	const client = { request: () => Promise.resolve() } as unknown as PromptClient;
	const host: PaneContextHost = {
		endpoints: {
			endpoint: (id) => {
				const runtime = settings.runtimes.find((candidate) => candidate.id === id);
				return runtime ? endpointOf(runtime) : null;
			},
			kindOf: (kind) => kinds[kind] as RuntimeKindAdapter,
			watcher: () => watcher,
			client: (id) => (id === 'local' ? client : null),
			commandCatalog: () => null,
		},
		screenAnswerers: new ScreenAnswerers(),
		models: {} as PaneContextHost['models'],
		queues: {} as PaneContextHost['queues'],
		settings: () => settings,
		saveSettings: () => undefined,
		vaultPath: () => '/Users/lasse/Vaults/hvelv',
		notify: () => undefined,
	};
	const context = new PaneContext(host, () => identity);
	return { context, identity, settings, reads, herdr, kinds };
}

describe('availability (where)', () => {
	it('shows no native view for a runtime that is no longer configured, and keeps the terminal', () => {
		const { context } = harness({ identity: { paneId: 'w1:p1', endpointId: 'rt-gone' } });
		expect(context.where()).toEqual({ remote: false, kindReason: NATIVE_UNKNOWN_RUNTIME_REASON });
		// The kind falls back to herdr's, whose terminal says why it cannot start.
		expect(context.kind().kind).toBe('herdr');
	});

	it('names a kind with no terminal as the terminal’s reason', () => {
		const claude = fakeKind('claude', { terminalUnavailable: 'not available on Windows' }).adapter;
		const { context } = harness({ kinds: { claude }, identity: { paneId: 'a-1', endpointId: CLAUDE.id } });
		expect(context.where()).toMatchObject({ remote: false, kindReason: null, terminalReason: 'not available on Windows' });
	});

	it('names a kind this build cannot run as no terminal reason: its terminal says why', () => {
		const claude = fakeKind('claude', { unavailable: 'not in this build', terminalUnavailable: 'not in this build' }).adapter;
		const { context } = harness({ kinds: { claude }, identity: { paneId: 'a-1', endpointId: CLAUDE.id } });
		expect(context.where().terminalReason).toBeNull();
	});

	it('gives a pane that is no agent (a `claude` shell tab) no native view', () => {
		const claude = fakeKind('claude', {
			paneNativeReason: (paneId: string) => (paneId.startsWith('sh-') ? 'a shell, not an agent' : null),
		}).adapter;
		const { context } = harness({ kinds: { claude }, identity: { paneId: 'sh-0000abcd', endpointId: CLAUDE.id } });
		expect(context.where()).toEqual({ remote: false, kindReason: 'a shell, not an agent', terminalReason: null });
	});

	it('marks a pane on a remote runtime whose transcripts are out of reach', () => {
		const { context } = harness({ identity: { paneId: 'w1:p1', endpointId: XL.id } });
		expect(context.where()).toMatchObject({ remote: true, kindReason: null });
	});

	it('adds the pane’s own reason (an hc terminal with no session label) under the runtime’s', () => {
		const { context } = harness({ panes: { 'w1:p1': { unavailable: 'no Claude session label' } } });
		expect(context.where()).toEqual({ remote: false, kindReason: 'no Claude session label', terminalReason: null });
		const open = harness({ panes: { 'w1:p1': {} } });
		expect(open.context.where()).toEqual({ remote: false, kindReason: null, terminalReason: null });
	});
});

describe('the cwd mapping', () => {
	it('maps a remote pane inside the remote vault onto this vault, and leaves one outside as it is', () => {
		const inside = harness({
			identity: { paneId: 'w1:p1', endpointId: XL.id },
			panes: { 'w1:p1': { snapshot: { cwd: '/home/lasse/hvelv/notes' } } },
		});
		expect(inside.context.remoteVaultPath()).toBe('/home/lasse/hvelv');
		expect(inside.context.cwdHere()).toBe('/Users/lasse/Vaults/hvelv/notes');
		const root = harness({
			identity: { paneId: 'w1:p1', endpointId: XL.id },
			panes: { 'w1:p1': { snapshot: { cwd: '/home/lasse/hvelv' } } },
		});
		expect(root.context.cwdHere()).toBe('/Users/lasse/Vaults/hvelv');
		const outside = harness({
			identity: { paneId: 'w1:p1', endpointId: XL.id },
			panes: { 'w1:p1': { snapshot: { cwd: '/home/lasse/hvelv-other' } } },
		});
		expect(outside.context.cwdHere()).toBe('/home/lasse/hvelv-other');
	});

	it('leaves a local pane’s cwd as reported, and opens mentions in this vault', () => {
		const { context } = harness({ panes: { 'w1:p1': { snapshot: { cwd: '/elsewhere' } } } });
		expect(context.remoteVaultPath()).toBe('');
		expect(context.cwdHere()).toBe('/elsewhere');
		expect(context.promptSource().vaultPath()).toBe('/Users/lasse/Vaults/hvelv');
		const remote = harness({ identity: { paneId: 'w1:p1', endpointId: XL.id } });
		expect(remote.context.promptSource().vaultPath()).toBe('/home/lasse/hvelv');
	});
});

describe('screen answering', () => {
	it('is null for a kind with no screen (the `claude` kind)', () => {
		const { context } = harness({ identity: { paneId: 'a-1', endpointId: CLAUDE.id } });
		expect(context.screenAnswering('claude')).toBeNull();
	});

	it('is null for an agent whose format reads no dialog', () => {
		const { context } = harness({ panes: { 'w1:p1': { glance: { agent: 'codex' } } } });
		expect(context.screenAnswering('codex')).toBeNull();
		expect(context.screenAnswering()).toBeNull();
	});

	it('shares one driver per runtime, kind and agent, and one trust claim per pane', () => {
		const { context } = harness({ panes: { 'w1:p1': { glance: { agent: 'claude', cwd: '/x' } } } });
		const first = context.screenAnswering();
		const second = context.screenAnswering('claude');
		expect(first).not.toBeNull();
		expect(first?.answerer).toBe(second?.answerer);
		expect(first?.cwd()).toBe('/x');
		expect(first?.claimTrust()).toBe(true);
		expect(second?.claimTrust()).toBe(false);
		second?.releaseTrust();
		expect(first?.claimTrust()).toBe(true);
	});

	it('wires the trust watch to read the pane by glance, never snapshot', () => {
		const { context, settings, reads } = harness({
			panes: { 'w1:p1': { glance: { agent: 'claude', agentStatus: 'blocked' } } },
		});
		settings.nativeAutoTrustFolders = true;
		context.trustWatch.tick();
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((read) => read.startsWith('glance '))).toBe(true);
	});
});

describe('the native surface’s dependencies', () => {
	it('sends through the kind of the tab’s runtime as it is now, over that runtime’s client', async () => {
		const { context, identity, herdr, kinds } = harness();
		const deps = context.surfaceDependencies();
		await deps.sender.send('w1:p1', 'hi');
		expect(herdr.sent).toEqual(['herdr:w1:p1:hi:client']);
		// The tab follows its pane to another runtime: the same surface's
		// sender asks that runtime's kind, over its own (absent) client.
		const core = fakeKind('herdr-core');
		kinds['herdr-core'] = core.adapter;
		identity.endpointId = CORE.id;
		await deps.sender.send('t1', 'there');
		expect(core.sent).toEqual(['herdr-core:t1:there:no client']);
		await deps.keySender.sendKeys('t1', ['Down', 'Enter']);
		expect(core.keys).toEqual([['herdr-core', 'Down', 'Enter']]);
	});

	it('offers a responder and an interrupt only for a kind that has them', () => {
		expect(harness().context.surfaceDependencies().responder).toBeUndefined();
		const claude = fakeKind('claude', {
			responder: () => ({ respond: () => Promise.resolve() }),
			promptSender: () => ({ send: () => Promise.resolve(), interrupt: () => Promise.resolve() }),
		}).adapter;
		const deps = harness({ kinds: { claude }, identity: { paneId: 'a-1', endpointId: CLAUDE.id } }).context.surfaceDependencies();
		expect(deps.responder).toBeDefined();
		expect('interrupt' in deps.sender).toBe(true);
		expect(deps.screen?.()).toBeNull();
	});

	it('reads the settings per draw', () => {
		const { context, settings } = harness();
		const deps = context.surfaceDependencies();
		settings.nativeAutoTrustFolders = false;
		expect(deps.autoTrustFolders()).toBe(false);
		settings.nativeAutoTrustFolders = true;
		expect(deps.autoTrustFolders()).toBe(true);
		settings.terminalPlacement = 'split-left';
		expect(deps.noteSplitBefore?.()).toBe(false);
		settings.terminalPlacement = 'split-right';
		expect(deps.noteSplitBefore?.()).toBe(true);
	});
});
