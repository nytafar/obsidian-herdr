#!/usr/bin/env node
/**
 * Generates `src/herdr/types.gen.ts` from `herdr api schema --json` (PRD N3).
 *
 * Usage:
 *   npm run gen:types                  # uses the discovered herdr binary
 *   npm run gen:types -- --binary /opt/homebrew/bin/herdr
 *   npm run gen:types -- --schema path/to/schema.json
 *   npm run gen:types -- --check       # fail if the checked-in file is stale
 *
 * The schema document is `{$schema, title, protocol, schema_version, schemas}`
 * where `schemas` holds five self-contained JSON Schema draft 2020-12 documents:
 * `request`, `success_response`, `error_response`, `event`, `subscription_event`.
 * All named types live in each document's `$defs`, and `$ref`s are written
 * `#/schemas/<document>/$defs/<Name>` rather than `#/$defs/<Name>`.
 *
 * Several names appear in more than one document (`PaneInfo`, `AgentStatus`, …).
 * They are emitted once when structurally identical after normalising the
 * document prefix out of every `$ref`, and as `<Document><Name>` otherwise.
 *
 * The generated file is types only, plus the `HERDR_PROTOCOL` /
 * `HERDR_SCHEMA_VERSION` constants the PRD wants recorded in the bundle.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'herdr', 'types.gen.ts');

const DOCUMENTS = ['success_response', 'request', 'event', 'subscription_event', 'error_response'];
const DOCUMENT_PREFIX = {
	success_response: 'Result',
	request: 'Request',
	event: 'Event',
	subscription_event: 'SubscriptionEvent',
	error_response: 'Error',
};

/** Same search order as src/herdr/binary.ts, minus the login-shell fallback. */
const BINARY_CANDIDATES = [
	'/opt/homebrew/bin/herdr',
	'/usr/local/bin/herdr',
	join(homedir(), '.local', 'bin', 'herdr'),
];

function parseArgs(argv) {
	const args = { binary: '', schema: '', check: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--check') args.check = true;
		else if (arg === '--binary') args.binary = argv[++i] ?? '';
		else if (arg === '--schema') args.schema = argv[++i] ?? '';
		else throw new Error(`unknown argument ${arg}`);
	}
	return args;
}

function resolveBinary(override) {
	if (override) return override;
	const found = BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
	if (found) return found;
	return 'herdr';
}

