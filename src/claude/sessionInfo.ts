/**
 * What the `claude` kind hears of a session from its own process (issue #160,
 * finding `native-view-session-settings` §6): the runtime overlay the session
 * model lays over the transcript's reading, field by field
 * (`PaneSnapshot.sessionInfo`, `mergeSessionInfo`).
 *
 * - `system:init`, at the start of every turn: the model's id and the
 *   permission mode;
 * - `system:status`: a permission mode change;
 * - every `result`: `modelUsage[<model>].contextWindow`, the exact window,
 *   which no herdr or hc transcript states (and `get_context_usage`'s
 *   `maxTokens` when the session bar asks, #171);
 * - a control response that names what it set: `set_model` answers
 *   `{model}`, `set_permission_mode` `{mode}`. (`apply_flag_settings` for
 *   effort answers bare, so effort is the sender's to record.)
 *
 * The process knows the model's id only; the name Claude shows is the
 * transcript's (`mergeSessionInfo` keeps the reading's name for the same id).
 * Pure, and the info object is replaced only when a field changed.
 */

import { contextTokens, type ContextBreakdown } from '../native/contextBreakdown';
import type { SessionInfo } from '../native/conversation';
import type { ContextUsage, StreamEvent } from './protocol';

/** A model id without the window suffix an alias may carry: `claude-opus-5-5[1m]`. */
function baseModel(model: string): string {
	return model.replace(/\[[^\]]*\]$/, '');
}

/** `info` with the model set to `id`; a window stated for another model goes. */
function withModel(info: SessionInfo, id: string): SessionInfo {
	if (!id || info.model?.id === id) return info;
	const { contextWindow: _old, ...rest } = info;
	return { ...rest, model: { id, label: id } };
}

function withMode(info: SessionInfo, mode: string | null): SessionInfo {
	return mode && mode !== info.permissionMode ? { ...info, permissionMode: mode } : info;
}

/** The window a result states for the session's model, or null when it states none for it. */
function windowOf(info: SessionInfo, windows: Record<string, number>): number | null {
	const model = info.model?.id;
	const entries = Object.entries(windows);
	if (!model) return entries.length === 1 ? (entries[0]?.[1] ?? null) : null;
	const found = entries.find(([key]) => key === model) ?? entries.find(([key]) => baseModel(key) === baseModel(model));
	return found ? found[1] : null;
}

/**
 * The window stated for the session's model, from a `result`'s
 * `modelUsage` or a `get_context_usage` answer (#171), as the runtime's.
 */
export function foldContextWindow(info: SessionInfo, windows: Record<string, number>): SessionInfo {
	const tokens = windowOf(info, windows);
	if (tokens === null || (info.contextWindow?.tokens === tokens && info.contextWindow.source === 'runtime')) {
		return info;
	}
	return { ...info, contextWindow: { tokens, source: 'runtime' } };
}

/** What one stream event says of the session, folded into what the process said before. */
export function foldRuntimeInfo(info: SessionInfo, event: StreamEvent): SessionInfo {
	switch (event.type) {
		case 'init':
			return withMode(withModel(info, event.model), event.permissionMode);
		case 'status':
			return withMode(info, event.permissionMode);
		case 'result':
			return foldContextWindow(info, event.windows);
		case 'response':
			return event.ok ? withMode(withModel(info, event.model), event.mode) : info;
		default:
			return info;
	}
}

/** A share of the window the way `/context` words it: `0.2%`. */
function share(tokens: number, window: number): string {
	return window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : '';
}

/**
 * A `get_context_usage` answer as the breakdown the session bar shows
 * (#171), worded as `/context` words it on herdr and hc.
 */
export function contextBreakdownOf(usage: ContextUsage, id: string): ContextBreakdown {
	return {
		id,
		model: usage.model,
		used: contextTokens(usage.totalTokens),
		window: usage.maxTokens > 0 ? contextTokens(usage.maxTokens) : '',
		percent: usage.maxTokens > 0 ? `${Math.round(usage.percentage)}%` : '',
		categories: usage.categories.map((category) => ({
			name: category.name,
			tokens: contextTokens(category.tokens),
			share: share(category.tokens, usage.maxTokens),
		})),
	};
}
