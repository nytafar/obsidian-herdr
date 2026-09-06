# Herdr plugin architecture, reliability and performance review

Reviewed 2026-09-06 against commit `1440d7d9c81dabd756b92c5e73856e74a474debb`.

## Assessment

The plugin has useful module boundaries and strong coverage of pure decisions and transport behavior. Keep that architecture. Its main weakness is ownership across asynchronous operations: the current connection, workspace, terminal identity and pending requests can stop agreeing during reconnects, profile changes or shutdown. Address those invariants before adding the local/remote toggle. This needs focused refactoring, not a framework or broad rewrite.

DRY is generally good in presentation decisions, but weaker in transport framing, renderer configuration and the separation between configuration data and Obsidian UI. Performance work already suppresses the expensive event noise appropriately. The largest measured costs remain the renderer engines, and the available benchmark does not establish that normal plugin usage leaks memory indefinitely.

Six new issues were posted, and five existing plans were elaborated or corrected. No plugin implementation, settings, release artifacts or running agent input was changed.

## Scope and verification

- Read the full source structure, repository instructions, architecture/development/remote documentation, parent PRD, tests, build scripts and CI workflows.
- Examined all 54 existing issues returned by the initial issue listing, including closed implementation work and 52 discussion comments. Checked concurrent #56 afterward; it concerns agent-driven Obsidian control and does not duplicate these findings.
- Inspected `/Users/lasse/Vaults/Snapshots/hvelv/.obsidian/plugins/herdr/`. Only the three release files are symlinked to the checkout, which avoids the earlier whole-repository installation problem.
- Verified the active Obsidian vault path before runtime inspection. Obsidian app package: 1.13.7; plugin: 0.1.0; local profile; ghostty-web engine; four scoped agent panes; one visible, active control terminal and one agent-list view; pending frame bytes zero at the observation; no captured errors.
- `npm test`: **463 passing tests across 23 files**. The initial sandbox run failed 20 socket tests with `listen EPERM`; rerunning with local socket access passed. Those failures were environmental.
- `npx tsc -noEmit -skipLibCheck`: passed. `npm run lint`: zero errors, 19 warnings. Several warnings concern acronym casing or test/global timer conventions and should be judged individually.
- Ran `node scripts/bench-renderers.mjs --json`, which performs production-equivalent bundles in temporary directories and isolated headless renderer benchmarks. Did not run ordinary `npm run build`, because it overwrites the file loaded by the live vault.
- Saved and ran synthetic reproductions of connection, scope and SSH/framing failures. They bundle source in memory; they do not connect to herdr or launch real SSH processes.

The runtime observation is a health snapshot, not an end-to-end certification. No ten-minute app memory study, GPU measurement, input latency test, remote-host smoke test, pop-out migration or controller takeover was performed. A whole-app heap reading cannot attribute memory to this plugin, so it is not used as a plugin-memory result. The installation points to this checkout, but that alone does not prove every loaded function matches current source; source findings are explicitly pinned to the reviewed commit.

## Findings and issue disposition

