#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Launch asset byte reader requires an absolute file path");
  process.exit(1);
}

try {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error("path is not a regular file");
  }

  const bytes = readFileSync(filePath);
  if (stat.size <= 0 || bytes.length <= 0) {
    throw new Error(`asset is empty (${bytes.length}/${stat.size} bytes)`);
  }
  if (bytes.length !== stat.size) {
    throw new Error(
      `asset body is incomplete (${bytes.length}/${stat.size} bytes)`,
    );
  }

  console.log(
    JSON.stringify({
      statSize: stat.size,
      bytesRead: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "unknown launch asset read error",
  );
  process.exit(1);
}
