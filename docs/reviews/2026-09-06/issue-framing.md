Review of 1440d7d; robustness follow-up to #2/#8, adjacent to #14/#15.

Both splitters enforce their size cap only for an unfinished tail. The newline-completing path decodes/concatenates without checking the total record size:
- [API splitter](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/herdr/client.ts#L169)
- [terminal splitter](https://github.com/nytafar/obsidian-herdr/blob/1440d7d9c81dabd756b92c5e73856e74a474debb/src/bridge/terminalSession.ts#L124)

Confirmed on the terminal splitter with a 16-byte budget: a complete 100-byte line is accepted; a 15-byte buffered prefix plus a 100-byte completing chunk is accepted as 115 bytes. After overflow, feeding suffix\nok\n emits suffix as a new record instead of discarding the remainder of the oversized record.

Enforce pending-plus-tail size before decoding or concatenation. For a stream that continues after errors, discard through the next newline to recover framing. Share the bounded framing primitive, keeping API and bridge error handling separate.

Acceptance: exact-limit, one-over-limit, whole-chunk and split-chunk cases; multibyte UTF-8 byte accounting; valid record after oversized record; no rejected-record suffix emitted as a standalone message.

This is demonstrated parser hardening, not evidence of unbounded memory growth in the live plugin. Ordinary pipe chunking limits typical overshoot. Local diagnostic: `docs/reviews/2026-09-06/transport-repros.mjs` (not yet committed).
