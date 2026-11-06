# Claude Code 2.1.318 dialogs, as the screen reads show them

Recorded 2026-11-06 for issue #151 from throwaway `oh-test-*` panes running
`claude --permission-mode default --model haiku` in a `/tmp` folder (the trust
prompt in a `/var/tmp` one). Measurements and key sequences: the docs root,
`findings/answering-on-screen.md`; the facts the code may rely on:
`docs/architecture.md`, "Answering Claude's dialogs from the screen".

- `herdr-*.txt` is herdr 0.9.5 `pane.read {source: visible, format: text}` of a
  pane 233 columns wide; `herdr-*.ansi` is the same read with
  `format: ansi`. Exactly as returned: trailing spaces trimmed, empty rows
  kept.
- `hc-*.txt` is hc 0.1.18 `terminal.read {lines: 0}` `.text` of a headless
  terminal at 200x120: no history, trailing blank rows dropped.

Scrubbed: the account's plan name in the banner (`Claude Pro`) and the
editor named on the `ctrl+g` hint (`nvim`). Nothing else was changed.

| File | Dialog | State when read |
| --- | --- | --- |
| `*-ask-single` | one `AskUserQuestion`, single choice | as opened, cursor on 1 |
| `herdr-ask-multi`, `hc-ask-multi-ticked` | one question, `multiSelect` | as opened; hc with 1 and 3 ticked |
| `*-ask-multi-other` | multi-select | 1 ticked, text typed on the "Type something" row (ticks it) |
| `herdr-ask-multi-after-submit-row`, `*-ask-multi-review` | multi-select | after `down enter` on the Submit row: the review |
| `herdr-ask-other-row`, `herdr-ask-other-typed` | single choice | cursor on "Type something.", then with text typed |
| `herdr-ask-two`, `herdr-ask-two-review` | two questions in one call | first tab; review after both answered |
| `*-bash-permission` | Bash `touch one.txt` | as opened |
| `herdr-bash-permission-session` | Bash `python3 -c …` | as opened: option 2 is "don't ask again for: python3 *" |
| `*-bash-deny-feedback` | Bash | `tab` on "No", feedback typed |
| `herdr-write-permission` | Write `b.txt` | as opened |
| `*-plan` | `ExitPlanMode` | as opened |
| `herdr-plan-feedback` | `ExitPlanMode` | feedback typed on row 3 |
| `hc-plan-after-approve-feedback` | after `shift+tab` with feedback | plan approved, session now in auto mode |
| `*-trust` | workspace trust at startup | as opened, cursor on "No, exit" |
