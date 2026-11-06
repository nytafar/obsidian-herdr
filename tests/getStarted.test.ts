/**
 * "Get started" (ADR-0008): when the card shows, what it offers on each
 * platform and scan, and what each path does, over a fake host. The one
 * fixed rule is pinned here and in `claudeKind.test.ts`: "Ask Claude"
 * starts its agent in the asking permission mode whatever the runtime's is.
 */

import { describe, expect, it } from 'vitest';
import {
	ACTION_ATTR,
	getStartedActionOf,
	renderGetStartedCard,
	runGetStartedAction,
} from '../src/getStarted/card';
import {
	ASK_CLAUDE_PERMISSION_MODE,
	CLAUDE_INSTALL_DOCS_URL,
	GetStartedFlow,
	HC_INSTALL_POSIX,
	HC_INSTALL_WINDOWS,
	HERDR_INSTALL_DOCS_URL,
	askClaudePrompt,
	claudeInstallCommand,
	getStartedModel,
	hcInstallCommand,
	showGetStarted,
	type GetStartedHost,
} from '../src/getStarted/flow';
import {
	defaultRuntimeSettings,
	newRuntime,
	type ClaudePermissionMode,
	type RuntimeConfig,
	type RuntimeSettings,
} from '../src/runtimes';
import { FakeElement, hostEl } from './fixtures/dom';

describe('when the card shows', () => {
	const base = { runtimeCount: 1, published: false, unavailable: null, error: null };

	it('shows with no runtimes at all', () => {
		expect(showGetStarted({ ...base, runtimeCount: 0 })).toBe(true);
		expect(showGetStarted({ ...base, runtimeCount: 0, published: true })).toBe(true);
	});

	it('shows when the active runtime failed to connect', () => {
		expect(showGetStarted({ ...base, error: 'herdr binary not found' })).toBe(true);
	});

	it('shows when the active runtime’s kind cannot run in this build', () => {
		expect(showGetStarted({ ...base, unavailable: 'not in this build' })).toBe(true);
	});

	it('does not show while an attempt is under way, or once one is published', () => {
		expect(showGetStarted(base)).toBe(false);
		expect(showGetStarted({ ...base, published: true })).toBe(false);
		expect(showGetStarted({ ...base, published: true, error: 'disconnected' })).toBe(false);
	});
});

