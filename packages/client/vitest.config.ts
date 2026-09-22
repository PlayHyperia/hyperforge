import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedBuild = path.resolve(
  __dirname,
  "../shared/build/framework.client.js",
);
const sharedSource = path.resolve(__dirname, "../shared/src");
const sourceDiagnosticsConsumers = new Set([
  path.resolve(__dirname, "src/lib/streamingSceneDiagnostics.ts"),
  path.resolve(__dirname, "tests/unit/lib/streamingSceneDiagnostics.test.ts"),
  path.resolve(__dirname, "src/screens/StreamingMode.tsx"),
  path.resolve(
    __dirname,
    "tests/unit/screens/StreamingRenderPreferences.test.ts",
  ),
]);

export default defineConfig({
  plugins: [
    react() as never,
    {
      name: "streaming-diagnostics-test-source-identity",
      enforce: "pre",
      resolveId(source, importer) {
        const owner = importer?.split("?")[0];
        // These source collector/test graphs need the current admission
        // API. Other client tests retain the installed compiled-package alias.
        // The alias plugin resolves its replacement through this hook; never
        // patch/rebuild a shared bundle that a playable session may be serving.
        if (
          (source === "@hyperforge/shared" || source === sharedBuild) &&
          owner &&
          sourceDiagnosticsConsumers.has(owner)
        )
          return path.join(sharedSource, "index.client.ts");
        // Real source systems must share the matching procgen recipe, not old
        // built declarations/geometry. No virtual modules or mocked systems.
        if (
          source === "@hyperforge/procgen/building" &&
          owner?.startsWith(sharedSource + path.sep)
        )
          return path.resolve(__dirname, "../procgen/src/building/index.ts");
        return null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        // Game panels and systems
        "src/game/panels/**/*.{ts,tsx}",
        "src/game/systems/**/*.{ts,tsx}",
        "src/game/hud/**/*.{ts,tsx}",
        "src/game/components/**/*.{ts,tsx}",
        // Core libraries and utilities
        "src/lib/**/*.{ts,tsx}",
        "src/utils/**/*.{ts,tsx}",
        "src/hooks/**/*.{ts,tsx}",
        "src/auth/**/*.{ts,tsx}",
        // UI framework components
        "src/ui/components/**/*.{ts,tsx}",
        "src/ui/controls/**/*.{ts,tsx}",
        "src/ui/core/**/*.{ts,tsx}",
        "src/ui/stores/**/*.{ts,tsx}",
        // Type guards and utilities
        "src/types/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/index.ts",
        // Exclude complex visual components that need E2E testing
        "**/CharacterPreview.tsx",
        "**/Minimap.tsx",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    // Timeout for async operations
    testTimeout: 10000,
    // jsdom + forks trips ERR_REQUIRE_ASYNC_MODULE in CI on newer Vitest.
    // Keep the browser-like environment, but use thread workers instead.
    pool: "threads",
  },
  resolve: {
    alias: {
      // Path alias to match vite.config.ts
      "@": path.resolve(__dirname, "src"),
      // Use actual shared package - per project rules, no mocks allowed
      // Tests should use real Hyperia instances with Playwright
      "@hyperforge/shared": path.resolve(
        __dirname,
        "../shared/build/framework.client.js",
      ),
    },
  },
});
