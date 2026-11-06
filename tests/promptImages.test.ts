/**
 * Images in prompts (issue #144): what the transcript says about them, how
 * the view reads their bytes only when it shows them, and how each runtime's
 * sender carries one to Claude.
 *
 * `tests/fixtures/transcripts/prompt-images.jsonl` is cut from a live herdr
 * session on Claude Code 2.1.318 (2026-11-06) and scrubbed of everything but
 * prompts, steers and replies: images pasted as paths with
 * `pane.send_text`, one queued while Claude worked, two in one prompt, and
 * the `[Image #N]` stand-ins and `[Image: source: …]` notes Claude wrote with
 * them. The senders' facts are in `docs/architecture.md`, "Images in prompts".
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyTranscript, reduce, transcriptImage } from '../src/agents/claude/transcript';
import type { ImageEntry } from '../src/native/conversation';
import {
	escapedPath,
	imageFileProblem,
	imagePaste,
	localImageFiles,
	MAX_PROMPT_IMAGE_BYTES,
	promptImages,
	type ImageFiles,
	type PromptImage,
} from '../src/native/promptImages';
import {
	clientPromptSender,
	IMAGES_UNSUPPORTED,
	imagesUnavailable,
	type PromptSender,
} from '../src/native/promptSender';
import { hcImagesUnavailable, hcPromptSender } from '../src/hc/actions';
import { userMessage } from '../src/claude/protocol';
import { SessionModel, type PaneSnapshot, type SessionWatcher } from '../src/native/sessionModel';
import type { TranscriptLines, TranscriptSource, TranscriptStream } from '../src/native/transcriptSource';
import { hostEl } from './fixtures/dom';
import { PromptBox, pastedImages, type ImageFile } from '../src/native/promptBox';
import { TurnRenderer, type ShownImage } from '../src/native/turnRenderer';
import { HcClient } from '../src/hc/client';
import { FrameKind } from '../src/hc/frames';
import { fakeSpawner, HELLO_RESULT, type FakeCore } from './fixtures/fakeHc';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'transcripts', 'prompt-images.jsonl'), 'utf8');
const LINES = FIXTURE.split('\n').filter(Boolean);

/** A one-pixel PNG, base64, as a pasted screenshot's bytes stand in. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const IMAGE: PromptImage = { mediaType: 'image/png', data: PIXEL, name: 'shot.png' };

function images(): ImageEntry[] {
	return reduce(emptyTranscript(), LINES).state.turns.flatMap((turn) =>
		turn.entries.filter((entry): entry is ImageEntry => entry.kind === 'image'),
	);
}

describe('images in the transcript (#144)', () => {
	it('reads the prompt the human typed, without the stand-ins Claude wrote for the pictures', () => {
		const { turns } = reduce(emptyTranscript(), LINES).state;

		expect(turns.map((turn) => turn.prompt)).toEqual([
			'Reply with one word, the colour of this image: /tmp/oh-test-img/red.png',
			'One word: what colour is it?',
			'Run the shell command: sleep 10 ; then reply done.',
			'Also: colour of this image, one word.',
			"Run this in the foreground, not background: python3 -c 'import time; time.sleep(12)' then reply ok.",
			'Two words: the colours, in order.',
			'One word: colour?',
		]);
		expect(JSON.stringify(turns)).not.toContain('[Image');
	});

	it('says where each image is — its record and its place among the record’s images — never what it is', () => {
		const { turns } = reduce(emptyTranscript(), LINES).state;
		const two = turns[5];

		expect(two?.entries.slice(0, 2)).toEqual([
			{ kind: 'image', id: `${two?.id}#0`, record: two?.id, index: 0, mediaType: 'image/png' },
			{ kind: 'image', id: `${two?.id}#1`, record: two?.id, index: 1, mediaType: 'image/png' },
		]);
		for (const entry of images()) expect(Object.keys(entry).sort()).toEqual(['id', 'index', 'kind', 'mediaType', 'record']);
	});

	it('shows a steer’s image after the steer, in the turn it entered', () => {
		const steered = reduce(emptyTranscript(), LINES).state.turns[4];
		const kinds = steered?.entries.map((entry) => entry.kind);

		const steer = steered?.entries.find((entry) => entry.kind === 'steer');
		expect(steer).toEqual({ kind: 'steer', text: 'Queued: colour of this one, one word.' });
		expect(kinds?.slice(kinds.indexOf('steer'), kinds.indexOf('steer') + 2)).toEqual(['steer', 'image']);
		const image = steered?.entries[kinds?.indexOf('image') ?? -1] as ImageEntry;
		// The attachment's own record carries the bytes.
		expect(image.record).not.toBe(steered?.id);
		expect(transcriptImage(FIXTURE, image.record, image.index)?.mediaType).toBe('image/png');
	});

	it('spends the steer’s enqueue, so a later prompt of the same words still opens a turn', () => {
		const enqueue = LINES.find((line) => line.includes('"operation":"enqueue"')) as string;
		const content = (JSON.parse(enqueue) as { content: string }).content;
		const again = JSON.stringify({
			type: 'user',
			uuid: 'again',
			message: { role: 'user', content },
		});

		const { state } = reduce(emptyTranscript(), [...LINES, again]);

		expect(state.pendingQueue).toEqual([]);
		expect(state.turns.at(-1)?.prompt).toBe(content);
	});

	it('finds every image’s bytes in the file by its record, and nothing for a record that has none', () => {
		const found = images().map((image) => transcriptImage(FIXTURE, image.record, image.index));

		expect(found).toHaveLength(6);
		for (const bytes of found) {
			expect(bytes?.mediaType).toBe('image/png');
			expect(Buffer.from(bytes?.data ?? '', 'base64').subarray(1, 4).toString()).toBe('PNG');
		}
		const first = images()[0] as ImageEntry;
		expect(transcriptImage(FIXTURE, first.record, 5)).toBeNull();
		expect(transcriptImage(FIXTURE, 'no-such-record', 0)).toBeNull();
		expect(transcriptImage(FIXTURE, '', 0)).toBeNull();
	});

	it('reads past the next record, which names the same uuid as its parent', () => {
		const first = images()[0] as ImageEntry;
		const child = LINES.find((line) => line.includes(`"parentUuid":"${first.record}"`));
		expect(child).toBeDefined();
		// The child comes first in a file written out of order: still the right line.
		const shuffled = [child, ...LINES.filter((line) => line !== child)].join('\n');

		expect(transcriptImage(shuffled, first.record, 0)).toEqual(transcriptImage(FIXTURE, first.record, 0));
	});
});

/** A source over one file, counting its reads. */
class OneFile implements TranscriptSource {
	reads = 0;
	constructor(
		private readonly path: string,
		private readonly text: string,
	) {}
	async read(path: string): Promise<string | null> {
		this.reads++;
		return path === this.path ? this.text : null;
	}
	open(path: string, onLines: TranscriptLines): TranscriptStream {
		if (path === this.path) onLines(this.text.split('\n').filter(Boolean));
		return { close: () => {} };
	}
}

