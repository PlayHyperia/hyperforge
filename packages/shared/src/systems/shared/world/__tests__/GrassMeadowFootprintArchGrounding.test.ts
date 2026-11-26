import { describe, expect, it } from "vitest";
import { attribute, instanceIndex, vertexIndex } from "three/tsl";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import THREE from "../../../../extras/three/three";
import {
  groundGrassBladeSteps,
  groundGrassBlades,
  type GrassBladeGroundingRequest,
  type GrassBladeGroundingResult,
} from "../GrassBladeGrounding";
import {
  createMeadowFootprintArchBuffers,
  GRASS_MEADOW_FOOTPRINT_ARCH,
} from "../GrassMeadowFootprintArch";
import type { GrassMeadowAuthoredBlade } from "../GrassMeadowAuthoredShape";
import {
  createClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import { GRASS_MEADOW_REFINEMENT } from "../GrassBladeLayout";
import {
  createGroundedGrassMeadowAuthoredMaterial,
  createGroundedGrassMeadowFootprintArchMaterial,
  GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
} from "../GrassGroundingGpu";
import {
  captureGrassMeadowInstalledBatch,
  certifyGrassMeadowClearance,
  certifyGrassMeadowFootprintArchClearance,
} from "../GrassMeadowClearance";
import { prepareGroundedGrassSteps } from "../GrassGroundingPipeline";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";

const ALL = (1 << 21) - 1;
type Ready = Extract<GrassBladeGroundingResult, { status: "ready" }>;

/** Actual seeded factory plus canonical endpoint module, never a forged mesh.
 * This CPU fixture is not native rendering, a worker admission or a world fit. */
function fixture(slope = false, count = 1) {
  const blades: GrassMeadowAuthoredBlade[] = [];
  const coarseGeometry = createClumpGeometry(
    21,
    3,
    FINE_GRASS_MEADOW_FIELD_SHAPE,
    undefined,
    (blade) => blades.push(blade),
  );
  const buffers = createMeadowFootprintArchBuffers(
    coarseGeometry,
    blades,
    FINE_GRASS_MEADOW_FIELD_SHAPE,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(buffers.positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(buffers.normals, 3),
  );
  geometry.setAttribute("uv", new THREE.BufferAttribute(buffers.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
  Object.defineProperty(geometry.userData, buffers.layout.metadataKey, {
    value: buffers.recipe,
    enumerable: true,
  });
  const terrain = gridGeometry(
    100,
    17,
    (x, z) => 20 + (slope ? 0.3 * x - 0.25 * z : 0),
  );
  const surface = new RetainedTerrainSurface(
    1,
    "footprint-arch-grounding-test",
    0,
    0,
    100,
    17,
    terrain,
  );
  const raw = {
    count,
    offsets: new Float32Array(count * 3),
    rotScaleHash: new Float32Array(count * 3),
    groundNormals: new Float32Array(count * 3),
    groundColors: new Float32Array(count * 3).fill(0.25),
    grassTints: new Float32Array(count * 4).fill(1),
  };
  for (let i = 0; i < count; i++) {
    raw.offsets.set([2 + 3 * i, 20, 2], i * 3);
    raw.rotScaleHash.set([0.61 + i * 0.3, 0.85 + i * 0.2, 0.4], i * 3);
    raw.groundNormals.set([0, 1, 0], i * 3);
  }
  const data = projectGrassAnchors(
    raw,
    surface,
    () => -1000,
    () => false,
  );
  const request: GrassBladeGroundingRequest = {
    data,
    geometry,
    lod: 0,
    geometryLayout: "fine-meadow-ribbon-v1",
    authoredMeadow: {
      kind: "meadow-footprint-arch-union-v1",
      coarseGeometry,
    },
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
    roadClearance: "per-blade-v1",
    oceanLevel: -1000,
    wind: { x: 0.129, z: 0.07095 },
  };
  return {
    geometry,
    coarseGeometry,
    request,
    dispose() {
      geometry.dispose();
      coarseGeometry.dispose();
      terrain.dispose();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

function ready(result: GrassBladeGroundingResult): Ready {
  if (result.status !== "ready") throw new Error(`Unexpected ${result.reason}`);
  return result;
}
function coarseRequest(f: Fixture): GrassBladeGroundingRequest {
  return {
    ...f.request,
    geometry: f.coarseGeometry,
    authoredMeadow: undefined,
  };
}

/** Independent numeric response: do not call either production wind helper. */
function windFactor(t: number, sourceY: number, scale: number, arch: boolean) {
  const control = arch ? 0.95 / 0.7 : 0.76;
  const tip = arch ? 0.95 * (2 / 0.7 - 1 / (0.7 * 0.7)) : 0.95;
  const curve = t * (2 * control + t * (tip - 2 * control));
  const amplitude = Math.min(
    1,
    (scale * sourceY) / (Math.max(curve, 1e-5) * 0.86),
  );
  return amplitude * (curve / 0.95) ** 2;
}

function worldPoint(
  f: Fixture,
  geometry: THREE.BufferGeometry,
  instance: number,
  vertex: number,
  deltas: Float32Array,
  stride: 7 | 15,
  fade: number,
  windX: number,
  windZ: number,
  fineUsesArch = true,
) {
  const { data } = f.request;
  const k = instance * 3;
  const position = geometry.getAttribute("position"),
    uv = geometry.getAttribute("uv");
  const scale = data.rotScaleHash[k + 1];
  const p = new THREE.Vector3(
    position.getX(vertex),
    position.getY(vertex) * fade,
    position.getZ(vertex),
  )
    .multiplyScalar(scale)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), -data.rotScaleHash[k])
    .applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().fromArray(data.groundNormals, k),
      ),
    )
    .add(new THREE.Vector3().fromArray(data.offsets, k));
  const d = (instance * 21 + Math.floor(vertex / stride)) * 2,
    u = uv.getX(vertex);
  p.y += deltas[d] * (1 - u) + deltas[d + 1] * u;
  const factor = windFactor(
    uv.getY(vertex),
    position.getY(vertex),
    scale,
    stride === 15 && fineUsesArch,
  );
  p.x += windX * factor;
  p.z += windZ * factor;
  return p;
}

function unionBoxes(f: Fixture, fineUsesArch = true) {
  return Array.from({ length: 21 }, (_, blade) => {
    const box = new THREE.Box3();
    for (const [geometry, stride] of [
      [f.geometry, 15],
      [f.coarseGeometry, 7],
    ] as const)
      for (let local = 0; local < stride; local++)
        for (const fade of [0, 1])
          for (const sx of [-1, 1])
            for (const sz of [-1, 1])
              box.expandByPoint(
                worldPoint(
                  f,
                  geometry,
                  0,
                  blade * stride + local,
                  new Float32Array(42),
                  stride,
                  fade,
                  sx * f.request.wind.x,
                  sz * f.request.wind.z,
                  fineUsesArch,
                ),
              );
    return box.expandByScalar(0.00001);
  });
}

function drainRoad(f: Fixture, fallback: boolean) {
  const steps = groundGrassBladeSteps(f.request);
  let roadBlades = 0;
  for (;;) {
    const step = steps.next();
    if (step.done) return { result: ready(step.value), roadBlades };
    if (step.value === "road_blade_bounds") {
      if (fallback && roadBlades === 0) f.request.wind.x = -0;
      roadBlades++;
    }
  }
}

function address(node: Node, instance: number, vertex: number): number {
  if (node === instanceIndex) return instance;
  if (node === vertexIndex) return vertex;
  const value: unknown = Reflect.get(node, "value");
  if (node.type === "ConstNode" && typeof value === "number") return value;
  const child = (key: string) => {
    const next: unknown = Reflect.get(node, key);
    if (!(next instanceof THREE.Node)) throw new Error(`Missing actual ${key}`);
    return address(next, instance, vertex);
  };
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  if (node.type !== "OperatorNode") throw new Error(`Unexpected ${node.type}`);
  const a = child("aNode"),
    b = child("bNode");
  switch (Reflect.get(node, "op")) {
    case "+":
      return a + b;
    case "*":
      return a * b;
    case "/":
      return Math.floor(a / b);
    default:
      throw new Error("Unexpected actual storage address operator");
  }
}

describe("opt-in footprint arch union (real CPU terrain and node graphs)", () => {
  it.each([false, true])(
    "preserves installed roots and contains endpoint-specific wind/morph sweeps on slope=%s",
    (slope) => {
      const f = fixture(slope, 2);
      try {
        const old = ready(groundGrassBlades(coarseRequest(f)));
        const result = ready(groundGrassBlades(f.request));
        expect(result.data).toEqual(old.data);
        expect(new Uint32Array(result.rootDeltas.buffer)).toEqual(
          new Uint32Array(old.rootDeltas.buffer),
        );
        expect(result.bladeVisibility).toEqual(old.bladeVisibility);
        expect(result.receipt.authoredMeadow).toEqual({
          kind: "meadow-footprint-arch-union-v1",
          authoredVerticesPerBlade: 15,
          coarseVerticesPerBlade: 7,
        });
        const bounds = result.sweptBounds;
        if (!bounds) throw new Error("Missing actual swept bounds");
        let maximumViolation = -Infinity;
        for (let instance = 0; instance < 2; instance++)
          for (let v = 0; v < 315; v++) {
            const [a, b] = GRASS_MEADOW_REFINEMENT.parentPairs[v % 15];
            const base = Math.floor(v / 15) * 7;
            for (const fade of [0, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const fine = worldPoint(
                    f,
                    f.geometry,
                    instance,
                    v,
                    result.rootDeltas,
                    15,
                    fade,
                    sx * f.request.wind.x,
                    sz * f.request.wind.z,
                  );
                  const parent = worldPoint(
                    f,
                    f.coarseGeometry,
                    instance,
                    base + a,
                    old.rootDeltas,
                    7,
                    fade,
                    sx * f.request.wind.x,
                    sz * f.request.wind.z,
                  )
                    .add(
                      worldPoint(
                        f,
                        f.coarseGeometry,
                        instance,
                        base + b,
                        old.rootDeltas,
                        7,
                        fade,
                        sx * f.request.wind.x,
                        sz * f.request.wind.z,
                      ),
                    )
                    .multiplyScalar(0.5);
                  for (const weight of [0, 0.5, 1]) {
                    const p = parent.clone().lerp(fine, weight);
                    maximumViolation = Math.max(
                      maximumViolation,
                      bounds.minX - p.x,
                      p.x - bounds.maxX,
                      bounds.minY - p.y,
                      p.y - bounds.maxY,
                      bounds.minZ - p.z,
                      p.z - bounds.maxZ,
                    );
                  }
                }
          }
        expect(maximumViolation).toBeLessThanOrEqual(1e-6);
      } finally {
        f.dispose();
      }
    },
  );

  it("uses the same explicit fine/parent wind dispatch after road-bound reuse is invalidated", () => {
    const cached = fixture(true),
      retry = fixture(true);
    try {
      cached.request.wind = { x: 0, z: 0.4 };
      retry.request.wind = { x: 0, z: 0.4 };
      const boxes = unionBoxes(cached),
        wrongProfileBoxes = unionBoxes(cached, false);
      const maskAt = (bounds: THREE.Box3[], x: number, z: number) => {
        let mask = ALL;
        bounds.forEach((box, blade) => {
          if (
            Math.hypot(
              Math.max(box.min.x - x, 0, x - box.max.x),
              Math.max(box.min.z - z, 0, z - box.max.z),
            ) <= 0.0005
          )
            mask &= ~(1 << blade);
        });
        return mask;
      };
      let point: { x: number; z: number; mask: number } | undefined;
      // A real point-road that distinguishes the fine profile from accidentally
      // applying the coarse profile to all22 samples. This makes both branches
      // nonvacuous instead of merely checking that two wrong masks agree.
      for (const box of [...boxes, ...wrongProfileBoxes])
        for (const x of [box.min.x, box.max.x])
          for (const z of [box.min.z, box.max.z]) {
            const mask = maskAt(boxes, x, z);
            if (
              !point &&
              mask !== 0 &&
              mask !== ALL &&
              mask !== maskAt(wrongProfileBoxes, x, z)
            )
              point = { x, z, mask };
          }
      if (!point)
        throw new Error("Missing nonvacuous fine-profile road boundary");
      const { mask } = point;
      const road = {
        startX: point.x,
        endX: point.x,
        startZ: point.z,
        endZ: point.z,
        width: 0.001,
        blendWidth: 0,
      };
      cached.request.roadSegments = [road];
      retry.request.roadSegments = [road];
      expect(mask).not.toBe(0);
      expect(mask).not.toBe(ALL);
      const a = drainRoad(cached, false),
        b = drainRoad(retry, true);
      expect(a.roadBlades).toBe(21);
      expect(b.roadBlades).toBe(21);
      expect(Object.is(retry.request.wind.x, -0)).toBe(true);
      expect(a.result.bladeVisibility).toEqual(new Uint32Array([mask]));
      expect(b.result.bladeVisibility).toEqual(a.result.bladeVisibility);
      expect(b.result.sweptBounds).toEqual(a.result.sweptBounds);
      expect(b.result.rootDeltas).toEqual(a.result.rootDeltas);
      expect(b.result.receipt.workUnits).toBeGreaterThan(
        a.result.receipt.workUnits,
      );
    } finally {
      cached.dispose();
      retry.dispose();
    }
  });

  it("certifies only exact installed arch rows with the matching union kind", () => {
    const f = fixture(true, 2);
    try {
      const old = ready(groundGrassBlades(coarseRequest(f))),
        result = ready(groundGrassBlades(f.request));
      const installed = captureGrassMeadowInstalledBatch({
        owner: 4,
        generation: 2,
        data: old.data,
        rootDeltas: old.rootDeltas,
        bladeVisibility: old.bladeVisibility,
      });
      const certificate = certifyGrassMeadowFootprintArchClearance(
        installed,
        result,
        () => true,
      );
      expect(certificate).toMatchObject({
        kind: "meadow-footprint-arch-clearance-v1",
        owner: 4,
        generation: 2,
      });
      expect(certificate?.sourceIndices).toEqual(new Uint32Array([0, 1]));
      expect(() =>
        certifyGrassMeadowClearance(installed, result, () => true),
      ).toThrow("combined authored/coarse sweep");
      expect(() =>
        certifyGrassMeadowFootprintArchClearance(installed, old, () => true),
      ).toThrow("combined authored/coarse sweep");
      expect(
        certifyGrassMeadowFootprintArchClearance(
          installed,
          result,
          () => false,
        ),
      ).toBeNull();
      new Uint32Array(result.rootDeltas.buffer)[42] ^= 1;
      expect(
        certifyGrassMeadowFootprintArchClearance(installed, result, () => true)
          ?.sourceIndices,
      ).toEqual(new Uint32Array([0]));
      result.bladeVisibility![0] &= ~1;
      expect(
        certifyGrassMeadowFootprintArchClearance(installed, result, () => true)
          ?.sourceIndices,
      ).toEqual(new Uint32Array());
    } finally {
      f.dispose();
    }
  });

  it.each([
    "omitted",
    "legacy-kind",
    "extra",
    "getter",
    "inherited",
    "lod",
    "count",
    "position",
    "normal",
    "uv",
    "coarse",
    "index",
    "draw",
  ] as const)("rejects forged/mismatched admission %s", (kind) => {
    const f = fixture();
    let getterCalls = 0;
    try {
      if (kind === "omitted") delete f.request.authoredMeadow;
      if (kind === "legacy-kind")
        f.request.authoredMeadow = {
          kind: "meadow-authored-union-v1",
          coarseGeometry: f.coarseGeometry,
        };
      if (kind === "extra")
        Object.defineProperty(f.request.authoredMeadow, "profile", {
          value: "unexpected",
        });
      if (kind === "getter")
        Object.defineProperty(f.request, "authoredMeadow", {
          get() {
            getterCalls++;
            throw new Error("getter executed");
          },
        });
      if (kind === "inherited") {
        const value = f.request.authoredMeadow;
        delete f.request.authoredMeadow;
        Object.setPrototypeOf(f.request, { authoredMeadow: value });
      }
      if (kind === "lod") f.request.lod = 1;
      if (kind === "count") f.request.data.count = 129;
      if (kind === "position" || kind === "normal" || kind === "uv") {
        const a = f.geometry.getAttribute(kind);
        a.setX(8, a.getX(8) + 0.01);
      }
      if (kind === "coarse") {
        const a = f.coarseGeometry.getAttribute("position");
        a.setY(3, a.getY(3) + 0.01);
      }
      if (kind === "index") f.geometry.index!.setX(0, 3);
      if (kind === "draw") f.geometry.setDrawRange(3, 6);
      expect(() => groundGrassBlades(f.request)).toThrow();
      expect(getterCalls).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("does not admit the union through the ordinary placement pipeline", () => {
    const f = fixture();
    let consumed = 0;
    try {
      const steps = prepareGroundedGrassSteps(
        f.request,
        {
          isCurrent: () => true,
          steps: (function* () {
            consumed++;
            yield "test-input";
            return {
              terrainSurface: f.request.terrainSurface,
              roadSegments: [],
            };
          })(),
        },
        () => -1000,
        () => false,
      );
      expect(() => steps.next()).toThrow("installed-anchor certification");
      expect(consumed).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("binds fifteen-vertex root addresses as storage with distinct endpoint metadata", () => {
    const f = fixture();
    const base = new MeshStandardNodeMaterial();
    let material: MeshStandardNodeMaterial | undefined;
    try {
      base.positionNode = attribute("position", "vec3");
      const roots = Float32Array.from({ length: 84 }, (_, i) => i / 1000);
      expect(() =>
        createGroundedGrassMeadowAuthoredMaterial(
          base,
          f.geometry,
          f.coarseGeometry,
          roots,
          2,
        ),
      ).toThrow();
      expect(f.geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      material = createGroundedGrassMeadowFootprintArchMaterial(
        base,
        f.geometry,
        f.coarseGeometry,
        roots,
        2,
      );
      expect(material.userData.grassMeadowFootprintArchGrounding).toBe(
        GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING,
      );
      expect(GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING.endpointId).toBe(
        GRASS_MEADOW_FOOTPRINT_ARCH.id,
      );
      expect(material.userData).not.toHaveProperty(
        "grassMeadowAuthoredGrounding",
      );
      const root = f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
      expect(root).toBeInstanceOf(StorageBufferAttribute);
      expect(root.array).toBe(roots);
      expect(root.itemSize).toBe(2);
      if (!(material.positionNode instanceof THREE.Node))
        throw new Error("Missing actual position response");
      const visited = new Set<Node>(),
        storageReads: Node[] = [];
      const visit = (node: Node) => {
        if (visited.has(node)) return;
        visited.add(node);
        if (node.type === "StorageArrayElementNode") storageReads.push(node);
        for (const child of node.getChildren()) visit(child);
      };
      visit(material.positionNode);
      expect(storageReads).toHaveLength(1);
      const index: unknown = Reflect.get(storageReads[0], "indexNode");
      if (!(index instanceof THREE.Node))
        throw new Error("Missing actual root storage address");
      for (let instance = 0; instance < 2; instance++)
        for (let vertex = 0; vertex < 315; vertex++)
          expect(address(index, instance, vertex)).toBe(
            instance * 21 + Math.floor(vertex / 15),
          );
      expect(() =>
        createGroundedGrassMeadowFootprintArchMaterial(
          base,
          f.geometry,
          f.coarseGeometry,
          roots,
          2,
        ),
      ).toThrow("binding");
    } finally {
      material?.dispose();
      base.dispose();
      f.dispose();
    }
  });
});
