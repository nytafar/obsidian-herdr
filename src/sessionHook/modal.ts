/**
 * The consent step for the Claude session hook (ADR-0006): one modal that
 * says whether the hook is in place on the active herdr-core runtime's
 * machine, shows the exact script and the exact settings entry install would
 * write (or the entry remove would take out), and writes only after a click.
 *
 * Both the `Install or remove the Claude session hook` command and the
 * herdr-core runtime form's button open it. What it writes is the plan built
 * from what it read and showed; the installer refuses if either file changed
 * in between (`./installer.ts`).
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import {
	applyInstall,
	applyRemove,
	inspectSessionHook,
	planInstall,
	planRemove,
	type HookMachine,
	type InstallPlan,
	type RemovePlan,
	type SessionHookSnapshot,
} from './installer';

/** Where the hook goes: the active runtime's name and machine. */
export interface SessionHookTarget {
	runtimeName: string;
	machine: HookMachine;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line for the runtime form: the state, and where it was looked for. */
export async function sessionHookStatusLine(target: SessionHookTarget): Promise<{ text: string; warning: boolean }> {
	try {
		const { status, paths } = await inspectSessionHook(target.machine);
		return {
			text: `${status.detail} Claude settings: ${paths.settingsPath}.`,
			warning: status.state === 'outdated' || status.state === 'unreadable',
		};
	} catch (error) {
		return { text: `Could not check the hook: ${message(error)}.`, warning: true };
	}
}

export class SessionHookModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private readonly target: SessionHookTarget,
		private readonly onDone?: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(`Claude session hook on ${this.target.runtimeName}`);
		void this.load();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Reading the Claude settings on that machine…' });
		let snapshot: SessionHookSnapshot;
		try {
			snapshot = await inspectSessionHook(this.target.machine);
		} catch (error) {
			contentEl.empty();
			contentEl.createEl('p', { cls: 'mod-warning', text: `Could not read them: ${message(error)}.` });
			this.buttons(null, null);
			return;
		}
		this.render(snapshot);
	}

	private render(snapshot: SessionHookSnapshot): void {
		const { contentEl } = this;
		contentEl.empty();
		const { status, paths } = snapshot;
		contentEl.createEl('p', {
			text:
				'The hook lets the native view follow Claude in a herdr-core terminal: when a Claude session starts, ' +
				"it labels the terminal with the session id, Claude's process id and the transcript path.",
		});
		contentEl.createEl('p', {
			cls: status.state === 'installed' || status.state === 'absent' ? undefined : 'mod-warning',
			text: `${status.detail} Claude settings: ${paths.settingsPath}${paths.fromEnv ? ' (from CLAUDE_CONFIG_DIR)' : ''}.`,
		});

		const install = status.state === 'installed' ? null : planInstall(snapshot);
		const remove = status.state === 'absent' ? null : planRemove(snapshot);

		if (install && !install.ok) contentEl.createEl('p', { cls: 'mod-warning', text: install.reason });
		if (install?.ok) {
			contentEl.createEl('h4', { text: status.state === 'absent' ? 'Install writes' : 'Update writes' });
			contentEl.createEl('p', {
				text: `This script, to ${paths.scriptPath}${snapshot.scriptText === null ? '' : ', replacing the one there'}:`,
			});
			contentEl.createEl('pre', { cls: 'herdr-hook-preview', text: install.script });
			contentEl.createEl('p', {
				text: install.settingsChanged
					? `This entry under "hooks" → "SessionStart" in ${paths.settingsPath}${install.createsSettings ? ', a new file' : ''}. Nothing else in that file changes:`
					: `This entry, already in ${paths.settingsPath}, which stays as it is:`,
			});
			contentEl.createEl('pre', { cls: 'herdr-hook-preview', text: JSON.stringify(install.entry, null, 2) });
		}

		if (remove && !remove.ok && status.state !== 'unreadable') {
			contentEl.createEl('p', { cls: 'mod-warning', text: remove.reason });
		}
		if (remove?.ok) {
			contentEl.createEl('h4', { text: 'Remove' });
			const what: string[] = [];
			if (remove.settingsChanged) what.push(`takes ${remove.entries.length === 1 ? 'this entry' : 'these entries'} out of ${paths.settingsPath}`);
			if (remove.deletesScript) what.push(`deletes ${paths.scriptPath}`);
			contentEl.createEl('p', { text: `Remove ${what.join(' and ')}. Nothing else changes.` });
			if (remove.entries.length > 0) {
				contentEl.createEl('pre', {
					cls: 'herdr-hook-preview',
					text: remove.entries.map((entry) => JSON.stringify(entry, null, 2)).join('\n'),
				});
			}
		}

		this.buttons(install?.ok ? install : null, remove?.ok ? remove : null, status.state === 'absent' ? 'Install' : 'Update');
	}

	private buttons(
		install: Extract<InstallPlan, { ok: true }> | null,
		remove: Extract<RemovePlan, { ok: true }> | null,
		installLabel = 'Install',
	): void {
		const row = new Setting(this.contentEl);
		row.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
		if (remove) {
			row.addButton((button) =>
				button
					.setButtonText('Remove')
					.setWarning()
					.onClick(() => void this.run('Removed the Claude session hook.', () => applyRemove(this.target.machine, remove))),
			);
		}
		if (install) {
			row.addButton((button) =>
				button
					.setButtonText(installLabel)
					.setCta()
					.onClick(() => void this.run('Installed the Claude session hook. It takes effect for Claude sessions started from now on.', () => applyInstall(this.target.machine, install))),
			);
		}
	}

	private async run(done: string, apply: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await apply();
			new Notice(`Herdr: ${done}`);
			this.close();
			this.onDone?.();
		} catch (error) {
			new Notice(`Herdr: ${message(error)}`);
			// Show the files as they are now, so the next click is on what is there.
			await this.load();
		} finally {
			this.busy = false;
		}
	}
}
