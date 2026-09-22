import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  groundGrassBladeSteps,
  GrassBladeGroundingJob,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import { getGrassBladeLayout } from "../GrassBladeLayout";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  RetainedTerrainSurface,
  type TerrainCellTopology,
} from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  createSameFaceCase,
  drainSameFaceSteps,
  INDEXED_SAME_FACE_CASES,
  SAME_FACE_CASES,
  sameFaceHash,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import { groundGrassBladeSteps as legacyGroundGrassBladeSteps } from "./fixtures/LegacyGrassBladeGroundingReference";

/** The existing small indexed goldens have no qualified eight-face blocks.
 * Use the real four-cell subdivision from TerrainGridSurface's edge tests:
 * 32 faces/cell, shared vertex identities, and genuinely nonplanar heights. */
function createDenseIndexedBatchCase(
  variant: "nonplanar" | "skinny" | "translated" = "nonplanar",
) {
  const fixture = createSameFaceCase("fine-lod0"),
    geometry = gridGeometry(2, 3, (x, z) => 20 + x * z),
    values = Array.from(geometry.getAttribute("position").array),
    ids = new Map<string, number>(),
    indices: number[] = [],
    offsets = [0];
  fixture.geometries.push(geometry);
  for (let id = 0; id < 9; id++)
    ids.set(`${values[id * 3]},${values[id * 3 + 2]}`, id);
  const vertex = (x: number, z: number) => {
    const key = `${x},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = values.length / 3;
      ids.set(key, id);
      values.push(x, 20 + x * z + Math.sin(x * 5 + z * 3) * 0.2, z);
    }
    return id;
  };
  for (let cellZ = 0; cellZ < 2; cellZ++)
    for (let cellX = 0; cellX < 2; cellX++) {
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 4; x++) {
          const x0 = -1 + cellX + x / 4,
            z0 = -1 + cellZ + z / 4,
            a = vertex(x0, z0),
            b = vertex(x0 + 0.25, z0),
            c = vertex(x0, z0 + 0.25),
            d = vertex(x0 + 0.25, z0 + 0.25);
          indices.push(a, c, b, b, c, d);
        }
      offsets.push(indices.length);
    }
  if (variant === "skinny")
    for (let id = 9; id < values.length / 3; id++)
      if (values[id * 3] === -0.75) values[id * 3] = Math.fround(-1 + 2 ** -24);
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(values), 3),
  );
  geometry.setIndex(indices);
  geometry.userData.terrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 3,
    cellIndexOffsets: Object.freeze(offsets),
    surfaceVertexCount: values.length / 3,
  } satisfies TerrainCellTopology);
  const surface = new RetainedTerrainSurface(
    101,
    "same-face-numerical-v1",
    variant === "translated" ? 350 : 0,
    variant === "translated" ? -450 : 0,
    2,
    3,
    geometry,
  );
  fixture.owned.splice(0, fixture.owned.length, { surface, geometry });
  const { request } = fixture;
  request.ownSurface = surface;
  request.surfaces = [surface];
  for (let i = 0; i < request.data.count; i++) {
    request.data.offsets.set(
      [i % 2 ? 0.5 : -0.5, 20, i < 2 ? -0.5 : 0.5],
      i * 3,
    );
    request.data.rotScaleHash[i * 3 + 1] = 0.25;
  }
  request.data = projectGrassAnchors(
    request.data,
    surface,
    () => -1000,
    () => false,
  );
  request.wind = { x: 0.01, z: 0.005 };
  return fixture;
}

/** Stop at the first indexed cursor yield without replacing any method.
 * After staging: one clump, N base blades, one owner filter, two endpoints,
 * one edge owner, then its first indexed step. All cells here are refined. */
function advanceToIndexedYield(
  job: GrassBladeGroundingJob,
  fixture: ReturnType<typeof createDenseIndexedBatchCase>,
) {
  while (
    job.state.status === "running" &&
    job.lastPhase !== "bounded_staging_allocation"
  )
    job.advance(1);
  expect(job.state.status).toBe("running");
  expect(job.lastPhase).toBe("bounded_staging_allocation");
  const blades = getGrassBladeLayout(
    fixture.request.lod,
    fixture.request.geometryLayout,
  ).bladesPerClump;
  for (const phase of [
    "anchor_surface",
    ...Array.from({ length: blades }, () => "blade_base_bounds"),
    "blade_base_owner",
    "endpoint_owner",
    "endpoint_owner",
    "edge_owner",
    "edge_triangle_batch",
  ]) {
    const operations = job.operations;
    job.advance(1);
    expect(job.state.status).toBe("running");
    expect(job.operations).toBe(operations + 1);
    expect(job.lastPhase).toBe(phase);
  }
  return { operations: job.operations, workBeforeFirstStep: blades * 2 + 5 };
}

/** Independent pre-shortcut oracle, not a helper which calls the current core.
 * Captured from native25's immutable 44,628-byte GrassBladeGrounding.ts:
 * SHA256 0105f0196355204864622ca8a884e66ac7c95ec28b5242e4e11ef8d369bc7de5.
 * The archived source was transpiled in memory and its four numeric imports
 * verified against native25 pins. TerrainGridSurface's insertion-only new API
 * was removed for byte verification; the old core never calls that API.
 * Tests need only this repository: no archive paths, dynamic source patching,
 * timing mocks, browser doubles or tolerance widening. These are Node22/V8
 * goldens independently derived from the archived core under that runtime.
 * Bun/JSC also produced exact old/current equality, but two hashes differ
 * across engines: dense-flat ed4fed3e282b781e437f887a96da810e2d5f37045906f04f8f7d3aed5e41ce40;
 * cell-boundaries 520992c931c3afb60405e9858c2eca76944b48e027ccf414da762c749f917a82.
 * Hashes include raw typed-array bytes, roots, source indices, bounds, ordered
 * dependency identities/uses and every semantic receipt field. Only elapsed
 * time, work counters and the new sameFaceEdges diagnostic are excluded.
 * Counters below are historical measurements, never current-output claims.
 */
const NATIVE25: Record<
  SameFaceCase,
  {
    hash: string;
    operations: number;
    workUnits: number;
    triangleVisits: number;
  }
> = {
  "ordinary-lod0": {
    hash: "6c323dfb5db93d64e3fb060856d23e7bf52cb632ee8dca296d22678f1edfbb10",
    operations: 2356,
    workUnits: 2038,
    triangleVisits: 196,
  },
  "ordinary-lod1": {
    hash: "986b7ebbc2c79419cb8deca43ed6a7c331c2144a202b87fa25f026df163a76a9",
    operations: 972,
    workUnits: 834,
    triangleVisits: 96,
  },
  "ordinary-lod2": {
    hash: "a82533957830310fe165b866965922709013ea23d351969f922ec996f552cf44",
    operations: 276,
    workUnits: 226,
    triangleVisits: 32,
  },
  "fine-lod0": {
    hash: "318f6ff93aba5c163377646fdaac5083642db5c2b1c5597aecdd525515495653",
    operations: 2357,
    workUnits: 2039,
    triangleVisits: 196,
  },
  "fine-lod1": {
    hash: "01b869b88b5eb29df59f875bad8a728952d97069c1d327ad09de9e29465ec15d",
    operations: 973,
    workUnits: 835,
    triangleVisits: 96,
  },
  "fine-lod2": {
    hash: "780587ce2848f5045a0469bb8e333d0a0519e8d386502ab9851746fc59559250",
    operations: 277,
    workUnits: 227,
    triangleVisits: 32,
  },
  "fine-near4": {
    hash: "7819e7ee02ed0a3e16cdef23d14eec82fae64b84f20a5760f8197e6870de3f1c",
    operations: 2789,
    workUnits: 2423,
    triangleVisits: 196,
  },
  "fine-dense-flat": {
    hash: "9bf9f69d0fc8a9265fb7bc73bddeabcfa12682d26ce3c7b31ebc3abbcd607575",
    operations: 14395,
    workUnits: 32554,
    triangleVisits: 3096,
  },
  "fine-dense-plane": {
    hash: "f564efb5eaceb91330dbd9aee8dbd1c52fef6f959610594ba3c88f8b92fe1302",
    operations: 14397,
    workUnits: 32556,
    triangleVisits: 3098,
  },
  "fine-dense-nonplanar": {
    hash: "275ed2c72a9e585f500c565b2533051670340f20458b643840ee3af357e45973",
    operations: 14375,
    workUnits: 32552,
    triangleVisits: 3094,
  },
  "regular-cell-boundaries": {
    hash: "606f9dc4d6715969c8b6c973c8f8b6d50613714d91bf3875419a2e679e9ab403",
    operations: 2386,
    workUnits: 2038,
    triangleVisits: 198,
  },
  "regular-diagonal-boundaries": {
    hash: "caa3c4405969f165dec4296956a55ce89e0370f51f7fd86b6f055f4372297499",
    operations: 2362,
    workUnits: 2044,
    triangleVisits: 192,
  },
  "refined-interiors": {
    hash: "c3298b1a3564ede23c1f719725d24d3cbf5e6cf9ec2c8b47b375e81233a4d715",
    operations: 2756,
    workUnits: 2760,
    triangleVisits: 456,
  },
  "refined-boundaries": {
    hash: "fe1d27431767848e401f74fe3c1159a6e7dc6ea9a5fe4d974c9616a2a16905c4",
    operations: 3184,
    workUnits: 3474,
    triangleVisits: 696,
  },
  "refined-skinny-neighbor": {
    hash: "ba10bbca64e7b45bdc43a3e461cd5d6ac8ab4a6834550e44cacb6b4dbbe770d0",
    operations: 2365,
    workUnits: 1749,
    triangleVisits: 360,
  },
  "adjacent-owners": {
    hash: "dd6368fb7cdcf4009bd6a7b53ef0abdc42fa8255ca7c6b703d619ec516a4a3f4",
    operations: 2297,
    workUnits: 1657,
    triangleVisits: 148,
  },
  "adjacent-reversed": {
    hash: "dd6368fb7cdcf4009bd6a7b53ef0abdc42fa8255ca7c6b703d619ec516a4a3f4",
    operations: 2347,
    workUnits: 1707,
    triangleVisits: 148,
  },
  "missing-neighbor": {
    hash: "8e64e6414c5517023e27c3d1719cae865fca21c714c3e5a9e4f6d453085226d0",
    operations: 1575,
    workUnits: 51,
    triangleVisits: 0,
  },
  "overlapping-owners": {
    hash: "34e8b6bc19ab242816fbd30336215823d20a7a095524c9e3ab0973bc924f89c8",
    operations: 2032,
    workUnits: 625,
    triangleVisits: 98,
  },
  "mixed-exclusions": {
    hash: "3247fec1dd3b23405cc724515b17bfb652415198bb92a4314454225c16c9fd94",
    operations: 2575,
    workUnits: 2566,
    triangleVisits: 244,
  },
  "terrain-edge-rejection": {
    hash: "fd9f21bcab87024e8c2b0edc1403077ea59e918461ea81e6c3fef9927c35d288",
    operations: 688,
    workUnits: 213,
    triangleVisits: 30,
  },
  empty: {
    hash: "62e0986fe91bed5aa79b8a7fbb21cfdf3b63a59f8a5a51ba64351241183ea5d7",
    operations: 1541,
    workUnits: 0,
    triangleVisits: 0,
  },
  "budget-one": {
    hash: "69afb0fc7a20b4cc1a9b4ff15edab5b2e2c6b57b76d7d0266a2557ff37739c93",
    operations: 1551,
    workUnits: 1,
    triangleVisits: 0,
  },
  "indexed-canonical-interiors": {
    hash: "171e6530a4cf70ff8adb400ae475d6ec79a099ed1b4a75728c845926c64690ed",
    operations: 7893,
    workUnits: 16256,
    triangleVisits: 1536,
  },
  "indexed-mixed-canonical": {
    hash: "ff793d4704f89941dae21c58bfbeeb083ade70edd60da017c0cc04c3980f5684",
    operations: 2345,
    workUnits: 2039,
    triangleVisits: 192,
  },
  "indexed-shifted-canonical": {
    hash: "b17d1b16acc7707c6487c220886af02ec50bbbb01da57a97b56ddadc34e64b86",
    operations: 2734,
    workUnits: 3048,
    triangleVisits: 288,
  },
  "indexed-refined-only": {
    hash: "fb97b9eef4bf0d0bdecae69bcc784171202114fb88d2a3e43d0dec411ac29707",
    operations: 2357,
    workUnits: 1741,
    triangleVisits: 360,
  },
  "indexed-cell-boundaries": {
    hash: "61b52bac762e27b8c4e37fe5b15c4013772626c5e944f6442523dec9cda5df26",
    operations: 2748,
    workUnits: 3056,
    triangleVisits: 290,
  },
  "indexed-diagonal-boundaries": {
    hash: "28d405912602486c94eac4fc85904697242c045599f7563d7b3955b4d783b137",
    operations: 2149,
    workUnits: 1533,
    triangleVisits: 144,
  },
  "indexed-translated-canonical": {
    hash: "6102d985a1a5ef5a13dce574157a5ecebc03e8704e823d5fa80bf38b4441c882",
    operations: 2340,
    workUnits: 2034,
    triangleVisits: 192,
  },
};

describe("same-face shortcut versus independent native25 grounding goldens", () => {
  it.each([1, 7])(
    "keeps repeated road and surface scratch private across interleaved %s-step jobs",
    (batch) => {
      const fixtures = [
        createSameFaceCase("fine-lod0"),
        createSameFaceCase("ordinary-lod1"),
        createSameFaceCase("adjacent-reversed"),
        createSameFaceCase("overlapping-owners"),
      ];
      try {
        for (const [index, item] of fixtures.slice(0, 2).entries()) {
          const { request } = item;
          // Two separated road hits must both be tested, even though each uses
          // the same road indices/grid cells. Intervening clumps remain clear.
          for (let clump = 0; clump < request.data.count; clump++)
            request.data.offsets.set(
              [clump % 2 === 0 ? 0 : 8, 20, -12 + clump * 8],
              clump * 3,
            );
          request.data = projectGrassAnchors(
            request.data,
            request.ownSurface,
            () => -1000,
            () => false,
          );
          request.roadSegments = [
            { startX: 0, startZ: -40, endX: 0, endZ: 40, width: 4 },
            { startX: 0, startZ: -40, endX: 0, endZ: 40, width: 4 },
          ];
          if (index === 1) request.roadClearance = "per-blade-v1";
        }
        const rows = fixtures.map((item, fixtureIndex) => {
          const before = sameFaceInputHash(item);
          const reference = drainSameFaceSteps(
            legacyGroundGrassBladeSteps(item.request),
          ).result;
          const trace: string[] = [];
          const serialSteps = groundGrassBladeSteps(item.request);
          const serial = drainSameFaceSteps(
            (function* () {
              for (;;) {
                const step = serialSteps.next();
                if (step.done) return step.value;
                trace.push(step.value);
                yield step.value;
              }
            })(),
          );
          expect(sameFaceHash(serial.result)).toBe(sameFaceHash(reference));
          const position = item.request.geometry.getAttribute("position");
          let zeroHeightVertices = 0;
          for (let vertex = 0; vertex < position.count; vertex++)
            if (position.getY(vertex) === 0) zeroHeightVertices++;
          // The overlapping-owner fixture defers after its first complete
          // envelope but before processedClumps is incremented. Preserve all
          // historical charges except zero-height fade work and the new
          // coverage proof. The reversed two-owner case skips one pair per
          // envelope after one proof. The three-owner overlapping case checks
          // the touching pair, then finds the overlap on its second proof pair
          // and deliberately keeps the original rejection path.
          const envelopes =
            serial.result.receipt.processedClumps +
            Number(serial.result.status === "defer");
          const proofPairs =
            fixtureIndex === 3 ? 2 : fixtureIndex === 2 ? 1 : 0;
          expect(
            trace.filter((phase) => phase === "coverage_owner_pair"),
          ).toHaveLength(proofPairs);
          const skippedOverlapChecks = fixtureIndex === 2 ? envelopes : 0;
          expect(serial.result.receipt.workUnits).toBe(
            reference.receipt.workUnits -
              zeroHeightVertices * envelopes +
              proofPairs -
              skippedOverlapChecks,
          );
          if (serial.result.status === "ready" && reference.status === "ready")
            expect(serial.result.bladeVisibility).toEqual(
              reference.bladeVisibility,
            );
          return {
            item,
            before,
            serial,
            trace,
            steps: groundGrassBladeSteps(item.request),
            observed: [] as string[],
            result: null as GrassBladeGroundingResult | null,
            resumptions: 0,
          };
        });
        for (let round = 0; round < 100_000; round++) {
          if (rows.every((row) => row.result !== null)) break;
          for (const row of rows)
            for (let stepIndex = 0; stepIndex < batch; stepIndex++) {
              if (row.result !== null) break;
              const step = row.steps.next();
              row.resumptions++;
              if (step.done) row.result = step.value;
              else row.observed.push(step.value);
            }
        }
        for (const row of rows) {
          if (!row.result) throw Error("Interleaved grounding did not finish");
          const { elapsedMs: _elapsed, ...receipt } = row.result.receipt;
          const { elapsedMs: _serialElapsed, ...serialReceipt } =
            row.serial.result.receipt;
          expect({ ...row.result, receipt }).toEqual({
            ...row.serial.result,
            receipt: serialReceipt,
          });
          expect(row.observed).toEqual(row.trace);
          expect(row.resumptions).toBe(row.serial.operations);
          expect(sameFaceInputHash(row.item)).toBe(row.before);
          for (const dependency of row.result.dependencies)
            expect(row.item.request.surfaces).toContain(dependency.surface);
        }
        for (const row of rows.slice(0, 2)) {
          expect(row.result?.receipt.processedClumps).toBe(4);
          expect(row.result?.receipt.rejected.road).toBe(2);
          expect(row.result?.receipt.retainedClumps).toBe(2);
        }
        expect(rows[2].result?.status).toBe("ready");
        expect(rows[2].result?.receipt.processedClumps).toBe(3);
        expect(rows[3].result).toMatchObject({
          status: "defer",
          reason: "overlapping_surface",
        });
      } finally {
        for (const item of fixtures) item.dispose();
      }
    },
  );

  it.each(SAME_FACE_CASES)(
    "preserves every semantic output byte for %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const before = sameFaceInputHash(fixture);
        const { result } = drainSameFaceSteps(
          groundGrassBladeSteps(fixture.request),
        );
        expect(sameFaceHash(result)).toBe(NATIVE25[id].hash);
        expect(sameFaceInputHash(fixture)).toBe(before);
        // The hash checks stable owner identity/order; verify actual borrowed
        // object identity too, so substituted owner objects cannot satisfy it.
        for (const dependency of result.dependencies)
          expect(dependency.surface).toBe(
            fixture.owned.find(
              ({ surface }) => surface.nodeId === dependency.surface.nodeId,
            )?.surface,
          );
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(["refined-skinny-neighbor", "indexed-refined-only"] as const)(
    "keeps exact indexed fallback work except duplicate zero-height fades for %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        expect(fixture.request.ownSurface.isRegularGrid).toBe(false);
        const { result, operations } = drainSameFaceSteps(
          groundGrassBladeSteps(fixture.request),
        );
        expect(result.receipt.sameFaceEdges).toBe(0);
        expect(operations).toBe(NATIVE25[id].operations);
        const position = fixture.request.geometry.getAttribute("position");
        let zeroHeightVertices = 0;
        for (let v = 0; v < position.count; v++)
          if (position.getY(v) === 0) zeroHeightVertices++;
        expect(result.receipt.workUnits).toBe(
          NATIVE25[id].workUnits -
            zeroHeightVertices * result.receipt.processedClumps,
        );
        expect(result.receipt.triangleVisits).toBe(NATIVE25[id].triangleVisits);
        expect(sameFaceHash(result)).toBe(NATIVE25[id].hash);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    "ordinary-lod0",
    "ordinary-lod1",
    "ordinary-lod2",
    "fine-lod0",
    "fine-lod1",
    "fine-lod2",
    "fine-near4",
  ] as const)(
    "preserves frozen signed-zero output with only the observed two-interval resumption savings: %s",
    (id) => {
      for (const zero of [0, -0])
        for (const wind of [
          { x: 0, z: 0 },
          { x: 0.4, z: 0.165 },
          { x: 0.9, z: 0.7 },
        ]) {
          const fixture = createSameFaceCase(id);
          try {
            const position = fixture.request.geometry.getAttribute("position");
            let zeroHeightVertices = 0;
            for (let v = 0; v < position.count; v++) {
              if (position.getY(v) !== 0) continue;
              position.setY(v, zero);
              expect(Object.is(position.getY(v), zero)).toBe(true);
              zeroHeightVertices++;
            }
            position.needsUpdate = true;
            fixture.request.wind = wind;
            const before = sameFaceInputHash(fixture);
            const legacy = drainSameFaceSteps(
              legacyGroundGrassBladeSteps(fixture.request),
            );
            let pairOrders = 0;
            const currentSteps = groundGrassBladeSteps(fixture.request);
            const current = drainSameFaceSteps(
              (function* () {
                for (;;) {
                  const step = currentSteps.next();
                  if (step.done) return step.value;
                  if (step.value === "interval_pair_order") pairOrders++;
                  yield step.value;
                }
              })(),
            );
            expect(legacy.result.status).toBe("ready");
            expect(current.result.status).toBe("ready");
            expect(sameFaceHash(current.result)).toBe(
              sameFaceHash(legacy.result),
            );
            expect(sameFaceInputHash(fixture)).toBe(before);
            // Each actual pair replaces one allocation, two merge and two
            // copy resumptions with one ordering resumption; no other saving
            // is admitted by this independent historical comparison.
            expect(current.operations).toBe(legacy.operations - 4 * pairOrders);
            expect(current.result.receipt.triangleVisits).toBe(
              legacy.result.receipt.triangleVisits,
            );
            expect(current.result.receipt.workUnits).toBe(
              legacy.result.receipt.workUnits -
                zeroHeightVertices * current.result.receipt.processedClumps,
            );
          } finally {
            fixture.dispose();
          }
        }
    },
  );

  it.each([0, -0])(
    "rereads mutable wind between swept-blade yields with initial wind %s",
    (zero) => {
      const fixture = createSameFaceCase("fine-lod0");
      try {
        const { request } = fixture,
          data = request.data,
          layout = getGrassBladeLayout(request.lod, request.geometryLayout);
        // One clump safely inside one flat triangle gives an independently
        // countable prefix: anchor, base blades, owner, two endpoints/blade.
        request.data = projectGrassAnchors(
          {
            count: 1,
            offsets: new Float32Array([-21, 20, -28]),
            rotScaleHash: data.rotScaleHash.slice(0, 3),
            groundColors: data.groundColors.slice(0, 3),
            grassTints: data.grassTints.slice(0, 4),
            groundNormals: data.groundNormals.slice(0, 3),
          },
          request.ownSurface,
          () => -1000,
          () => false,
        );
        const before = sameFaceInputHash(fixture),
          secondSweptBladeYield = 3 * layout.bladesPerClump + 4;
        const run = (
          ground:
            typeof groundGrassBladeSteps | typeof legacyGroundGrassBladeSteps,
          mutate: boolean,
        ) => {
          request.wind = { x: zero, z: zero };
          let staged = false,
            groundingYields = 0,
            mutations = 0;
          const steps = ground(request);
          const result = drainSameFaceSteps(
            (function* () {
              for (;;) {
                const step = steps.next();
                if (step.done) return step.value;
                if (step.value === "bounded_staging_allocation") staged = true;
                const isCurrent = ground === groundGrassBladeSteps;
                if (
                  staged &&
                  step.value ===
                    (isCurrent ? "blade_swept_bounds" : "grounding_operation")
                ) {
                  groundingYields++;
                  if (
                    mutate &&
                    groundingYields === (isCurrent ? 2 : secondSweptBladeYield)
                  ) {
                    request.wind.x = 0.9;
                    request.wind.z = 0.7;
                    mutations++;
                  }
                }
                yield step.value;
              }
            })(),
          );
          expect(result.result.receipt.sameFaceEdges).toBe(
            layout.bladesPerClump,
          );
          expect(result.result.receipt.triangleVisits).toBe(
            layout.bladesPerClump,
          );
          expect(mutations).toBe(mutate ? 1 : 0);
          expect(sameFaceInputHash(fixture)).toBe(before);
          return result;
        };
        const legacy = run(legacyGroundGrassBladeSteps, true),
          current = run(groundGrassBladeSteps, true),
          unchangedWind = run(groundGrassBladeSteps, false);
        if (
          legacy.result.status !== "ready" ||
          current.result.status !== "ready" ||
          unchangedWind.result.status !== "ready"
        )
          throw Error("Expected all swept-wind fixtures to remain grounded");
        expect(current.result.data.count).toBe(1);
        expect(sameFaceHash(current.result)).toBe(sameFaceHash(legacy.result));
        expect(current.operations).toBe(legacy.operations);
        expect(current.result.sweptBounds).not.toEqual(
          unchangedWind.result.sweptBounds,
        );
        const position = request.geometry.getAttribute("position");
        let zeroHeightVertices = 0;
        for (let v = 0; v < position.count; v++)
          if (position.getY(v) === 0) zeroHeightVertices++;
        expect(current.result.receipt.workUnits).toBe(
          legacy.result.receipt.workUnits - zeroHeightVertices,
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(INDEXED_SAME_FACE_CASES)(
    "uses a genuinely indexed owner for %s, never the whole-grid shortcut",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        expect(fixture.request.ownSurface.isRegularGrid).toBe(false);
        const topology = fixture.owned[0].geometry.userData.terrainCellTopology;
        expect(Object.isFrozen(topology)).toBe(true);
        expect(Object.isFrozen(topology.cellIndexOffsets)).toBe(true);
        if (id === "indexed-shifted-canonical") {
          // The first four-face fan shifts later canonical face IDs by two.
          expect(topology.cellIndexOffsets.slice(0, 4)).toEqual([
            0, 12, 18, 24,
          ]);
          const sample = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };
          expect(fixture.request.ownSurface.sample(-24, -53, sample)).toBe(
            true,
          );
          expect(sample.faceIndex).toBe(4);
        }
        if (id === "indexed-translated-canonical") {
          expect(fixture.request.ownSurface.centerX).toBe(4096);
          expect(fixture.request.ownSurface.centerZ).toBe(-2048);
        }
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    "indexed-canonical-interiors",
    "indexed-mixed-canonical",
    "indexed-shifted-canonical",
    "indexed-translated-canonical",
  ] as const)(
    "removes real traversal only from canonical indexed cells: %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const { result, operations } = drainSameFaceSteps(
          groundGrassBladeSteps(fixture.request),
        );
        expect(sameFaceHash(result)).toBe(NATIVE25[id].hash);
        expect(result.receipt.sameFaceEdges).toBeGreaterThan(0);
        expect(result.receipt.refinedSameFaceEdges).toBe(0);
        expect(result.receipt.triangleVisits).toBeLessThanOrEqual(
          NATIVE25[id].triangleVisits * 0.6,
        );
        expect(result.receipt.workUnits).toBeLessThan(NATIVE25[id].workUnits);
        expect(operations).toBeLessThan(NATIVE25[id].operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(["indexed-cell-boundaries", "indexed-diagonal-boundaries"] as const)(
    "keeps exact boundary anchors on the fallback beside distinct Float32 neighbors: %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const data = fixture.request.data;
        const coordinates = [data.offsets[0], data.offsets[3], data.offsets[6]];
        expect(new Set(coordinates).size).toBe(3);
        expect(coordinates[1]).toBeLessThan(coordinates[0]);
        expect(coordinates[2]).toBeGreaterThan(coordinates[0]);
        const bits = new Uint32Array(new Float32Array(coordinates).buffer);
        expect(bits[1]).toBe(bits[0] + 1);
        expect(bits[2]).toBe(bits[0] - 1);
        let fastNeighbor = false;
        for (let i = 0; i < data.count; i++) {
          const request = {
            ...fixture.request,
            data: {
              count: 1,
              offsets: data.offsets.slice(i * 3, i * 3 + 3),
              rotScaleHash: data.rotScaleHash.slice(i * 3, i * 3 + 3),
              groundColors: data.groundColors.slice(i * 3, i * 3 + 3),
              grassTints: data.grassTints.slice(i * 4, i * 4 + 4),
              groundNormals: data.groundNormals.slice(i * 3, i * 3 + 3),
            },
          };
          const { result } = drainSameFaceSteps(groundGrassBladeSteps(request));
          expect(result.status).toBe("ready");
          if (i % 3 === 0) expect(result.receipt.sameFaceEdges).toBe(0);
          else fastNeighbor ||= result.receipt.sameFaceEdges > 0;
        }
        expect(fastNeighbor).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    "fine-dense-flat",
    "fine-dense-plane",
    "fine-dense-nonplanar",
  ] as const)(
    "removes material geometric traversal without changing 64 retained clumps: %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const { result, operations } = drainSameFaceSteps(
          groundGrassBladeSteps(fixture.request),
        );
        expect(result.status).toBe("ready");
        if (result.status !== "ready") throw Error(result.reason);
        expect(result.data.count).toBe(64);
        expect(sameFaceHash(result)).toBe(NATIVE25[id].hash);
        expect(result.receipt.sameFaceEdges).toBeGreaterThan(0);
        // Work counters prove real removal of old cursor work, not a wall-time
        // benchmark or a claim about native scene FPS/startup qualification.
        expect(result.receipt.triangleVisits).toBeLessThanOrEqual(
          NATIVE25[id].triangleVisits * 0.6,
        );
        expect(result.receipt.workUnits).toBeLessThan(NATIVE25[id].workUnits);
        expect(operations).toBeLessThan(NATIVE25[id].operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    "fine-lod0",
    "fine-near4",
    "regular-cell-boundaries",
    "refined-skinny-neighbor",
    "adjacent-reversed",
    "indexed-shifted-canonical",
    "indexed-cell-boundaries",
    "indexed-translated-canonical",
  ] as const)(
    "preserves the independent result with one-operation scheduling: %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const before = sameFaceInputHash(fixture);
        const job = new GrassBladeGroundingJob(fixture.request, () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        );
        while (job.state.status === "running") {
          const operations = job.operations;
          job.advance(1);
          expect(job.lastSliceOperations).toBeLessThanOrEqual(1);
          expect(job.operations - operations).toBeLessThanOrEqual(1);
        }
        expect(job.state.status).toBe("ready");
        if (job.state.status !== "ready")
          throw Error(JSON.stringify(job.state));
        expect(sameFaceHash(job.state.result)).toBe(NATIVE25[id].hash);
        expect(job.operations).toBeLessThan(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(job.activeMs).toBeLessThan(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
        );
        expect(sameFaceInputHash(fixture)).toBe(before);
        const terminal = job.state,
          operations = job.operations;
        expect(job.advance(1)).toBe(terminal);
        expect(job.operations).toBe(operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    ["position", "edge_interval", "fine-lod0"],
    ["index", "edge_interval", "fine-lod0"],
    ["position", "bounded_output_allocation", "fine-lod0"],
    ["index", "bounded_output_allocation", "fine-lod0"],
    ["position", "bounded_output_allocation", "indexed-shifted-canonical"],
    ["index", "bounded_output_allocation", "indexed-shifted-canonical"],
  ] as const)(
    "cancels replaced %s storage at %s before further work/publication for %s",
    (attribute, phase, id) => {
      const fixture = createSameFaceCase(id);
      try {
        const job = new GrassBladeGroundingJob(fixture.request, () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        );
        while (job.state.status === "running" && job.lastPhase !== phase)
          job.advance(1);
        expect(job.state.status).toBe("running");
        expect(job.lastPhase).toBe(phase);
        const { geometry } = fixture.owned[0];
        if (attribute === "position")
          geometry.setAttribute(
            "position",
            geometry.getAttribute("position").clone(),
          );
        else geometry.setIndex(geometry.getIndex()!.clone());
        const operations = job.operations;
        expect(job.advance(1)).toEqual({
          status: "cancelled",
          reason: "invalidated",
        });
        expect(job.operations).toBe(operations);
        expect(job.lastSliceOperations).toBe(0);
        const terminal = job.state;
        expect(job.advance(1)).toBe(terminal);
        expect(job.operations).toBe(operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    ["missing-neighbor", "waiting_support"],
    ["overlapping-owners", "waiting_support"],
    ["budget-one", "failed_budget"],
  ] as const)(
    "keeps %s terminal under one-operation scheduling",
    (id, status) => {
      const fixture = createSameFaceCase(id);
      try {
        const job = new GrassBladeGroundingJob(fixture.request, () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        );
        while (job.state.status === "running") job.advance(1);
        expect(job.state.status).toBe(status);
        if (job.state.status === "waiting_support")
          expect(sameFaceHash(job.state.result)).toBe(NATIVE25[id].hash);
        if (job.state.status === "failed_budget")
          expect(job.state.reason).toBe("grounding_work");
        const terminal = job.state,
          operations = job.operations;
        expect(job.advance(1)).toBe(terminal);
        expect(job.operations).toBe(operations);
      } finally {
        fixture.dispose();
      }
    },
  );
});

describe("bounded indexed edge cursor batches", () => {
  it.each([1, 7, 64, 8192])(
    "preserves the frozen indexed golden with %i-operation slices",
    (slice) => {
      const fixture = createSameFaceCase("indexed-canonical-interiors");
      try {
        const before = sameFaceInputHash(fixture),
          sync = drainSameFaceSteps(groundGrassBladeSteps(fixture.request)),
          job = new GrassBladeGroundingJob(fixture.request, () =>
            fixture.owned.every(({ surface, geometry }) =>
              surface.matchesGeometry(geometry),
            ),
          );
        while (job.state.status === "running") {
          job.advance(slice);
          expect(job.lastSliceOperations).toBeLessThanOrEqual(slice);
        }
        expect(job.state.status).toBe("ready");
        if (job.state.status !== "ready")
          throw Error(JSON.stringify(job.state));
        expect(sameFaceHash(job.state.result)).toBe(
          NATIVE25["indexed-canonical-interiors"].hash,
        );
        expect(sameFaceHash(job.state.result)).toBe(sameFaceHash(sync.result));
        expect({ ...job.state.result.receipt, elapsedMs: 0 }).toEqual({
          ...sync.result.receipt,
          elapsedMs: 0,
        });
        expect(job.operations).toBe(sync.operations);
        expect(sameFaceInputHash(fixture)).toBe(before);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(
    (["nonplanar", "skinny", "translated"] as const).flatMap((variant) =>
      [1, 7, 64, 8192].map((slice) => ({ variant, slice })),
    ),
  )(
    "preserves dense $variant indexed output and exact work with $slice-operation slices",
    ({ variant, slice }) => {
      const fixture = createDenseIndexedBatchCase(variant);
      try {
        const before = sameFaceInputHash(fixture),
          surface = fixture.request.ownSurface,
          legacy = drainSameFaceSteps(
            legacyGroundGrassBladeSteps(fixture.request),
          ),
          sync = drainSameFaceSteps(groundGrassBladeSteps(fixture.request));
        expect(surface.isRegularGrid).toBe(false);
        expect(surface.groundingEdgeIndexStats?.blocks).toBe(16);
        expect(
          surface.groundingEdgeIndexStats?.qualifiedBlocks,
        ).toBeGreaterThan(0);
        if (variant === "skinny")
          expect(surface.groundingEdgeIndexStats?.qualifiedBlocks).toBeLessThan(
            16,
          );
        expect(sync.result.status).toBe("ready");
        expect(sync.result.receipt.retainedClumps).toBeGreaterThan(0);
        expect(sync.result.receipt.sameFaceEdges).toBeGreaterThan(0);
        expect(sync.result.receipt.refinedSameFaceEdges).toBeGreaterThan(0);
        expect(
          sync.result.receipt.sameFaceEdges -
            sync.result.receipt.refinedSameFaceEdges,
        ).toBe(legacy.result.receipt.sameFaceEdges);
        expect(sync.result.receipt.triangleVisits).toBeGreaterThan(0);
        expect(sync.result.receipt.triangleVisits).toBeLessThan(
          legacy.result.receipt.triangleVisits,
        );
        expect(sameFaceHash(sync.result)).toBe(sameFaceHash(legacy.result));
        const job = new GrassBladeGroundingJob(fixture.request, () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        );
        while (job.state.status === "running") {
          const operations = job.operations;
          job.advance(slice);
          expect(job.lastSliceOperations).toBeLessThanOrEqual(slice);
          expect(job.operations - operations).toBe(job.lastSliceOperations);
        }
        expect(job.state.status).toBe("ready");
        if (job.state.status !== "ready")
          throw Error(JSON.stringify(job.state));
        expect(sameFaceHash(job.state.result)).toBe(
          sameFaceHash(legacy.result),
        );
        expect({ ...job.state.result.receipt, elapsedMs: 0 }).toEqual({
          ...sync.result.receipt,
          elapsedMs: 0,
        });
        expect(job.operations).toBe(sync.operations);
        expect(sameFaceInputHash(fixture)).toBe(before);
        const terminal = job.state;
        expect(job.advance(slice)).toBe(terminal);
        expect(job.operations).toBe(sync.operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(
    (
      [
        "position",
        "index",
        "position-version",
        "index-version",
        "cancel",
      ] as const
    ).flatMap((mutation) => [0, 1].map((batch) => ({ mutation, batch }))),
  )(
    "stops $mutation at indexed batch yield $batch without further work or publication",
    ({ mutation, batch }) => {
      // The first cell is deliberately uncertified, retaining the exact
      // indexed fallback suspension this lifetime test targets.
      const fixture = createDenseIndexedBatchCase("skinny");
      try {
        const job = new GrassBladeGroundingJob(fixture.request, () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        );
        advanceToIndexedYield(job, fixture);
        for (let i = 0; i < batch; i++) job.advance(1);
        expect(job.state.status).toBe("running");
        expect(job.lastPhase).toBe("edge_triangle_batch");
        const operations = job.operations,
          { geometry } = fixture.owned[0];
        if (mutation === "position")
          geometry.setAttribute(
            "position",
            geometry.getAttribute("position").clone(),
          );
        else if (mutation === "index")
          geometry.setIndex(geometry.getIndex()!.clone());
        else if (mutation === "position-version")
          geometry.getAttribute("position").needsUpdate = true;
        else if (mutation === "index-version")
          geometry.getIndex()!.needsUpdate = true;
        else job.cancel();
        expect(job.advance(1)).toEqual({
          status: "cancelled",
          reason: mutation === "cancel" ? "caller" : "invalidated",
        });
        expect(job.operations).toBe(operations);
        if (mutation !== "cancel") expect(job.lastSliceOperations).toBe(0);
        expect("result" in job.state).toBe(false);
        const terminal = job.state;
        expect(job.advance(8192)).toBe(terminal);
        expect(job.cancel()).toBe(terminal);
        expect(job.operations).toBe(operations);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("charges every indexed step at each position inside both first four-step batches", () => {
    const fixture = createDenseIndexedBatchCase("skinny");
    try {
      const current = () =>
          fixture.owned.every(({ surface, geometry }) =>
            surface.matchesGeometry(geometry),
          ),
        probe = new GrassBladeGroundingJob(fixture.request, current),
        first = advanceToIndexedYield(probe, fixture);
      probe.cancel();
      for (let acceptedSteps = 0; acceptedSteps < 8; acceptedSteps++) {
        const request = {
            ...fixture.request,
            workBudget: first.workBeforeFirstStep + acceptedSteps,
          },
          sync = drainSameFaceSteps(groundGrassBladeSteps(request));
        expect(sync.result.status).toBe("defer");
        if (sync.result.status !== "defer")
          throw Error("Expected work exhaustion");
        expect(sync.result.reason).toBe("work_budget");
        expect(sync.result.receipt.workUnits).toBe(request.workBudget);
        expect(sync.result.receipt.processedClumps).toBe(0);
        // The charge is never rounded to a whole batch: budgets 0..3 after
        // the prefix fail on one resumption; 4..7 fail on the following one.
        expect(sync.operations).toBe(
          first.operations + Math.floor(acceptedSteps / 4) + 1,
        );
        for (const slice of [1, 7, 64, 8192]) {
          const job = new GrassBladeGroundingJob(request, current);
          while (job.state.status === "running") job.advance(slice);
          expect(job.state).toEqual({
            status: "failed_budget",
            reason: "grounding_work",
          });
          expect(job.operations).toBe(sync.operations);
          expect("result" in job.state).toBe(false);
          const terminal = job.state;
          expect(job.advance(slice)).toBe(terminal);
          expect(job.operations).toBe(sync.operations);
        }
      }
    } finally {
      fixture.dispose();
    }
  });

  it.each([1, 7, 64, 8192])(
    "requires the exact complete geometric-work budget with %i-operation slices",
    (slice) => {
      const fixture = createDenseIndexedBatchCase();
      try {
        const complete = drainSameFaceSteps(
            groundGrassBladeSteps(fixture.request),
          ).result,
          needed = complete.receipt.workUnits;
        expect(complete.status).toBe("ready");
        for (const workBudget of [needed - 1, needed]) {
          const request = { ...fixture.request, workBudget },
            sync = drainSameFaceSteps(groundGrassBladeSteps(request)),
            job = new GrassBladeGroundingJob(request, () =>
              fixture.owned.every(({ surface, geometry }) =>
                surface.matchesGeometry(geometry),
              ),
            );
          while (job.state.status === "running") job.advance(slice);
          expect(sync.result.receipt.workUnits).toBe(workBudget);
          expect(job.operations).toBe(sync.operations);
          if (workBudget < needed) {
            expect(sync.result.status).toBe("defer");
            expect(job.state).toEqual({
              status: "failed_budget",
              reason: "grounding_work",
            });
          } else {
            expect(job.state.status).toBe("ready");
            if (job.state.status !== "ready")
              throw Error(JSON.stringify(job.state));
            expect(sameFaceHash(job.state.result)).toBe(
              sameFaceHash(sync.result),
            );
            expect({ ...job.state.result.receipt, elapsedMs: 0 }).toEqual({
              ...sync.result.receipt,
              elapsedMs: 0,
            });
          }
        }
      } finally {
        fixture.dispose();
      }
    },
  );
});
