/**
 * PhysXManager.server.ts - Server-Side PhysX WASM Loading
 *
 * This module handles Node.js-specific WASM loading for PhysX.
 * It is dynamically imported by PhysXManager.ts only in Node.js environments,
 * ensuring browser bundles don't include Node.js modules.
 *
 * Why Separate File:
 * - Bundlers (Vite, Webpack) can't handle Node.js modules in browser builds
 * - Dynamic import with computed path prevents bundler from trying to include this
 * - Keeps Node.js dependencies isolated from browser code
 *
 * Loading Strategy:
 * 1. Production reads WASM beside the resolved PhysX JavaScript package entry.
 * 2. Development supports local assets and CDN/temp-cache fallback.
 * 3. Provides buffer to PhysX via wasmBinary option (bypasses locateFile).
 *
 * Referenced by: PhysXManager.loadPhysXInternal() in Node.js environments only
 */

/**
 * Load PhysX WASM Binary for Node.js
 *
 * Production must use the same package bound by the competitive build identity.
 * A working-directory asset or persistent temporary cache cannot replace it.
 * Development may use local assets followed by CDN fetching with caching.
 *
 * @returns Buffer containing physx-js-webidl.wasm binary
 * @throws Error if WASM file cannot be loaded from any source
 */
export async function loadPhysXWasmForNode(): Promise<Buffer> {
  const { readFileSync, writeFileSync, existsSync, mkdirSync } =
    await import("node:fs");
  if (process.env["NODE_ENV"] === "production") {
    const entry = new URL(import.meta.resolve("@hyperforge/physx-js-webidl"));
    if (
      entry.protocol !== "file:" ||
      !entry.pathname.endsWith("/physx-js-webidl.js")
    ) {
      throw new Error(
        "[PhysXManager] Unsupported production PhysX package entry",
      );
    }
    return readFileSync(new URL("./physx-js-webidl.wasm", entry));
  }
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  // Try local paths first (for development, CI, and direct workspace access)
  const localPaths = [
    // Built package location (CI builds here)
    join(process.cwd(), "../physx-js-webidl/dist/physx-js-webidl.wasm"),
    join(
      process.cwd(),
      "../../packages/physx-js-webidl/dist/physx-js-webidl.wasm",
    ),
    // Node modules (installed package)
    join(
      process.cwd(),
      "node_modules/@hyperforge/physx-js-webidl/dist/physx-js-webidl.wasm",
    ),
    join(
      process.cwd(),
      "../../node_modules/@hyperforge/physx-js-webidl/dist/physx-js-webidl.wasm",
    ),
    // Workspace root assets
    join(process.cwd(), "assets/web/physx-js-webidl.wasm"),
    join(process.cwd(), "../../assets/web/physx-js-webidl.wasm"),
    join(process.cwd(), "../../../assets/web/physx-js-webidl.wasm"),
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      const wasmBuffer = readFileSync(path);
      return wasmBuffer;
    }
  }

  // Fall back to CDN fetch with caching

  // Check cache first
  const cacheDir = join(tmpdir(), "hyperia-cache");
  const cachePath = join(cacheDir, "physx-js-webidl.wasm");

  if (existsSync(cachePath)) {
    const wasmBuffer = readFileSync(cachePath);
    return wasmBuffer;
  }

  // Fetch from CDN (PORT is typically 5555 in dev)
  const port = process.env["PORT"] || "5555";
  const cdnUrl =
    process.env["PUBLIC_CDN_URL"] || `http://localhost:${port}/game-assets`;
  const wasmUrl = `${cdnUrl}/web/physx-js-webidl.wasm`;

  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(
      `[PhysXManager] Failed to fetch WASM from CDN: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const wasmBuffer = Buffer.from(arrayBuffer);

  // Cache for future use
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, wasmBuffer);

  return wasmBuffer;
}
