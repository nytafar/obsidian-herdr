Review of 1440d7d; follow-up to #11 and prerequisite hardening for #54.

Two mocked reproductions confirm failures of tunnel ownership:

1. Delay remote HOME resolution during start(), call and await stop(), then complete HOME resolution. start() still spawns SSH, notices stopped afterward, and throws without killing the new child. Observed one alive child, no kill signals, status starting. See [start/stop/attempt](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/ssh.ts#L309). The HOME helper itself also has an untracked child and no deadline ([defaultDeps](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/ssh.ts#L175)).
2. Two plugin instances using the same host/socket generate the same /tmp pathname because [localSocketPathFor](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/ssh.ts#L136) hashes only those settings. Each start/stop unlinks it. Starting B replaces A's pathname; stopping A then removes B's active socket while B's child stays alive and reports connected. RPCs fail without the SSH exit event that would trigger recovery.

Use a short per-instance owned socket path, stable across that instance's retries, and cancellation/generation checks around every asynchronous startup boundary. Track and bound HOME discovery, and clean up an aborted attempt's children.

Acceptance: stopping during HOME resolution, unlink, or probing leaves no child/socket; two vaults with identical remote settings can start/stop independently without interrupting each other; retries reuse only their own socket.

Local reproduction: `docs/reviews/2026-09-06/transport-repros.mjs` (not yet committed). All processes, probes and unlink operations are mocked; no remote host was touched.
