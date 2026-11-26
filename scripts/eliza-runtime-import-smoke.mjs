#!/usr/bin/env node

import { EXPECTED_ELIZA_RUNTIME_VERSIONS } from "./eliza-runtime-pin-policy.mjs";

const loaded = [];
for (const [name, version] of Object.entries(EXPECTED_ELIZA_RUNTIME_VERSIONS)) {
  const module = await import(name);
  const exportCount = Object.keys(module).length;
  if (exportCount === 0) {
    throw new Error(`${name}@${version} loaded without any exports`);
  }
  loaded.push({ name, version, exportCount });
}

console.log(JSON.stringify({ ok: true, loaded }, null, 2));
