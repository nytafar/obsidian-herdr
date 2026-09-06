Review refinement at 1440d7d: the shared tab-label cache already proposed here should own invalidation as well as retrieval.

Current AgentListView fetches labels on added/workspaceResolved, but scope subscribes to tab.renamed and ignores tab events in ingest. A rename can therefore remain stale, as already acknowledged in #16's completion comment. refreshTabLabels also applies an awaited response without verifying that the client/scope/workspace still matches the request, so an old connection's labels can briefly contaminate a new one.

Acceptance additions: rename an existing tab with no pane creation and update both list/title; change connection while tab.list is pending and reject the old response; two open list views share one fetch; explicitly clear empty results; key cache entries by connection plus workspace. Keep I/O outside render().
