import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseGlbJson, summarizeVrmDocument } from "./audit-avatar-lods.mjs";
import {
  allocatePrimitiveTriangleBudgets,
  optimizeVrmLod,
} from "./optimize-vrm-lod.mjs";
import validator from "gltf-validator";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturePath = path.join(
  workspaceRoot,
  "packages/server/world/assets/avatars/steve.vrm",
);

test("preserves VRM rig and rights metadata while optimizing an immutable source", async () => {
  const source = readFileSync(fixturePath);
  const sourceDocument = parseGlbJson(source, fixturePath);
  const sourceSummary = summarizeVrmDocument(sourceDocument, source);
  const result = await optimizeVrmLod(source, {
    maxTriangles: 1_800,
    maxTextureSize: 256,
    source: fixturePath,
  });
  const outputDocument = parseGlbJson(result.output, "optimized fixture");
  const outputSummary = summarizeVrmDocument(outputDocument, result.output);
  const validation = await validator.validateBytes(
    new Uint8Array(result.output),
    {
      uri: "optimized-fixture.vrm",
      format: "glb",
      writeTimestamp: false,
      maxIssues: 0,
    },
  );

  assert.ok(result.output.length < source.length / 4);
  assert.ok(outputSummary.triangles <= 1_800);
  assert.equal(outputSummary.vrmSpecVersion, sourceSummary.vrmSpecVersion);
  assert.deepEqual(outputSummary.humanBoneNames, sourceSummary.humanBoneNames);
  assert.deepEqual(outputSummary.jointCounts, sourceSummary.jointCounts);
  assert.equal(outputSummary.rigFingerprint, sourceSummary.rigFingerprint);
  assert.equal(
    result.report.outputRigFingerprint,
    result.report.sourceRigFingerprint,
  );
  assert.deepEqual(outputSummary.license, sourceSummary.license);
  assert.equal(outputDocument.images.length, 1);
  assert.equal(outputDocument.images[0].uri, undefined);
  assert.ok(Number.isInteger(outputDocument.images[0].bufferView));
  assert.equal(outputDocument.images[0].mimeType, "image/png");
  assert.deepEqual(outputSummary.textureDimensions, [
    { width: 256, height: 256 },
  ]);
  assert.equal(result.report.sourceSha256.length, 64);
  assert.equal(result.report.outputSha256.length, 64);
  assert.equal(validation.issues.numErrors, 0);

  const secondPass = await optimizeVrmLod(result.output, {
    maxTriangles: 1_800,
    maxTextureSize: 128,
    source: "optimized buffer-view fixture",
  });
  const secondSummary = summarizeVrmDocument(
    parseGlbJson(secondPass.output, "second-pass fixture"),
    secondPass.output,
  );
  assert.deepEqual(secondSummary.textureDimensions, [
    { width: 128, height: 128 },
  ]);
  assert.equal(secondPass.report.imageDetails[0].optimized, true);
  assert.ok(secondPass.output.length < result.output.length);
  const secondValidation = await validator.validateBytes(
    new Uint8Array(secondPass.output),
    {
      uri: "second-pass-fixture.vrm",
      format: "glb",
      writeTimestamp: false,
      maxIssues: 0,
    },
  );
  assert.equal(secondValidation.issues.numErrors, 0);
});

test("fails closed on unsafe output parameters", async () => {
  const source = readFileSync(fixturePath);
  await assert.rejects(
    optimizeVrmLod(source, {
      maxTriangles: 1_800,
      maxTextureSize: 300,
      source: fixturePath,
    }),
    /power of two/,
  );
  await assert.rejects(
    optimizeVrmLod(source, {
      maxTriangles: 1_800,
      maxTextureSize: 256,
      maxError: 0.5,
      source: fixturePath,
    }),
    /no larger than 0.1/,
  );
});

test("protects per-part error floors while distributing a global triangle budget", () => {
  const source = [622, 622, 1288, 84, 1082, 418, 428, 628, 628];
  const minimum = [244, 244, 430, 32, 370, 244, 252, 250, 250];
  const budgets = allocatePrimitiveTriangleBudgets(source, minimum, 3_000);

  assert.equal(
    budgets.reduce((sum, count) => sum + count, 0),
    3_000,
  );
  assert.ok(budgets.every((count, index) => count >= minimum[index]));
  assert.ok(budgets.every((count, index) => count <= source[index]));
  assert.deepEqual(
    allocatePrimitiveTriangleBudgets(source, minimum, 3_000),
    budgets,
  );
  assert.throws(
    () => allocatePrimitiveTriangleBudgets(source, minimum, 2_000),
    /minimum is 2316/,
  );
});
