import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type THREE from "../../../../extras/three/three";
import {
  groundGrassBlades,
  groundGrassBladeSteps,
  GrassGroundingContinuation,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  captureGrassMeadowInstalledBatch,
  certifyGrassMeadowClearance,
  type GrassMeadowInstalledBatch,
} from "../GrassMeadowClearance";
import { createMeadowAuthoredClumpGeometry } from "../GrassVisualManager";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";

type Ready = Extract<GrassBladeGroundingResult, { status: "ready" }>;
const ALL = (1 << 21) - 1;
let pair: ReturnType<typeof createMeadowAuthoredClumpGeometry>;
let terrain: THREE.BufferGeometry;
let request: GrassBladeGroundingRequest;
let ordinary: Ready;
let authored: Ready;

function ready(result: GrassBladeGroundingResult): Ready {
  if (result.status !== "ready")
    throw new Error("Fixture failed real grounding");
  return result;
}

function baseline(): GrassMeadowInstalledBatch {
  return captureGrassMeadowInstalledBatch({
    owner: 7,
    generation: 2,
    data: ordinary.data,
    rootDeltas: ordinary.rootDeltas,
    bladeVisibility: ordinary.bladeVisibility,
  });
}

function candidate(): Ready {
  return {
    ...authored,
    data: {
      count: authored.data.count,
      offsets: authored.data.offsets.slice(),
      rotScaleHash: authored.data.rotScaleHash.slice(),
      groundNormals: authored.data.groundNormals.slice(),
      groundColors: authored.data.groundColors.slice(),
      grassTints: authored.data.grassTints.slice(),
    },
    rootDeltas: authored.rootDeltas.slice(),
    sourceIndices: authored.sourceIndices.slice(),
    bladeVisibility: authored.bladeVisibility?.slice(),
  };
}

beforeAll(() => {
  pair = createMeadowAuthoredClumpGeometry();
  terrain = gridGeometry(100, 16, () => 20);
  const surface = new RetainedTerrainSurface(
    1,
    "meadow-clearance-test",
    0,
    0,
    100,
    16,
    terrain,
  );
  const raw = {
    count: 3,
    offsets: new Float32Array([-2, 20, 0, 0, 20, 0, 2, 20, 0]),
    rotScaleHash: new Float32Array([0, 1, 0.4, 1, 1, 0.6, 2, 1, 0.8]),
    groundNormals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    groundColors: new Float32Array(9).fill(0.25),
    grassTints: new Float32Array(12).fill(1),
  };
  const data = projectGrassAnchors(
    raw,
    surface,
    () => -1000,
    () => false,
  );
  const coarseRequest: GrassBladeGroundingRequest = {
    data,
    geometry: pair.coarseGeometry,
    lod: 0,
    geometryLayout: "fine-meadow-ribbon-v1",
    ownSurface: surface,
    surfaces: [surface],
    terrainSurface: {
      schemaVersion: 1,
      zones: [],
      waterBodies: [],
      arenaFloorIds: [],
      arenaGradeHeight: null,
    },
    roadSegments: [],
    oceanLevel: -1000,
    wind: { x: 0.25, z: 0.15 },
    roadClearance: "per-blade-v1",
  };
  ordinary = ready(groundGrassBlades(coarseRequest));
  expect(ordinary.data.count).toBe(3);
  request = {
    ...coarseRequest,
    data: ordinary.data,
    geometry: pair.geometry,
    authoredMeadow: {
      kind: "meadow-authored-union-v1",
      coarseGeometry: pair.coarseGeometry,
    },
  };
  authored = ready(groundGrassBlades(request));
  expect(authored.data.count).toBe(3);
});

afterAll(() => {
  pair.geometry.dispose();
  pair.coarseGeometry.dispose();
  terrain.dispose();
});