| Priority | Finding | Evidence | Tracking |
|---|---|---|---|
| P1 | Stale connection startup survives unload, overwrites newer reconnects, or prevents a new scope from priming | Synthetic orchestration reproduction | [#57](https://github.com/nytafar/obsidian-herdr/issues/57) |
| P1 before profile toggle | Terminal identity lacks its server/profile; resume can attach to a different server's same-ID pane | Source plus persisted-state reproduction | [#54 clarification](https://github.com/nytafar/obsidian-herdr/issues/54#issuecomment-5558717824) |
| P2 | Workspace identity changes without reconciling its pane collection | Three failing invariant checks | [#58](https://github.com/nytafar/obsidian-herdr/issues/58) |
| P2 | SSH can spawn after stop; separate vault instances unlink one another's socket | Mocked child/socket reproductions | [#59](https://github.com/nytafar/obsidian-herdr/issues/59) |
| P2, small hardening task | Completed oversized NDJSON records bypass the limit; terminal overflow loses framing | Synthetic byte-budget checks | [#60](https://github.com/nytafar/obsidian-herdr/issues/60) |
| P2 | Agent-list DOM guards reject elements created in pop-outs | Source and official realm guidance; not live-smoked | [#61](https://github.com/nytafar/obsidian-herdr/issues/61) |
| P2 before community release | Release pipeline demands a `v` prefix contrary to Obsidian's release contract | Workflow and official sample | [#62](https://github.com/nytafar/obsidian-herdr/issues/62) |

### Connection and terminal ownership

`main.ts:578` awaits discovery and later publishes client/scope without an unload flag or attempt generation. `reconnect()` does not serialize overlapping attempts. Delaying and completing discovery in different orders reproduces an undisposed client after unload and a newer client overwritten by an older attempt. Separately, `primeScope()` at line 680 uses one plugin-wide boolean: a new connection's prime is skipped while the old request runs, and no retry follows. Pending ordinary RPC sockets also survive `HerdrClient.dispose()` until their response or timeout.

Introduce a small connection coordinator that owns an immutable connection configuration, cancellation generation, client, scope, tunnel and refresh work. Invalidate before awaiting teardown. Check ownership after asynchronous boundaries, and dispose resources created by stale attempts. Publish disconnected state to views as well as successful scope replacements. Associate priming and queued refreshes with the owning connection.

The related terminal issue is more consequential than a stale label. `TerminalViewState` at `terminalView.ts:82` stores only `paneId` and `mode`; `main.ts` reuses leaves by pane ID. `TerminalView.start()` chooses the command from current plugin settings each time. An existing local bridge can continue after switching the list to remote, acquire a remote title from the new scope, then attach to the remote same-ID pane after hide/reveal, reconnect, mode toggle or renderer rebuild. Control mode supplies `--takeover`.

Choose and test one policy: pin each view to an endpoint identity, or explicitly retire the old profile's views on switching. Include that identity in lookup, restoration, title sourcing and notification suppression. This does not require multiple configurable remote servers, which the latest #54 decision explicitly defers. Multi-step actions should similarly retain the client/configuration they started with rather than resolving mutable global connection state between requests.

Additional reliability gaps worth handling in that coordinator: initial `ping()` failure prevents subscription from starting, so stream backoff cannot recover that initial failure; the stream handshake itself has no acknowledgement deadline. These are source findings, not separately reproduced outages in the live vault. Snapshot/event ordering also needs an explicit contract: a slower snapshot must not erase newer events. Avoid assuming that subscribing before snapshot alone guarantees reconciliation.

### Scope consistency

`scope.ts:505` re-resolves the workspace using `lastPaneList`, then changes only the workspace ID and method. It leaves the existing pane map untouched. The reproduced sequence selects workspace B while `list()` still returns workspace A's pane. Renaming the matching workspace away leaves a nonempty pane collection under a null workspace. Creating the first in-vault pane after an unmatched initial snapshot does not activate cwd fallback because live events do not update the resolution inventory.

Maintain current inventory or perform an authoritative coalesced refresh on relevant structural changes, then reconcile membership and selected identity together. Add collection assertions to the existing rename tests; testing only that a resolution event fired missed the defect. Notifications, counts, splitting decisions and row actions all depend on this invariant.

### SSH lifecycle and socket ownership

`ssh.ts:319` awaits HOME resolution. If `stop()` finishes during that wait, the resumed startup still reaches `attempt()` and spawns a child before checking the stopped flag. The reproduction observes an alive child, no kill signal and a status of `starting`. The HOME helper at line 175 also has no deadline and is not tracked by tunnel teardown.

The short socket path at line 136 hashes only host plus remote path. Two vaults using the same profile therefore share it, but each instance unlinks it on start and stop. The mock reproduction starts both and stops A: B remains alive and reports connected after its socket pathname is removed. Its exit-based recovery does not trigger.

Use a short private instance-owned pathname that stays stable across that instance's retries. Bound and track discovery children, check cancellation after awaits, and make aborted attempts release all resources they created. Test stop during each asynchronous stage and two independent instances with identical settings.

### Framing, pop-outs and releases

Both NDJSON splitters check unfinished tails but miss completed oversized lines. A 16-byte budget accepts a 100-byte terminated line and a 115-byte split record. After terminal overflow, a suffix of the rejected line is emitted as a new record. Validate the aggregate byte length before concatenation/decoding, then discard through the next newline if the transport continues. This is a concrete shared-helper opportunity. It is not proof of unbounded live memory growth; normal pipe chunks limit typical overshoot.

`agentListView.ts:313,325` uses the main realm's `Element` constructor. Targets created in a secondary window fail those guards. The explorer already contains a cross-window-safe target helper at `explorerButtons.ts:145`. Reuse that policy and audit xterm's `HTMLElement` checks at lines 348 and 532. Obsidian explains the constructor distinction in its [pop-out guidance](https://docs.obsidian.md/plugins/guides/pop-out-windows). Add an actual secondary-window smoke check for row clicks, SVG targets, keyboard input, fit and wheel coordinates.

The release workflow triggers on `v*` and validates `v + manifest.version`, while AGENTS.md and the [official sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md#releasing-new-releases) require a bare version tag. Align trigger, validation and documentation before community release. Existing symlink installation success does not test this contract. Keep the useful three-asset and embedded-WASM checks. Do not delete historical release tags as an automatic cleanup step.

## Architecture and DRY

### Boundaries worth preserving

The JSON API and terminal bridge are correctly separate: metadata/actions use RPC; terminal frames and input use a child-process session. The renderer interface keeps bridge code independent of ghostty/xterm. `ActionHost` makes actions testable without running Obsidian. `rowModel`, notification decisions, path helpers and input encoders make behavior reviewable in small tests. Scope filters revision/spinner/cache-second noise before notifying views. Delegated events avoid accumulating listeners during list rebuilding. Terminal generation checks, bounded frame buffering and hidden-view suspension are useful existing defenses.

### Focused changes with practical value

| Area | Current pressure | Recommended boundary |
|---|---|---|
| `main.ts`, 771 lines | Lifecycle, discovery/reconnect, state refresh, placement, menus and status UI | Connection coordinator first; extract command/menu and placement wiring when next changed |
| `terminalView.ts`, 1,174 lines | Pure helpers, visibility/frame state machines, renderer/session lifecycle, DOM | Move tested helpers into focused modules; keep view lifecycle orchestration visible and coherent |
| `settings.ts`, 898 lines | Types/defaults/validation mixed with Obsidian settings UI | Pure settings model plus settings tab; existing actions currently import a module that imports Obsidian |
| API/bridge framing | Same bounded-record policy implemented twice with the same defect | Shared byte-based splitter; separate transport-specific recovery/error mapping |
| Renderer adapters | Repeated CSS color map, font lookup and snapshot policy | Shared policy helpers; retain engine-specific mounting, disposal and input interception |
| Tab labels | View-owned cache and retrieval; planned terminal-title consumer | Connection-scoped metadata cache with rename invalidation and stale-response rejection |

Line counts indicate mixed responsibilities, not automatic defects. Generated `types.gen.ts` is 2,147 lines and should remain generated. Do not split coherent transport state machines solely to meet a line-count target, introduce a generic event framework, or force the two renderer implementations into inheritance because their interfaces happen to resemble one another.

`paths.ts` is a natural home for POSIX normalization currently in `actions.ts`. Renderer helper extraction should preserve the different engine semantics: a theme update can repaint xterm in place, but ghostty currently needs reconstruction. The settings/UI split would make the claimed pure boundaries real rather than relying on an Obsidian runtime stub transitively.

## Performance findings

Fresh run of the existing benchmark: 200,000 lines, 36.4 MB input, 120×40 grid, default 10 MB budget. This is synthetic scrolling input; herdr's actual cell-repaint protocol does not continuously populate local scrollback.

| Measurement | ghostty-web | xterm.js |
|---|---:|---:|
| Parse time | 491 ms | 904 ms |
| Approximate throughput | 74.1 MB/s | 40.3 MB/s |
| Retained scrollback lines | 5,961 | 6,000 |
| Buffer growth measure | 14.29 MB WASM | 11.81 MB heap + external |
| Growth remaining after disposal | 14.29 MB WASM | 0.47 MB heap + external |

The last two columns use different memory accounting and must not be presented as identical whole-process measurements. Ghostty's shared WebAssembly memory cannot shrink; freed regions may be reused, so retained capacity is not proof that each reopen leaks another terminal. Xterm releases most of its buffer allocations in this test. Neither number measures canvas/GPU memory or guarantees that process RSS drops immediately.

Minified production-equivalent bundle sizes: neither engine 93,916 bytes; ghostty only 741,264; xterm only 394,647; both 1,038,055. The two engines contribute roughly 944 KB of the 1.04 MB bundle. WASM initialization is deferred, but both libraries remain in the single shipped JavaScript bundle. Dynamic imports alone would not make their shipped bytes disappear under the three-file release contract.

The benchmark's installed-source checks still find ghostty's unconditional animation-frame loop and dirty-row rendering, versus xterm's demand-driven repaint and visibility pause. An unconditional callback is not a full repaint. Its frequency follows browser scheduling and display conditions, so “60 wakeups/s” is an illustrative 60 Hz case, not a measured constant on every device. Hidden suspension after 30 seconds limits active resources; it does not shrink already-grown shared WASM capacity.

Keep existing event filtering, RAF coalescing, snapshot bounds and explorer debounce. There is no new evidence here to justify list virtualization, extensive caches or a rewrite of the parser hot path. Full list rebuilding does discard DOM focus; if frequent meaningful events affect keyboard navigation, preserve the focused pane/action across refresh or update keyed rows. Prioritize that usability invariant over speculative CPU optimization.

For the next performance pass, measure actual visible/hidden terminals at representative grids, a controlled busy pane, renderer write latency, main-thread stalls, input-to-visible-output latency and memory after repeated hide/reveal cycles. Isolate plugin objects and WASM/canvas allocations; whole-app heap trends can include unrelated plugins. Resolve xterm's existing Unicode-width correctness issue #48 before treating it as a universally preferable default.

## Existing issue corrections

- [#54](https://github.com/nytafar/obsidian-herdr/issues/54#issuecomment-5558717824): keep the simple local/remote toggle, but specify terminal endpoint ownership and lifecycle prerequisites. Multiple remote entries remain deferred.
- [#43](https://github.com/nytafar/obsidian-herdr/issues/43#issuecomment-5558718210): shared tab-label cache needs rename invalidation, client/workspace identity and stale-response checks, not just shared fetching. Existing `tab.renamed` subscriptions are ignored by scope ingestion.
- [#47](https://github.com/nytafar/obsidian-herdr/issues/47#issuecomment-5558718610): `stopImmediatePropagation` cannot undo ancestor capture handlers that already ran. Preserve ordinary Ctrl/Alt terminal behavior and measure actual host dispatch. Shift+Tab remains the concrete reported failure; the latest #18 comments already confirm Shift+Enter works.
- [#53](https://github.com/nytafar/obsidian-herdr/issues/53#issuecomment-5558718994): rebuilding fixes the inert theme setter but also restarts the session. A palette change should not retake control from another controller or reconnect to a different profile. Include closed and suspended sessions in acceptance.
- [#32](https://github.com/nytafar/obsidian-herdr/issues/32#issuecomment-5558719303): summarized findings and dependencies without rewriting prior decisions.

No duplicate tickets were filed for #48 Unicode width, #49 IME, #50 theme mapping, #51 descender verification, #25 mouse or #33 local history. Their current distinctions matter: history cannot be created by raising a buffer budget when the protocol only repaints cells; application-mode signals are missing from the current session seam; mouse/scroll support should be rechecked when herdr changes, as the latest comment requests.

## Validation gaps and recommended order

The existing 463 tests give good confidence in helpers and transport units. They do not cover all actual view/plugin wiring: the agent-list test only guards module surface, and many terminal-view tests exercise exported helpers. Add orchestration tests with delayed fake discovery, clients, renderers and timers; test state after every completion order. Use targeted Obsidian smoke checks for actual DOM events, focus, rendering and composition. Run `npm test` in normal PR/push CI; currently it runs in release CI only.

Recommended order:

1. #57/#59 connection and resource ownership, plus the terminal identity contract in #54.
2. #58 workspace consistency; existing terminal correctness #53/#48/#49 and Shift+Tab in #47/#18.
3. Implement the #54 toggle under those invariants; #43 metadata sharing/invalidation; #61 pop-out checks.
4. #60 bounded framing extraction and settings-model separation; #62 before community release.
5. Continue feature plans and performance measurement on the stabilized boundaries.

The code-review skill's separate standards/behavior passes shaped this review: documented release and lifecycle requirements are distinguished from discretionary extraction suggestions. The Obsidian CLI skill supported read-only runtime inspection. No fixes were implemented as part of the review.

## Reproduction artifacts

Run from the repository root:

```sh
node docs/reviews/2026-09-06/lifecycle-repros.mjs
node docs/reviews/2026-09-06/scope-repros.mjs
node docs/reviews/2026-09-06/transport-repros.mjs
```

The lifecycle and transport scripts assert the observed defective behavior and exit successfully when reproduced; they are audit evidence, not regression tests asserting correct behavior. The scope script asserts desired invariants and currently exits 1 with three failures. Their assertions must be adapted when promoted into regression tests. All operate on fake/synthetic state and in-memory bundles. Copies of the posted issue/comment text are stored beside this report. ESLint excludes these standalone Node scripts from its TypeScript project service, matching the existing exclusion for build/benchmark scripts; that narrow lint-config change is the only existing repository file changed by this review. The pre-existing README and untracked user files were preserved. No files were committed.
