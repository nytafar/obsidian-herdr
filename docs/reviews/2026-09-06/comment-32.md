Architecture/performance review completed at 1440d7d (2026-09-06). Existing 463 tests pass; tsc passes; lint has 19 warnings, no errors. Live snapshot: four scoped agents, one visible control terminal, no captured errors. Detailed report and reproducible diagnostics saved locally in docs/reviews/2026-09-06/; not committed yet.

New findings: #57 connection lifecycle races; #58 inconsistent workspace membership; #59 SSH cancellation/socket ownership; #60 framing bounds; #61 pop-out event targets; #62 release tag contract.

Suggested dependency adjustment: handle #57 and #59 and the terminal-identity acceptance added to #54 before shipping the local/remote toggle. This preserves the decision to defer multiple server entries. Then #58 scope correctness; retain terminal correctness work #53/#48/#49 and the now-confirmed Shift+Tab case in #47/#18. #43 should centralize tab-label invalidation. #62 is required before community release.

Architecture is worth keeping: API versus bridge separation, injected action host, pure row/notification decisions, renderer adapters, filtered events. Focus refactoring on connection ownership, settings model versus settings UI, shared NDJSON framing and shared theme/font policies. Run the existing tests on PR/push CI, not only release.

Fresh headless benchmark: ghostty 36.4 MB parsed in 491 ms vs xterm 904 ms; ghostty WASM growth retained after free 14.29 MB vs xterm heap+external residual 0.47 MB. This measures a synthetic scrollback workload, not live repaint latency or a leak slope. Existing #33/#25 protocol constraints remain; increasing scrollback budget cannot manufacture missing history.
