import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        include: ['packages/**/*.test.ts', 'tests/contracts/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
        environment: 'node',
        passWithNoTests: true,
    },
});
//# sourceMappingURL=vitest.config.js.map