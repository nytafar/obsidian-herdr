/**
 * The `claude` kind's scope, client and tab labels (ADR-0007): the
 * plugin's own agent table seen through the seams every kind fills, so the
 * agent list, the notifier, the status bar and the native view read it
 * like any other runtime.
 *
 * - **Scope.** One row per stored session of the runtime, the ones it runs
 *   and the stopped ones alike: everything the plugin started in this vault.
 *   A stopped row is `idle` with `stopped: true`.
 * - **Client.** No transport. `ping` answers at once, `start` reports the one
 *   `connected` edge, and `request` takes three methods for the native view:
 *   `agent.prompt`, `agent.interrupt` and `agent.respond`. Disposing it ends
 *   nothing: the processes belong to the table, not to a connection.
 * - **Tab labels.** None: the kind has no tabs.
 *
 * No Obsidian.
 */

import type { ConnectionClient, ConnectionEventMap, ConnectionScope } from '../connection';
import {
	relevantDiff,
	type PaneState,
	type ResolutionMethod,
	type ScopeEventMap,
	type Unsubscribe,
} from '../herdr/scope';
import type { AgentStatus } from '../herdr/types.gen';
import type { WaitingAnswer } from '../native/pendingRequest';
import { promptImages } from '../native/promptImages';
import type { TabLabels } from '../tabLabels';
import type { ClaudeAgents, ClaudeAgentStatus, ClaudeAgentView, ClaudeRuntimeSetup } from './agents';

/** What the list calls the place the rows come from. */
export const CLAUDE_SCOPE_LABEL = 'agents run by Obsidian';

/**
 * An agent status as the shared rows carry it: stopped is idle with a flag,
 * and a TUI that has not reported its status is `unknown`.
 */
export function paneStatusOf(status: ClaudeAgentStatus): AgentStatus {
	return status === 'stopped' ? 'idle' : status;
}

/** One agent as a row. */
export function toClaudePaneState(agent: ClaudeAgentView, scopeId: string): PaneState {
	return {
		paneId: agent.id,
		workspaceId: scopeId,
		tabId: '',
		agent: 'claude',
		name: agent.name,
		agentStatus: paneStatusOf(agent.status),
		title: '',
		label: '',
		cwd: agent.cwd,
		focused: false,
		tokens: {},
		statusChangedSeq: agent.statusSeq,
		stopped: agent.status === 'stopped',
		started: agent.started,
	};
}

export class ClaudeScope implements ConnectionScope {
	private rows = new Map<string, PaneState>();
	private loaded = false;
	private readonly handlers = new Map<string, Set<(...args: never) => void>>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly agents: ClaudeAgents,
		private readonly runtimeId: string,
		/** The scope's id: this vault's path. */
		private readonly scopeId: string,
	) {
		this.unsubscribe = agents.on((runtime) => {
			if (runtime === this.runtimeId && this.loaded) this.reconcile();
		});
	}

	/** The vault path once the stored rows are read; null before. */
	get workspaceId(): string | null {
		return this.loaded ? this.scopeId : null;
	}

	get workspaceLabel(): string | null {
		return this.loaded ? CLAUDE_SCOPE_LABEL : null;
	}

	get method(): ResolutionMethod {
		return this.loaded ? 'setting' : 'none';
	}

	get size(): number {
		return this.rows.size;
	}

	/** How many rows have a process. */
	get running(): number {
		return this.list().filter((row) => !row.stopped).length;
	}

	list(): PaneState[] {
		return [...this.rows.values()];
	}

	get(paneId: string): PaneState | undefined {
		return this.rows.get(paneId);
	}

	/** Reads the stored rows: the prime, on the one `connected` edge. */
	load(): void {
		const first = !this.loaded;
		this.loaded = true;
		if (first) this.emit('workspaceResolved', this.scopeId, 'setting');
		this.reconcile();
	}

	/** Takes a row out; only {@link ClaudeAgents.forget} removes it for good. */
	forget(paneId: string): void {
		const row = this.rows.get(paneId);
		if (!row) return;
		this.rows.delete(paneId);
		this.emit('removed', row);
	}

	/** The table announces every change, so there is nothing to poll. */
	refresh(): Promise<void> {
		return Promise.resolve();
	}

	agentNames(): Set<string> {
		return this.agents.names(this.runtimeId);
	}

	on<K extends keyof ScopeEventMap>(type: K, handler: (...args: ScopeEventMap[K]) => void): Unsubscribe {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		const stored = handler as unknown as (...args: never) => void;
		set.add(stored);
		return () => {
			this.handlers.get(type)?.delete(stored);
		};
	}

	dispose(): void {
		this.unsubscribe();
		this.handlers.clear();
	}

	private reconcile(): void {
		const next = new Map<string, PaneState>();
		for (const agent of this.agents.list(this.runtimeId)) next.set(agent.id, toClaudePaneState(agent, this.scopeId));
		const before = this.rows;
		this.rows = next;
		for (const [paneId, row] of before) if (!next.has(paneId)) this.emit('removed', row);
		for (const [paneId, row] of next) {
			const old = before.get(paneId);
			if (!old) this.emit('added', row);
			else if (relevantDiff(old, row).length > 0 || old.stopped !== row.stopped) {
				this.emit('changed', paneId, old, row);
			}
		}
	}

	private emit<K extends keyof ScopeEventMap>(type: K, ...args: ScopeEventMap[K]): void {
		const set = this.handlers.get(type);
		if (!set) return;
		for (const handler of [...set]) {
			try {
				(handler as unknown as (...rest: ScopeEventMap[K]) => void)(...args);
			} catch {
				// One bad subscriber must not stop the others.
			}
		}
	}
}

