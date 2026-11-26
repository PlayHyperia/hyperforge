import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // These tests exercise providers/services and don't require a DOM runtime.
    // Keeping them on Node avoids jsdom worker startup failures in CI.
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "src/__tests__/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/mockData.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    watchExclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
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
      {
        find: "@",
        replacement: path.resolve(import.meta.dirname, "./src"),
      },
    ],
  },
});
