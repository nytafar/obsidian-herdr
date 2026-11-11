/**
 * A {@link RuntimesHost} for tests of the Runtimes page (#178): it records
 * what each action asks of the plugin and the tab, in order, as strings, and
 * keeps the per-runtime write listeners so a test can fire them.
 */

import { defaultLocalRuntime, type RuntimeKind } from '../../src/runtimes';
import type { ConnectionStatus, ConnectionStatusSource } from '../../src/settings';
import type { RuntimeField } from '../../src/settingsTab/runtimeKeys';
import type { RuntimesHost } from '../../src/settingsTab/runtimes';

/** A connection the test sets by hand, and tells its listeners about with `changed()`. */
export interface FakeConnection extends ConnectionStatusSource {
	current: ConnectionStatus;
	listeners: Set<() => void>;
	changed(): void;
}

/** The local herdr, connected, with a socket, a server and a workspace. */
export function fakeConnection(overrides: Partial<ConnectionStatus> = {}): FakeConnection {
	const listeners = new Set<() => void>();
	const connection: FakeConnection = {
		current: {
			runtime: defaultLocalRuntime(),
			unavailable: null,
			discovery: {
				binary: { path: '/opt/homebrew/bin/herdr', source: 'homebrew' },
				socketPath: '/tmp/herdr.sock',
				status: { status: 'running', version: '0.9.5', protocol: 22 },
				error: null,
			} as unknown as ConnectionStatus['discovery'],
			socketPath: '/tmp/herdr.sock',
			tunnel: null,
			mismatch: null,
			workspace: { id: 'w4', label: 'hvelv', method: 'label', agentCount: 3 },
			error: null,
			state: 'connected',
			...overrides,
		},
		listeners,
		status: () => connection.current,
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		changed: () => {
			for (const listener of [...listeners]) listener();
		},
	};
	return connection;
}

export interface RecordedRuntimesHost {
	calls: string[];
	host: RuntimesHost;
	connection: FakeConnection;
	/** The listeners `onRuntimeWrite` holds now. */
	listeners: Set<(id: string, field: RuntimeField) => void>;
	/** Fires every listener, as the tab does after a per-runtime write. */
	written(id: string, field: RuntimeField): void;
}

export function recordRuntimesHost(
	options: {
		confirm?: boolean;
		unavailable?: Partial<Record<RuntimeKind, string>>;
		canOpenPages?: boolean;
		connection?: FakeConnection;
	} = {},
): RecordedRuntimesHost {
	const calls: string[] = [];
	const connection = options.connection ?? fakeConnection();
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
		canOpenPages: options.canOpenPages ?? false,
		connection,
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
		connection,
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
