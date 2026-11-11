/**
 * A {@link RuntimesHost} for tests of the Runtimes page (#178): it records
 * what each action asks of the plugin and the tab, in order, as strings, and
 * keeps the per-runtime write listeners so a test can fire them.
 */

import type { RuntimeKind } from '../../src/runtimes';
import type { RuntimeField } from '../../src/settingsTab/runtimeKeys';
import type { RuntimesHost } from '../../src/settingsTab/runtimes';

export interface RecordedRuntimesHost {
	calls: string[];
	host: RuntimesHost;
	/** The listeners `onRuntimeWrite` holds now. */
	listeners: Set<(id: string, field: RuntimeField) => void>;
	/** Fires every listener, as the tab does after a per-runtime write. */
	written(id: string, field: RuntimeField): void;
}

export function recordRuntimesHost(
	options: { confirm?: boolean; unavailable?: Partial<Record<RuntimeKind, string>> } = {},
): RecordedRuntimesHost {
	const calls: string[] = [];
	const listeners = new Set<(id: string, field: RuntimeField) => void>();
	const host: RuntimesHost = {
		kindUnavailable: (kind) => options.unavailable?.[kind] ?? null,
		activate: async (id) => {
			calls.push(`activate:${id}`);
		},
		save: async () => {
			calls.push('save');
		},
		refreshRuntimes: () => calls.push('refreshRuntimes'),
		confirm: async () => {
			calls.push('confirm');
			return options.confirm ?? true;
		},
		update: () => calls.push('update'),
		openPage: (path) => calls.push(`openPage:${path.join('/')}`),
		onRuntimeWrite: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		drawDefaultAgent: () => calls.push('drawDefaultAgent'),
	};
	return {
		calls,
		host,
		listeners,
		written: (id, field) => {
			for (const listener of [...listeners]) listener(id, field);
		},
	};
}

/** A host that does nothing; definitions only need it to exist. */
export function quietRuntimes(): RuntimesHost {
	return recordRuntimesHost().host;
}
