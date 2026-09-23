import { homedir } from 'node:os';
import path from 'node:path';

export type PathStyle = 'posix' | 'win32';

export function localPathStyle(platform: NodeJS.Platform = process.platform): PathStyle {
	return platform === 'win32' ? 'win32' : 'posix';
}

export function pathApi(style: PathStyle): typeof path.posix {
	return style === 'win32' ? path.win32 : path.posix;
}

export function pathListDelimiter(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? ';' : ':';
}

export function splitPathList(
	value: string,
	delimiter: string = pathListDelimiter(),
): string[] {
	return value
		.split(delimiter)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function joinPathList(parts: readonly string[], delimiter: string = pathListDelimiter()): string {
	return parts.join(delimiter);
}

export function executableName(name: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

export function expandHome(
	value: string,
	options: { home?: string; style?: PathStyle } = {},
): string {
	const home = options.home ?? homedir();
	const style = options.style ?? localPathStyle();
	if (value === '~') return home;
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		const rest = value.slice(2);
		return pathApi(style).join(home, rest);
	}
	return value;
}

export function normalizeHostPath(value: string, style: PathStyle): string {
	if (value.length === 0) return value;
	const normal = style === 'win32' ? value.replace(/\//g, '\\') : value.replace(/\\/g, '/');
	return pathApi(style).normalize(normal);
}

export function trimTrailingHostSeparators(value: string, style: PathStyle): string {
	if (!value) return '';
	const api = pathApi(style);
	const normal = normalizeHostPath(value, style);
	const root = api.parse(normal).root;
	const sep = style === 'win32' ? '\\' : '/';
	let end = normal.length;
	while (end > root.length && normal[end - 1] === sep) end -= 1;
	return normal.slice(0, end);
}

export function basenameHostPath(value: string, style: PathStyle): string {
	const trimmed = trimTrailingHostSeparators(value, style);
	return trimmed ? pathApi(style).basename(trimmed) : '';
}

export function joinHostPath(style: PathStyle, ...parts: string[]): string {
	return normalizeHostPath(pathApi(style).join(...parts), style);
}

export function sameHostPath(a: string, b: string, style: PathStyle): boolean {
	const left = trimTrailingHostSeparators(a, style);
	const right = trimTrailingHostSeparators(b, style);
	return style === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function isPathInside(child: string, root: string, style: PathStyle): boolean {
	const api = pathApi(style);
	const normalChild = trimTrailingHostSeparators(child, style);
	const normalRoot = trimTrailingHostSeparators(root, style);
	if (!normalChild || !normalRoot) return false;
	if (sameHostPath(normalChild, normalRoot, style)) return true;
	const relative = api.relative(normalRoot, normalChild);
	const lowered = style === 'win32' ? relative.toLowerCase() : relative;
	return lowered !== '' && lowered !== '..' && !lowered.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}