function watcherOf(pane: PaneSnapshot): SessionWatcher {
	return {
		snapshot: (paneId) => (paneId === pane.paneId ? pane : null),
		onSession: () => () => {},
		onStatus: () => () => {},
		onMembership: () => () => {},
	};
}

describe('the session model reads an image when it is shown (#144)', () => {
	const pane: PaneSnapshot = {
		paneId: 'w4:p1',
		cwd: '/tmp/oh-test-img',
		agentSession: 'dee76cdf',
		agentStatus: 'idle',
	};
	const path = '/home/lasse/.claude/projects/-tmp-oh-test-img/dee76cdf.jsonl';

	function model(): { model: SessionModel; source: OneFile } {
		const source = new OneFile(path, FIXTURE);
		const model = new SessionModel({
			endpointId: 'local',
			paneId: 'w4:p1',
			watcher: () => watcherOf(pane),
			source: () => source,
			home: '/home/lasse',
		});
		model.start();
		return { model, source };
	}

	it('holds no bytes in its state, and reads them from the transcript on asking', async () => {
		const { model: session } = model();
		expect(JSON.stringify(session.state)).not.toContain(PIXEL.slice(0, 12));
		expect(FIXTURE).toContain('iVBORw0KGgo');
		expect(JSON.stringify(session.state)).not.toContain('iVBORw0KGgo');

		const image = images()[0] as ImageEntry;
		await expect(session.readImage(image)).resolves.toEqual(transcriptImage(FIXTURE, image.record, image.index));
	});

	it('shares one read of the file between the images one draw asks for', async () => {
		const { model: session, source } = model();

		const all = await Promise.all(images().map((image) => session.readImage(image)));

		expect(all.every((bytes) => bytes?.mediaType === 'image/png')).toBe(true);
		expect(source.reads).toBe(1);
		// And keeps nothing afterwards: the next look reads again.
		await session.readImage(images()[0] as ImageEntry);
		expect(source.reads).toBe(2);
	});

	it('reads nothing for an image with no record', async () => {
		const { model: session, source } = model();

		await expect(
			session.readImage({ kind: 'image', id: '#0', record: '', index: 0, mediaType: 'image/png' }),
		).resolves.toBeNull();
		expect(source.reads).toBe(0);
	});
});

