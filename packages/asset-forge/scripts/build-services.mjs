#!/usr/bin/env node

/**
 * Build script to compile TypeScript services for server-side use
 */

import { execFileSync } from "node:child_process";

console.log("🔨 Building TypeScript services...");

try {
  // Keep the build contract checked in and reviewable. The previous script
  // rewrote/deleted tsconfig.services.json at runtime and left it behind on a
  // failed compiler process, making identical runs depend on the prior exit.
  execFileSync("bunx", ["tsc", "-p", "tsconfig.services.json"], {
    stdio: "inherit",
  });
  console.log("✅ TypeScript services built successfully!");
} catch (error) {
  console.error("❌ Build failed:", error);
  process.exitCode = 1;
}
