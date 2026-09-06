import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		// Bridge tests spawn real child processes; give the big-frame case room.
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		alias: {
			// `obsidian` has no runtime entry point outside the app; the stub lets a
			// test import a module that mentions ItemView and still run under node.
			obsidian: fileURLToPath(new URL('./tests/fixtures/obsidian.ts', import.meta.url)),
		},
	},
});
