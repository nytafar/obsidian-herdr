/**
 * The list view's own behaviour needs a DOM and a live herdr, so what is left to
 * test here is the one thing `main.ts` and the view's registration agree on: the
 * view type id. Everything a row *says* lives in `src/views/rowModel.ts` and is
 * covered by `tests/rowModel.test.ts`; the view re-exported those helpers for a
 * while after issue #16 split them out, and that shim is gone — callers import
 * the pure module directly.
 */

import { describe, expect, it } from 'vitest';
import * as view from '../src/views/agentListView';

describe('agentListView module surface', () => {
	it('exports the view type id', () => {
		expect(view.AGENT_LIST_VIEW_TYPE).toBe('herdr-agents');
	});
});
