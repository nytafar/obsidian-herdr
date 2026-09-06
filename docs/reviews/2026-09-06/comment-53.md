Review refinement: rebuilding applies the new ghostty theme, but the current rebuildRenderer() also calls start(), which reattaches with --takeover in control mode. It is therefore more than a cosmetic one-line operation.

Preserve attachment intent: changing a palette should not reclaim a terminal that was closed because another controller took over, nor reconnect a tab to the other profile after #54 switches settings. Cover visible, suspended, and session-closed tabs; preserve observe mode and the existing snapshot policy. Route css-change through the same tested behavior where appropriate.

Keep the renderer contract honest: one engine supports in-place theme updates, the other needs reconstruction. Exposing that capability or returning a rebuild-required outcome is clearer than silently calling an inert setter.
