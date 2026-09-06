/**
 * Where a terminal view opens (PRD M13, issue #28).
 *
 * When the note you are looking at lives inside the agent's working directory,
 * the terminal belongs next to it, not in a tab of its own. Everything that
 * decides that is here and pure: `openTerminal` only turns the answer into a
 * `createLeafBySplit` or a `getLeaf('tab')` call. {@link decideOpenTarget} sits
 * one step earlier (issue #38): whether a leaf is placed at all, or an open
 * terminal is switched to this pane.
 *
 * The comparison is done on herdr's side of the world: `vaultPath` is whatever
 * `herdrVaultPath()` returns (the remote vault path under a remote profile), so
 * it lines up with the pane's cwd, which is a path on the machine herdr runs on.
 */

import { normalizePosixPath } from './actions';
import { trimTrailingSlashes } from './paths';
import { isUnder } from './herdr/scope';
import type { TerminalPlacement, TerminalTabMode } from './settings';

export interface PlacementInput {
	/** The `terminalPlacement` setting. */
	placement: TerminalPlacement;
	/** `PaneState.cwd` of the agent pane, as herdr reports it. */
	paneCwd: string;
	/** Vault-relative path of the active note, or null when none is open. */
	activeFilePath: string | null;
	/** Vault path as herdr sees it (`herdrVaultPath()`). Empty when unknown. */
	vaultPath: string;
}

/** A tab, or a split beside the note; `before` puts the terminal on the left. */
export type PlacementDecision = { kind: 'tab' } | { kind: 'split'; before: boolean };

const TAB: PlacementDecision = { kind: 'tab' };

/**
 * Splits beside the note only when the setting asks for it, a note is open, and
 * that note sits inside the agent's working directory. A cwd equal to the vault
 * root contains every note, so it always splits; a cwd outside the vault
 * contains none, so it never does. Anything unknown (no vault path, no cwd)
 * falls back to a plain tab, which is the behaviour this feature replaces.
 */
export function decidePlacement(input: PlacementInput): PlacementDecision {
	if (input.placement === 'tab') return TAB;

	const relative = input.activeFilePath?.trim() ?? '';
	const cwd = input.paneCwd.trim();
	const vault = input.vaultPath.trim();
	if (!relative || !cwd || !vault) return TAB;

	const notePath = normalizePosixPath(`${trimTrailingSlashes(vault)}/${relative}`);
	if (!isUnder(notePath, cwd)) return TAB;

	return { kind: 'split', before: input.placement === 'split-left' };
}

export interface OpenTargetInput {
	/** The `terminalTab` setting. */
	mode: TerminalTabMode;
	/** A terminal view for this very pane is already open. */
	hasPaneLeaf: boolean;
	/** Some terminal view is open, whichever pane it shows. */
	hasAnyLeaf: boolean;
}

/**
 * Which leaf `openTerminal` should end up in (issue #38).
 *
 * `existing` is this pane's own terminal, `switch` is another pane's terminal
 * that takes this pane over, `new` is a leaf that still has to be placed.
 */
export type OpenTarget = 'existing' | 'switch' | 'new';

/**
 * Where an open request lands, given the tab mode and what is already open.
 *
 * This pane's own terminal always wins, in both modes: reusing it is what keeps
 * a second open from spawning a second bridge, and switching a leaf to the pane
 * it already shows would restart that bridge for nothing. Only `reuse` with
 * some *other* terminal open takes a leaf over; everything else is placed by
 * {@link decidePlacement}, exactly as before this setting existed.
 */
export function decideOpenTarget(input: OpenTargetInput): OpenTarget {
	if (input.hasPaneLeaf) return 'existing';
	if (input.mode === 'reuse' && input.hasAnyLeaf) return 'switch';
	return 'new';
}
