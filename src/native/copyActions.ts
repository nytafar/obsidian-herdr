/**
 * Copying out of the native view (#140): a prompt as typed, and a turn's reply
 * as Markdown or as plain text, because pasting what the agent said into a
 * note is the vault's own workflow.
 *
 * The text copied is the transcript's, never the DOM's: the reply is the
 * turn's prose entries as the agent wrote them, so a link, a callout or a
 * code fence comes out as source Markdown and nothing the renderer added —
 * a copy button on a code block, a heading anchor — leaks into it. Tool
 * rows, thoughts and subagent reports are not the reply and are left out.
 *
 * Code-block copy is Obsidian's: `MarkdownRenderer.render` runs the core
 * post-processor that adds `.copy-code-button` to every `pre > code`, and the
 * view root carries `markdown-rendered`, the ancestor its CSS keys on (#109).
 */

import { Component, Notice, setIcon, setTooltip } from 'obsidian';
import type { Turn } from './reducer';

/** How long a button shows that it copied, or that it could not. */
export const COPY_FEEDBACK_MS = 1500;

/** What the reader is told when the clipboard refused. */
export const COPY_FAILED_MESSAGE = "Couldn't copy. Select the text and copy it manually.";

/** Where copied text goes and how a failure is told. */
export interface Copier {
	write: (text: string) => Promise<void>;
	notify: (message: string) => void;
}

/** The system clipboard and an Obsidian notice. */
export const defaultCopier: Copier = {
	write: (text) => navigator.clipboard.writeText(text),
	notify: (message) => {
		new Notice(message);
	},
};

/**
 * The reply of a turn as Markdown: its prose blocks in order, a blank line
 * between them, and nothing else. Empty when the agent has said nothing yet.
 */
export function replyMarkdown(turn: Turn): string {
	const blocks: string[] = [];
	for (const entry of turn.entries) {
		if (entry.kind !== 'text') continue;
		const text = entry.text.trim();
		if (text) blocks.push(text);
	}
	return blocks.join('\n\n');
}

/** A code fence's opening or closing line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A table's delimiter row, `| --- | :-: |`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A thematic break: three or more of one of `-`, `*`, `_`. */
const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;

/**
 * Markdown as plain text: what a reader sees, without the marks that make it
 * Markdown. Code keeps its content exactly; headings, quotes, emphasis, links
 * and wikilinks lose their syntax and keep their words; a list item keeps a
 * bullet; a table becomes tab-separated rows.
 */
export function plainText(markdown: string): string {
	const out: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split('\n')) {
		const fenceMatch = FENCE.exec(line);
		if (fence !== null) {
			if (fenceMatch && fenceMatch[1]?.[0] === fence[0] && (fenceMatch[1]?.length ?? 0) >= fence.length) {
				fence = null;
			} else {
				out.push(line);
			}
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1] ?? '```';
			continue;
		}
		// A table's delimiter row is syntax only, and goes with its line.
		if (TABLE_DELIMITER.test(line) && line.includes('-') && line.includes('|')) continue;
		out.push(plainLine(line));
	}
	return out
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** One line outside a code block. */
function plainLine(raw: string): string {
	if (THEMATIC_BREAK.test(raw)) return '';
	let line = raw;
	// Quotes, nested or not, and a callout's `[!kind]` with them.
	let quoted = false;
	while (/^ {0,3}> ?/.test(line)) {
		line = line.replace(/^ {0,3}> ?/, '');
		quoted = true;
	}
	if (quoted) line = line.replace(/^\[!\w+\][+-]? ?/, '');
	const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
	if (heading) return plainInline(heading[1] ?? '');
	const indent = /^\s*/.exec(line)?.[0] ?? '';
	const bullet = /^\s*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line);
	if (bullet) return `${indent}• ${plainInline(line.slice(bullet[0].length))}`;
	if (/^\s*\|.*\|\s*$/.test(line)) {
		return line
			.trim()
			.replace(/^\||\|$/g, '')
			.split('|')
			.map((cell) => plainInline(cell.trim()))
			.join('\t');
	}
	return plainInline(line);
}

/**
 * The inline marks of one line. Code spans are taken out first, so what is
 * inside one stays exactly as written.
 */
