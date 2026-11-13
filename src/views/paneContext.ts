/**
 * The pane context (issue #184): what one terminal tab's pane is, as the
 * native surface and the tab ask it.
 *
 * Built over the endpoint resolver (#182) and the tab's identity, read per
 * call, so a tab switched to another pane or runtime asks about the new one.
 * It owns the answers the terminal view used to work out inline:
 *
 * - the tab's kind and endpoint;
 * - availability ({@link PaneContext.where}): where the pane lives and what
 *   rules each view out;
 * - the cwd mapping between the pane's machine and this vault;
 * - screen answering (ADR-0009) and the trust watch's wiring (#167), which
 *   reads the pane by `glance`, never `snapshot`;
 * - the native surface's dependencies: the prompt sender, the responder, the
 *   key sender, the session settings and the context readout, each over the
 *   tab's own runtime's client.
 *
 * The view keeps what is Obsidian's: lifecycle, header, visibility, view
 * state. Nothing here imports Obsidian, so `tests/paneContext.test.ts` drives
 * it with a fake resolver and fake kinds.
 */

import type { Endpoint } from '../connection';
import { normalizeTerminalPlacement, type HerdrSettings } from '../settings';
import { nativeViewBlock, type RuntimeKindAdapter } from '../runtime/kind';
import type { EndpointResolver } from '../runtime/endpoints';
import { agentFormat, type AgentFormat } from '../agents/format';
import { defaultAgentFormat } from '../agents/catalog';
import type { PaneWhere } from '../native/paneSurface';
import type { PaneGlance, PaneSnapshot } from '../native/sessionWatcher';
import { ScreenAnswerer } from '../native/screenAnswer';
import type { ScreenAnswerers, ScreenAnswering } from '../native/screenAnswerers';
import { TrustWatch } from '../native/trustWatch';
import { imagesUnavailable, type PromptClient } from '../native/promptSender';
import type { WaitingAnswer } from '../native/pendingRequest';
import type { NativePaneSurfaceOptions } from '../native/surface';
import type { SessionModels } from '../native/sessionModel';
import type { PromptQueueSource } from '../native/promptQueue';
import { normalizeCommandUsage, withCommandUsed, type CommandCatalogSource } from '../native/commandCatalog';
import { normalizeToolGroupPresentation } from '../native/toolCalls';
import { normalizeContextReadoutStyle, normalizePromptBoxStyle } from '../native/composerLook';
import { linkSourcePath } from '../native/noteLinks';

/** Why a tab whose runtime was removed from the registry offers no native view. */
export const NATIVE_UNKNOWN_RUNTIME_REASON = 'runtime no longer configured';

/**
 * Where a pane lives, with the pane's own reason against the native view on
 * top of its runtime's (ADR-0006): an hc terminal whose Claude has not
 * labelled it with its session stays a terminal and names the install
 * command, and a pane running another agent than Claude names it (#155).
 * The runtime's reason comes first; only a connected runtime has a
 * pane reason, so a tab on one that is not keeps what it shows.
 */
export function withPaneReason(block: PaneWhere, paneReason: string | null): PaneWhere {
	if (block.remote || block.kindReason || !paneReason) return block;
	return { remote: false, kindReason: paneReason };
}

/** The tab's pane: which one, on which runtime. Read per call. */
export interface PaneContextIdentity {
	paneId: string;
	endpointId: string;
}

/** What a pane context needs from the plugin. */
export interface PaneContextHost {
	readonly endpoints: Pick<EndpointResolver, 'endpoint' | 'kindOf' | 'watcher' | 'client' | 'commandCatalog'>;
	/** The plugin's one screen answer driver per runtime and agent, and the trust claims. */
	readonly screenAnswerers: Pick<ScreenAnswerers, 'answerer' | 'claimTrust' | 'releaseTrust' | 'trustClaimed'>;
	/** The plugin's session models and prompt queues, which outlive a view. */
	readonly models: SessionModels;
	readonly queues: PromptQueueSource;
	/** The settings as they are now. */
	settings(): HerdrSettings;
	/** Persists a setting the context changed (the `/` usage counts). */
	saveSettings(): void;
	/** This vault's absolute path, or '' for a non-filesystem adapter. */
	vaultPath(): string;
	notify(message: string): void;
}

/**
 * The native surface's options a pane context builds: everything that is
 * the pane's or the plugin's, not the view's.
 */