function loadSchema(args) {
	if (args.schema) return JSON.parse(readFileSync(args.schema, 'utf8'));
	const binary = resolveBinary(args.binary);
	const json = execFileSync(binary, ['api', 'schema', '--json'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(json);
}

function herdrVersion(args) {
	if (args.schema) return null;
	try {
		const out = execFileSync(resolveBinary(args.binary), ['--version'], { encoding: 'utf8' });
		return out.trim();
	} catch {
		return null;
	}
}

const REF_PREFIX = /^#\/schemas\/[a-z_]+\/\$defs\//;

/** Ref target name, ignoring which document it points into. */
function refName(ref) {
	if (!REF_PREFIX.test(ref)) throw new Error(`unexpected $ref ${ref}`);
	return ref.replace(REF_PREFIX, '');
}

/** Stable text of a schema with document prefixes stripped from every `$ref`. */
function normalise(node) {
	if (Array.isArray(node)) return node.map(normalise);
	if (node && typeof node === 'object') {
		const out = {};
		for (const key of Object.keys(node).sort()) {
			out[key] = key === '$ref' ? refName(node[key]) : normalise(node[key]);
		}
		return out;
	}
	return node;
}

/**
 * @returns Map<`${document}/${name}`, tsName> plus the list of types to emit.
 */
function planNames(schemas) {
	const byName = new Map(); // name -> [{ document, text, node }]
	for (const document of DOCUMENTS) {
		const defs = schemas[document]?.$defs ?? {};
		for (const [name, node] of Object.entries(defs)) {
			const entry = { document, node, text: JSON.stringify(normalise(node)) };
			const list = byName.get(name);
			if (list) list.push(entry);
			else byName.set(name, [entry]);
		}
	}

	const mapping = new Map();
	const emit = [];
	for (const [name, entries] of byName) {
		const shared = entries.every((entry) => entry.text === entries[0].text);
		if (shared) {
			for (const entry of entries) mapping.set(`${entry.document}/${name}`, name);
			emit.push({ tsName: name, node: entries[0].node, document: entries[0].document });
		} else {
			for (const entry of entries) {
				const tsName = `${DOCUMENT_PREFIX[entry.document]}${name}`;
				mapping.set(`${entry.document}/${name}`, tsName);
				emit.push({ tsName, node: entry.node, document: entry.document });
			}
		}
	}
	emit.sort((a, b) => (a.tsName < b.tsName ? -1 : a.tsName > b.tsName ? 1 : 0));
	return { mapping, emit };
}

const PRIMITIVES = {
	string: 'string',
	integer: 'number',
	number: 'number',
	boolean: 'boolean',
	null: 'null',
};

function quote(value) {
	return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function isIdentifier(name) {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyKey(name) {
	return isIdentifier(name) ? name : quote(name);
}

class Emitter {
	constructor(mapping, document) {
		this.mapping = mapping;
		this.document = document;
	}

	ref(node) {
		const name = refName(node.$ref);
		const tsName = this.mapping.get(`${this.document}/${name}`);
		if (!tsName) throw new Error(`unresolved $ref ${node.$ref} in ${this.document}`);
		return tsName;
	}

	/** @returns a TypeScript type expression for `node`, indented under `indent`. */
	type(node, indent = '') {
		if (node === true || node === undefined) return 'unknown';
		if (node === false) return 'never';
		if (node.$ref) return this.ref(node);
		if (node.const !== undefined) return typeof node.const === 'string' ? quote(node.const) : JSON.stringify(node.const);
		if (Array.isArray(node.enum)) {
			return node.enum.map((value) => (value === null ? 'null' : quote(value))).join(' | ');
		}
		if (Array.isArray(node.oneOf)) return this.union(node.oneOf, indent);
		if (Array.isArray(node.anyOf)) return this.union(node.anyOf, indent);
		if (Array.isArray(node.allOf)) {
			return node.allOf.map((sub) => this.type(sub, indent)).join(' & ');
		}

		const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
		if (types.length > 1) {
			return types.map((type) => this.type({ ...node, type }, indent)).join(' | ');
		}
		const type = types[0];
		if (!type) return 'unknown';
		if (type === 'array') {
			const items = this.type(node.items, indent);
			return /[ |&]/.test(items) ? `(${items})[]` : `${items}[]`;
		}
		if (type === 'object') return this.object(node, indent);
		return PRIMITIVES[type] ?? 'unknown';
	}

	union(members, indent) {
		const inline = [...new Set(members.map((member) => this.type(member, indent)))];
		if (inline.length === 1) return inline[0];
		if (!inline.some((part) => part.includes('\n'))) return inline.join(' | ');
		// Multi-line unions of object literals: re-emit one level deeper so the
		// members line up under the `|`.
		const nested = [...new Set(members.map((member) => this.type(member, `${indent}\t`)))];
		return nested.map((part) => `\n${indent}\t| ${part}`).join('');
	}

	object(node, indent) {
		const properties = node.properties ?? {};
		const names = Object.keys(properties);
		if (names.length === 0) {
			const extra = node.additionalProperties;
			if (extra && extra !== true) return `Record<string, ${this.type(extra, indent)}>`;
			return 'Record<string, unknown>';
		}
		const required = new Set(node.required ?? []);
		const inner = `${indent}\t`;
		const lines = names.map((name) => {
			const optional = required.has(name) ? '' : '?';
			const type = this.type(properties[name], inner);
			return `${inner}${propertyKey(name)}${optional}: ${type};`;
		});
		return `{\n${lines.join('\n')}\n${indent}}`;
	}
}

/** `{"const":"x"}`-tagged unions: map the tag value to its variant. */
function taggedVariants(node, tag) {
	const members = node?.oneOf ?? node?.anyOf ?? [];
	const out = [];
	for (const member of members) {
		const value = member?.properties?.[tag]?.const;
		if (typeof value === 'string') out.push({ value, member });
	}
	return out.length === members.length && out.length > 0 ? out : null;
}

function generate(schema, version) {
	const { schemas } = schema;
	const { mapping, emit } = planNames(schemas);

	const out = [];
	out.push('/**');
	out.push(' * GENERATED FILE — do not edit. Run `npm run gen:types` (PRD N3).');
	out.push(` * Source: \`herdr api schema --json\`${version ? ` from ${version}` : ''}.`);
	out.push(` * Protocol ${schema.protocol}, schema version ${schema.schema_version}.`);
	out.push(' *');
	out.push(' * Unknown fields are tolerated at runtime: these types describe what the');
	out.push(' * server promised at generation time, never what a newer server may add.');
	out.push(' */');
	out.push('');
	out.push('/** herdr JSON API protocol number this bundle was generated against. */');
	out.push(`export const HERDR_PROTOCOL = ${schema.protocol};`);
	out.push('/** `schema_version` of the schema document used for generation. */');
	out.push(`export const HERDR_SCHEMA_VERSION = ${schema.schema_version};`);
	if (version) {
		out.push('/** herdr build the schema was read from. Informational only. */');
		out.push(`export const HERDR_SCHEMA_SOURCE_VERSION = ${quote(version)};`);
	}
	out.push('');

	for (const { tsName, node, document } of emit) {
		const emitter = new Emitter(mapping, document);
		const body = emitter.type(node, '');
		if (body.startsWith('{\n')) out.push(`export interface ${tsName} ${body}`);
		else if (body.startsWith('\n')) out.push(`export type ${tsName} =${body};`);
		else out.push(`export type ${tsName} = ${body};`);
		out.push('');
	}

	// Method -> params map, taken from the request document's tagged union.
	const methods = [];
	for (const member of schemas.request.oneOf ?? []) {
		const method = member?.properties?.method?.const;
		const params = member?.properties?.params;
		if (typeof method !== 'string' || !params) continue;
		const emitter = new Emitter(mapping, 'request');
		methods.push({ method, type: emitter.type(params, '\t') });
	}
	methods.sort((a, b) => (a.method < b.method ? -1 : 1));
	out.push('/** Every method name the server accepts, and the params each requires. */');
	out.push('export interface HerdrMethodParams {');
	for (const { method, type } of methods) out.push(`\t${quote(method)}: ${type};`);
	out.push('}');
	out.push('');
	out.push('export type HerdrMethod = keyof HerdrMethodParams;');
	out.push('');

	// Result variants, keyed by their `type` tag.
	const resultVariants = taggedVariants(schemas.success_response.$defs.ResponseResult, 'type');
	if (resultVariants) {
		const emitter = new Emitter(mapping, 'success_response');
		out.push('/** Result payloads keyed by their internal `type` tag. */');
		out.push('export interface HerdrResultByType {');
		for (const { value, member } of resultVariants) {
			out.push(`\t${quote(value)}: ${emitter.type(member, '\t')};`);
		}
		out.push('}');
		out.push('');
		out.push('export type HerdrResultType = keyof HerdrResultByType;');
		out.push('');
	}

	// Lifecycle event payloads, keyed by their `type` tag (equal to the `event` name).
	const eventVariants = taggedVariants(schemas.event.$defs.EventData, 'type');
	if (eventVariants) {
		const emitter = new Emitter(mapping, 'event');
		out.push('/** Lifecycle event payloads keyed by `data.type` (equal to `event`). */');
		out.push('export interface HerdrEventByKind {');
		for (const { value, member } of eventVariants) {
			out.push(`\t${quote(value)}: ${emitter.type(member, '\t')};`);
		}
		out.push('}');
		out.push('');
	}

	const subVariants = taggedVariants(schemas.subscription_event.$defs.SubscriptionEventData, 'type');
	if (subVariants) {
		const emitter = new Emitter(mapping, 'subscription_event');
		out.push('/** Subscription event payloads keyed by `data.type` (dotted names). */');
		out.push('export interface HerdrSubscriptionEventByKind {');
		for (const { value, member } of subVariants) {
			out.push(`\t${quote(value)}: ${emitter.type(member, '\t')};`);
		}
		out.push('}');
		out.push('');
	}

	return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}`.trimEnd() + '\n';
}

const args = parseArgs(process.argv.slice(2));
const schema = loadSchema(args);
const source = generate(schema, herdrVersion(args));

if (args.check) {
	const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (current !== source) {
		process.stderr.write('src/herdr/types.gen.ts is stale; run `npm run gen:types`\n');
		process.exit(1);
	}
	process.stdout.write('src/herdr/types.gen.ts is up to date\n');
} else {
	writeFileSync(OUT, source);
	process.stdout.write(
		`wrote ${OUT} (protocol ${schema.protocol}, schema_version ${schema.schema_version})\n`,
	);
}
