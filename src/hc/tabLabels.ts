/**
 * herdr-core's tab labels (ADR-0005): herdr-app keeps tabs in its document,
 * terminals carry `herdr.tab=<id>`, so grouping by tab reads the scope's
 * resolved space. Nothing is fetched here: the scope re-reads the document on
 * its `doc` event and says when the names may have moved.
 */

import type { TabLabels, Unsubscribe } from '../tabLabels';
import type { HcScope } from './scope';

export class HcTabLabels implements TabLabels {
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: Unsubscribe[];

	constructor(private readonly scope: HcScope) {
		const notify = (): void => {
			for (const listener of [...this.listeners]) {
				try {
					listener();
				} catch {
					// One bad subscriber must not stop the others.
				}
			}
		};
		this.unsubscribe = [scope.onTabLabelsChanged(notify), scope.on('workspaceResolved', notify)];
	}

	get(tabId: string): string | undefined {
		return this.scope.tabLabels().get(tabId);
	}

	labels(): ReadonlyMap<string, string> {
		return this.scope.tabLabels();
	}

	ensure(): void {}

	subscribe(listener: () => void): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		for (const off of this.unsubscribe.splice(0)) off();
		this.listeners.clear();
	}
}
