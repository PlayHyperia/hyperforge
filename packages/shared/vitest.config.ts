import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

/**
 * Dynamically generate aliases from @hyperforge/procgen package.json exports
 * This ensures vitest can resolve workspace package subpath imports automatically
 * without manual maintenance when new exports are added.
 */
function generateProcgenAliases(): Array<{
  find: string;
  replacement: string;
}> {
  const procgenPkgPath = path.resolve(
    import.meta.dirname,
    "../procgen/package.json",
  );
  const aliases: Array<{ find: string; replacement: string }> = [];

  try {
    const pkgJson = JSON.parse(fs.readFileSync(procgenPkgPath, "utf-8"));
    const exports = pkgJson.exports || {};

    // Sort by path length descending (more specific first)
    const exportPaths = Object.keys(exports).sort(
      (a, b) => b.length - a.length,
    );

    for (const exportPath of exportPaths) {
      const exportConfig = exports[exportPath];
      const importPath =
        typeof exportConfig === "string"
          ? exportConfig
          : exportConfig?.import || exportConfig?.default;

      if (!importPath) continue;

      // Convert export path to package import path
      // "." -> "@hyperforge/procgen"
      // "./building" -> "@hyperforge/procgen/building"
      const packagePath =
        exportPath === "."
          ? "@hyperforge/procgen"
          : `@hyperforge/procgen${exportPath.slice(1)}`;

      // Convert relative import to absolute path
      const absolutePath = path.resolve(
        import.meta.dirname,
        "../procgen",
        importPath,
      );

      aliases.push({
        find: packagePath,
        replacement: absolutePath,
      });
    }
  } catch (error) {
    console.warn(
      "[vitest.config] Failed to read procgen package.json, using fallback aliases:",
      error,
    );
    // Fallback to minimal required aliases
    return [
      {
        find: "@hyperforge/procgen",
        replacement: path.resolve(
          import.meta.dirname,
          "../procgen/dist/index.js",
        ),
      },
    ];
  }

  return aliases;
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "src/**/*.test.ts",
        "**/*.d.ts",
        "**/*.config.*",
      ],
    },
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"],
    watchExclude: ["**/node_modules/**", "**/dist/**", "**/build/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: [
      // Auto-generated procgen aliases (sorted by specificity)
      ...generateProcgenAliases(),
      // Local src alias
      {
        find: "@",
        replacement: path.resolve(import.meta.dirname, "./src"),
      },
    ],
  },
});
