/**
 * Folder and row actions, prompts and keys on a herdr-core runtime
 * (ADR-0005's action mapping):
 *
 * - Start agent: `terminal.run {line, cwd, name, labels}`, labelled
 *   `herdr.seen=0` and, when the scope resolved a space, `herdr.space`, so the
 *   agent shows in herdr-app too ([[herdr-core-api]] §5; herdr-app
 *   `docs/labels.md`); and, except for a template, the plugin's own
 *   `obsidian-herdr.agent=<kind>`, the list's fallback kind (`LABEL_AGENT`).
 * - Close: `terminal.kill`, then `terminal.rm`.
 * - Pin: the shared `herdr.pinned` label.
 * - Prompt: `terminal.send`; keys: `terminal.keys`.
 * - Screen access for dialog answers (#164): `terminal.read`, one key per
 *   `terminal.keys`, text over a short attach.
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
import { imageExtension, imagePaste, type PromptImage } from '../native/promptImages';
import { checkScreenKey, checkScreenText, type ScreenAccess, type ScreenKey } from '../native/screenAccess';
import { HcError } from './connection';
import { LABEL_AGENT, LABEL_PINNED, LABEL_SEEN, LABEL_SPACE, parseTerminal } from './model';

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
			this.host.notice('Gjetr: not connected to herdr-core.');
			return null;
		}
		const issue = remoteVaultPathIssue(this.host.runtime());
		if (issue) {
			this.host.notice(`Gjetr: ${issue}. Set it in the plugin settings.`);
			return null;
		}
		const agent = await agentToStart(this.host, options);
		if (!agent) return null;
		const settings = this.host.settings();
		const label = folderName(folderAbsPath);
		const kind = agent.kind ?? FALLBACK_AGENT_KIND;
		const labels: Record<string, string> = { [LABEL_SEEN]: '0' };
		// The kind it was started as, the list's fallback when the foreground
		// is not one it knows. A template names no agent kind, so it gets none.
		if (!agent.template) labels[LABEL_AGENT] = kind;
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
			this.host.notice(`Gjetr: could not start an agent. ${describe(error)}`);
			return null;
		}
		for (let attempt = 0; ; attempt++) {
			try {
				const result = await send<unknown>('terminal.run', { ...run, cwd: folderAbsPath, name, labels });
				const paneId = parseTerminal(result)?.address ?? '';
				if (!paneId) throw new Error('herdr-core answered without a terminal address');
				this.host.notice(`Gjetr: started ${agentLabel(agent)} agent "${name}" in ${label}`);
				if (settings.openTerminalAfterStart) await this.host.openTerminal(paneId, folderAbsPath);
				return { paneId, name, kind };
			} catch (error) {
				// Another client can take the name between our check and the call.
				if (error instanceof HcError && error.kind === 'name_taken' && attempt === 0) {
					taken.add(name);
					name = nameFor();
					continue;
				}
				this.host.notice(`Gjetr: could not start an agent. ${describe(error)}`);
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
				this.host.notice(`Gjetr: could not close the agent. ${describe(error)}`);
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
		if (gone) this.host.notice('Gjetr: that agent is already gone, so its row was removed from the list.');
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
			this.host.notice(`Gjetr: could not ${pinned ? 'pin' : 'unpin'} the agent. ${describe(error)}`);
			return false;
		}
	}

	private unsupported(what: string): null {
		this.host.notice(`Gjetr: ${what} is not available on herdr-core.`);
		return null;
	}
}

/** What images need of an hc client beyond `request` (`HcClient` has both). */
export interface HcImageClient extends PromptClient {
	/** Types text into a terminal's program with no Enter. */
	input(terminal: string, text: string): Promise<void>;
	/** Whether the core lists a method in its `hello`. */
	hasMethod(method: string): boolean;
}

function imageClient(client: PromptClient | null): HcImageClient | null {
	const candidate = client as Partial<HcImageClient> | null;
	return candidate && typeof candidate.input === 'function' && typeof candidate.hasMethod === 'function'
		? (candidate as HcImageClient)
		: null;
}

/** Why images cannot go out over this herdr-core connection, or null (#144). */
export function hcImagesUnavailable(client: PromptClient | null): string | null {
	if (!client) return 'herdr-core is not connected';
	const images = imageClient(client);
	if (!images) return 'this herdr-core connection cannot type into a terminal';
	if (!images.hasMethod('terminal.put')) return 'this herdr-core has no terminal.put; a newer hc sends images';
	return null;
}

/** A file name for one image `terminal.put` writes beside the terminal. */
export function hcImageName(image: PromptImage, index: number, now: number): string {
	return `image-${now}-${index + 1}.${imageExtension(image.mediaType)}`;
}

/**
 * The prompt box over `terminal.send`: pasted, then Enter, one call.
 *
 * Images (#144) go as a dropped file does on Claude's terminal: each is put
 * beside the terminal with `terminal.put` (on the terminal's own machine,
 * removed with the terminal), the paths are typed as one bracketed paste with
 * no Enter ({@link HcImageClient.input}), which Claude turns into image
 * attachments, and `terminal.send` then pastes the text and presses the Enter
 * that sends both — an empty text included (measured 2026-11-06, hc 0.1.18,
 * `docs/architecture.md`, "Images in prompts").
 */
