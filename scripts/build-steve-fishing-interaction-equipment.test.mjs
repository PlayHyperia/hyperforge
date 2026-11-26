import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSteveFishingInteractionEquipment } from "./build-steve-fishing-interaction-equipment.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("fits every unfinished fishing item to the canonical Steve body", async () => {
  const report = await buildSteveFishingInteractionEquipment(
    workspaceRoot,
    false,
  );
  assert.equal(report.avatar.id, "steve");
  assert.equal(report.browserVerification.loaded, true);
  assert.deepEqual(report.browserVerification.consoleErrors, []);
  assert.deepEqual(
    report.outputs.map((output) => output.itemId),
    ["fly_fishing_rod", "small_fishing_net", "lobster_pot"],
  );
  for (const output of report.outputs) {
    assert.equal(output.attachmentBone, "rightHand");
    assert.equal(output.fittedWorldPositionErrorMetres, 0);
    assert.ok(output.fittedWorldRotationErrorDegrees < 0.0001);
    assert.deepEqual(output.validator, {
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
    });
  }
});
