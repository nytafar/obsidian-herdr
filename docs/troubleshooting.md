# Troubleshooting

Start with the status block at the top of **Settings → Herdr**; every problem
below shows up there.

**"Herdr binary not found", or terminals never start.** Obsidian was launched
from the Dock and has no login `PATH`. Set **Herdr binary** to the absolute path
from `which herdr`.

**"Server: not reachable".** herdr is not running, or listens on another socket.
`herdr status server --json` prints the socket; copy it into **Socket path**.

**"No herdr workspace matches this vault yet".** Neither the label nor the cwd
rule matched. Label a herdr workspace like the vault folder, open a pane whose
cwd is inside the vault, or pin **Workspace ID**.

**"Protocol mismatch".** The running herdr speaks a different protocol number
than the plugin was generated against. A warning only: the plugin never refuses
to connect, ignores fields it does not know, and disables just the single action
whose method is missing.

**The list is empty but herdr shows panes.** Only panes with an agent are
listed; shell panes are deliberately invisible.

**Rows show `~/…` paths for every agent.** The agents run outside this vault's
folder, for example in another vault. Paths inside the vault are shown relative
to it.

**The herdr TUI pane keeps resizing.** That is control mode: the pane follows
the Obsidian tab. Switch the tab to observe with the eye button, or set **Attach
mode** to observe.

**Control was lost while the tab was in the background.** Expected: a hidden
control tab hands control back after thirty seconds and takes it again when
revealed.

**Scrolling in Obsidian scrolls the pane in the herdr TUI too.** Expected today:
scrollback lives in herdr and is shared by every viewer of the pane.

**Obsidian feels heavy with several terminals open.** Close tabs you are not
reading (hidden ones already release after thirty seconds), lower **Scrollback
memory budget**, or switch **Terminal engine** to xterm.js, which returns memory
when tabs close.

**Session closed: terminal attach taken over.** Another client took control of
the pane. The refresh button reconnects.

**Remote: the tunnel connects but nothing answers.** Almost always a wrong
remote socket path. Verify with `ssh <host> <remote binary> status server --json`.

**Remote: terminals fail while the list works.** The forwarded socket does not
carry terminals. Check **Remote herdr binary** is an absolute path that exists on
the remote host.

**A leftover `herdr terminal session` process.** Closing the tab ends it;
`pgrep -fa 'terminal session'` should show one process per open terminal tab and
none afterwards.
