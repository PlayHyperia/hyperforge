import { defineConfig } from "vite";
import { resolve } from "path";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: resolve(import.meta.dirname, "tsconfig.build.json"),
      include: ["src/lib/**/*.ts", "src/index.ts"],
      outDir: "dist",
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        // Viewer excluded from lib build due to WIP WebGPU support
        // 'viewer/index': resolve(__dirname, 'src/viewer/index.ts'),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => {
        // Externalize all three.js imports (including subpath exports and node_modules resolution)
        if (
          id === "three" ||
          id.startsWith("three/") ||
          id.includes("node_modules/three/")
        ) {
          return true;
        }
        // Other external dependencies
        if (["tweakpane", "troika-three-text"].includes(id)) {
          return true;
        }
        return false;
      },
      output: {
        preserveModules: true,
        preserveModulesRoot: "src",
        // Ensure external imports don't get rewritten to relative paths
        paths: (id) => {
          // Map any three.js internal path back to proper import
          if (id.includes("node_modules") && id.includes("three")) {
            if (id.includes("three.tsl")) {
              return "three/tsl";
            }
            if (id.includes("webgpu")) {
              return "three/webgpu";
            }
            return "three";
          }
          return id;
        },
      },
    },
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
  },
});
