#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

export const HYPERIA_NODE_VERSION = "22.23.2";
export const HYPERIA_NODE_TYPES_VERSION = "22.20.1";

export function assertHyperiaNodeVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^v/, "");

  if (normalized !== HYPERIA_NODE_VERSION) {
    const found = String(value || "").trim() || "an unknown version";
    throw new Error(
      `Hyperia requires Node.js ${HYPERIA_NODE_VERSION} exactly for its native runtime dependencies; found ${found}. Install the version pinned in .node-version or .nvmrc and retry.`,
    );
  }

  return HYPERIA_NODE_VERSION;
}

function isDirectInvocation() {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint &&
    import.meta.url === pathToFileURL(path.resolve(entrypoint)).href,
  );
}

if (isDirectInvocation()) {
  try {
    assertHyperiaNodeVersion(process.version);
    console.log(`[runtime] Node.js ${HYPERIA_NODE_VERSION} verified`);
  } catch (error) {
    console.error(
      `[runtime] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