describe('the thumbnail (#144)', () => {
	function renderer(read?: (image: ImageEntry) => Promise<{ mediaType: string; data: string } | null>): {
		el: ReturnType<typeof hostEl>['el'];
		turns: TurnRenderer;
		opened: ShownImage[];
	} {
		const { el, host } = hostEl();
		const opened: ShownImage[] = [];
		const turns = new TurnRenderer(host, {
			presentation: () => 'highlight',
			vaultPath: () => '/vault',
			renderMarkdown: async () => {},
			resolveUri: () => null,
			...(read ? { readImage: read } : {}),
			openImage: (image) => opened.push(image),
		});
		return { el, turns, opened };
	}

	const entry: ImageEntry = { kind: 'image', id: 'u1#0', record: 'u1', index: 0, mediaType: 'image/png' };

	it('is drawn from the bytes it reads, and opens full size on a click', async () => {
		const read = vi.fn(async () => ({ mediaType: 'image/png', data: PIXEL }));
		const { el, turns, opened } = renderer(read);

		turns.render({ id: 'u1', prompt: 'What is this?', entries: [entry], headings: [] });
		await vi.waitFor(() => expect(el.findAll('herdr-native-image-thumb')).toHaveLength(1));

		const thumb = el.find('herdr-native-image-thumb');
		expect(thumb.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
		expect(thumb.getAttribute('alt')).toBe('Image (PNG)');
		el.find('herdr-native-image').dispatch('click');
		await vi.waitFor(() => expect(opened).toEqual([{ src: `data:image/png;base64,${PIXEL}`, label: 'Image (PNG)' }]));
		// One read for the thumbnail and the click both.
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('is read once while the turn around it grows', async () => {
		const read = vi.fn(async () => ({ mediaType: 'image/png', data: PIXEL }));
		const { turns } = renderer(read);

		turns.render({ id: 'u1', prompt: 'What is this?', entries: [entry], headings: [] });
		turns.render({
			id: 'u1',
			prompt: 'What is this?',
			entries: [entry, { kind: 'text', messageId: 'm1', text: 'A pixel.' }],
			headings: [],
		});

		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
	});

	it('stays its label, and opens nothing, when the bytes are not there', async () => {
		const { el, turns, opened } = renderer(async () => null);

		turns.render({ id: 'u1', prompt: '', entries: [entry], headings: [] });
		el.find('herdr-native-image').dispatch('click');
		await Promise.resolve();
		await Promise.resolve();

		expect(el.find('herdr-native-image').textContent).toBe('Image (PNG)');
		expect(el.findAll('herdr-native-image-thumb')).toHaveLength(0);
		expect(opened).toEqual([]);
	});

	it('is a disabled label where nothing can read it', () => {
		const { el, turns } = renderer();

		turns.render({ id: 'u1', prompt: '', entries: [entry], headings: [] });

		expect(el.find('herdr-native-image').disabled).toBe(true);
	});
});

describe('what the prompt box takes (#144)', () => {
	it('takes the four types Claude reads, up to 5 MB', () => {
		expect(imageFileProblem({ name: 'a.png', type: 'image/png', size: 10 })).toBeNull();
		expect(imageFileProblem({ name: 'a.webp', type: 'image/webp', size: MAX_PROMPT_IMAGE_BYTES })).toBeNull();
		expect(imageFileProblem({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toBe(
			'a.svg is not a PNG, JPEG, GIF or WebP image',
		);
		expect(imageFileProblem({ name: 'big.jpg', type: 'image/jpeg', size: MAX_PROMPT_IMAGE_BYTES + 1 })).toBe(
			'big.jpg is larger than 5 MB',
		);
	});

	it('pastes paths as a terminal writes a dropped file', () => {
		expect(escapedPath('/tmp/sp ace/x.png')).toBe('/tmp/sp\\ ace/x.png');
		expect(imagePaste(['/tmp/a.png', '/tmp/sp ace/b.png'])).toBe(
			'\u001b[200~/tmp/a.png /tmp/sp\\ ace/b.png\u001b[201~',
		);
	});

	it('reads images back out of request parameters, dropping what Claude would not take', () => {
		expect(
			promptImages([IMAGE, { mediaType: 'image/svg+xml', data: 'x' }, { mediaType: 'image/png', data: '' }, null, 'x']),
		).toEqual([IMAGE]);
		expect(promptImages(undefined)).toEqual([]);
	});
});

/** A client that records its calls, answering `terminal.put` with a path. */
function recordingClient(fail?: string): {
	calls: { method: string; params: unknown }[];
	request: <T>(method: string, params: unknown) => Promise<T>;
} {
	const calls: { method: string; params: unknown }[] = [];
	return {
		calls,
		request: async <T>(method: string, params: unknown): Promise<T> => {
			calls.push({ method, params });
			if (fail === method) throw new Error(`${method} failed`);
			if (method === 'terminal.put') {
				const name = (params as { name: string }).name;
				return { path: `/state/files/t7/${name}`, bytes: 1 } as T;
			}
			return undefined as T;
		},
	};
}

function fakeFiles(): ImageFiles & { written: PromptImage[][]; released: string[][] } {
	const written: PromptImage[][] = [];
	const released: string[][] = [];
	return {
		written,
		released,
		async write(images) {
			written.push([...images]);
			return images.map((_, index) => `/tmp/gjetr-images/image-${index}.png`);
		},
		release(paths) {
			released.push([...paths]);
		},
	};
}

describe('image files on this machine (#144)', () => {
	it('writes each image to a file of its own, readable by this user only, named for its type', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'oh-test-images-'));
		try {
			const files = localImageFiles(join(dir, 'images'));
			const paths = await files.write([IMAGE, { ...IMAGE, mediaType: 'image/jpeg' }]);

			expect(paths).toHaveLength(2);
			expect(paths[0]).toMatch(/\/images\/image-[0-9a-f-]+\.png$/);
			expect(paths[1]).toMatch(/\.jpg$/);
			expect(readFileSync(paths[0] as string).toString('base64')).toBe(PIXEL);
			expect(statSync(paths[0] as string).mode & 0o777).toBe(0o600);
			// Nothing goes at once: Claude may still be reading.
			files.release(paths);
			expect(paths.every((path) => existsSync(path))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('herdr: images as a pasted path (#144)', () => {
	it('writes each image, pastes the paths, then sends the text with its Enter', async () => {
		const client = recordingClient();
		const files = fakeFiles();
		const sender = clientPromptSender(() => client, files);

		await sender.send('w4:p1', 'What colour?', [IMAGE, IMAGE]);

		expect(files.written).toEqual([[IMAGE, IMAGE]]);
		expect(client.calls).toEqual([
			{
				method: 'pane.send_text',
				params: {
					pane_id: 'w4:p1',
					text: '\u001b[200~/tmp/gjetr-images/image-0.png /tmp/gjetr-images/image-1.png\u001b[201~',
				},
			},
			{ method: 'agent.prompt', params: { target: 'w4:p1', text: 'What colour?' } },
		]);
		expect(files.released).toEqual([
			['/tmp/gjetr-images/image-0.png', '/tmp/gjetr-images/image-1.png'],
		]);
	});

	it('sends a picture with no words with a bare Enter, which herdr’s agent.prompt refuses to', async () => {
		const client = recordingClient();
		const sender = clientPromptSender(() => client, fakeFiles());

		await sender.send('w4:p1', '  ', [IMAGE]);

		expect(client.calls.map((call) => call.method)).toEqual(['pane.send_text', 'agent.send_keys']);
		expect(client.calls[1]?.params).toEqual({ target: 'w4:p1', keys: ['Enter'] });
	});

	it('lets the files go even when the send fails', async () => {
		const files = fakeFiles();
		const sender = clientPromptSender(() => recordingClient('agent.prompt'), files);

		await expect(sender.send('w4:p1', 'Hi', [IMAGE])).rejects.toThrow('agent.prompt failed');
		expect(files.released).toHaveLength(1);
	});

	it('writes nothing for a prompt without images, and says images can go', async () => {
		const client = recordingClient();
		const files = fakeFiles();
		const sender = clientPromptSender(() => client, files);

		await sender.send('w4:p1', 'Hi');

		expect(files.written).toEqual([]);
		expect(client.calls.map((call) => call.method)).toEqual(['agent.prompt']);
		expect(imagesUnavailable(sender, 'w4:p1')).toBeNull();
	});
});

/** An hc client with raw input and a method list, as `HcClient` has them. */
function hcClient(methods: string[] = ['terminal.put']): ReturnType<typeof recordingClient> & {
	typed: { terminal: string; text: string }[];
	input(terminal: string, text: string): Promise<void>;
	hasMethod(method: string): boolean;
} {
	const client = recordingClient();
	const typed: { terminal: string; text: string }[] = [];
	return {
		...client,
		typed,
		async input(terminal, text) {
			typed.push({ terminal, text });
			client.calls.push({ method: '(input)', params: { terminal, text } });
		},
		hasMethod: (method) => methods.includes(method),
	};
}

describe('herdr-core: images put beside the terminal (#144)', () => {
	it('puts each image, types the paths as one paste, then sends the text', async () => {
		const client = hcClient();
		const sender = hcPromptSender(() => client, () => 1700);

		await sender.send('t7', 'What colour?', [IMAGE, { ...IMAGE, mediaType: 'image/jpeg' }]);

		expect(client.calls).toEqual([
			{ method: 'terminal.put', params: { terminal: 't7', name: 'image-1700-1.png', data: PIXEL } },
			{ method: 'terminal.put', params: { terminal: 't7', name: 'image-1700-2.jpg', data: PIXEL } },
			{
				method: '(input)',
				params: {
					terminal: 't7',
					text: '\u001b[200~/state/files/t7/image-1700-1.png /state/files/t7/image-1700-2.jpg\u001b[201~',
				},
			},
			{ method: 'terminal.send', params: { terminal: 't7', text: 'What colour?' } },
		]);
	});

	it('sends a picture alone with an empty send, which presses Enter', async () => {
		const client = hcClient();

		await hcPromptSender(() => client).send('t7', '', [IMAGE]);

		expect(client.calls.at(-1)).toEqual({ method: 'terminal.send', params: { terminal: 't7', text: '' } });
	});

	it('says why not on a core without terminal.put, or a client that cannot type', async () => {
		expect(hcImagesUnavailable(hcClient())).toBeNull();
		expect(hcImagesUnavailable(hcClient([]))).toBe('this herdr-core has no terminal.put; a newer hc sends images');
		expect(hcImagesUnavailable(recordingClient())).toBe('this herdr-core connection cannot type into a terminal');
		expect(hcImagesUnavailable(null)).toBe('herdr-core is not connected');

		const old = hcClient([]);
		await expect(hcPromptSender(() => old).send('t7', 'Hi', [IMAGE])).rejects.toThrow('no terminal.put');
		expect(old.calls).toEqual([]);
	});
});

describe('the claude kind: images as content blocks (#144)', () => {
	it('writes the text first, then one base64 image block each', () => {
		expect(userMessage('What colour?', [IMAGE])).toEqual({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'What colour?' },
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } },
				],
			},
		});
		expect(userMessage('', [IMAGE])).toEqual({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } }],
			},
		});
		// A prompt without images is the string it always was.
		expect(userMessage('Hi')).toEqual({ type: 'user', message: { role: 'user', content: 'Hi' } });
	});
});

