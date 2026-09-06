Review of 1440d7d, 2026-09-06. Related: #54, #2.

Three failures reproduced with deferred discovery/snapshot and fake clients; no live server was changed:

1. Start connect, unload before discovery resolves, then resolve discovery: an undisposed client is assigned after unload.
2. Start two connections; let the newer discovery finish first: the older completion overwrites the newer client without disposing it.
3. While an old snapshot is pending, connect a new client and trigger priming: the plugin-wide `priming` flag skips the new snapshot. Finishing the old request does not schedule the skipped prime.

Evidence: [connect](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/main.ts#L578), [reconnect](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/main.ts#L564), [primeScope](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/main.ts#L680). Existing request sockets also survive `HerdrClient.dispose()` until response/timeout ([client](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/client.ts#L548)).

Give a connection attempt immutable settings, an epoch/cancellation token, and ownership of its client/scope/tunnel. Invalidate on reconnect/unload; check after awaits; dispose superseded resources. Priming must belong to that connection, with a queued re-prime when needed. Announce scope clearing to views as well as successful replacement.

Acceptance: delayed discovery after unload creates no lasting resources; out-of-order reconnects leave only the newest client; a new connection always primes even when an old snapshot is pending; cancelled requests cannot update current status. Include tests of actual orchestration with injected dependencies.

Saved local audit reproduction: `docs/reviews/2026-09-06/lifecycle-repros.mjs` (not yet committed). This is a prerequisite for reliable #54 switching, not a request for multiple remote profiles.
