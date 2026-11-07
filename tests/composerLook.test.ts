/**
 * How the prompt box looks (#173): the two settings' values, the readout's
 * label in each form, and the gauge's arc.
 */

import { describe, expect, it } from 'vitest';
import {
	contextReadoutLabel,
	gaugeDash,
	normalizeContextReadoutStyle,
	normalizePromptBoxStyle,
	PROMPT_BOX_STYLE_CLASSES,
	promptBoxStyleClass,
} from '../src/native/composerLook';
import { contextReadout } from '../src/native/sessionSettings';

describe('composer look: the settings', () => {
	it('reads the three box styles, and anything else as divided', () => {
		expect(normalizePromptBoxStyle('divided')).toBe('divided');
		expect(normalizePromptBoxStyle('joined')).toBe('joined');
		expect(normalizePromptBoxStyle('floating')).toBe('floating');
		expect(normalizePromptBoxStyle('round')).toBe('divided');
		expect(normalizePromptBoxStyle(undefined)).toBe('divided');
	});

	it('reads the two readouts, and anything else as detail', () => {
		expect(normalizeContextReadoutStyle('detail')).toBe('detail');
		expect(normalizeContextReadoutStyle('gauge')).toBe('gauge');
		expect(normalizeContextReadoutStyle(3)).toBe('detail');
	});

	it('gives every box style its own class', () => {
		expect(promptBoxStyleClass('floating')).toBe('herdr-prompt-style-floating');
		expect(new Set(PROMPT_BOX_STYLE_CLASSES).size).toBe(3);
	});
});

describe('composer look: the readout', () => {
	const known = contextReadout({ contextUsed: 46_000, contextWindow: { tokens: 200_000, source: 'context-command' } });
	const bare = contextReadout({ contextUsed: 46_000 });

	it('labels the detail form with the exact count', () => {
		expect(contextReadoutLabel(known, 'detail')).toBe(known.title);
	});

	it('leads the gauge’s label with the counts it does not show', () => {
		expect(contextReadoutLabel(known, 'gauge')).toBe(`46k / 200k · 23%. ${known.title}`);
	});

	it('labels a gauge with no window as the detail form, which it falls back to', () => {
		expect(contextReadoutLabel(bare, 'gauge')).toBe(bare.title);
	});

	it('draws the share as the arc over a 100-long circle, clamped', () => {
		expect(known.share).toBeCloseTo(0.23);
		expect(gaugeDash(known.share)).toBe('23 100');
		expect(gaugeDash(null)).toBe('0 100');
		expect(gaugeDash(1.4)).toBe('100 100');
		expect(gaugeDash(-1)).toBe('0 100');
		expect(gaugeDash(0.12345)).toBe('12.3 100');
	});
});
