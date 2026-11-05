/**
 * The herdr kind's half of a connection's lifecycle (`ConnectionDriver.prime`
 * and `.start`, `../connection.ts`): what the coordinator did itself before
 * the herdr-core kind needed a different one (ADR-0005). Behaviour unchanged.
 *
 * - **Prime.** `session.snapshot` carries workspaces, panes and agent names in
 *   one round trip (PRD section 7); a server without it falls back to the
 *   three list calls (PRD M3). `scope.prime` diffs rather than resets, so a
 *   re-prime is invisible unless something changed.
 * - **Start.** Every stream event goes to the scope, then the scope's
 *   subscriptions are sent. Agent names are the one thing the stream never
 *   carries, so they are re-read, coalesced, after the scope changes shape.
 */

import { setTimer } from '../timers';
import type { HerdrEvent, Subscription } from './client';
import type { ScopeEventMap } from './scope';
import type { AgentInfo, PaneInfo, SessionSnapshot, WorkspaceInfo } from './types.gen';

/** Delay before a coalesced `agent.list` refresh; a burst of panes is one call. */
export const AGENT_NAME_REFRESH_MS = 300;

/** The slice of `HerdrClient` priming and the stream use. */
export interface HerdrPrimeClient {
	snapshot(): Promise<SessionSnapshot | null>;
	listAgents(): Promise<AgentInfo[]>;
	listWorkspaces(): Promise<WorkspaceInfo[]>;
	listPanes(): Promise<PaneInfo[]>;
	subscribe(subscriptions: Subscription[]): void;
	isUnsupported(method: string): boolean;
	on(type: '*', handler: (event: HerdrEvent) => void): unknown;
}

/** The slice of `WorkspaceScope` priming and the stream use. */
export interface HerdrPrimeScope {
	setAgentNames(agents: readonly AgentInfo[]): void;
	prime(workspaces: WorkspaceInfo[], panes: PaneInfo[]): void;
	ingest(event: HerdrEvent): void;
	on<K extends keyof ScopeEventMap>(
		type: K,
		handler: (...args: ScopeEventMap[K]) => void,
	): unknown;
}

export async function primeHerdrScope(
	client: HerdrPrimeClient,
	scope: HerdrPrimeScope,
	retired: () => boolean,
): Promise<void> {
	const snapshot = await client.snapshot();
	if (retired()) return;
	// Names first: `prime` reads them when it builds the pane states.
	if (snapshot) {
		scope.setAgentNames(snapshot.agents ?? []);
		scope.prime(snapshot.workspaces ?? [], snapshot.panes ?? []);
		return;
	}
	const agents = await client.listAgents();
	if (retired()) return;
	const workspaces = await client.listWorkspaces();
	if (retired()) return;
	const panes = await client.listPanes();
	if (retired()) return;
	scope.setAgentNames(agents);
	scope.prime(workspaces, panes);
}

export interface HerdrStreamOptions {
	subscriptions: readonly Subscription[];
	setTimer?: (callback: () => void, ms: number) => unknown;
}

/**
 * Feeds the scope from the stream and subscribes. Also hangs the coalesced
 * `agent.list` off the scope: a pane that just gained an agent has no name
 * yet, because names are not on the event stream (PRD M8). A failure is
 * cosmetic; rows fall back to the title.
 */
export function startHerdrStream(
	client: HerdrPrimeClient,
	scope: HerdrPrimeScope,
	options: HerdrStreamOptions,
): void {
	const schedule = options.setTimer ?? ((callback, ms) => setTimer(callback, ms));
	let pending = false;
	const refreshNames = (): void => {
		if (pending) return;
		// A herdr without `agent.list` said so once already: stay off it.
		if (client.isUnsupported('agent.list')) return;
		pending = true;
		schedule(() => {
			pending = false;
			void client.listAgents().then(
				(agents) => scope.setAgentNames(agents),
				() => undefined,
			);
		}, AGENT_NAME_REFRESH_MS);
	};
	scope.on('added', () => refreshNames());
	scope.on('workspaceResolved', () => refreshNames());
	client.on('*', (event) => scope.ingest(event));
	client.subscribe([...options.subscriptions]);
}
