/**
 * "Get started" (ADR-0008): what a new user with no working runtime is
 * offered, and what each offer does. Three paths:
 *
 * 1. **Simple mode now.** With `claude` found: a local `claude` runtime
 *    ("Claude, run by Obsidian", ADR-0007), added when there is none, made
 *    active, and an agent started at the vault root. Without it: how to
 *    install Claude Code, a link and the official command, shown and never run.
 * 2. **Install herdr-core** with its official installer, the exact command
 *    for this platform, three ways:
 *    - **Copy**, for the user's own terminal; every platform.
 *    - **Run in a terminal tab**: a shell tab of the `claude` kind with the
 *      command typed for it (`openShellHere`). The tab needs a `claude`
 *      runtime in the registry, added silently when `claude` is found. Not on
 *      Windows, which has no pty.
 *    - **Ask Claude**: an agent in the vault prompted to run exactly that
 *      command and check `hc --version`, **always in the asking permission
 *      mode** ({@link ASK_CLAUDE_PERMISSION_MODE}), whatever the runtime is
 *      set to, so the Bash call arrives as a permission card that shows the
 *      command and the user's Allow is the consent.
 * 3. **herdr instead**: a link to herdr's install docs.
 *
 * After an install the flow rescans the binaries ("Check again"); once `hc`
 * is found it offers "herdr-core on this machine" in one click, which adds
 * the runtime, makes it active, and offers the Claude session hook (ADR-0006)
 * through its consent modal once the runtime has connected, since the hook
 * is written over that connection.
 *
 * The plugin never downloads or installs anything itself: the installer runs
 * only in a terminal the user sees, or as a tool call the user allows.
 *
 * No Obsidian import: everything outside comes through {@link GetStartedHost}.
 */

import {
	newRuntime,
	type ClaudePermissionMode,
	type RuntimeConfig,
	type RuntimeSettings,
} from '../runtimes';

/** herdr-core's official installer for Linux and macOS (ADR-0008). */
export const HC_INSTALL_POSIX = 'curl -fsSL https://releases.herdr.dev/core/install.sh | sh';
/** herdr-core's official installer for Windows, in PowerShell (ADR-0008). */
export const HC_INSTALL_WINDOWS = 'irm https://releases.herdr.dev/core/install.ps1 | iex';
/** herdr's install docs, for users who want the TUI. */
export const HERDR_INSTALL_DOCS_URL = 'https://herdr.dev/tui/docs/install/';
/** Claude Code's setup docs. */
export const CLAUDE_INSTALL_DOCS_URL = 'https://code.claude.com/docs/en/setup';
/** Claude Code's official native installer for macOS, Linux and WSL. */
export const CLAUDE_INSTALL_POSIX = 'curl -fsSL https://claude.ai/install.sh | bash';
/** Claude Code's official native installer for Windows PowerShell. */
export const CLAUDE_INSTALL_WINDOWS = 'irm https://claude.ai/install.ps1 | iex';

/**
 * The permission mode "Ask Claude" always starts in: the asking one, never
 * the runtime's configured mode, which may auto-accept (ADR-0008). Pinned on
 * the agent's row, so a resume keeps it too.
 */
export const ASK_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'manual';

/** The name the "Ask Claude" agent's row starts from. */
export const ASK_CLAUDE_AGENT_NAME = 'Install herdr-core';

/** The palette command's name. */
export const GET_STARTED_COMMAND_NAME = 'Get started';

function isWindows(platform: string): boolean {
	return platform === 'win32';
}

/** herdr-core's official install command for a platform (`process.platform`). */
export function hcInstallCommand(platform: string): string {
	return isWindows(platform) ? HC_INSTALL_WINDOWS : HC_INSTALL_POSIX;
}

/** Claude Code's official install command for a platform. */
export function claudeInstallCommand(platform: string): string {
	return isWindows(platform) ? CLAUDE_INSTALL_WINDOWS : CLAUDE_INSTALL_POSIX;
}

