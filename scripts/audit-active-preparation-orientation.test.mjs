import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  angularDeviationDegrees,
  rotateVectorByQuaternion,
  validateOrientationAuthority,
} from "./audit-active-preparation-orientation.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const authority = JSON.parse(
  readFileSync(
    path.join(
      workspaceRoot,
      "scripts/active-preparation-orientation-authority.json",
    ),
    "utf8",
  ),
);

test("accepts the exact 17-item active preparation orientation authority", () => {
  const result = validateOrientationAuthority(authority);
  assert.equal(result.families.length, 7);
  assert.equal(
    result.families.reduce((sum, family) => sum + family.itemIds.length, 0),
    17,
  );
  assert.equal(
    result.families.reduce((sum, family) => sum + family.phases.length, 0),
    47,
  );
  assert.deepEqual(
    result.families
      .flatMap((family) => family.phases)
      .filter((phase) => phase.runtimeMotionRole === "retrieve")
      .map((phase) => phase.id),
    [
      "net-retrieve-approach",
      "net-retrieve-contact",
      "net-retrieve-lift",
      "net-retrieve-standing",
      "pot-retrieve-approach",
      "pot-retrieve-contact",
      "pot-retrieve-lift",
      "pot-retrieve-standing",
    ],
  );
});

test("rotates source axes with normalized browser quaternions", () => {
  const half = Math.sqrt(0.5);
  const result = rotateVectorByQuaternion([1, 0, 0], [0, 0, half, half]);
  assert.ok(Math.abs(result[0]) < 1e-12);
  assert.ok(Math.abs(result[1] - 1) < 1e-12);
  assert.ok(Math.abs(result[2]) < 1e-12);
});

test("measures directed and bidirectional action-axis deviations", () => {
  assert.equal(angularDeviationDegrees([1, 0, 0], [1, 0, 0]), 0);
  assert.equal(angularDeviationDegrees([1, 0, 0], [-1, 0, 0]), 180);
  assert.equal(angularDeviationDegrees([1, 0, 0], [-1, 0, 0], true), 0);
});

test("rejects incomplete or weakened orientation authorities", () => {
  assert.throws(
    () =>
      validateOrientationAuthority({
        ...authority,
        maximumOrientationDeviationDegrees: 1,
      }),
    /authority is invalid/u,
  );
  assert.throws(
    () =>
      validateOrientationAuthority({
        ...authority,
        families: authority.families.slice(1),
      }),
    /authority is invalid/u,
  );
  assert.throws(
    () =>
      validateOrientationAuthority({
        ...authority,
        families: authority.families.map((family, index) =>
          index === 0
            ? {
                ...family,
                phases: [
                  {
                    ...family.phases[0],
                    expectedActionAxis: [0, 0, 0],
                  },
                  ...family.phases.slice(1),
                ],
              }
            : family,
        ),
      }),
    /must be normalized/u,
  );
});
