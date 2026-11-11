/**
 * The per-runtime keys of the settings tab (issue #178): a runtime page's
 * controls name `runtimes.<id>.<field>`, and `effects.ts` hands those keys
 * here. The stored `runtimes` array and what each field means are as they
 * were; only the path to them is new.
 *
 * A runtime id may hold dots (`ssh:lasse@xl:~/.config/herdr/herdr.sock`),
 * so the field is what follows the last dot and the id is everything between.
 */

import type { HerdrSettings } from '../settings';
import {
	activeRuntimeOf,
	DEFAULT_CLAUDE_PERMISSION_MODE,
	DEFAULT_HERDR_SOCKET,
	kindTargets,
	normalizePermissionMode,
	runtimeById,
	RUNTIME_KINDS,
	RUNTIME_TARGETS,
	type RuntimeConfig,
	type RuntimeKind,
	type RuntimeTarget,
} from '../runtimes';

/** The fields of a runtime a page edits. `id` is never one: tabs and pins name it. */
export type RuntimeField =
	| 'name'
	| 'kind'
	| 'target'
	| 'host'
	| 'binary'
	| 'socketPath'
	| 'remoteVaultPath'
	| 'workspace'
	| 'permissionMode';

/** A control key for one field of one runtime. */
export type RuntimeKey = `runtimes.${string}.${RuntimeField}`;

/** What a change of a field costs, after the save. */
interface RuntimeFieldSpec {
	/** The connection is rebuilt from it, when this runtime is the active one. */
	connection: boolean;
	/** It names or places the runtime: the switcher and the status bar are retitled. */
	retitle: boolean;
}

/**
 * The per-runtime half of the key→effect table. A field of the active
 * runtime reconnects, as the form always did; a field of another runtime
 * only saves, since nothing is connected to it. Renaming never reconnects.
 */
export const RUNTIME_FIELD_EFFECTS: { readonly [F in RuntimeField]: RuntimeFieldSpec } = {
	name: { connection: false, retitle: true },
	kind: { connection: true, retitle: true },
	target: { connection: true, retitle: true },
	host: { connection: true, retitle: true },
	binary: { connection: true, retitle: false },
	socketPath: { connection: true, retitle: false },
	remoteVaultPath: { connection: true, retitle: false },
	workspace: { connection: true, retitle: false },
	permissionMode: { connection: true, retitle: false },
};

const isField = (field: string): field is RuntimeField =>
	Object.prototype.hasOwnProperty.call(RUNTIME_FIELD_EFFECTS, field);

/** The key of one field of one runtime. */
export function runtimeKey(id: string, field: RuntimeField): RuntimeKey {
	return `runtimes.${id}.${field}`;
}

/** The runtime and field a key names, or null when it is not a per-runtime key. */
export function parseRuntimeKey(key: string): { id: string; field: RuntimeField } | null {
	if (!key.startsWith('runtimes.')) return null;
	const rest = key.slice('runtimes.'.length);
	const dot = rest.lastIndexOf('.');
	if (dot <= 0) return null;
	const field = rest.slice(dot + 1);
	return isField(field) ? { id: rest.slice(0, dot), field } : null;
}

/** What a control shows for a field: the stored value, the permission mode normalised. */
export function readRuntimeField(settings: HerdrSettings, id: string, field: RuntimeField): unknown {
	const runtime = runtimeById(settings, id);
	if (!runtime) return undefined;
	if (field === 'permissionMode') return normalizePermissionMode(runtime.permissionMode);
	return runtime[field];
}

/** What the plugin does after a per-runtime write. A subset of the tab's host. */
export interface RuntimeWriteHost {
	saveSettings(): Promise<void>;
	scheduleReconnect(): void;
	refreshRuntimes(): void;
}

/**
 * Stores one field, saves, and runs what it costs: a reconnect for a
 * connection field of the active runtime, a retitle for what names it. A key
 * for a runtime that is gone changes nothing; a kind or target this build
 * does not know is ignored.
 */
export async function writeRuntimeField(
	settings: HerdrSettings,
	id: string,
	field: RuntimeField,
	value: unknown,
	host: RuntimeWriteHost,
): Promise<void> {
	const runtime = runtimeById(settings, id);
	if (!runtime) {
		console.warn(`Gjetr: no runtime has the id "${id}"`);
		return;
	}
	if (!store(runtime, field, value)) return;
	await host.saveSettings();
	const spec = RUNTIME_FIELD_EFFECTS[field];
	if (spec.connection && activeRuntimeOf(settings).id === id) host.scheduleReconnect();
	if (spec.retitle) host.refreshRuntimes();
}

/** Writes the field in place; false when the value is not one it can hold. */
function store(runtime: RuntimeConfig, field: RuntimeField, value: unknown): boolean {
	switch (field) {
		case 'kind':
			if (!(RUNTIME_KINDS as readonly unknown[]).includes(value)) return false;
			retarget(runtime, value as RuntimeKind, runtime.target);
			return true;
		case 'target':
			if (!(RUNTIME_TARGETS as readonly unknown[]).includes(value)) return false;
			retarget(runtime, runtime.kind, value as RuntimeTarget);
			return true;
		case 'permissionMode':
			if (runtime.kind !== 'claude') return false;
			runtime.permissionMode = normalizePermissionMode(value);
			return true;
		default:
			runtime[field] = typeof value === 'string' ? value : '';
			return true;
	}
}

/**
 * A kind or target change: the socket field follows when it still holds the
 * old combination's default, and keeps what the user typed otherwise. The
 * binary keeps what was typed: its default is empty (a search) everywhere.
 */
export function retarget(runtime: RuntimeConfig, kind: RuntimeKind, target: RuntimeTarget): void {
	if (kind !== 'herdr') runtime.socketPath = '';
	else if (runtime.socketPath.trim() === '') runtime.socketPath = DEFAULT_HERDR_SOCKET;
	// Claude run by Obsidian runs here only, and has a permission mode (ADR-0007).
	const placed = kindTargets(kind).includes(target) ? target : 'local';
	if (kind === 'claude') runtime.permissionMode = normalizePermissionMode(runtime.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE);
	else delete runtime.permissionMode;
	runtime.kind = kind;
	runtime.target = placed;
}
