import { describe, expect, it } from "vitest";
import {
  groundGrassBladeSteps,
  GrassBladeGroundingJob,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
} from "../GrassBladeGrounding";
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
    "preserves the frozen exhaustive output and resumptions for signed-zero fades: %s",
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
            const current = drainSameFaceSteps(
              groundGrassBladeSteps(fixture.request),
            );
            expect(legacy.result.status).toBe("ready");
            expect(current.result.status).toBe("ready");
            expect(sameFaceHash(current.result)).toBe(
              sameFaceHash(legacy.result),
            );
            expect(sameFaceInputHash(fixture)).toBe(before);
            expect(current.operations).toBe(legacy.operations);
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