export type PaneSurfaceDependencies = Pick<
	NativePaneSurfaceOptions,
	| 'models'
	| 'queues'
	| 'sender'
	| 'responder'
	| 'screen'
	| 'sessionSettings'
	| 'contextUsage'
	| 'keySender'
	| 'autoTrustFolders'
	| 'presentation'
	| 'composer'
	| 'vaultPath'
	| 'noteSplitBefore'
	| 'linkSourcePath'
>;

/** What the prompt box's `/` and `@` suggest reads from the pane (#98). */
export interface PanePromptSource {
	cwd: () => string;
	catalog: (agent: string) => CommandCatalogSource | null;
	format: () => AgentFormat | null | undefined;
	paneId: () => string;
	usage: () => ReturnType<typeof normalizeCommandUsage>;
	onCommandUsed: (name: string) => void;
	vaultPath: () => string;
}

export class PaneContext {
	/**
	 * "Trust new folders automatically" for this tab's pane (#167): looks at
	 * the screen while the pane's agent has no session yet, whichever surface
	 * the tab shows, since an hc terminal at the prompt has no native view.
	 * It reads the pane by `glance`, never `snapshot`, which on herdr may read
	 * the Claude process of a pane this tab does not follow.
	 */
	readonly trustWatch: TrustWatch;

	constructor(
		private readonly host: PaneContextHost,
		private readonly identity: () => PaneContextIdentity,
	) {
		this.trustWatch = new TrustWatch({
			enabled: () => host.settings().nativeAutoTrustFolders === true,
			claimed: () => host.screenAnswerers.trustClaimed(this.trustKey()),
			pane: () => this.glance(),
			answering: (agent) => this.screenAnswering(agent),
			claim: () => host.screenAnswerers.claimTrust(this.trustKey()),
			release: () => host.screenAnswerers.releaseTrust(this.trustKey()),
			notify: (message) => host.notify(message),
		});
	}

	/** The tab's endpoint, or null when the settings no longer hold its runtime. */
	endpoint(): Endpoint | null {
		return this.host.endpoints.endpoint(this.identity().endpointId);
	}

	/** The kind adapter of this tab's runtime; herdr's while the runtime is unknown. */
	kind(): RuntimeKindAdapter {
		return this.host.endpoints.kindOf(this.endpoint()?.runtime.kind ?? 'herdr');
	}

	/** The client the tab's senders go through, read per call. */
	private client(): PromptClient | null {
		return this.host.endpoints.client(this.identity().endpointId);
	}

	/** The pane as its runtime's session watcher last reported it, or null. */
	snapshot(): PaneSnapshot | null {
		const { paneId, endpointId } = this.identity();
		if (!paneId) return null;
		return this.host.endpoints.watcher(endpointId)?.snapshot(paneId) ?? null;
	}

	/**
	 * This tab's pane as its runtime last reported it, read with no side
	 * effects (`SessionWatcher.glance`), or null for a kind that offers none.
	 */
	glance(): PaneGlance | null {
		const { paneId, endpointId } = this.identity();
		if (!paneId) return null;
		return this.host.endpoints.watcher(endpointId)?.glance?.(paneId) ?? null;
	}

	/**
	 * The pane's working directory as its runtime's session watcher last
	 * reported it, or empty when it has none: what the prompt box's `/` and `@`
	 * are relative to (#98).
	 */
	cwd(): string {
		return this.snapshot()?.cwd ?? '';
	}

	/**
	 * Where this tab's pane lives, for both views' availability (issue #54,
	 * ADR-0002, ADR-0004): on another machine, and whether its runtime's kind
	 * rules a view out by itself. A runtime that is no longer in the registry
	 * can show nothing natively; its terminal says why.
	 */
	where(): PaneWhere {
		const { endpointId, paneId } = this.identity();
		const endpoint = this.endpoint();
		if (!endpoint) return { remote: false, kindReason: NATIVE_UNKNOWN_RUNTIME_REASON };
		const kind = this.host.endpoints.kindOf(endpoint.runtime.kind);
		// A kind that runs but has no terminal of its own (ADR-0007) says so; a
		// kind this build cannot run at all keeps its terminal, which says why.
		const terminalReason =
			kind.unavailable === null
				? (kind.terminalUnavailable ?? (paneId ? (kind.paneTerminalReason?.(endpoint, paneId) ?? null) : null))
				: null;
		// A pane that is no agent (a `claude` shell tab) has nothing to show natively.
		const paneReason = paneId ? (kind.paneNativeReason?.(paneId) ?? null) : null;
		if (paneReason) return { remote: false, kindReason: paneReason, terminalReason };
		const block = nativeViewBlock(kind, endpoint);
		if (block.remote || block.kindReason || !paneId) return { ...block, terminalReason };
		return {
			...withPaneReason(block, this.host.endpoints.watcher(endpointId)?.unavailable?.(paneId) ?? null),
			terminalReason,
		};
	}

