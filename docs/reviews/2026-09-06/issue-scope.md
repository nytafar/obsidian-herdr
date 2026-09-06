Review of 1440d7d. Adjacent to completed #4 and #16; this is a current correctness defect.

With workspaces A labeled like the vault and B labeled differently, prime panes pa/pb, then:
- Rename A away: workspace resolves to null but scope.list() still returns pa.
- Rename B to the vault label: workspace resolves to B but scope.list() still returns pa from A instead of pb.
- Independently, start unmatched with no panes, then create the first pane inside the vault: cwd fallback never resolves.

[scope.ts:505](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/scope.ts#L505) changes resolvedId/method without reconciling the pane map. [upsert:529](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/scope.ts#L529) does not maintain the global pane inventory used by resolution; lastPaneList stays at its snapshot.

Impact: rows and counts can describe the wrong workspace; agent actions can combine stale pane data with a newly selected workspace.

Keep current resolution inputs and reconcile selected identity plus pane membership atomically. Either maintain a current inventory or perform a coalesced authoritative refresh on relevant lifecycle events.

Acceptance: rename-away removes old panes; rename-into-scope populates the new workspace's existing panes; pane creation/move/cwd change enables fallback resolution; removed panes cannot reappear from stale inventory. Assert collection contents, not just workspaceResolved events.

Three failing invariant checks saved locally in `docs/reviews/2026-09-06/scope-repros.mjs` (not yet committed); all use synthetic data.