/** A browser `File`, as far as the box reads one. */
function file(name: string, type: string, size = 10): ImageFile {
	return { name, type, size, arrayBuffer: async () => new ArrayBuffer(size) };
}

function transfer(files: ImageFile[], text = ''): { files: ImageFile[]; types: string[]; getData: (format: string) => string } {
	return {
		files,
		types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
		getData: (format) => (format === 'text/plain' ? text : ''),
	};
}

function sender(reason: string | null = null): PromptSender & { sent: { text: string; images?: readonly PromptImage[] }[] } {
	const sent: { text: string; images?: readonly PromptImage[] }[] = [];
	return {
		sent,
		async send(_paneId, text, images) {
			sent.push(images ? { text, images } : { text });
		},
		imagesUnavailable: () => reason,
	};
}

function box(promptSender: PromptSender, status: 'idle' | 'working' | 'unknown' = 'idle') {
	const { el, host } = hostEl();
	const notices: string[] = [];
	const prompt = new PromptBox({
		paneId: () => 'w4:p1',
		sender: promptSender,
		notify: (message) => notices.push(message),
		readFile: async (image) => `bytes-of-${image.name}`,
	});
	prompt.mount(host);
	prompt.setStatus(status);
	return { prompt, el, notices, input: el.find('herdr-native-prompt-input'), root: el.find('herdr-native-prompt-box') };
}