	/** The vault's path on the pane's machine when that is another one, else ''. */
	remoteVaultPath(): string {
		const runtime = this.endpoint()?.runtime;
		if (runtime?.target !== 'ssh') return '';
		return runtime.remoteVaultPath.trim().replace(/\/+$/, '');
	}

	/**
	 * The pane's cwd on this machine, for what is looked up here: relative
	 * links. A pane on an SSH runtime working inside the remote vault maps
	 * onto this vault; anywhere else it stays as reported. The `/` catalog
	 * is the pane's own machine's instead (`commandCatalog`).
	 */
	cwdHere(): string {
		const cwd = this.cwd();
		const remoteVault = this.remoteVaultPath();
		if (!remoteVault || !cwd) return cwd;
		const local = this.host.vaultPath();
		if (cwd === remoteVault) return local;
		return cwd.startsWith(`${remoteVault}/`) ? `${local}${cwd.slice(remoteVault.length)}` : cwd;
	}

	/** This tab's pane, plugin-wide, for the trust prompt's one claim (#167). */
	trustKey(): string {
		const { endpointId, paneId } = this.identity();
		return `${endpointId}\n${paneId}`;
	}

	/**
	 * Reading and answering this pane's dialog on its screen (ADR-0009), or
	 * null for a kind with no screen (the `claude` kind) or an agent whose
	 * format reads none. The driver is the plugin's one for this runtime and
	 * agent, so every tab on the pane shares its one-answer guard, and it
	 * reads the runtime's client per call. `agent` is the one the trust watch
	 * saw running; the card's is its session's. Nothing here reads the pane
	 * by `snapshot`, so the trust watch's use costs no process read.
	 */
	screenAnswering(agent?: string): ScreenAnswering | null {
		const endpointId = this.identity().endpointId;
		const kind = this.kind();
		const screen = kind.screen?.(() => this.host.endpoints.client(endpointId));
		const running = agent ?? this.glance()?.agent ?? undefined;
		const format = running ? agentFormat(running) : defaultAgentFormat();
		const parse = format?.screenDialog;
		if (!screen || !format || !parse) return null;
		const answerers = this.host.screenAnswerers;
		const answerer = answerers.answerer(
			`${endpointId}\n${kind.kind}\n${format.agent}`,
			() => new ScreenAnswerer({ screen, parse }),
		);
		return {
			answerer,
			screen,
			parse,
			statusMessage: () => this.glance()?.blockMessage ?? null,
			cwd: () => this.glance()?.cwd ?? '',
			claimTrust: () => answerers.claimTrust(this.trustKey()),
			releaseTrust: () => answerers.releaseTrust(this.trustKey()),
		};
	}

