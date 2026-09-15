import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

// Setup follows https://github.com/obsidianmd/eslint-plugin/blob/master/docs/configuration.md.
// The recommended config already brings @eslint/js, typescript-eslint
// (type-checked), browser globals, node globals (isDesktopOnly) and Obsidian's
// DOM helper globals, so none of that is repeated here.
export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		// Agent worktrees: whole checkouts of this repo, not ours to lint.
		'.claude/**',
		'esbuild.config.mjs',
		'version-bump.mjs',
		// Build-time script, not plugin code, and not in tsconfig's project.
		'scripts/*.mjs',
		// Standalone audit reproductions, outside the plugin TypeScript project.
		'docs/reviews/**/*.mjs',
		// Generated from `herdr api schema --json`; `npm run gen:types` owns it.
		'src/herdr/types.gen.ts',
		'versions.json',
		'main.js',
		'package-lock.json',
		'tsconfig.json',
		// Test double for the herdr binary: plain node script, not plugin code.
		'tests/fixtures/*.mjs',
	]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['src/**/*.ts'],
		rules: {
			// `brands` replaces the plugin's default list rather than extending it,
			// so start from that. The list is not a public export; recheck the
			// import path after upgrading the plugin.
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					// "cursor" is the terminal cursor, not the Cursor editor.
					brands: DEFAULT_BRANDS.filter((b) => b !== 'Cursor'),
					ignoreRegex: [
						// A placeholder showing the format, not prose.
						'^user@host$',
						// Strings naming the PATH variable. Brands and acronyms
						// match case-insensitively, so PATH cannot be an acronym
						// without turning every "path" into "PATH".
						'\\bPATH\\b',
					],
				},
			],
		},
	},
	{
		// The recommended config matches only JS/TS, so the manifest check never
		// ran. The rule walks an ESTree AST, which the TS parser gives for JSON.
		files: ['manifest.json'],
		languageOptions: { parser: tseslint.parser },
		plugins: { obsidianmd },
		extends: [tseslint.configs.disableTypeChecked],
		// The recommended severity for this rule.
		rules: { 'obsidianmd/validate-manifest': 'warn' },
	},
	{
		// src/timers.ts: process-side modules also run under plain node in the
		// unit tests, where there is no window; see the comment in that file.
		files: ['src/timers.ts'],
		rules: { 'obsidianmd/no-global-this': 'off' },
	},
	{
		// Tests run in node under vitest, not in an Obsidian window, and the
		// community plugin scanner skips them. Popout-window rules do not apply.
		files: ['tests/**'],
		rules: {
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-create-el': 'off',
		},
	},
);
