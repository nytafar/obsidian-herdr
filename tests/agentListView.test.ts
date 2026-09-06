/**
 * The list view's own behaviour needs a DOM and a live herdr, so what is left to
 * test here is its module surface: `src/main.ts` imports `countStatuses` from
 * this file, and the row helpers moved to `src/views/rowModel.ts` (issue #16)
 * without moving their import path. The row logic itself is covered by
 * `tests/rowModel.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as view from '../src/views/agentListView';
import * as rowModel from '../src/views/rowModel';

describe('agentListView module surface', () => {
	it('exports the view type id', () => {
		expect(view.AGENT_LIST_VIEW_TYPE).toBe('herdr-agents');
	});

	it('re-exports the row helpers its callers still import from here', () => {
		expect(view.countStatuses).toBe(rowModel.countStatuses);
		expect(view.agentDisplayName).toBe(rowModel.agentDisplayName);
		expect(view.relativeCwd).toBe(rowModel.relativeCwd);
		expect(view.pathLabel).toBe(rowModel.pathLabel);
		expect(view.cacheBadge).toBe(rowModel.cacheBadge);
		expect(view.buildRows).toBe(rowModel.buildRows);
		expect(view.STATUS_LABEL).toBe(rowModel.STATUS_LABEL);
		expect(view.STATUS_ORDER).toBe(rowModel.STATUS_ORDER);
	});
});
