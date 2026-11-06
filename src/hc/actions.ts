/**
 * Folder and row actions, prompts and keys on a herdr-core runtime
 * (ADR-0005's action mapping):
 *
 * - Start agent: `terminal.run {line, cwd, name, labels}`, labelled
 *   `herdr.seen=0` and, when the scope resolved a space, `herdr.space`, so the
 *   agent shows in herdr-app too ([[herdr-core-api]] §5; herdr-app
 *   `docs/labels.md`).
 * - Close: `terminal.kill`, then `terminal.rm`.
 * - Pin: the shared `herdr.pinned` label.
 * - Prompt: `terminal.send`; keys: `terminal.keys`.
 * - New tab, split, rename and focus have no hc method: the capabilities hide
 *   them, and a call that slips through says so instead of sending anything.
 *
 * No Obsidian import: everything arrives through the same {@link ActionHost}
 * the herdr actions use.
 */

import {
	agentLabel,
	agentToStart,
	buildAgentName,
	FALLBACK_AGENT_KIND,
	folderName,
	type ActionHost,
	type Requester,
} from '../actions';
import { argIssue, commandIssue, programOf } from '../agents/catalog';
import { remoteVaultPathIssue } from '../runtimes';
import type { RuntimeActions, StartAgentOptions } from '../runtime/kind';
import {
	NO_CONNECTION_MESSAGE,
	type KeySender,
	type PromptClient,
	type PromptSender,
} from '../native/promptSender';
import { HcError } from './connection';
import { LABEL_PINNED, LABEL_SEEN, LABEL_SPACE, parseTerminal } from './model';

/** How long `terminal.rm` is retried while a killed terminal is still `live`. */
export const RM_RETRY_MS = 2000;
const RM_POLL_MS = 100;

/**
 * The shell line that starts an agent: the user's own shell, interactive, so
 * its PATH and setup are the ones a terminal has (agents installed by mise,
 * nvm or `~/.local/bin`), and a shell again when the agent exits, as in a
 * herdr pane. The line itself is run by `sh -c` (`terminal.run` `line`); the
 * inner command is plain enough for bash, zsh and fish alike.
 *
 * `args` follow the program (graduation's `--resume <id>`, ADR-0007, or a
 * catalog entry's own, issue #125). They are written into a single-quoted
 * shell line, so only plain words are taken: letters, digits and
 * `._=/:@+,-`, nothing a shell would read twice. `command` is a catalog
 * entry's own program instead of the kind's: a name or a path, `~/` allowed
 * at the front, which bash, zsh and fish all expand.
 */
export function agentLaunchLine(kind: string, args: readonly string[] = [], own?: string): string {
	const program = own?.trim() || programOf(kind);
	const programIssue = commandIssue(program);
	if (programIssue) throw new Error(programIssue);
	for (const arg of args) {
		const issue = argIssue(arg);
		if (issue) throw new Error(issue);
	}
	const command = [program, ...args].join(' ');
	return `SHELL="\${SHELL:-/bin/sh}"; export SHELL; exec "$SHELL" -ic '${command}; exec "$SHELL" -i'`;
}

/**
 * A terminal name hc accepts (`[a-z0-9-_.]`, 1-32, not ID-shaped `t7`), from
 * the plugin's agent-name pattern, which is already within that alphabet.
 */
export function hcTerminalName(name: string): string {
	return /^t\d+$/.test(name) ? `a-${name}`.slice(0, 32) : name;
}

/** herdr key names (`Down`, `Enter`, `C-c`) as hc's (`down`, `enter`, `ctrl+c`). */
export function hcKeyName(key: string): string {
	const trimmed = key.trim();
	const modified = /^([CMS])-(.+)$/.exec(trimmed);
	if (modified) {
		const prefix = modified[1] === 'C' ? 'ctrl' : modified[1] === 'M' ? 'alt' : 'shift';
		return `${prefix}+${hcKeyName(modified[2] ?? '')}`;
	}
	const lower = trimmed.toLowerCase();
	if (lower === 'escape') return 'esc';
	if (lower === 'return') return 'enter';
	if (trimmed.length === 1) return trimmed;
	return lower;
}

/** A readable failure: the core's message and its `data.kind`. */
function describe(error: unknown): string {
	if (error instanceof HcError) return `${error.message} (${error.kind})`;
	return error instanceof Error ? error.message : String(error);
}

/** What the actions need of the scope besides the host: the resolved space. */
export interface HcActionScope {
	readonly space: { id: string; name: string | null } | null;
}

export interface StartedHcAgent {
	paneId: string;
	name: string;
	kind: string;
}

export class HcActions implements RuntimeActions {
	constructor(
		private readonly host: ActionHost,
		private readonly scope: () => HcActionScope | null,
	) {}

	newTabHere(): Promise<null> {
		return Promise.resolve(this.unsupported('new tabs'));
	}

	splitHere(): Promise<null> {
		return Promise.resolve(this.unsupported('splits'));
	}

	renameAgent(): Promise<null> {
		return Promise.resolve(this.unsupported('renaming agents'));
	}

	focusPane(): Promise<boolean> {
		this.unsupported('focusing a pane');
		return Promise.resolve(false);
	}