/** The prompt "Ask Claude" starts its agent with. */
export function askClaudePrompt(platform: string): string {
	const command = hcInstallCommand(platform);
	const shell = isWindows(platform) ? 'in PowerShell' : 'in a shell';
	return [
		'Install herdr-core (the `hc` command) on this machine with its official installer.',
		'',
		`Run exactly this command ${shell}, unchanged, as one tool call:`,
		'',
		command,
		'',
		'Do not use sudo, do not download or run anything else, and do not edit any files.',
		'When it has finished, verify the install by running `hc --version`, and tell me the version it reports.',
		'If `hc` is not found, say where the installer put it and stop there.',
	].join('\n');
}

/** What the agent list knows about the connection when it would draw the card. */
export interface GetStartedConditions {
	/** How many runtimes the registry holds. */
	runtimeCount: number;
	/** A connection is published with a scope. */
	published: boolean;
	/** Why the active runtime's kind cannot run in this build, or null. */
	unavailable: string | null;
	/** The last connection attempt's error, or null while none failed. */
	error: string | null;
}

/**
 * Whether the agent list shows "Get started": no runtime connects. That is
 * no runtimes at all, or nothing published while the active runtime's kind
 * cannot run here or its attempt failed. An attempt still under way shows
 * nothing yet, so a working setup never flashes the card on startup.
 */
export function showGetStarted(conditions: GetStartedConditions): boolean {
	if (conditions.runtimeCount === 0) return true;
	if (conditions.published) return false;
	return conditions.unavailable !== null || conditions.error !== null;
}

/** What a rescan found on this machine; null paths were not found. */
export interface BinaryScan {
	claude: string | null;
	hc: string | null;
}

/** An offer that may be unavailable, with the reason shown in its place. */
export type Offer = { available: true } | { available: false; reason: string };

/** Everything the card draws, decided here. */
export interface GetStartedModel {
	/** False until the first scan answered; the card says it is looking. */
	scanned: boolean;
	simple:
		| { available: true; claudePath: string; runtimeExists: boolean }
		| { available: false; docsUrl: string; command: string };
	install: {
		command: string;
		terminal: Offer;
		askClaude: Offer;
	};
	herdrDocsUrl: string;
	/** After the install: what the rescan found. */
	after:
		| { found: false }
		| {
				found: true;
				hcPath: string;
				/** The local herdr-core runtime that exists already, or null to add one. */
				existingId: string | null;
		  };
}

/** The registry's first `claude` runtime, which every path here uses. */
export function claudeRuntimeOf(settings: RuntimeSettings): RuntimeConfig | null {
	return settings.runtimes.find((runtime) => runtime.kind === 'claude') ?? null;
}

/** The registry's first herdr-core runtime on this machine. */
export function localHcRuntimeOf(settings: RuntimeSettings): RuntimeConfig | null {
	return settings.runtimes.find((runtime) => runtime.kind === 'herdr-core' && runtime.target === 'local') ?? null;
}

/** The card for the registry, the scan and the platform as they are now. */
export function getStartedModel(input: {
	platform: string;
	scan: BinaryScan | null;
	settings: RuntimeSettings;
	/** This machine can open shell tabs (a pty from `script`). */
	shellsAvailable: boolean;
}): GetStartedModel {
	const { platform, scan, settings } = input;
	const claudePath = scan?.claude ?? null;
	const claudeRuntime = claudeRuntimeOf(settings);
	const simple: GetStartedModel['simple'] = claudePath
		? { available: true, claudePath, runtimeExists: claudeRuntime !== null }
		: { available: false, docsUrl: CLAUDE_INSTALL_DOCS_URL, command: claudeInstallCommand(platform) };

	let terminal: Offer;
	if (isWindows(platform) || !input.shellsAvailable) {
		terminal = { available: false, reason: 'Terminal tabs are not available on this platform.' };
	} else if (!claudeRuntime && !claudePath) {
		terminal = {
			available: false,
			reason: 'The terminal tab belongs to "Claude, run by Obsidian", which needs Claude Code on this machine.',
		};
	} else {
		terminal = { available: true };
	}
	const askClaude: Offer = claudePath
		? { available: true }
		: { available: false, reason: 'Needs Claude Code on this machine.' };

	const hcPath = scan?.hc ?? null;
	return {
		scanned: scan !== null,
		simple,
		install: { command: hcInstallCommand(platform), terminal, askClaude },
		herdrDocsUrl: HERDR_INSTALL_DOCS_URL,
		after: hcPath ? { found: true, hcPath, existingId: localHcRuntimeOf(settings)?.id ?? null } : { found: false },
	};
}