function plainInline(text: string): string {
	const parts = text.split(/(`+)([^`]|[^`].*?[^`])\1(?!`)/);
	let result = '';
	// `split` with two groups: text, fence, code, text, fence, code, …
	for (let at = 0; at < parts.length; at += 3) {
		result += plainMarks(parts[at] ?? '');
		const code = parts[at + 2];
		if (code !== undefined) result += code.trim() || code;
	}
	return result;
}

/** Emphasis, links, wikilinks, embeds and escapes, outside code spans. */
function plainMarks(text: string): string {
	return text
		.replace(/!?\[\[([^[\]|]+)\|([^[\]]*)\]\]/g, '$2')
		.replace(/!?\[\[([^[\]]+)\]\]/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<((?:https?|obsidian|mailto):[^>\s]+)>/g, '$1')
		.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
		.replace(/(~~|==)(?=\S)(.+?)(?<=\S)\1/g, '$2')
		.replace(/(^|[^*\w])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '$1$2')
		.replace(/(^|[^_\w])_(?=\S)(.+?)(?<=\S)_(?![_\w])/g, '$1$2')
		.replace(/\\([\\`*_{}[\]()#+\-.!|~=<>])/g, '$1');
}

/** One copy button. */
export interface CopyButtonSpec {
	/** Its class, beside the shared `herdr-native-copy`. */
	cls: string;
	/** A Lucide icon name. */
	icon: string;
	/** What it does, in sentence case: its tooltip and its accessible name. */
	label: string;
	/** The text to copy, read at the click, so a growing reply copies whole. */
	text: () => string;
}

/**
 * A button that copies, with its listener and its feedback timer on
 * `component`, so both go when the item it belongs to is drawn again.
 *
 * It shows a check for a moment once the text is on the clipboard; when the
 * clipboard refuses, a cross, and a notice that says what to do instead.
 */
export function copyButton(
	parent: HTMLElement,
	component: Component,
	spec: CopyButtonSpec,
	copier: Copier,
): HTMLElement {
	const button = parent.createEl('button', {
		cls: ['herdr-native-copy', 'clickable-icon', spec.cls],
		attr: { type: 'button' },
	});
	let timer: number | null = null;
	const show = (icon: string, label: string): void => {
		setIcon(button, icon);
		setTooltip(button, label);
		button.setAttr('aria-label', label);
	};
	const settle = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		button.removeClass('is-copied', 'is-failed');
		show(spec.icon, spec.label);
	};
	const flash = (cls: 'is-copied' | 'is-failed', icon: string, label: string): void => {
		settle();
		button.addClass(cls);
		show(icon, label);
		timer = window.setTimeout(settle, COPY_FEEDBACK_MS);
	};
	show(spec.icon, spec.label);
	// A copy that lands after the item was drawn again has no button to flash.
	let live = true;
	component.register(() => {
		live = false;
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	});
	component.registerDomEvent(button, 'click', () => {
		void copyText(spec.text(), copier).then((ok) => {
			if (!live) return;
			if (ok) flash('is-copied', 'check', 'Copied');
			else flash('is-failed', 'x', "Couldn't copy");
		});
	});
	return button;
}

/** The text on the clipboard, or false and the reader told why not. */
async function copyText(text: string, copier: Copier): Promise<boolean> {
	try {
		await copier.write(text);
		return true;
	} catch {
		copier.notify(COPY_FAILED_MESSAGE);
		return false;
	}
}

/**
 * The reply's actions, under the turn: copy as Markdown and copy as plain
 * text. `markdown` is read at the click.
 */
export function renderReplyActions(
	parent: HTMLElement,
	component: Component,
	markdown: () => string,
	copier: Copier,
): HTMLElement {
	const el = parent.createDiv({ cls: 'herdr-native-reply-actions' });
	copyButton(
		el,
		component,
		{ cls: 'herdr-native-copy-markdown', icon: 'copy', label: 'Copy as Markdown', text: markdown },
		copier,
	);
	copyButton(
		el,
		component,
		{
			cls: 'herdr-native-copy-plain',
			icon: 'remove-formatting',
			label: 'Copy as plain text',
			text: () => plainText(markdown()),
		},
		copier,
	);
	return el;
}