describe("installed meadow clearance acceptance (real CPU grounding)", () => {
  it("certifies unchanged installed rows without exposing fitter placement arrays", () => {
    const certificate = certifyGrassMeadowClearance(
      baseline(),
      candidate(),
      () => true,
    )!;
    expect(Array.from(certificate.sourceIndices)).toEqual([0, 1, 2]);
    expect(Array.from(certificate.bladeVisibility)).toEqual([ALL, ALL, ALL]);
    expect(certificate.owner).toBe(7);
    expect(certificate.generation).toBe(2);
    expect(certificate.sweptBounds).toEqual(authored.sweptBounds);
    expect(certificate).not.toHaveProperty("data");
    expect(certificate).not.toHaveProperty("rootDeltas");
    expect(certificate.dependencies[0].surface).toBe(request.ownSurface);
  });

  it("takes a detached baseline, including masks and subarray byte offsets", () => {
    const result = candidate();
    const storage = new Float32Array(result.rootDeltas.length + 4);
    storage.set(result.rootDeltas, 2);
    const source = {
      owner: 7,
      generation: 2,
      data: result.data,
      rootDeltas: storage.subarray(2, -2),
      bladeVisibility: new Uint32Array([1, 3, 7]),
    };
    const snapshot = captureGrassMeadowInstalledBatch(source);
    source.data.offsets[0] = 999;
    source.rootDeltas[0] = 10;
    source.bladeVisibility[0] = 8;
    expect(snapshot.data.offsets[0]).toBe(ordinary.data.offsets[0]);
    expect(snapshot.rootDeltas[0]).toBe(ordinary.rootDeltas[0]);
    expect(snapshot.bladeVisibility![0]).toBe(1);
  });

  for (const [field, stride] of [
    ["offsets", 3],
    ["rotScaleHash", 3],
    ["groundNormals", 3],
    ["groundColors", 3],
    ["grassTints", 4],
  ] as const) {
    it("keeps a row coarse if one Float32 word changes in " + field, () => {
      const result = candidate();
      const array = result.data[field];
      const bits = new Uint32Array(
        array.buffer,
        array.byteOffset,
        array.length,
      );
      bits[stride] ^= 1;
      const certificate = certifyGrassMeadowClearance(
        baseline(),
        result,
        () => true,
      )!;
      expect(Array.from(certificate.sourceIndices)).toEqual([0, 2]);
    });
  }

  it("requires exact root-correction words, including signed zero", () => {
    const result = candidate();
    new Uint32Array(result.rootDeltas.buffer)[42] ^= 1;
    expect(
      Array.from(
        certifyGrassMeadowClearance(baseline(), result, () => true)!
          .sourceIndices,
      ),
    ).toEqual([0, 2]);
    const signed = candidate();
    const bits = new Uint32Array(signed.data.offsets.buffer);
    expect(signed.data.offsets[2]).toBe(0);
    bits[2] ^= 0x80000000;
    expect(
      Array.from(
        certifyGrassMeadowClearance(baseline(), signed, () => true)!
          .sourceIndices,
      ),
    ).toEqual([1, 2]);
  });

  it("rejects a fresh visibility subset and never unmasks new blades", () => {
    const installed = {
      ...baseline(),
      bladeVisibility: new Uint32Array([3, 7, 15]),
    };
    const result = candidate();
    result.bladeVisibility = new Uint32Array([1, ALL, 15]);
    const certificate = certifyGrassMeadowClearance(
      installed,
      result,
      () => true,
    )!;
    expect(Array.from(certificate.sourceIndices)).toEqual([1, 2]);
    expect(Array.from(certificate.bladeVisibility)).toEqual([7, 15]);
  });

  it("treats absent old visibility as all blades", () => {
    const result = candidate();
    result.bladeVisibility = new Uint32Array([ALL - 1, ALL, ALL]);
    expect(
      Array.from(
        certifyGrassMeadowClearance(
          { ...baseline(), bladeVisibility: undefined },
          result,
          () => true,
        )!.sourceIndices,
      ),
    ).toEqual([1, 2]);
  });

  it("maps compacted output back to original installed rows", () => {
    const result = candidate();
    result.data.count = 2;
    for (const [field, stride] of [
      ["offsets", 3],
      ["rotScaleHash", 3],
      ["groundNormals", 3],
      ["groundColors", 3],
      ["grassTints", 4],
    ] as const)
      result.data[field] = result.data[field].slice(stride);
    result.rootDeltas = result.rootDeltas.slice(42);
    result.sourceIndices = new Uint32Array([1, 2]);
    if (result.bladeVisibility)
      result.bladeVisibility = result.bladeVisibility.slice(1);
    expect(
      Array.from(
        certifyGrassMeadowClearance(baseline(), result, () => true)!
          .sourceIndices,
      ),
    ).toEqual([1, 2]);
  });

  it("does not mistake an ordinary endpoint fit for a combined sweep", () => {
    expect(() =>
      certifyGrassMeadowClearance(baseline(), ordinary, () => true),
    ).toThrow("combined authored/coarse sweep");
  });

  it("returns no certificate for an exhausted sweep budget", () => {
    const failed = groundGrassBlades({ ...request, workBudget: 1 });
    expect(failed.status).toBe("defer");
    expect(
      certifyGrassMeadowClearance(baseline(), failed, () => true),
    ).toBeNull();
  });

  it("handles a completely rejected batch without dropping its coarse fallback", () => {
    const result = candidate();
    for (const field of [
      "offsets",
      "rotScaleHash",
      "groundNormals",
      "groundColors",
      "grassTints",
    ] as const)
      result.data[field] = new Float32Array();
    result.data.count = 0;
    result.rootDeltas = new Float32Array();
    result.sourceIndices = new Uint32Array();
    result.bladeVisibility = new Uint32Array();
    result.sweptBounds = null;
    const certificate = certifyGrassMeadowClearance(
      baseline(),
      result,
      () => true,
    )!;
    expect(certificate.sourceIndices.length).toBe(0);
    expect(certificate.sweptBounds).toBeNull();
  });

  it.each([
    [0, 0, 2],
    [0, 2, 1],
    [0, 1, 3],
  ])("rejects malformed source order %j", (...indices) => {
    const result = candidate();
    result.sourceIndices = new Uint32Array(indices);
    expect(() =>
      certifyGrassMeadowClearance(baseline(), result, () => true),
    ).toThrow("source order");
  });

  it("returns no certificate for a stale lease before or after acceptance", () => {
    expect(
      certifyGrassMeadowClearance(baseline(), candidate(), () => false),
    ).toBeNull();
    let calls = 0;
    expect(
      certifyGrassMeadowClearance(baseline(), candidate(), () => ++calls === 1),
    ).toBeNull();
    expect(calls).toBe(2);
  });

  it("shared continuation cancels after region invalidation and publishes nothing", () => {
    let current = true;
    const continuation = new GrassGroundingContinuation(
      groundGrassBladeSteps(request),
      () => current,
    );
    expect(continuation.advance(1).status).toBe("running");
    current = false;
    expect(continuation.advance(1)).toEqual({
      status: "cancelled",
      reason: "invalidated",
    });
    expect(continuation.state).not.toHaveProperty("result");
  });

  it("publishes no partial certificate after cancellation", () => {
    const continuation = new GrassGroundingContinuation(
      groundGrassBladeSteps(request),
      () => true,
    );
    continuation.advance(1);
    expect(continuation.cancel()).toEqual({
      status: "cancelled",
      reason: "caller",
    });
    expect(continuation.advance(1)).not.toHaveProperty("result");
  });

  it("rejects invalid installed capacities, owner identity and masks", () => {
    expect(() =>
      captureGrassMeadowInstalledBatch({ ...baseline(), owner: -1 }),
    ).toThrow("identity");
    expect(() =>
      captureGrassMeadowInstalledBatch({
        ...baseline(),
        data: { ...ordinary.data, count: 129 },
      }),
    ).toThrow("capacity");
    for (const invalid of [0, 1 << 22])
      expect(() =>
        captureGrassMeadowInstalledBatch({
          ...baseline(),
          bladeVisibility: new Uint32Array([invalid, ALL, ALL]),
        }),
      ).toThrow("visibility");
  });

  it("rejects nonfinite roots and malformed union bounds", () => {
    const result = candidate();
    result.rootDeltas[0] = NaN;
    expect(() =>
      certifyGrassMeadowClearance(baseline(), result, () => true),
    ).toThrow("float array");
    const other = candidate();
    other.sweptBounds = null;
    expect(() =>
      certifyGrassMeadowClearance(baseline(), other, () => true),
    ).toThrow("union bounds");
  });
});