describe('pasting and dropping images on the prompt box (#144)', () => {
	it('attaches a pasted screenshot, shows it, and sends it with the text', async () => {
		const out = sender();
		const { prompt, el, input } = box(out);

		const event = input.dispatch('paste', { clipboardData: transfer([file('image.png', 'image/png')]) });
		await vi.waitFor(() => expect(prompt.attachedImages).toHaveLength(1));

		expect(event.defaultPrevented).toBe(true);
		const strip = el.find('herdr-native-prompt-images');
		expect(strip.hasClass('herdr-is-hidden')).toBe(false);
		expect(strip.find('herdr-native-prompt-image-thumb').getAttribute('src')).toBe(
			'data:image/png;base64,bytes-of-image.png',
		);

		input.value = 'What is this?';
		await prompt.send();

		expect(out.sent).toEqual([
			{ text: 'What is this?', images: [{ mediaType: 'image/png', data: 'bytes-of-image.png', name: 'image.png' }] },
		]);
		expect(prompt.attachedImages).toEqual([]);
		expect(strip.hasClass('herdr-is-hidden')).toBe(true);
	});

	it('sends a picture with no words', async () => {
		const out = sender();
		const { prompt, input } = box(out);

		input.dispatch('paste', { clipboardData: transfer([file('image.png', 'image/png')]) });
		await vi.waitFor(() => expect(prompt.attachedImages).toHaveLength(1));
		await prompt.send();

		expect(out.sent).toHaveLength(1);
		expect(out.sent[0]?.text).toBe('');
	});

	it('pastes the text, not a picture of it, when the clipboard holds both', () => {
		expect(pastedImages(transfer([file('cells.png', 'image/png')], 'a\tb'))).toEqual([]);
		const { prompt, input } = box(sender());

		const event = input.dispatch('paste', { clipboardData: transfer([file('cells.png', 'image/png')], 'a\tb') });

		expect(event.defaultPrevented).toBe(false);
		expect(prompt.attachedImages).toEqual([]);
	});

	it('takes dropped image files and says which others it left out', async () => {
		const { prompt, root, notices } = box(sender());

		const over = root.dispatch('dragover', { dataTransfer: transfer([file('a.png', 'image/png')]) });
		expect(over.defaultPrevented).toBe(true);
		expect(root.hasClass('herdr-is-drop-target')).toBe(true);
		const drop = root.dispatch('drop', {
			dataTransfer: transfer([file('a.png', 'image/png'), file('notes.pdf', 'application/pdf'), file('b.gif', 'image/gif')]),
		});
		await vi.waitFor(() => expect(prompt.attachedImages).toHaveLength(2));

		expect(drop.defaultPrevented).toBe(true);
		expect(root.hasClass('herdr-is-drop-target')).toBe(false);
		expect(prompt.attachedImages.map((image) => image.name)).toEqual(['a.png', 'b.gif']);
		expect(notices).toEqual(['Gjetr: notes.pdf is not a PNG, JPEG, GIF or WebP image.']);
	});

	it('removes an image from the strip with its button', async () => {
		const { prompt, el, input } = box(sender());
		input.dispatch('paste', { clipboardData: transfer([file('a.png', 'image/png'), file('b.png', 'image/png')]) });
		await vi.waitFor(() => expect(prompt.attachedImages).toHaveLength(2));

		el.findAll('herdr-native-prompt-image-remove')[0]?.dispatch('click');

		expect(prompt.attachedImages.map((image) => image.name)).toEqual(['b.png']);
		expect(el.findAll('herdr-native-prompt-image')).toHaveLength(1);
	});

	it('attaches nothing, and says why, where the runtime cannot send images', () => {
		const { prompt, input, root, notices } = box(sender('this herdr-core has no terminal.put; a newer hc sends images'));

		const pasted = input.dispatch('paste', { clipboardData: transfer([file('a.png', 'image/png')]) });
		const dropped = root.dispatch('drop', { dataTransfer: transfer([file('a.png', 'image/png')]) });

		expect(pasted.defaultPrevented).toBe(false);
		// A drop is never the browser's: it would type the file's path.
		expect(dropped.defaultPrevented).toBe(true);
		expect(prompt.attachedImages).toEqual([]);
		expect(notices).toEqual([
			'Gjetr: images cannot be sent here (this herdr-core has no terminal.put; a newer hc sends images).',
			'Gjetr: images cannot be sent here (this herdr-core has no terminal.put; a newer hc sends images).',
		]);
	});

	it('treats a sender that says nothing about images as one that takes none', () => {
		const silent: PromptSender = { send: async () => {} };
		const { prompt, notices, root } = box(silent);

		root.dispatch('drop', { dataTransfer: transfer([file('a.png', 'image/png')]) });

		expect(prompt.attachedImages).toEqual([]);
		expect(notices).toEqual([`Gjetr: images cannot be sent here (${IMAGES_UNSUPPORTED}).`]);
	});

	it('takes no image while there is no agent to send it to', () => {
		const { prompt, root, notices } = box(sender(), 'unknown');

		root.dispatch('drop', { dataTransfer: transfer([file('a.png', 'image/png')]) });

		expect(prompt.attachedImages).toEqual([]);
		expect(notices).toEqual(['Gjetr: images cannot be sent here (no agent in this pane).']);
	});

	it('leaves a drag of text alone', () => {
		const { root } = box(sender());

		const over = root.dispatch('dragover', { dataTransfer: transfer([], '[[A note]]') });

		expect(over.defaultPrevented).toBe(false);
	});
});

