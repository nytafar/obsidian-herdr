Architecture review at 1440d7d: the existing bridge can keep running after the list switches, but terminal identity is **not pinned to that profile**.

TerminalViewState persists only {paneId, mode}; main.terminalLeaf/stateMatchesPane compare paneId alone. Every start (reveal after suspension, reconnect, mode toggle, renderer rebuild) derives its command from current plugin.settings. Thus a local tab can acquire a remote title from the new scope while still showing the local process, and later reconnect to the remote pane with the same ID, using --takeover in control mode. A same-ID row may also reveal the old server's terminal.

Before adding the icon toggle, choose an explicit policy: pin each terminal to its local/remote endpoint identity and include it in lookup/restoration, or deliberately retire old-profile terminals on switch. This does not require the multi-server settings expansion Lasse deferred. Capture connection settings for asynchronous actions too.

Acceptance: same pane ID on local and remote never aliases; old tab title, resume, mode toggle and theme rebuild stay associated with the intended server; notification suppression is profile-aware. Connection lifecycle prerequisites are #57 and #59. The audit's synthetic identity/lifecycle repro is saved locally under docs/reviews/2026-09-06/.
