/**
 * How the prompt box looks (#173): its style and how its context readout
 * reads. Two settings, applied live to every open native view.
 *
 * Both are CSS classes only. The box is one structure in every style — the
 * text area, then a toolbar strip with the session bar's pickers, the context
 * readout, Stop and Send — and the readout carries both its forms, so a
 * change of setting swaps a class and draws nothing again.
 *
 * - **Divided** (default): the strip has its own background and a rule above it.
 * - **Joined**: one surface; the strip is the box's last row.
 * - **Floating**: raised over the transcript with the theme's shadow and a
 *   fade above it; Send and Stop are icon buttons with the theme's own
 *   button radius (Lasse, 2026-11-07: not round, as the mockup had them).
 *
 * The readout is **Detail** (`46k / 200k · 23%`, default) or **Gauge** (a
 * small ring with the percentage, the token count in the tooltip). With no
 * known window the gauge falls back to the token count.
 */

import type { ContextReadout } from './sessionSettings';

export type PromptBoxStyle = 'divided' | 'joined' | 'floating';
export type ContextReadoutStyle = 'detail' | 'gauge';

export const PROMPT_BOX_STYLES: readonly PromptBoxStyle[] = ['divided', 'joined', 'floating'];
export const CONTEXT_READOUT_STYLES: readonly ContextReadoutStyle[] = ['detail', 'gauge'];

/** What the settings dropdowns show, sentence case. */
export const PROMPT_BOX_STYLE_LABELS: Readonly<Record<PromptBoxStyle, string>> = {
	divided: 'Divided',
	joined: 'Joined',
	floating: 'Floating',
};

export const CONTEXT_READOUT_STYLE_LABELS: Readonly<Record<ContextReadoutStyle, string>> = {
	detail: 'Detail',
	gauge: 'Gauge',
};

export const DEFAULT_PROMPT_BOX_STYLE: PromptBoxStyle = 'divided';
export const DEFAULT_CONTEXT_READOUT_STYLE: ContextReadoutStyle = 'detail';

/** A stored or hand-edited value read as a box style; anything else is the default. */
export function normalizePromptBoxStyle(value: unknown): PromptBoxStyle {
	return PROMPT_BOX_STYLES.find((style) => style === value) ?? DEFAULT_PROMPT_BOX_STYLE;
}

/** A stored or hand-edited value read as a readout style; anything else is the default. */
export function normalizeContextReadoutStyle(value: unknown): ContextReadoutStyle {
	return CONTEXT_READOUT_STYLES.find((style) => style === value) ?? DEFAULT_CONTEXT_READOUT_STYLE;
}

/** The class a box style puts on the prompt box. */
export function promptBoxStyleClass(style: PromptBoxStyle): string {
	return `herdr-prompt-style-${style}`;
}

/** Every box style's class, so a change takes the old one off. */
export const PROMPT_BOX_STYLE_CLASSES: readonly string[] = PROMPT_BOX_STYLES.map(promptBoxStyleClass);

/** The class the gauge puts on the readout. */
export const GAUGE_CLASS = 'herdr-is-gauge';

/** What the two settings come to, as the surface reads them per draw. */
export interface ComposerLook {
	boxStyle: PromptBoxStyle;
	readout: ContextReadoutStyle;
}

/**
 * The readout's label, which is also its hover tooltip. The detail form shows
 * the numbers already, so its label is the exact count; the gauge shows only
 * the percentage, so its label leads with the `46k / 200k · 23%` the detail
 * form would have shown. Without a window the gauge shows the token count and
 * the label is the detail one.
 */
export function contextReadoutLabel(readout: ContextReadout, style: ContextReadoutStyle): string {
	if (style === 'gauge' && readout.percent !== '') {
		return `${readout.tokens} · ${readout.percent}. ${readout.title}`;
	}
	return readout.title;
}

/**
 * The ring's arc as an SVG `stroke-dasharray` over a circle whose
 * `pathLength` is 100: the share of the window used, clamped to the ring.
 * An attribute, not a style, so no inline style is ever written.
 */
export function gaugeDash(share: number | null): string {
	const filled = share === null || !Number.isFinite(share) ? 0 : Math.min(100, Math.max(0, share * 100));
	return `${Math.round(filled * 10) / 10} 100`;
}