describe('HcClient.input: typing with no Enter, over a short attach (#144)', () => {
	async function connected(features: string[]): Promise<{ client: HcClient; core: FakeCore }> {
		const { spawn, cores } = fakeSpawner((core) => {
			core.handlers.set('hello', () => ({
				...HELLO_RESULT,
				methods: [...HELLO_RESULT.methods, 'terminal.put'],
				features,
			}));
			core.handlers.set('terminal.get', () => ({ address: 't7', cols: 150, rows: 40 }));
			core.handlers.set('terminal.attach', () => ({ channel: 3, automatic_input: true, terminal: { address: 't7' } }));
		});
		const client = new HcClient({ argv: ['hc', 'connect'], spawn });
		await client.ping();
		return { client, core: cores[0] as FakeCore };
	}

	it('attaches at the terminal’s own grid without taking it, types as automatic input, and closes', async () => {
		const { client, core } = await connected(HELLO_RESULT.features);

		await client.input('t7', imagePaste(['/state/a.png']));

		expect(core.calls.find((call) => call.method === 'terminal.attach')?.params).toEqual({
			terminal: 't7',
			cols: 150,
			rows: 40,
			history: 0,
			resumed: true,
		});
		const sent = core.sent(3);
		expect(sent.map((frame) => frame.kind)).toEqual([FrameKind.AutomaticInput, FrameKind.Close]);
		expect(sent[0]?.payload.toString()).toBe('\u001b[200~/state/a.png\u001b[201~');
		expect(client.hasMethod('terminal.put')).toBe(true);
		client.dispose();
	});

	it('types as a person would on a core without automatic input', async () => {
		const { client, core } = await connected(['framed', 'attach']);

		await client.input('t7', 'x');

		expect(core.sent(3).map((frame) => frame.kind)).toEqual([FrameKind.Data, FrameKind.Close]);
		client.dispose();
	});
});
