import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Only include .test.ts files (unit/integration tests)
    // Exclude .spec.ts files (Playwright E2E tests - run with `npm run test:e2e`)
    // Scope collection to this package's real test roots. A workspace dependency
    // can be symlinked beneath node_modules, and a package-wide `**` glob follows
    // those links into sibling packages (including archived source trees).
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.spec.ts", // Playwright E2E tests
      "**/tests/e2e/**", // E2E test directory
    ],
    // Timeout for longer-running integration tests
    testTimeout: 30000,
    hookTimeout: 30000,
    // Setup file to mock browser globals (WebGPU, etc.)
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: [
      {
        find: /^@hyperforge\/shared\/client$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../shared/src/index.client.ts",
        ),
      },
      {
        find: /^@hyperforge\/shared$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../shared/src/index.ts",
        ),
      },
      {
        find: /^@hyperforge\/shared\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../shared/src/$1"),
      },
    ],
  },
});
