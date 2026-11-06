/**
 * Folder and row actions on a `claude` runtime (ADR-0007):
 *
 * - **Start agent:** a new stored session in the folder, its process started
 *   at once so the first prompt does not wait for it, and its native view
 *   opened when the settings say so.
 * - **Close** ("Stop agent"): the process stops in the ADR's order; the row
 *   stays, stopped, and opening or prompting it resumes the conversation.
 * - **Forget:** a stopped row goes for good. The transcript stays where
 *   Claude keeps it.
 * - **Resume:** opening a stopped row spawns it with `--resume`.
 * - **Graduation:** the process stops and the row's cwd and session go to the
 *   runtime it continues on (`main.ts` runs that half).
 * - **Open shell here:** a plain shell in the folder, in a terminal tab
 *   (ADR-0008), with an optional command run first; not a row.
 * - New tab, split, rename and focus have no meaning without a multiplexer:
 *   the capabilities hide them, and a call that slips through says so.
 *
 * No Obsidian import: everything arrives through the {@link ActionHost}.
 */

import { buildAgentName, folderName, type ActionHost } from '../actions';
import type { GraduationRelease, RuntimeActions } from '../runtime/kind';
import type { ClaudeAgents } from './agents';
import type { ClaudeShells } from './shells';

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The arguments after `claude` that continue a graduated row on another
 * runtime: its permission mode, so the pane does not come up in the user's
 * own default, then `--resume <session>`. Every value is a plain word, which
 * herdr-core's single-quoted launch line requires.
 */
export function graduationArgs(release: GraduationRelease): string[] {
	return [
		...(release.permissionMode ? ['--permission-mode', release.permissionMode] : []),
		'--resume',
		release.sessionId,
	];
}

export interface StartedClaudeAgent {
	paneId: string;
	name: string;
}

export class ClaudeActions implements RuntimeActions {
	constructor(
		private readonly host: ActionHost,
		private readonly agents: ClaudeAgents,
		private readonly shells: ClaudeShells | null = null,
	) {}

	private get runtimeId(): string {
		return this.host.runtime().id;
	}

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

	async startAgentHere(folderAbsPath: string): Promise<StartedClaudeAgent | null> {
		if (!this.host.connection()) {
			this.host.notice('Herdr: not connected to Claude run by Obsidian yet.');
			return null;
		}
		const settings = this.host.settings();
		const label = folderName(folderAbsPath);
		const name = buildAgentName(
			settings.agentNamePattern || '{folder}',
			{ folder: label, vault: this.host.vaultName() },
			this.agents.names(this.runtimeId),
		);
		let paneId: string;
		try {
			paneId = this.agents.start(this.runtimeId, folderAbsPath, name).id;
		} catch (error) {
			this.host.notice(`Herdr: could not start Claude. ${describe(error)}`);
			return null;
		}
		this.host.notice(`Herdr: started Claude "${name}" in ${label}`);
		if (settings.openTerminalAfterStart) await this.host.openTerminal(paneId, folderAbsPath);
		return { paneId, name };
	}

	/**
	 * Stops the agent; its row stays, stopped. False, because the pane is not
	 * gone: its tabs keep showing the conversation, which a prompt resumes.
	 */
	async closePane(paneId: string): Promise<boolean> {
		try {
			await this.agents.stop(this.runtimeId, paneId);
		} catch (error) {
			this.host.notice(`Herdr: could not stop the agent. ${describe(error)}`);
		}
		return false;
	}

	async resumeAgent(paneId: string): Promise<void> {
		const agent = this.agents.get(this.runtimeId, paneId);
		if (!agent || agent.status !== 'stopped') return;
		try {
			this.agents.resume(this.runtimeId, paneId);
		} catch (error) {
			this.host.notice(`Herdr: could not resume the agent. ${describe(error)}`);
		}
	}

	async forgetAgent(paneId: string, endpointId: string): Promise<boolean> {
		try {
			await this.agents.forget(this.runtimeId, paneId);
		} catch (error) {
			this.host.notice(`Herdr: could not forget the agent. ${describe(error)}`);
			return false;
		}
		this.host.detachTerminalLeaves(paneId, endpointId);
		return true;
	}

	async releaseForGraduation(paneId: string): Promise<GraduationRelease | null> {
		const agent = this.agents.get(this.runtimeId, paneId);
		// A session with no turn has no transcript, so `--resume` elsewhere
		// would find no conversation; the menu does not offer it either.
		if (!agent?.started) return null;
		await this.agents.stop(this.runtimeId, paneId);
		// The session as it is after the stop: a `/clear` may have rotated it.
		const after = this.agents.get(this.runtimeId, paneId) ?? agent;
		const permissionMode = this.agents.permissionMode(this.runtimeId);
		return { cwd: after.cwd, sessionId: after.sessionId, ...(permissionMode ? { permissionMode } : {}) };
	}

	/**
	 * A shell in the folder, its tab opened. `command` runs first, in plain
	 * view (D3's installer). Resolves to the shell's pane id.
	 */
	async openShellHere(folderAbsPath: string, command?: string): Promise<string | null> {
		const shells = this.shells;
		if (!shells) return this.unsupported('a shell tab');
		const paneId = shells.open(folderAbsPath, command);
		await this.host.openTerminal(paneId, folderAbsPath);
		return paneId;
	}

	private unsupported(what: string): null {
		this.host.notice(`Herdr: ${what} is not available for Claude run by Obsidian.`);
		return null;
	}
}
