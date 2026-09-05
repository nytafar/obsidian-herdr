import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		// Bridge tests spawn real child processes; give the big-frame case room.
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
