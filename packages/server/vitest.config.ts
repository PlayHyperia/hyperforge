import { defineConfig } from "vitest/config";
import path from "path";

// The opt-in real-owner route lane initializes shared PhysX from server tests.
// Keep both source trees within Vite's root so its server-only dynamic import
// resolves normally, and use current dock/court source without rebuilding dist.
const pondBankRoutes = process.env.HYPERIA_POND_BANK_ROUTES === "1";
const workspaceRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  ...(pondBankRoutes ? { root: workspaceRoot } : {}),
  test: {
    // Only include .test.ts files (unit/integration tests)
    // Exclude .spec.ts files (Playwright E2E tests - run with `npm run test:e2e`)
    // Scope collection to this package's real test roots. A workspace dependency
    // can be symlinked beneath node_modules, and a package-wide `**` glob follows
    // those links into sibling packages (including archived source trees).
    include: pondBankRoutes
      ? [
          "packages/server/src/systems/ServerNetwork/__tests__/PlayerSupport.integration.test.ts",
        ]
      : ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
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
    setupFiles: pondBankRoutes
      ? [path.resolve(import.meta.dirname, "vitest.setup.ts")]
      : ["./vitest.setup.ts"],
  },
  resolve: {
    alias: [
      ...(pondBankRoutes
        ? [
            {
              find: /^@hyperforge\/procgen\/building$/,
              replacement: path.resolve(
                import.meta.dirname,
                "../procgen/src/building/index.ts",
              ),
            },
            {
              find: /^@hyperforge\/procgen\/items\/dock$/,
              replacement: path.resolve(
                import.meta.dirname,
                "../procgen/src/items/dock/index.ts",
              ),
            },
          ]
        : []),
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
