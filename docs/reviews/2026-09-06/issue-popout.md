Review of 1440d7d. [AgentListView.onClick](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/views/agentListView.ts#L311) and [onKeyDown](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/views/agentListView.ts#L322) both reject targets unless `target instanceof Element` against the module's main-window constructor.

Elements created when the list opens/renders in a pop-out belong to another realm, so these guards return false. The row looks interactive but neither opening the terminal nor focusing herdr runs.

Obsidian documents this exact cross-window constructor trap and recommends its cross-window helpers: [Support pop-out windows](https://docs.obsidian.md/plugins/guides/pop-out-windows). The plugin already handles this correctly for [explorer targets](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/explorerButtons.ts#L145); reuse that policy or Obsidian's helper.

Also audit xterm's `screen instanceof HTMLElement` checks at lines 348 and 532, which can lose cell metrics/coordinates in that realm.

Acceptance: create/render the agent list in a secondary window; row body and SVG action icon respond to click and Enter/Space; xterm wheel coordinates and fit remain correct after migration. Preserve focus when rows rerender.

Evidence level: source-confirmed against official DOM realm guidance; the current live snapshot was checked in its main window, not moved to a pop-out during this review.
