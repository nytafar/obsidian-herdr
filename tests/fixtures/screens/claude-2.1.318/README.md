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

## Narrow screens (issue #163)

Recorded 2026-11-06 for the screen dialog parser
(`src/agents/claude/screenDialog.ts`, `tests/screenDialog.test.ts`), with
long questions, labels, typed answers, commands and file names so that every
part of every dialog wraps:

- `herdr-60-*`, `herdr-90-*`: herdr 0.9.5 `pane.read {source: visible,
  format: text}` of one pane held at 60x40, then 90x45, by a `herdr terminal
  session control --cols --rows` client; one Claude session for both, so the
  90-column screens name the `…-herdr60` folder and repeat its plan slug.
  `*-trust` from a second pane in `/var/tmp/oh-test-trust-narrow-herdr`,
  resized from 60 to 90.
- `hc-60-*`, `hc-90-*`: hc 0.1.18 `terminal.read {lines: 0}` `.text` of
  terminals started at 60x40 and 90x45 (`terminal.run {size}`); text typed
  key by key over `terminal.keys` (`shift+x` for capitals). `hc-60-trust`
  sits in a folder with a long name, so the path wraps mid-word.

Scrubbed as above, plus the home directory in the shell line over
`herdr-*-trust` (`/home/user`). Replacing the editor's name shortens hint
lines without re-wrapping them.

| File (`<runtime>-<cols>-…`) | State when read |
| --- | --- |
| `ask-single`, `ask-other-typed` | single choice as opened; cursor on the own-answer row with a long answer typed |
| `ask-multi`, `-ticked`, `-other` | multi-select as opened; 1 and 3 ticked; a long own answer typed (ticks row 4) |
| `ask-multi-submit-row` | cursor moved down to `Submit` |
| `ask-multi-submit-row-torn` | the same on `herdr-90` and `hc-60`: Claude repainted the row as `❯    Submit<end of the typed answer>` and dropped the answer's last line. Must read as no dialog |
| `ask-multi-review` | the review after `enter` on `Submit` |
| `ask-two`, `-second`, `-review` | two questions: first tab, second tab after `2`, review after `1` |
| `bash-permission`, `-deny-amend`, `-deny-feedback` | a long `touch`; `tab` on "No" (placeholder); feedback typed |
| `write-permission`, `edit-permission` | Write, then (after allowing it) Edit, of a long file name |
| `plan`, `plan-feedback` | plan approval; long feedback typed on row 3 |
| `trust` | workspace trust as opened |

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

## After an approved plan (issue #165)

Recorded 2026-11-06 during the answer driver's live run, from `oh-test-ans*`
panes in `/tmp` (herdr 0.9.5 `pane.read`, 233 columns; hc 0.1.18
`terminal.read`, 200x120), after the driver approved a plan with manual edits.
Scrubbed as above.

| File | Dialog | State when read |
| --- | --- | --- |
| `*-write-after-plan` | Write `d.txt`, the plan's step | as opened; under its hint a titled rule, `──── create-d-txt-file ─` (herdr) and `──── create-d-txt-plan ─` (hc), is the screen's last line |

## The settings pickers and footers (issues #169, #170)

Recorded 2026-11-06 by `npm run record-screens -- --only settings` from
`oh-test-settings-*` sessions (`settingsSteps` in
`scripts/record-screens/scenario.ts`): herdr 0.9.5 at 233x62 and 60x40, hc
0.1.18 at 200x120 and 60x40, `claude --permission-mode default --model
haiku`. Nothing was chosen in a picker: they were left with `esc`, and `s`
was pressed once, after a reply, to bring up the confirm. Scrubbed as above.
The line between the prompt's lower rule and the footer is the recording
account's own statusline. Read by `parseClaudeSettingsScreen`
(`tests/settingsScreen.test.ts`); `parseClaudeScreen` reads every one as no
dialog.

| File (`<runtime>-[60-]…`) | State when read |
| --- | --- |
| `footer-manual` | the prompt at start, `⏸ manual mode on · ← for agents` |
| `model-picker` | `/model` as opened, cursor on Haiku 5.5 ✔ (row 5) |
| `model-picker-scrolled` | wide only: `down` ×6, cursor on row 11, `↑ 2.` on top |
| `effort-picker`, `-right` | `/effort` as opened (`▲` over medium); after `right` (high) |
| `switch-model` | after a reply, `/model`, `up`, `s`: "Switch model?" to Sonnet 5.5 |
| `model-picker-back` | `esc` on the confirm: the picker again, cursor on the current model |
| `footer-accept-edits`, `-plan`, `-auto` | `shift+tab` once, twice, three times |

### Added with the safety review of #169 and #170

Recorded 2026-11-06 by hand from the `oh-test-fix169-herdr` herdr tab (233
columns, `pane.read {source: visible}`) on another account, scrubbed as
above (`Claude Team` → `Claude Pro`), except
`hc-model-picker-scrolled-end`, read by the review from the
`oh-test-settings-hc` terminal. The scenario has a step for each.

| File | State when read |
| --- | --- |
| `hc-model-picker-scrolled-end` | wide only: `down` ×8, cursor on the last row (13), `↑ 4.` on top, nothing below |
| `herdr-model-picker-no-effort` | `down` once, cursor on Haiku 4.5: `○ Effort not supported for Haiku 4.5` |
| `herdr-prompt-placeholder.ansi` | `format: ansi`: the empty input with Claude's dim suggestion `Try "edit <filepath> to..."` |
| `herdr-prompt-draft.ansi` | the same words typed: plain. The text reads of the two are identical |

The scenario types `Try "edit <filepath> to..."` for the draft; a session
that suggests other words records a draft that is not a look-alike, and
`tests/settingsScreen.test.ts` then needs the words of the new suggestion.

## Re-recording for a new Claude (issue #168)

`npm run record-screens` re-records this set for the Claude Code on the PATH
(its own binary, never a mise shim) into `../claude-<version>/` and prints
how each screen differs from the newest set before it, the dialog under its
rule by default (`-- --full` for whole screens, `-- --help` for the rest).
It runs the prompts and keys above in `oh-test-*` herdr tabs and hc
terminals, in the folders these screens name, and removes every tab,
terminal and folder, and what its Claude sessions wrote under `~/.claude`,
when it ends, also on failure or Ctrl+C. It will not start while one of
those folders exists, or while Claude already trusts a trust screen's
folder; `-- --dry-run` checks both and runs nothing. The scenario is
`scripts/record-screens/scenario.ts`. Two differences from the recordings
here: the wide trust screens come from `/var/tmp/oh-test-trust-wide-*`,
because Claude trusts the folders above for good; and every text on hc is
typed through the plugin's own screen access, which goes key by key over
`terminal.keys` whenever the text allows (all the scenario's texts do), so
the 60- and 90-column terminals keep their size (#172).