describe('the official commands', () => {
	it('uses the POSIX installer on Linux and macOS, PowerShell on Windows', () => {
		expect(hcInstallCommand('linux')).toBe('curl -fsSL https://releases.herdr.dev/core/install.sh | sh');
		expect(hcInstallCommand('darwin')).toBe(HC_INSTALL_POSIX);
		expect(hcInstallCommand('win32')).toBe('irm https://releases.herdr.dev/core/install.ps1 | iex');
		expect(claudeInstallCommand('linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
		expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
	});

	it('asks Claude to run exactly that command and to verify with hc --version', () => {
		for (const platform of ['linux', 'darwin', 'win32']) {
			const prompt = askClaudePrompt(platform);
			const lines = prompt.split('\n');
			expect(lines).toContain(hcInstallCommand(platform));
			expect(prompt).toContain('`hc --version`');
			expect(prompt).toContain('Do not use sudo');
		}
		expect(askClaudePrompt('win32')).toContain('in PowerShell');
		expect(askClaudePrompt('win32')).not.toContain(HC_INSTALL_POSIX);
	});

	it('pins the asking mode for Ask Claude', () => {
		expect(ASK_CLAUDE_PERMISSION_MODE).toBe('manual');
	});
});

function registry(...runtimes: RuntimeConfig[]): RuntimeSettings {
	if (runtimes.length === 0) return defaultRuntimeSettings();
	return { runtimes, activeRuntime: runtimes[0]?.id ?? '' };
}

function claudeRuntime(id = 'rt-claude', mode: ClaudePermissionMode = 'manual'): RuntimeConfig {
	return { ...newRuntime('claude', 'local', []), id, permissionMode: mode };
}

describe('the card model', () => {
	const scan = { claude: '/usr/local/bin/claude', hc: null };

	it('offers simple mode when claude is found, and how to install it when not', () => {
		const found = getStartedModel({ platform: 'linux', scan, settings: registry(), shellsAvailable: true });
		expect(found.simple).toEqual({ available: true, claudePath: '/usr/local/bin/claude', runtimeExists: false });
		const missing = getStartedModel({
			platform: 'win32',
			scan: { claude: null, hc: null },
			settings: registry(),
			shellsAvailable: false,
		});
		expect(missing.simple).toEqual({
			available: false,
			docsUrl: CLAUDE_INSTALL_DOCS_URL,
			command: 'irm https://claude.ai/install.ps1 | iex',
		});
	});

	it('says it is still looking before the first scan', () => {
		const model = getStartedModel({ platform: 'linux', scan: null, settings: registry(), shellsAvailable: true });
		expect(model.scanned).toBe(false);
		expect(model.after).toEqual({ found: false });
	});

	it('offers every way to install on Linux with claude found', () => {
		const model = getStartedModel({ platform: 'linux', scan, settings: registry(), shellsAvailable: true });
		expect(model.install).toEqual({
			command: HC_INSTALL_POSIX,
			terminal: { available: true },
			askClaude: { available: true },
		});
		expect(model.herdrDocsUrl).toBe(HERDR_INSTALL_DOCS_URL);
	});

	it('has no terminal tab on Windows, or without a pty, and says why', () => {
		const windows = getStartedModel({ platform: 'win32', scan, settings: registry(), shellsAvailable: true });
		expect(windows.install.command).toBe(HC_INSTALL_WINDOWS);
		expect(windows.install.terminal).toMatchObject({ available: false });
		expect(windows.install.askClaude).toEqual({ available: true });
		const noPty = getStartedModel({ platform: 'linux', scan, settings: registry(), shellsAvailable: false });
		expect(noPty.install.terminal.available).toBe(false);
		expect(JSON.stringify(noPty.install.terminal)).toContain('platform');
	});

	it('needs a claude runtime or claude itself for the terminal tab, and claude for Ask Claude', () => {
		const none = getStartedModel({
			platform: 'linux',
			scan: { claude: null, hc: null },
			settings: registry(),
			shellsAvailable: true,
		});
		expect(none.install.terminal.available).toBe(false);
		expect(JSON.stringify(none.install.terminal)).toContain('Claude Code');
		expect(none.install.askClaude).toMatchObject({ available: false });
		// A claude runtime is enough for a shell tab: the shell does not run claude.
		const withRuntime = getStartedModel({
			platform: 'linux',
			scan: { claude: null, hc: null },
			settings: registry(claudeRuntime()),
			shellsAvailable: true,
		});
		expect(withRuntime.install.terminal).toEqual({ available: true });
		expect(withRuntime.install.askClaude).toMatchObject({ available: false });
	});

	it('offers to add herdr-core once hc is found, or to use the one there is', () => {
		const hc = { claude: null, hc: '/home/u/.local/bin/hc' };
		const add = getStartedModel({ platform: 'linux', scan: hc, settings: registry(), shellsAvailable: true });
		expect(add.after).toEqual({ found: true, hcPath: '/home/u/.local/bin/hc', existingId: null });
		const existing = { ...newRuntime('herdr-core', 'local', []), id: 'rt-hc' };
		const remote = { ...newRuntime('herdr-core', 'ssh', []), id: 'rt-remote' };
		const use = getStartedModel({
			platform: 'linux',
			scan: hc,
			settings: registry(remote, existing),
			shellsAvailable: true,
		});
		expect(use.after).toEqual({ found: true, hcPath: '/home/u/.local/bin/hc', existingId: 'rt-hc' });
	});
});

interface FakeHost extends GetStartedHost {
	calls: unknown[][];
	notices: string[];
	copied: string[];
	registry: RuntimeSettings;
}

function fakeHost(
	options: {
		platform?: string;
		claude?: string | null;
		hc?: string | null;
		registry?: RuntimeSettings;
		shells?: boolean;
		connects?: boolean;
	} = {},
): FakeHost {
	const calls: unknown[][] = [];
	const notices: string[] = [];
	const copied: string[] = [];
	const host: FakeHost = {
		platform: options.platform ?? 'linux',
		calls,
		notices,
		copied,
		registry: options.registry ?? registry(),
		settings: () => host.registry,
		vaultPath: () => '/vault',
		findBinary: (name) => {
			calls.push(['findBinary', name]);
			return Promise.resolve(name === 'claude' ? (options.claude ?? null) : (options.hc ?? null));
		},
		shellsAvailable: () => options.shells ?? true,
		addRuntime: (runtime) => {
			calls.push(['addRuntime', runtime.kind, runtime.target]);
			host.registry = { ...host.registry, runtimes: [...host.registry.runtimes, runtime] };
			return Promise.resolve();
		},
		switchRuntime: (id) => {
			calls.push(['switchRuntime', id]);
			host.registry = { ...host.registry, activeRuntime: id };
			return Promise.resolve();
		},
		waitForRuntime: (id) => {
			calls.push(['waitForRuntime', id]);
			return Promise.resolve(options.connects ?? true);
		},
		startAgentInVault: () => {
			calls.push(['startAgentInVault', host.registry.activeRuntime]);
			return Promise.resolve();
		},
		startClaudeAgent: (start) => {
			calls.push(['startClaudeAgent', start]);
			return Promise.resolve('cl-1');
		},
		openShellHere: (folder, shell) => {
			calls.push(['openShellHere', folder, shell]);
			return Promise.resolve('sh-1');
		},
		copy: (text) => {
			copied.push(text);
			return Promise.resolve();
		},
		openSessionHook: () => {
			calls.push(['openSessionHook', host.registry.activeRuntime]);
		},
		notice: (message) => notices.push(message),
		changed: () => calls.push(['changed']),
	};
	return host;
}

function named(host: FakeHost, name: string): unknown[][] {
	return host.calls.filter((call) => call[0] === name);
}

async function scanned(host: FakeHost): Promise<GetStartedFlow> {
	const flow = new GetStartedFlow(host);
	await flow.rescan();
	return flow;
}

describe('the flow', () => {
	it('scans once on the first draw, and again only on Check again', async () => {
		const host = fakeHost({ claude: '/c' });
		const flow = new GetStartedFlow(host);
		flow.ensureScanned();
		flow.ensureScanned();
		await flow.rescan();
		flow.ensureScanned();
		expect(named(host, 'findBinary')).toEqual([
			['findBinary', 'claude'],
			['findBinary', 'hc'],
		]);
		expect(flow.lastScan).toEqual({ claude: '/c', hc: null });
		await flow.rescan();
		expect(named(host, 'findBinary')).toHaveLength(4);
	});

	it('tells subscribers and the host when the scan lands', async () => {
		const host = fakeHost();
		const flow = new GetStartedFlow(host);
		let seen = 0;
		const off = flow.subscribe(() => seen++);
		await flow.rescan();
		off();
		await flow.rescan();
		expect(seen).toBe(1);
		expect(named(host, 'changed')).toHaveLength(2);
	});

	describe('simple mode now', () => {
		it('adds a claude runtime, makes it active and starts an agent in the vault', async () => {
			const host = fakeHost({ claude: '/usr/local/bin/claude' });
			const flow = await scanned(host);
			expect(await flow.startSimpleMode()).toBe(true);
			const added = host.registry.runtimes.find((runtime) => runtime.kind === 'claude');
			expect(added).toMatchObject({ kind: 'claude', target: 'local' });
			expect(host.calls.filter((call) => call[0] !== 'changed' && call[0] !== 'findBinary')).toEqual([
				['addRuntime', 'claude', 'local'],
				['switchRuntime', added?.id],
				['waitForRuntime', added?.id],
				['startAgentInVault', added?.id],
			]);
		});

		it('reuses the claude runtime there is', async () => {
			const host = fakeHost({ claude: '/c', registry: registry(newRuntime('herdr', 'local', []), claudeRuntime()) });
			const flow = await scanned(host);
			await flow.startSimpleMode();
			expect(named(host, 'addRuntime')).toEqual([]);
			expect(named(host, 'switchRuntime')).toEqual([['switchRuntime', 'rt-claude']]);
		});

		it('refuses without claude, and starts nothing when the runtime does not connect', async () => {
			const missing = fakeHost();
			expect(await (await scanned(missing)).startSimpleMode()).toBe(false);
			expect(named(missing, 'addRuntime')).toEqual([]);
			expect(missing.notices[0]).toContain('install Claude Code');

			const down = fakeHost({ claude: '/c', connects: false });
			expect(await (await scanned(down)).startSimpleMode()).toBe(false);
			expect(named(down, 'startAgentInVault')).toEqual([]);
			expect(down.notices[0]).toContain('did not connect');
		});
	});

	describe('install herdr-core', () => {
		it('copies the exact official command, per platform', async () => {
			const linux = fakeHost();
			await new GetStartedFlow(linux).copyInstaller();
			expect(linux.copied).toEqual([HC_INSTALL_POSIX]);
			const windows = fakeHost({ platform: 'win32' });
			await new GetStartedFlow(windows).copyInstaller();
			expect(windows.copied).toEqual([HC_INSTALL_WINDOWS]);
			expect(windows.notices[0]).toContain('clipboard');
		});

		it('says so when the clipboard refuses', async () => {
			const host = fakeHost();
			host.copy = () => Promise.reject(new Error('denied'));
			await new GetStartedFlow(host).copyInstaller();
			expect(host.notices).toEqual(['Herdr: could not copy the command. denied']);
		});

		it('runs the installer in a shell tab in the vault, adding the claude runtime silently', async () => {
			const host = fakeHost({ claude: '/c' });
			const flow = await scanned(host);
			expect(await flow.runInTerminal()).toBe('sh-1');
			const added = host.registry.runtimes.find((runtime) => runtime.kind === 'claude');
			expect(named(host, 'openShellHere')).toEqual([
				['openShellHere', '/vault', { command: HC_INSTALL_POSIX, runtimeId: added?.id }],
			]);
			// Silently: the list stays on what it was.
			expect(named(host, 'switchRuntime')).toEqual([]);
			expect(host.registry.activeRuntime).toBe('local');
		});

		it('uses an existing claude runtime for the tab even without claude', async () => {
			const host = fakeHost({ registry: registry(newRuntime('herdr', 'local', []), claudeRuntime()) });
			const flow = await scanned(host);
			await flow.runInTerminal();
			expect(named(host, 'addRuntime')).toEqual([]);
			expect(named(host, 'openShellHere')[0]?.[2]).toEqual({ command: HC_INSTALL_POSIX, runtimeId: 'rt-claude' });
		});

		it('never opens a terminal tab on Windows, or without claude or a claude runtime', async () => {
			const windows = fakeHost({ platform: 'win32', claude: 'C:\\claude.exe' });
			expect(await (await scanned(windows)).runInTerminal()).toBeNull();
			expect(named(windows, 'openShellHere')).toEqual([]);
			expect(named(windows, 'addRuntime')).toEqual([]);
			expect(windows.notices[0]).toContain('not available on this platform');

			const none = fakeHost();
			expect(await (await scanned(none)).runInTerminal()).toBeNull();
			expect(named(none, 'openShellHere')).toEqual([]);
		});

		it('asks Claude in the asking mode even when the runtime is set to auto', async () => {
			const host = fakeHost({
				claude: '/c',
				registry: registry(newRuntime('herdr', 'local', []), claudeRuntime('rt-claude', 'auto')),
			});
			const flow = await scanned(host);
			expect(await flow.askClaude()).toBe('cl-1');
			const [start] = named(host, 'startClaudeAgent');
			expect(start?.[1]).toEqual({
				runtimeId: 'rt-claude',
				cwd: '/vault',
				name: 'Install herdr-core',
				prompt: askClaudePrompt('linux'),
				permissionMode: 'manual',
			});
			// The waiting card answers on the published connection only.
			expect(named(host, 'switchRuntime')).toEqual([['switchRuntime', 'rt-claude']]);
		});

		it('asks Claude on Windows with the PowerShell command', async () => {
			const host = fakeHost({ platform: 'win32', claude: 'C:\\claude.exe' });
			const flow = await scanned(host);
			await flow.askClaude();
			const start = named(host, 'startClaudeAgent')[0]?.[1] as { prompt: string; permissionMode: string };
			expect(start.prompt).toContain(HC_INSTALL_WINDOWS);
			expect(start.permissionMode).toBe('manual');
		});

		it('does not ask Claude without claude', async () => {
			const host = fakeHost();
			expect(await (await scanned(host)).askClaude()).toBeNull();
			expect(named(host, 'startClaudeAgent')).toEqual([]);
		});

		it('ignores a second click while one action runs', async () => {
			const host = fakeHost({ claude: '/c' });
			let release: (value: boolean) => void = () => undefined;
			host.waitForRuntime = () => new Promise((resolve) => (release = resolve));
			const flow = await scanned(host);
			const first = flow.askClaude();
			await Promise.resolve();
			expect(await flow.askClaude()).toBeNull();
			release(true);
			expect(await first).toBe('cl-1');
			expect(named(host, 'startClaudeAgent')).toHaveLength(1);
		});
	});

	describe('after the install', () => {
		it('rescans, adds herdr-core on this machine, makes it active, then offers the hook', async () => {
			const host = fakeHost({ hc: '/home/u/.local/bin/hc' });
			const flow = new GetStartedFlow(host);
			expect(await flow.useHerdrCore()).toBe(true);
			const added = host.registry.runtimes.find((runtime) => runtime.kind === 'herdr-core');
			expect(added).toMatchObject({ target: 'local' });
			expect(host.calls.filter((call) => call[0] !== 'changed')).toEqual([
				['findBinary', 'claude'],
				['findBinary', 'hc'],
				['addRuntime', 'herdr-core', 'local'],
				['switchRuntime', added?.id],
				['waitForRuntime', added?.id],
				['openSessionHook', added?.id],
			]);
		});

		it('uses the local herdr-core runtime there is', async () => {
			const existing = { ...newRuntime('herdr-core', 'local', []), id: 'rt-hc' };
			const host = fakeHost({ hc: '/hc', registry: registry(newRuntime('herdr', 'local', []), existing) });
			await new GetStartedFlow(host).useHerdrCore();
			expect(named(host, 'addRuntime')).toEqual([]);
			expect(named(host, 'switchRuntime')).toEqual([['switchRuntime', 'rt-hc']]);
		});

		it('adds nothing while hc is still missing, and offers no hook when it does not connect', async () => {
			const missing = fakeHost();
			expect(await new GetStartedFlow(missing).useHerdrCore()).toBe(false);
			expect(named(missing, 'addRuntime')).toEqual([]);
			expect(missing.notices[0]).toContain('not found yet');

			const down = fakeHost({ hc: '/hc', connects: false });
			expect(await new GetStartedFlow(down).useHerdrCore()).toBe(false);
			expect(named(down, 'openSessionHook')).toEqual([]);
		});
	});
});

describe('the card', () => {
	function buttons(el: FakeElement): FakeElement[] {
		return el.findAll('herdr-get-started-button');
	}

	function draw(model: ReturnType<typeof getStartedModel>): FakeElement {
		const { el, host } = hostEl();
		renderGetStartedCard(host, model, 'Local herdr is not available: herdr binary not found');
		return el;
	}

	it('draws every path, with the command shown and the links', () => {
		const el = draw(
			getStartedModel({
				platform: 'linux',
				scan: { claude: '/c', hc: null },
				settings: registry(),
				shellsAvailable: true,
			}),
		);
		expect(buttons(el).map((button) => button.getAttribute(ACTION_ATTR))).toEqual([
			'simple',
			'copy',
			'terminal',
			'ask-claude',
			'check-again',
		]);
		expect(el.textContent).toContain(HC_INSTALL_POSIX);
		expect(el.textContent).toContain('herdr binary not found');
		expect(JSON.stringify(collectHrefs(el))).toContain(HERDR_INSTALL_DOCS_URL);
	});

	it('disables what is unavailable, says why, and ignores clicks on it', () => {
		const el = draw(
			getStartedModel({
				platform: 'win32',
				scan: { claude: null, hc: null },
				settings: registry(),
				shellsAvailable: false,
			}),
		);
		const terminal = buttons(el).find((button) => button.getAttribute(ACTION_ATTR) === 'terminal');
		expect(terminal?.getAttribute('disabled')).toBe('true');
		expect(getStartedActionOf(terminal)).toBeNull();
		expect(el.textContent).toContain('not available on this platform');
		// Claude Code's installer is shown, never a button that runs it.
		expect(el.textContent).toContain('irm https://claude.ai/install.ps1 | iex');
		expect(collectHrefs(el)).toContain(CLAUDE_INSTALL_DOCS_URL);
		expect(buttons(el).map((button) => button.getAttribute(ACTION_ATTR))).not.toContain('simple');
	});

	it('offers herdr-core on this machine once hc is found', () => {
		const el = draw(
			getStartedModel({
				platform: 'linux',
				scan: { claude: null, hc: '/hc' },
				settings: registry(),
				shellsAvailable: true,
			}),
		);
		const use = buttons(el).find((button) => button.getAttribute(ACTION_ATTR) === 'use-herdr-core');
		expect(use?.textContent).toBe('Add herdr-core on this machine');
	});

	it('maps a click inside a button to its action, and runs it on the flow', async () => {
		const el = draw(
			getStartedModel({
				platform: 'linux',
				scan: { claude: '/c', hc: null },
				settings: registry(),
				shellsAvailable: true,
			}),
		);
		const copy = buttons(el).find((button) => button.getAttribute(ACTION_ATTR) === 'copy');
		expect(getStartedActionOf(copy)).toBe('copy');
		expect(getStartedActionOf(el)).toBeNull();
		const host = fakeHost();
		await runGetStartedAction(new GetStartedFlow(host), 'copy');
		expect(host.copied).toEqual([HC_INSTALL_POSIX]);
	});
});

function collectHrefs(el: FakeElement): string[] {
	const own = el.getAttribute('href');
	return [...(own ? [own] : []), ...el.children.flatMap((child) => collectHrefs(child))];
}