/** What the flow needs from the plugin; fakes in tests. */
export interface GetStartedHost {
	/** `process.platform`. */
	readonly platform: string;
	/** The registry, read per use: the settings tab replaces and edits it. */
	settings(): RuntimeSettings;
	/** This vault's absolute path. */
	vaultPath(): string;
	/** A binary on this machine by name, or null. May spawn the login shell. */
	findBinary(name: 'claude' | 'hc'): Promise<string | null>;
	/** This machine can open shell tabs. */
	shellsAvailable(): boolean;
	/** Adds a runtime to the registry and saves; does not switch to it. */
	addRuntime(runtime: RuntimeConfig): Promise<void>;
	/** Makes a runtime active and reconnects. */
	switchRuntime(id: string): Promise<void>;
	/** Waits for that runtime to be published with its scope; false on timeout. */
	waitForRuntime(id: string): Promise<boolean>;
	/** "Start agent here" at the vault root, on the active runtime. */
	startAgentInVault(): Promise<unknown>;
	/**
	 * Starts a `claude` agent on a runtime, its row pinned to `permissionMode`,
	 * sends it `prompt`, and opens it in the native view. Resolves to its id.
	 */
	startClaudeAgent(options: {
		runtimeId: string;
		cwd: string;
		name: string;
		prompt: string;
		permissionMode: ClaudePermissionMode;
		/** The row's cards offer only Allow once and Deny. */
		allowOnceOnly: boolean;
	}): Promise<string | null>;
	/** A shell tab in `folder` on a `claude` runtime, `command` run first. */
	openShellHere(folder: string, options: { command?: string; runtimeId?: string }): Promise<string | null>;
	/** Writes text to the clipboard. */
	copy(text: string): Promise<void>;
	/** Opens the Claude session hook's consent modal on the active runtime. */
	openSessionHook(): void;
	notice(message: string): void;
	/** The scan or the registry changed: redraw the cards. */
	changed(): void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The flow's state and actions, one per plugin. */
export class GetStartedFlow {
	private scan: BinaryScan | null = null;
	private scanning: Promise<BinaryScan> | null = null;
	private busy = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly host: GetStartedHost) {}

	/** Runs `listener` on every redraw the flow asks for; returns the unsubscribe. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		this.host.changed();
		for (const listener of [...this.listeners]) listener();
	}

	/** What the last scan found; null before the first one answered. */
	get lastScan(): BinaryScan | null {
		return this.scan;
	}

	/** The card as things are now. Pure: never scans. */
	model(): GetStartedModel {
		return getStartedModel({
			platform: this.host.platform,
			scan: this.scan,
			settings: this.host.settings(),
			shellsAvailable: this.host.shellsAvailable(),
		});
	}

	/**
	 * Scans once, the first time a card is drawn. A draw never scans again,
	 * so a scan that finds nothing cannot become a redraw loop; only
	 * {@link rescan} ("Check again") looks again.
	 */
	ensureScanned(): void {
		if (this.scan || this.scanning) return;
		void this.rescan();
	}

	/** Looks for `claude` and `hc` again, and redraws with what it found. */
	rescan(): Promise<BinaryScan> {
		if (this.scanning) return this.scanning;
		this.scanning = (async () => {
			try {
				const [claude, hc] = await Promise.all([this.host.findBinary('claude'), this.host.findBinary('hc')]);
				this.scan = { claude, hc };
			} catch {
				this.scan = { claude: null, hc: null };
			} finally {
				this.scanning = null;
			}
			this.changed();
			return this.scan;
		})();
		return this.scanning;
	}

	/**
	 * The registry's `claude` runtime, added silently when there is none.
	 * Does not switch to it.
	 */
	async ensureClaudeRuntime(): Promise<RuntimeConfig> {
		const existing = claudeRuntimeOf(this.host.settings());
		if (existing) return existing;
		const runtime = newRuntime(
			'claude',
			'local',
			this.host.settings().runtimes.map((entry) => entry.id),
		);
		await this.host.addRuntime(runtime);
		return runtime;
	}

