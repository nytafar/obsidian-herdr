#!/usr/bin/env node
/**
 * Stands in for the herdr binary in bridge tests.
 *
 * Accepts `terminal session control|observe <target> [--takeover] [--cols N] [--rows N]`
 * and speaks the NDJSON contract from PRD section 7: emits one full frame on
 * start, echoes every `terminal.input` back as a frame, acknowledges resize and
 * scroll, and exits on `terminal.release`.
 *
 * Env knobs used by the tests:
 *   FAKE_CHUNK=1          write stdout one byte at a time (partial-line parsing)
 *   FAKE_GARBAGE=1        emit a non-JSON stdout line before the first frame
 *   FAKE_STDERR=<text>    write that as a plain-text stderr line on start
 *   FAKE_BIG=<bytes>      make the first frame payload this many bytes
 *   FAKE_IGNORE_RELEASE=1 keep running after terminal.release
 *   FAKE_IGNORE_SIGTERM=1 also ignore SIGTERM (forces the SIGKILL path)
 *   FAKE_EXIT_CODE=<n>    exit code on release (default 0)
 */

const argv = process.argv.slice(2);
if (argv[0] !== 'terminal' || argv[1] !== 'session') {
	process.stderr.write(`fake-herdr: unexpected argv ${JSON.stringify(argv)}\n`);
	process.exit(2);
}
const mode = argv[2];
const target = argv[3];
if (mode !== 'control' && mode !== 'observe') {
	process.stderr.write(`fake-herdr: bad mode ${mode}\n`);
	process.exit(2);
}
const flags = argv.slice(4);
const takeover = flags.includes('--takeover');
const cols = readFlag(flags, '--cols');
const rows = readFlag(flags, '--rows');

function readFlag(list, name) {
	const i = list.indexOf(name);
	return i === -1 ? null : Number(list[i + 1]);
}

let seq = 0;
const out = [];

function frame(text, full = false) {
	out.push(
		JSON.stringify({
			type: 'terminal.frame',
			seq: seq++,
			encoding: 'ansi',
			width: cols ?? 80,
			height: rows ?? 24,
			full,
			bytes: Buffer.from(text, 'utf8').toString('base64'),
		}),
	);
	drain();
}

function closed(reason) {
	out.push(JSON.stringify({ type: 'terminal.closed', reason }));
	drain();
}

/** Exit without truncating a pipe: stop reading and let the loop drain. */
function finish(reason) {
	closed(reason);
	process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
	process.stdin.destroy();
}

function drain() {
	while (out.length > 0) {
		const line = `${out.shift()}\n`;
		if (process.env.FAKE_CHUNK === '1') {
			for (const byte of Buffer.from(line, 'utf8')) {
				process.stdout.write(Buffer.from([byte]));
			}
		} else {
			process.stdout.write(line);
		}
	}
}

if (process.env.FAKE_STDERR) {
	process.stderr.write(`${process.env.FAKE_STDERR}\n`);
}
if (process.env.FAKE_GARBAGE === '1') {
	process.stdout.write('not json at all\n');
}

const big = Number(process.env.FAKE_BIG ?? 0);
frame(
	big > 0 ? 'x'.repeat(big) : `hello ${target} ${mode}${takeover ? ' takeover' : ''} ${cols}x${rows}`,
	true,
);

if (process.env.FAKE_IGNORE_RELEASE === '1') {
	// Stay alive after release and after stdin closes, so the caller has to signal.
	setInterval(() => {}, 1000);
}
if (process.env.FAKE_IGNORE_SIGTERM === '1') {
	process.on('SIGTERM', () => {});
}

let buffer = '';
process.stdin.on('data', (chunk) => {
	buffer += chunk.toString('utf8');
	let nl = buffer.indexOf('\n');
	while (nl !== -1) {
		handle(buffer.slice(0, nl));
		buffer = buffer.slice(nl + 1);
		nl = buffer.indexOf('\n');
	}
});
process.stdin.on('end', () => {
	if (process.env.FAKE_IGNORE_RELEASE !== '1') {
		// Real herdr sends Detach when stdin closes.
		finish('stdin closed');
	}
});

function handle(line) {
	if (line.trim() === '') return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		process.stderr.write(`herdr: terminal session control input ignored: ${line}\n`);
		return;
	}
	switch (msg.type) {
		case 'terminal.input':
			frame(msg.text ?? Buffer.from(msg.bytes ?? '', 'base64').toString('utf8'));
			return;
		case 'terminal.resize':
			frame(`resize ${msg.cols}x${msg.rows}`);
			return;
		case 'terminal.scroll':
			frame(`scroll ${msg.direction} ${msg.lines} ${msg.source ?? 'wheel'}`);
			return;
		case 'terminal.release':
			if (process.env.FAKE_IGNORE_RELEASE === '1') return;
			finish('released');
			return;
		default:
			return;
	}
}