	async startAgentHere(folderAbsPath: string, options?: StartAgentOptions): Promise<StartedHcAgent | null> {
		const send = this.host.connection();
		if (!send) {
			this.host.notice('Herdr: not connected to herdr-core.');
			return null;
		}
		const issue = remoteVaultPathIssue(this.host.runtime());
		if (issue) {
			this.host.notice(`Herdr: ${issue}. Set it in the plugin settings.`);
			return null;
		}
		const agent = await agentToStart(this.host, options);
		if (!agent) return null;
		const settings = this.host.settings();
		const label = folderName(folderAbsPath);
		const kind = agent.kind ?? FALLBACK_AGENT_KIND;
		const labels: Record<string, string> = { [LABEL_SEEN]: '0' };
		const space = this.scope()?.space;
		if (space) labels[LABEL_SPACE] = space.id;
		const taken = this.host.takenAgentNames();
		const nameFor = (): string =>
			hcTerminalName(
				buildAgentName(
					settings.agentNamePattern || '{folder}',
					{ folder: label, vault: this.host.vaultName() },
					taken,
				),
			);
		let name = nameFor();
		// A template runs as hc's own argv; everything else in the user's shell.
		let run: { line: string } | { argv: string[] };
		try {
			run = agent.template ? { argv: [agent.template] } : { line: agentLaunchLine(kind, agent.args, agent.command) };
		} catch (error) {
			this.host.notice(`Herdr: could not start an agent. ${describe(error)}`);
			return null;
		}
		for (let attempt = 0; ; attempt++) {
			try {
				const result = await send<unknown>('terminal.run', { ...run, cwd: folderAbsPath, name, labels });
				const paneId = parseTerminal(result)?.address ?? '';
				if (!paneId) throw new Error('herdr-core answered without a terminal address');
				this.host.notice(`Herdr: started ${agentLabel(agent)} agent "${name}" in ${label}`);
				if (settings.openTerminalAfterStart) await this.host.openTerminal(paneId, folderAbsPath);
				return { paneId, name, kind };
			} catch (error) {
				// Another client can take the name between our check and the call.
				if (error instanceof HcError && error.kind === 'name_taken' && attempt === 0) {
					taken.add(name);
					name = nameFor();
					continue;
				}
				this.host.notice(`Herdr: could not start an agent. ${describe(error)}`);
				return null;
			}
		}
	}

	/**
	 * Kills the terminal, then removes it. A terminal the core no longer has is
	 * the outcome asked for, as with herdr's `pane_not_found` (issue #90).
	 */
	async closePane(paneId: string, endpointId: string): Promise<boolean> {
		const send: Requester =
			this.host.connection() ?? (<T,>(method: string, params: unknown) => this.host.request<T>(method, params));
		let gone = false;
		try {
			await send('terminal.kill', { terminal: paneId });
		} catch (error) {
			if (error instanceof HcError && error.kind === 'not_found') gone = true;
			else if (!(error instanceof HcError && error.kind === 'finished')) {
				this.host.notice(`Herdr: could not close the agent. ${describe(error)}`);
				return false;
			}
		}
		if (!gone) {
			const deadline = this.host.now() + RM_RETRY_MS;
			for (;;) {
				try {
					await send('terminal.rm', { terminal: paneId });
					break;
				} catch (error) {
					if (error instanceof HcError && error.kind === 'not_found') break;
					// The kill landed but the process has not been reaped yet.
					if (error instanceof HcError && error.kind === 'live' && this.host.now() < deadline) {
						await this.host.sleep(RM_POLL_MS);
						continue;
					}
					// Killed but kept: the row still goes, as the agent has ended.
					break;
				}
			}
		}
		if (gone) this.host.notice('Herdr: that agent is already gone, so its row was removed from the list.');
		this.host.forgetPane(paneId, endpointId);
		this.host.detachTerminalLeaves(paneId, endpointId);
		return true;
	}

	/** The shared `herdr.pinned` label: `1` pins, empty removes it. */
	async setPinned(paneId: string, pinned: boolean): Promise<boolean> {
		try {
			await this.host.request('terminal.label', {
				terminal: paneId,
				labels: { [LABEL_PINNED]: pinned ? '1' : '' },
			});
			return true;
		} catch (error) {
			this.host.notice(`Herdr: could not ${pinned ? 'pin' : 'unpin'} the agent. ${describe(error)}`);
			return false;
		}
	}

	private unsupported(what: string): null {
		this.host.notice(`Herdr: ${what} is not available on herdr-core.`);
		return null;
	}
}

/** The prompt box over `terminal.send`: pasted, then Enter, one call. */
export function hcPromptSender(client: () => PromptClient | null): PromptSender {
	return {
		async send(paneId: string, text: string): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			try {
				await connected.request('terminal.send', { terminal: paneId, text });
			} catch (error) {
				throw new Error(describe(error));
			}
		},
	};
}

/** Key presses over `terminal.keys`, in hc's key names. */
export function hcKeySender(client: () => PromptClient | null): KeySender {
	return {
		async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			try {
				await connected.request('terminal.keys', { terminal: paneId, keys: keys.map(hcKeyName) });
			} catch (error) {
				throw new Error(describe(error));
			}
		},
	};
}
