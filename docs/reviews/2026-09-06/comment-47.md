Review correction: stopImmediatePropagation cannot prevent an ancestor capture listener that already ran. The issue's proposed wording suggests it can. Establish Obsidian's actual dispatch phase and handling of defaultPrevented before deciding where interception belongs.

Also, swallowing every otherwise-unbound Ctrl/Alt combination would break ordinary terminal use (especially Linux Ctrl shortcuts and Alt/Meta shell navigation). Preserve the renderer's terminal encodings by default; suppress host commands only under a defined focused-terminal policy, with explicit escape hatches.

Retain Shift+Tab CSI Z as a concrete acceptance case from Lasse's latest #18 check. Test composition, Ctrl+C, Alt word navigation, command-palette escape, and keydown/keyup duplication. Router unit tests validate policy, but a real Obsidian DOM smoke test is still needed to validate propagation. This review did not inject keys into the user's running agent.
