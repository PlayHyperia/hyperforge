import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DUEL_AVATAR_CANDIDATES } from "./build-duel-avatar-candidates.mjs";
import { buildDuelAvatarSourceInventory } from "./inventory-duel-avatar-sources.mjs";

test("inventories every immutable VRM source and detects manifest drift", async () => {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const outputPath = path.join(
    mkdtempSync(path.join(tmpdir(), "hyperia-vrm-inventory-")),
    "source-inventory.json",
  );

  const inventory = await buildDuelAvatarSourceInventory({
    assetsRoot,
    outputPath,
  });
  assert.equal(inventory.totals.sources, 22);
  assert.equal(
    inventory.totals.selectedTechnicalCandidates,
    DUEL_AVATAR_CANDIDATES.length,
  );
  assert.equal(inventory.totals.validatorErrors, 44);
  assert.deepEqual(inventory.totals.validatorErrorCodes, {
    UNDECLARED_EXTENSION: 44,
  });
  assert.equal(inventory.totals.missingRequiredBones, 0);
  assert.equal(inventory.totals.embeddedRightsCompatible, 0);
  assert.equal(
    inventory.candidates.some((candidate) =>
      candidate.source.startsWith("avatars/duel-candidates/"),
    ),
    false,
  );
  assert.equal(
    inventory.candidates.every(
      (candidate) =>
        candidate.lods.length === 1 &&
        candidate.lods[0].asset === candidate.source &&
        candidate.validator.errors === 2 &&
        candidate.validator.messages
          .filter((issue) => issue.severity === 0)
          .every((issue) => issue.code === "UNDECLARED_EXTENSION"),
    ),
    true,
  );

  await buildDuelAvatarSourceInventory({
    assetsRoot,
    outputPath,
    check: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), inventory);
});
