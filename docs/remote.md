# Remote herdr over SSH

Run agents on another machine and see them here. The plugin forwards herdr's API
socket over SSH for the list and the actions, and runs herdr's terminal bridge on
the far side for terminals.

## The vault must exist on both machines

Everything the plugin does is relative to the vault: which workspace matches,
which folder an agent starts in, which note a terminal opens beside. The remote
host therefore needs a copy of this vault at **Remote vault path**, kept in sync
by whatever you already use, such as Obsidian Sync, Self-hosted LiveSync,
Syncthing or a git remote. The plugin does not sync anything itself. Tested with
a mirrored vault on 2026-09-06; it works.

## Settings

- **Use a remote herdr**: on.
- **SSH host**: `user@host` or an alias from `~/.ssh/config`. Login must succeed
  without a prompt; the plugin runs `ssh` non-interactively.
- **Remote socket path**: the herdr server's socket on the remote host, usually
  `~/.config/herdr/herdr.sock`. A `~` is fine here (see below).
- **Remote herdr binary**: an **absolute** path such as
  `/home/you/.local/bin/herdr`. Non-interactive SSH has a minimal `PATH`, so a
  bare `herdr` will not be found.
- **Remote vault path**: where the mirror lives on the remote host. Required.

The status block in settings shows the tunnel state; a dropped link reconnects
with backoff.

## Two caveats

**The tilde.** `ssh -L local:~/x` does not expand `~` on the remote side; the
forward binds and then every connection through it dies silently. The plugin asks
the remote host for `$HOME` and expands the path itself, so `~` in **Remote
socket path** is safe even though it would not be in a hand-typed command.

**Terminals do not use the forward.** herdr's terminal bridge talks to a
different socket inside the CLI process, so remote terminals run the CLI on the
far side: `ssh -T <host> <remote binary> terminal session control|observe …`.
That is why the remote binary path matters even when the tunnel is healthy.

## Checking by hand

```bash
ssh <host> <remote binary> status server --json
```

proves the server is up and prints its socket path. Nothing is created on the
remote host by the plugin unless you start an agent.
