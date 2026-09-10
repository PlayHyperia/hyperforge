#!/usr/bin/env bun

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyPrebuiltFiles } from "./copy-prebuilt-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const distDir = join(rootDir, "dist");
const sourceDir = join(rootDir, "..", "client", "public", "web");
const typesDir = join(rootDir, "types");

// Files to copy
const files = [
  {
    src: join(sourceDir, "physx-js-webidl.js"),
    dest: join(distDir, "physx-js-webidl.js"),
  },
  {
    src: join(sourceDir, "physx-js-webidl.wasm"),
    dest: join(distDir, "physx-js-webidl.wasm"),
  },
  {
    src: join(typesDir, "physx-js-webidl.d.ts"),
    dest: join(distDir, "physx-js-webidl.d.ts"),
  },
];

try {
  const result = copyPrebuiltFiles(files);
  console.log(
    `✓ PhysX prebuilt artifacts ready (${result.copied} copied, ${result.skipped} unchanged)`,
  );
} catch (error) {
  console.error(
    `ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
