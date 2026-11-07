/**
 * Images sent with a prompt (issue #144): what the prompt box accepts and how
 * each runtime's sender carries one to Claude.
 *
 * Measured 2026-11-06 on herdr 0.9.5, hc 0.1.18 and Claude Code 2.1.318
 * (`docs/architecture.md`, "Images in prompts"):
 *
 * - **A terminal Claude attaches an image when a bracketed paste is exactly
 *   paths to image files.** A paste of `ESC[200~/a/b.png ESC[201~` becomes
 *   `[Image #1]` in the input; several paths separated by a space become one
 *   image each, and a space inside a path is escaped with a backslash, as a
 *   terminal writes a dropped file. A path typed as text in a prompt is not
 *   an attachment (Claude reads it with its Read tool instead), and a paste
 *   that mixes a path with words stays text.
 * - The text that follows lands in the same input and the next Enter sends
 *   both as one prompt, whatever the agent's status: while it works, the
 *   prompt is queued with its image like any typed one.
 * - Claude reads the file when the paste lands, so it may go once the prompt
 *   is sent; herdr-core removes the files it put with their terminal.
 * - `claude -p` in stream-json takes image content blocks in the user message
 *   directly.
 *
 * Nothing here imports `obsidian`: the senders run in the runtime kinds.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimer } from '../timers';

/** One image the human attached, as the prompt box read it. */
export interface PromptImage {
	/** One of {@link PROMPT_IMAGE_TYPES}. */
	mediaType: string;
	/** The bytes, base64. */
	data: string;
	/** The file's own name, or one made up for a pasted screenshot; for display. */
	name: string;
}

/** The media types Claude takes as an image block. */
export const PROMPT_IMAGE_TYPES: readonly string[] = Object.freeze([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
]);

/**
 * The largest image the box takes: the size Claude's API takes per image.
 * A terminal Claude scales a larger one down itself, but the `claude` kind
 * hands the bytes over as they are, and one limit is easier to explain.
 */
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

/** How many images one prompt carries at most. */
export const MAX_PROMPT_IMAGES = 20;

/**
 * The images of a request's parameters, as a sender wrote them: anything that
 * is not one of the types Claude takes, or carries no data, is left out.
 */
export function promptImages(value: unknown): PromptImage[] {
	if (!Array.isArray(value)) return [];
	const images: PromptImage[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== 'object' || item === null) continue;
		const { mediaType, data, name } = item as Record<string, unknown>;
		if (typeof mediaType !== 'string' || !PROMPT_IMAGE_TYPES.includes(mediaType)) continue;
		if (typeof data !== 'string' || !data) continue;
		images.push({ mediaType, data, name: typeof name === 'string' ? name : '' });
	}
	return images;
}

/** The file extension a terminal Claude recognises for a media type. */
export function imageExtension(mediaType: string): string {
	switch (mediaType) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/gif':
			return 'gif';
		case 'image/webp':
			return 'webp';
		default:
			return 'png';
	}
}

/**
 * Why a file cannot go with a prompt, in words for a notice, or null when it
 * can. `type` and `size` are what a browser `File` says about itself.
 */
export function imageFileProblem(file: { type: string; size: number; name: string }): string | null {
	const name = file.name || 'the pasted image';
	if (!PROMPT_IMAGE_TYPES.includes(file.type)) {
		return `${name} is not a PNG, JPEG, GIF or WebP image`;
	}
	if (file.size > MAX_PROMPT_IMAGE_BYTES) return `${name} is larger than 5 MB`;
	return null;
}

/** A path as a terminal writes a dropped file: spaces escaped with a backslash. */
export function escapedPath(path: string): string {
	return path.replace(/ /g, '\\ ');
}

/**
 * The bracketed paste that makes a terminal Claude attach `paths` as images:
 * the paths alone, escaped, separated by a space. Anything else in the same
 * paste makes it text.
 */
export function imagePaste(paths: readonly string[]): string {
	return `\u001b[200~${paths.map(escapedPath).join(' ')}\u001b[201~`;
}

/**
 * Image files on the agent's machine, for a runtime whose Claude takes an
 * image as a pasted path (herdr). The `claude` kind needs none, and
 * herdr-core puts its files beside the terminal itself (`terminal.put`).
 */
export interface ImageFiles {
	/** Writes each image to a file of its own; resolves with their paths, in order. */
	write(images: readonly PromptImage[]): Promise<string[]>;
	/** The prompt they went with has been sent: the files may go. */
	release(paths: readonly string[]): void;
}

/** How long a written image stays after its prompt went, as a margin over Claude's read. */
export const IMAGE_FILE_GRACE_MS = 60_000;

/**
 * Image files in this machine's temporary folder, readable by this user only,
 * removed a minute after their prompt went: Claude read them when the paste
 * landed, and a screenshot should not outlive its prompt in `/tmp`.
 */
export function localImageFiles(dir: string = join(tmpdir(), 'gjetr-images')): ImageFiles {
	return {
		async write(images) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const paths: string[] = [];
			for (const image of images) {
				const path = join(dir, `image-${randomUUID()}.${imageExtension(image.mediaType)}`);
				await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 });
				paths.push(path);
			}
			return paths;
		},
		release(paths) {
			if (!paths.length) return;
			const timer = setTimer(() => {
				for (const path of paths) void unlink(path).catch(() => undefined);
			}, IMAGE_FILE_GRACE_MS);
			// Never what keeps a process alive (the unit tests run under node).
			(timer as { unref?: () => void }).unref?.();
		},
	};
}
