/**
 * Graduation (ADR-0007, issue #185): a row of a resumable kind continues on
 * another runtime of this machine.
 *
 * Which runtimes can take it is what their kinds state
 * (`RuntimeCapabilities.continueTarget`), never a list here. Moving it is an
 * order with no step to skip: release the row here (its process confirmed
 * gone, the row held), switch to the target, wait for it to connect, start
 * `claude --resume <session>` there through its own start-agent path, and
 * only then forget the row; anything that fails on the way gives the row
 * back, stopped, where it can be resumed as before. The conversation is
 * never resumed in two places.
 *
 * Everything it acts through is injected, so `tests/graduation.test.ts`
 * pins the order with fakes.
 */

import { graduationArgs } from './claude/actions';
import type { GraduationRelease, RuntimeActions, RuntimeKindAdapter } from './runtime/kind';
import { runtimeById, runtimeDisplayName, type RuntimeKind, type RuntimeSettings } from './runtimes';
import type { GraduationTarget } from './views/rowMenu';

export interface GraduationDeps {
	/** The registry as it is now. */
	settings(): RuntimeSettings;
	/** The adapter of a kind. */
	kindOf(kind: RuntimeKind): Pick<RuntimeKindAdapter, 'capabilities' | 'unavailable'>;
	/** The runtime the list points at: rows are released from it. */
	listEndpointId(): string;
	/** The actions of the runtime the list points at, read per step: a switch replaces them. */
	actions(): Pick<RuntimeActions, 'releaseForGraduation' | 'startAgentHere'>;
	/** Makes a runtime the active one and reconnects. */
	switchRuntime(id: string): Promise<void>;
	/** Waits until that runtime is published with a resolved scope; false after the timeout. */
	scopeReady(id: string): Promise<boolean>;
	/** Closes the tabs of a pane on a runtime. */
	detachTerminalLeaves(paneId: string, endpointId: string): void;
	notice(message: string): void;
}

export class Graduation {
	constructor(private readonly deps: GraduationDeps) {}

	/**
	 * The runtimes a row of a resumable kind can continue on: those on this
	 * machine — the transcript is this machine's, so an SSH one could not
	 * resume it — whose kind can take it and that this build can run.
	 * Labelled by kind, with the runtime's name when the kind has several.
	 */
	targets(): GraduationTarget[] {
		const candidates = this.deps.settings().runtimes.filter((runtime) => {
			const kind = this.deps.kindOf(runtime.kind);
			return kind.capabilities.continueTarget && runtime.target === 'local' && kind.unavailable === null;
		});
		return candidates.map((runtime) => {
			const several = candidates.filter((other) => other.kind === runtime.kind).length > 1;
			return {
				id: runtime.id,
				label: several ? `${runtime.kind} (${runtimeDisplayName(runtime)})` : runtime.kind,
			};
		});
	}

	/**
	 * Moves a row released from `endpointId` (the list's runtime) to the
	 * runtime `runtimeId`, in the order above.
	 */
	async continueIn(paneId: string, endpointId: string, runtimeId: string): Promise<void> {
		const deps = this.deps;
		const target = runtimeById(deps.settings(), runtimeId);
		if (!target || deps.listEndpointId() !== endpointId) return;
		// Resolves once the process here for the session is confirmed gone, and
		// holds the row so nothing here starts it again meanwhile.
		let released: GraduationRelease | null;
		try {
			released = (await deps.actions().releaseForGraduation?.(paneId)) ?? null;
		} catch (error) {
			deps.notice(`Gjetr: could not continue the agent. ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (!released) {
			deps.notice('Gjetr: that agent has no session to continue.');
			return;
		}
		let moved = false;
		try {
			const name = runtimeDisplayName(target);
			await deps.switchRuntime(runtimeId);
			if (!(await deps.scopeReady(runtimeId))) {
				deps.notice(
					`Gjetr: ${name} did not connect, or has no workspace for this vault, so the agent was left stopped here. Switch back to resume it.`,
				);
				return;
			}
			const started = await deps.actions().startAgentHere(released.cwd, {
				kind: 'claude',
				args: graduationArgs(released),
			});
			if (!started) return;
			moved = true;
			await released.forget();
			deps.detachTerminalLeaves(paneId, endpointId);
		} finally {
			// The session did not move: the row is stopped here, for the user to resume.
			if (!moved) released.reclaim();
		}
	}
}