export function hcPromptSender(client: () => PromptClient | null, now: () => number = Date.now): PromptSender {
	return {
		async send(paneId: string, text: string, images: readonly PromptImage[] = []): Promise<void> {
			const connected = client();
			if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
			try {
				if (images.length) {
					const reason = hcImagesUnavailable(connected);
					const typer = imageClient(connected);
					if (reason || !typer) throw new Error(reason ?? 'images cannot be sent');
					const stamp = now();
					const paths: string[] = [];
					for (const [index, image] of images.entries()) {
						const put = await connected.request<{ path?: unknown } | null>('terminal.put', {
							terminal: paneId,
							name: hcImageName(image, index, stamp),
							data: image.data,
						});
						if (typeof put?.path !== 'string' || !put.path) throw new Error('herdr-core did not say where the image went');
						paths.push(put.path);
					}
					await typer.input(paneId, imagePaste(paths));
				}
				await connected.request('terminal.send', { terminal: paneId, text });
			} catch (error) {
				throw new Error(describe(error));
			}
		},
		imagesUnavailable: () => hcImagesUnavailable(client()),
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

/** What typing needs of an hc client beyond `request` (`HcClient` has it). */
type HcTypingClient = PromptClient & Pick<HcImageClient, 'input'>;

function typingClient(client: PromptClient): HcTypingClient | null {
	const candidate = client as Partial<HcTypingClient>;
	return typeof candidate.input === 'function' ? (candidate as HcTypingClient) : null;
}

/**
 * `text` as `terminal.keys` names, one per character, or null when a
 * character has no key name. hc 0.1.18 names only the unshifted keys of a US
 * layout, lowercases a bare letter (a capital is `shift+<letter>`), calls a
 * space `space`, and types `shift+<digit or punctuation>` as the unshifted
 * character, so `!`, `?`, `:`, `(` and anything outside ASCII cannot go this
 * way (measured 2026-11-06, `docs/architecture.md`, "Screen access, as
 * built").
 */
export function hcTextKeys(text: string): string[] | null {
	const keys: string[] = [];
	for (const char of text) {
		if (/^[a-z0-9,.;\-/\\'[\]=`]$/.test(char)) keys.push(char);
		else if (/^[A-Z]$/.test(char)) keys.push(`shift+${char.toLowerCase()}`);
		else if (char === ' ') keys.push('space');
		else return null;
	}
	return keys;
}

/**
 * Screen access on herdr-core (#164, ADR-0009): `terminal.read {lines: 0}`
 * for the visible screen, `terminal.keys` with one key per call (its reply is
 * the status from before the key, so it confirms nothing and is not read).
 * Text goes key by key in one `terminal.keys` call when every character has a
 * key name ({@link hcTextKeys}): that never touches the terminal's size, and
 * the call answers once the keys are in, so a key pressed after it lands
 * after the text. Other text goes as one AUTOMATIC_INPUT frame on a short
 * resumed attach at the terminal's own grid ({@link HcImageClient.input}),
 * which refuses where closing it would resize the terminal (#172);
 * `terminal.send` presses Enter.
 */
export function hcScreenAccess(client: () => PromptClient | null): ScreenAccess {
	const connected = (): PromptClient => {
		const current = client();
		if (!current) throw new Error(NO_CONNECTION_MESSAGE);
		return current;
	};
	return {
		async read(paneId: string): Promise<string> {
			const requester = connected();
			let result: { text?: unknown } | null;
			try {
				result = await requester.request<{ text?: unknown } | null>('terminal.read', {
					terminal: paneId,
					lines: 0,
				});
			} catch (error) {
				throw new Error(describe(error));
			}
			if (typeof result?.text !== 'string') throw new Error('herdr-core did not return the screen');
			return result.text;
		},
		async press(paneId: string, key: ScreenKey): Promise<void> {
			const checked = checkScreenKey(key);
			const requester = connected();
			try {
				await requester.request('terminal.keys', { terminal: paneId, keys: [checked] });
			} catch (error) {
				throw new Error(describe(error));
			}
		},
		async type(paneId: string, text: string): Promise<void> {
			checkScreenText(text);
			const requester = connected();
			if (!text) return;
			const keys = hcTextKeys(text);
			const typer = keys ? null : typingClient(requester);
			if (!keys && !typer) throw new Error('this herdr-core connection cannot type into a terminal');
			try {
				if (keys) await requester.request('terminal.keys', { terminal: paneId, keys });
				else await typer?.input(paneId, text);
			} catch (error) {
				throw new Error(describe(error));
			}
		},
	};
}

/**
 * The terminal's agent status as hc reports it now (`terminal.get`'s
 * `status.state`: `idle`, `working`, `blocked`, `done`), or null while the
 * agent reports none: what the session settings driver checks before it
 * sends anything (#169, #170).
 */
export function hcAgentStatus(client: () => PromptClient | null): (paneId: string) => Promise<string | null> {
	return async (paneId) => {
		const connected = client();
		if (!connected) throw new Error(NO_CONNECTION_MESSAGE);
		let result: unknown;
		try {
			result = await connected.request<unknown>('terminal.get', { terminal: paneId });
		} catch (error) {
			throw new Error(describe(error));
		}
		return parseTerminal(result)?.status?.state ?? null;
	};
}