/** What `agent.respond` takes. */
export interface ClaudeRespondParams {
	target: string;
	request: string;
	answer: WaitingAnswer;
}

/** Said by a request on a client whose connection was retired. */
export const CLAUDE_NOT_CONNECTED = 'not connected to this Claude runtime';

export class ClaudeClient implements ConnectionClient {
	private disposed = false;
	private readonly disposers: (() => void)[] = [];
	private readonly handlers: { [K in keyof ConnectionEventMap]: Set<(...args: ConnectionEventMap[K]) => void> } = {
		connected: new Set(),
		disconnected: new Set(),
	};

	constructor(
		private readonly agents: ClaudeAgents,
		readonly runtimeId: string,
		readonly setup: Readonly<ClaudeRuntimeSetup>,
	) {
		agents.configure(runtimeId, setup);
	}

	get state(): 'connected' | 'disposed' {
		return this.disposed ? 'disposed' : 'connected';
	}

	ping(): Promise<unknown> {
		return this.disposed ? Promise.reject(new Error(CLAUDE_NOT_CONNECTED)) : Promise.resolve({});
	}

	/** The one `connected` edge, which primes the scope. */
	start(): void {
		if (this.disposed) return;
		for (const handler of [...this.handlers.connected]) handler();
	}

	request<T>(method: string, params?: unknown): Promise<T> {
		if (this.disposed) return Promise.reject(new Error(CLAUDE_NOT_CONNECTED));
		const args = (params ?? {}) as Record<string, unknown>;
		const target = typeof args.target === 'string' ? args.target : '';
		try {
			switch (method) {
				case 'agent.prompt':
					// Settles once the prompt is written, which a switch from the
					// terminal view can take a moment to allow, or never will be.
					return this.agents
						.prompt(
							this.runtimeId,
							target,
							typeof args.text === 'string' ? args.text : '',
							promptImages(args.images),
						)
						.then(() => null as T);
				case 'agent.interrupt':
					this.agents.interrupt(this.runtimeId, target);
					break;
				case 'agent.respond': {
					const { request, answer } = args as unknown as ClaudeRespondParams;
					this.agents.respond(this.runtimeId, target, request, answer);
					break;
				}
				default:
					throw new Error(`${method} is not supported by Claude run by Obsidian`);
			}
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return Promise.resolve(null as T);
	}

	on<K extends keyof ConnectionEventMap>(type: K, handler: (...args: ConnectionEventMap[K]) => void): () => void {
		const set = this.handlers[type] as Set<(...args: ConnectionEventMap[K]) => void>;
		set.add(handler);
		return () => set.delete(handler);
	}

	setSocketPath(): void {}

	/** Runs `handler` when this connection is retired (the scope unsubscribes). */
	onDispose(handler: () => void): void {
		if (this.disposed) handler();
		else this.disposers.push(handler);
	}

	/** Ends this connection only; the agents keep running in the table. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.handlers.connected.clear();
		this.handlers.disconnected.clear();
		for (const handler of this.disposers.splice(0)) handler();
	}
}

/** The kind has no tabs, so there are no labels to read. */
export class NoTabLabels implements TabLabels {
	get(): string | undefined {
		return undefined;
	}

	labels(): ReadonlyMap<string, string> {
		return new Map();
	}

	ensure(): void {}

	subscribe(): Unsubscribe {
		return () => undefined;
	}

	dispose(): void {}
}