	/**
	 * The native surface's dependencies: the pane's own runtime's senders and
	 * readers, and the plugin settings the surface reads per draw.
	 */
	surfaceDependencies(): PaneSurfaceDependencies {
		const client = () => this.client();
		const prompts = () => this.kind().promptSender(client);
		const host = this.host;
		const settings = () => host.settings();
		return {
			// Plugin-held and reference counted, so two tabs on one pane read one
			// transcript (ADR-0003).
			models: host.models,
			// Prompts typed while the agent works wait in the plugin's queue (#159).
			queues: host.queues,
			// Prompts go through the tab's own runtime, its kind's sender over its
			// own client, and only while that runtime is the connected one and can
			// show a native view at all (ADR-0002, ADR-0006); `--wait` is never
			// asked for (#97, ADR-0003).
			sender: {
				send: (paneId, text, images, options) => prompts().send(paneId, text, images, options),
				// Whether images can go with a prompt (#144), asked of the kind as
				// it is now: herdr-core's answer depends on the core's version.
				imagesUnavailable: (paneId) => imagesUnavailable(prompts(), paneId),
				// The pane gate (review of #169): nothing typed into a picker the
				// session bar opened, nor one that may still be open.
				blocked: (paneId) => prompts().blocked?.(paneId) ?? null,
				// Stop, for a kind with a real interrupt (ADR-0007).
				...(prompts().interrupt
					? { interrupt: (paneId: string) => prompts().interrupt?.(paneId) ?? Promise.resolve() }
					: {}),
			},
			// The waiting card's answers, for a kind whose agents' dialogs are its
			// own requests (ADR-0007), over the same client.
			...(this.kind().responder
				? {
						responder: {
							respond: (paneId: string, requestId: string, answer: WaitingAnswer) => {
								const responder = this.kind().responder?.(client);
								return responder
									? responder.respond(paneId, requestId, answer)
									: Promise.reject(new Error('this runtime does not answer requests'));
							},
						},
					}
				: {}),
			// The waiting card's answers on the pane's screen (ADR-0009), for a
			// kind with one and an agent whose dialogs its format reads.
			screen: () => this.screenAnswering(),
			// The session bar's pickers (#161), for a kind that can change the
			// model, effort and mode; asked of the kind as it is now, every draw,
			// so the pane is read by `glance`. herdr and herdr-core drive the
			// agent's own pickers, read by its format (#169, #170).
			sessionSettings: () => {
				const agent = this.glance()?.agent;
				const format = agent ? agentFormat(agent) : defaultAgentFormat();
				return this.kind().sessionSettings?.(client, format ?? null) ?? null;
			},
			// The readout's breakdown (#171), for a kind that asks without
			// writing to the conversation; the others send `/context`.
			contextUsage: () => this.kind().contextUsage?.(client) ?? null,
			// The waiting card's "Trust this folder" (#99), over the same client and
			// only ever `Down Enter` on the workspace trust prompt.
			keySender: {
				sendKeys: (paneId, keys) => this.kind().keySender(client).sendKeys(paneId, keys),
			},
			// Read per block, so the setting reaches an open view (#99).
			autoTrustFolders: () => settings().nativeAutoTrustFolders === true,
			// Read fresh on every draw, so a setting change and a vault the user
			// moved reach a view that is already open (#95).
			presentation: () => normalizeToolGroupPresentation(settings().nativeToolGroups),
			composer: () => ({
				boxStyle: normalizePromptBoxStyle(settings().nativePromptBoxStyle),
				readout: normalizeContextReadoutStyle(settings().nativeContextReadout),
			}),
			vaultPath: () => host.vaultPath(),
			// Links open beside the tab, on the side opposite the one a terminal
			// is placed on beside its note (#114).
			noteSplitBefore: () => normalizeTerminalPlacement(settings().terminalPlacement) !== 'split-left',
			// Relative links resolve from the pane's cwd when it is in the vault.
			linkSourcePath: () => linkSourcePath(this.cwdHere(), host.vaultPath()),
		};
	}

	/**
	 * What the prompt box's suggest reads (#98): `/` offers the pane's
	 * commands and skills, `@` the vault's files. The pane's own cwd decides
	 * the project scope and the form a mention takes, on the pane's own
	 * machine (ADR-0006).
	 */
	promptSource(): PanePromptSource {
		const host = this.host;
		return {
			cwd: () => this.cwd(),
			// The commands of the machine the agent runs on: over the runtime's
			// connection for herdr-core over SSH (ADR-0006).
			catalog: (agent) => host.endpoints.commandCatalog(this.identity().endpointId, agent),
			// The catalogue of the agent the pane runs (ADR-0010): none named is
			// the default agent's, one without a format has none.
			format: () => {
				const agent = this.snapshot()?.agent;
				return agent ? agentFormat(agent) : undefined;
			},
			paneId: () => this.identity().paneId,
			// The most used commands first (#149), counted in the plugin's data
			// whatever runtime the pane is on.
			usage: () => normalizeCommandUsage(host.settings().commandUsage),
			onCommandUsed: (name) => {
				const settings = host.settings();
				settings.commandUsage = withCommandUsed(normalizeCommandUsage(settings.commandUsage), name);
				host.saveSettings();
			},
			// The agent opens a mention on its own machine: on an SSH runtime,
			// the remote vault's copy of the file.
			vaultPath: () => this.remoteVaultPath() || host.vaultPath(),
		};
	}
}