	/**
	 * Simple mode now: the `claude` runtime, made active, with an agent at the
	 * vault root. Refused while `claude` was not found.
	 */
	async startSimpleMode(): Promise<boolean> {
		return this.once(false, async () => {
			if (!this.scan?.claude) {
				this.host.notice('Herdr: install Claude Code first, then check again.');
				return false;
			}
			const runtime = await this.ensureClaudeRuntime();
			if (!(await this.activate(runtime))) return false;
			await this.host.startAgentInVault();
			return true;
		});
	}

	/** Copies the official installer command. */
	async copyInstaller(): Promise<void> {
		const command = hcInstallCommand(this.host.platform);
		try {
			await this.host.copy(command);
			this.host.notice('Herdr: the herdr-core install command is on the clipboard.');
		} catch (error) {
			this.host.notice(`Herdr: could not copy the command. ${describe(error)}`);
		}
	}

	/**
	 * Run in a terminal tab: a shell tab in the vault with the installer as
	 * its first command, which the user watches and can stop. Adds the
	 * `claude` runtime the tab belongs to when there is none, without
	 * switching to it. Never on Windows.
	 */
	async runInTerminal(): Promise<string | null> {
		const offer = this.model().install.terminal;
		if (!offer.available) {
			this.host.notice(`Herdr: ${offer.reason}`);
			return null;
		}
		const runtime = await this.ensureClaudeRuntime();
		return this.host.openShellHere(this.host.vaultPath(), {
			command: hcInstallCommand(this.host.platform),
			runtimeId: runtime.id,
		});
	}

	/**
	 * Ask Claude: an agent in the vault, made active on the `claude` runtime
	 * (the waiting card answers only on the published connection), prompted
	 * to run the installer. Started in {@link ASK_CLAUDE_PERMISSION_MODE},
	 * never in the runtime's own mode.
	 */
	async askClaude(): Promise<string | null> {
		return this.once<string | null>(null, async () => {
			if (!this.scan?.claude) {
				this.host.notice('Herdr: "Ask Claude" needs Claude Code on this machine.');
				return null;
			}
			const runtime = await this.ensureClaudeRuntime();
			if (!(await this.activate(runtime))) return null;
			return this.host.startClaudeAgent({
				runtimeId: runtime.id,
				cwd: this.host.vaultPath(),
				name: ASK_CLAUDE_AGENT_NAME,
				prompt: askClaudePrompt(this.host.platform),
				permissionMode: ASK_CLAUDE_PERMISSION_MODE,
				// Allow once and Deny only: a session or project grant would
				// leave a Bash rule for `curl` and `sh` behind.
				allowOnceOnly: true,
			});
		});
	}

	/**
	 * After the install: "herdr-core on this machine" in one click. Rescans
	 * first, adds the local herdr-core runtime unless one exists, makes it
	 * active, and once it has connected offers the session hook.
	 */
	async useHerdrCore(): Promise<boolean> {
		return this.once(false, async () => {
			const scan = await this.rescan();
			if (!scan.hc) {
				this.host.notice('Herdr: hc was not found yet. Finish the install, then check again.');
				return false;
			}
			let runtime = localHcRuntimeOf(this.host.settings());
			if (!runtime) {
				runtime = newRuntime(
					'herdr-core',
					'local',
					this.host.settings().runtimes.map((entry) => entry.id),
				);
				await this.host.addRuntime(runtime);
			}
			if (!(await this.activate(runtime))) return false;
			this.host.openSessionHook();
			return true;
		});
	}

	/** Switches to a runtime and waits for it; says so when it does not come up. */
	private async activate(runtime: RuntimeConfig): Promise<boolean> {
		await this.host.switchRuntime(runtime.id);
		if (await this.host.waitForRuntime(runtime.id)) return true;
		this.host.notice('Herdr: the runtime did not connect. Its status is in the settings.');
		return false;
	}

	/** One multi-step action at a time: a second click while one runs is ignored. */
	private async once<T>(busy: T, run: () => Promise<T>): Promise<T> {
		if (this.busy) return busy;
		this.busy = true;
		try {
			return await run();
		} finally {
			this.busy = false;
			this.changed();
		}
	}
}
