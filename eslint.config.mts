import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
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
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		// Test double for the herdr binary: plain node script, not plugin code.
		'tests/fixtures/*.mjs',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
);
