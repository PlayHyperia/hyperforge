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
  createMeadowSweptBladeBuffers,
  GRASS_MEADOW_SWEPT_BLADE,
} from "../GrassMeadowSweptBlade";
import type { GrassMeadowAuthoredBlade } from "../GrassMeadowAuthoredShape";
import {
  createClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import { GRASS_MEADOW_REFINEMENT } from "../GrassBladeLayout";
import {
  createGroundedGrassMeadowAuthoredMaterial,
  createGroundedGrassMeadowFootprintArchMaterial,
  createGroundedGrassMeadowSweptBladeMaterial,
  GRASS_MEADOW_SWEPT_BLADE_GROUNDING,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
  GRASS_BLADE_VISIBILITY_ATTRIBUTE,
} from "../GrassGroundingGpu";
import {
  captureGrassMeadowInstalledBatch,
  certifyGrassMeadowClearance,
  certifyGrassMeadowFootprintArchClearance,
  certifyGrassMeadowSweptBladeClearance,
} from "../GrassMeadowClearance";
import { prepareGroundedGrassSteps } from "../GrassGroundingPipeline";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";

const ALL = (1 << 21) - 1;
type Ready = Extract<GrassBladeGroundingResult, { status: "ready" }>;

/** Real seeded coarse factory, strict swept endpoint and indexed terrain. */
function fixture(slope = false, count = 1) {
  const blades: GrassMeadowAuthoredBlade[] = [];
  const shape = {
    ...FINE_GRASS_MEADOW_FIELD_SHAPE,
    BLADE_WIDTH_BEZIER_CONTROL_POINTS: [0.25, 2.3, 1.3, 0, 0] as const,
  };
  const coarseGeometry = createClumpGeometry(21, 3, shape, undefined, (blade) =>
    blades.push(blade),
  );
  const buffers = createMeadowSweptBladeBuffers(coarseGeometry, blades, shape);
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
    "swept-blade-grounding-test",
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
  const request: GrassBladeGroundingRequest = {
    data: projectGrassAnchors(
      raw,
      surface,
      () => -1000,
      () => false,
    ),
    geometry,
    lod: 0,
    geometryLayout: "fine-meadow-ribbon-v1",
    authoredMeadow: { kind: "meadow-swept-blade-union-v1", coarseGeometry },
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

/** Independent numeric response, never the production wind-factor function. */
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
  fineUsesSweep = true,
) {
  const { data } = f.request,
    k = instance * 3,
    position = geometry.getAttribute("position"),
    uv = geometry.getAttribute("uv"),
    scale = data.rotScaleHash[k + 1];
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
  const fine = stride === 15 && fineUsesSweep,
    t = fine ? Math.sin((uv.getY(vertex) * Math.PI) / 2) : uv.getY(vertex),
    control = fine ? 0.95 : 0.76;
  const curve = t * (2 * control + t * (0.95 - 2 * control));
  const factor =
    Math.min(
      1,
      (scale * position.getY(vertex)) / (Math.max(curve, 1e-5) * 0.86),
    ) *
    (curve / 0.95) ** 2;
  p.x += windX * factor;
  p.z += windZ * factor;
  return p;
}

function unionBoxes(f: Fixture, fineUsesSweep = true) {
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
                  fineUsesSweep,
                ),
              );
    return box.expandByScalar(0.00001);
  });
}
function drainRoad(f: Fixture, invalidateReuse: boolean) {
  const steps = groundGrassBladeSteps(f.request);
  let roadBlades = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) return { result: ready(next.value), roadBlades };
    if (next.value === "road_blade_bounds") {
      if (invalidateReuse && roadBlades === 0) f.request.wind.x = -0;
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
      throw new Error("Unexpected storage address operator");
  }
}

describe("explicit swept-blade grounding (real terrain and node graphs)", () => {
  it.each([false, true])(
    "contains both endpoint/morph envelopes without moving installed roots, slope=%s",
    (slope) => {
      const f = fixture(slope, 2);
      try {
        const original = ready(groundGrassBlades(coarseRequest(f))),
          result = ready(groundGrassBlades(f.request));
        expect(result.data).toEqual(original.data);
        expect(new Uint32Array(result.rootDeltas.buffer)).toEqual(
          new Uint32Array(original.rootDeltas.buffer),
        );
        expect(result.bladeVisibility).toEqual(original.bladeVisibility);
        expect(result.receipt.authoredMeadow).toEqual({
          kind: "meadow-swept-blade-union-v1",
          authoredVerticesPerBlade: 15,
          coarseVerticesPerBlade: 7,
        });
        const b = result.sweptBounds;
        if (!b) throw new Error("Missing actual union bounds");
        let violation = -Infinity;
        for (let instance = 0; instance < 2; instance++)
          for (let v = 0; v < 315; v++) {
            const pair = GRASS_MEADOW_REFINEMENT.parentPairs[v % 15],
              base = Math.floor(v / 15) * 7;
            for (const fade of [0, 1])
              for (const sx of [-1, 1])
                for (const sz of [-1, 1]) {
                  const point = (
                    g: THREE.BufferGeometry,
                    vertex: number,
                    stride: 7 | 15,
                  ) =>
                    worldPoint(
                      f,
                      g,
                      instance,
                      vertex,
                      result.rootDeltas,
                      stride,
                      fade,
                      sx * f.request.wind.x,
                      sz * f.request.wind.z,
                    );
                  const fine = point(f.geometry, v, 15),
                    parent = point(f.coarseGeometry, base + pair[0], 7)
                      .add(point(f.coarseGeometry, base + pair[1], 7))
                      .multiplyScalar(0.5);
                  for (const weight of [0, 0.5, 1]) {
                    const p = parent.clone().lerp(fine, weight);
                    violation = Math.max(
                      violation,
                      b.minX - p.x,
                      p.x - b.maxX,
                      b.minY - p.y,
                      p.y - b.maxY,
                      b.minZ - p.z,
                      p.z - b.maxZ,
                    );
                  }
                }
          }
        expect(violation).toBeLessThanOrEqual(1e-6);
        expect(result.receipt.workBudget).toBe(1_000_000);
      } finally {
        f.dispose();
      }
    },
  );

  it("uses the sine fine profile in both normal and invalidated-cache road sweeps", () => {
    const a = fixture(true),
      b = fixture(true);
    try {
      a.request.wind = { x: 0, z: 0.4 };
      b.request.wind = { x: 0, z: 0.4 };
      const boxes = unionBoxes(a),
        wrong = unionBoxes(a, false);
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
      let boundary: { x: number; z: number; mask: number } | undefined;
      for (const box of [...boxes, ...wrong])
        for (const x of [box.min.x, box.max.x])
          for (const z of [box.min.z, box.max.z]) {
            const mask = maskAt(boxes, x, z);
            if (
              !boundary &&
              mask !== 0 &&
              mask !== ALL &&
              mask !== maskAt(wrong, x, z)
            )
              boundary = { x, z, mask };
          }
      if (!boundary)
        throw new Error("Missing nonvacuous sine-profile road boundary");
      const road = {
        startX: boundary.x,
        endX: boundary.x,
        startZ: boundary.z,
        endZ: boundary.z,
        width: 0.001,
        blendWidth: 0,
      };
      a.request.roadSegments = [road];
      b.request.roadSegments = [road];
      const cached = drainRoad(a, false),
        fallback = drainRoad(b, true);
      expect(cached.roadBlades).toBe(21);
      expect(fallback.roadBlades).toBe(21);
      expect(Object.is(b.request.wind.x, -0)).toBe(true);
      expect(cached.result.bladeVisibility).toEqual(
        new Uint32Array([boundary.mask]),
      );
      expect(fallback.result.bladeVisibility).toEqual(
        cached.result.bladeVisibility,
      );
      expect(fallback.result.sweptBounds).toEqual(cached.result.sweptBounds);
      expect(fallback.result.rootDeltas).toEqual(cached.result.rootDeltas);
      expect(fallback.result.receipt.workUnits).toBeGreaterThan(
        cached.result.receipt.workUnits,
      );
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("certifies exact installed rows only, preserving masks and rejecting other endpoint certificates", () => {
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
      const certify = () =>
        certifyGrassMeadowSweptBladeClearance(installed, result, () => true);
      expect(certify()).toMatchObject({
        kind: "meadow-swept-blade-clearance-v1",
        owner: 4,
        generation: 2,
      });
      expect(certify()?.sourceIndices).toEqual(new Uint32Array([0, 1]));
      for (const wrong of [
        certifyGrassMeadowClearance,
        certifyGrassMeadowFootprintArchClearance,
      ])
        expect(() => wrong(installed, result, () => true)).toThrow(
          "combined authored/coarse sweep",
        );
      expect(() =>
        certifyGrassMeadowSweptBladeClearance(installed, old, () => true),
      ).toThrow("combined authored/coarse sweep");
      expect(
        certifyGrassMeadowSweptBladeClearance(installed, result, () => false),
      ).toBeNull();
      new Uint32Array(result.rootDeltas.buffer)[42] ^= 1;
      expect(certify()?.sourceIndices).toEqual(new Uint32Array([0]));
      result.bladeVisibility![0] &= ~1;
      expect(certify()?.sourceIndices).toEqual(new Uint32Array());
      expect(installed.bladeVisibility).toEqual(new Uint32Array([ALL, ALL]));
    } finally {
      f.dispose();
    }
  });

  it.each([
    "omitted",
    "authored",
    "arch",
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
  ] as const)("rejects mismatched admission before publication: %s", (kind) => {
    const f = fixture();
    let getterCalls = 0;
    try {
      if (kind === "omitted") delete f.request.authoredMeadow;
      if (kind === "authored" || kind === "arch")
        f.request.authoredMeadow = {
          kind:
            kind === "arch"
              ? "meadow-footprint-arch-union-v1"
              : "meadow-authored-union-v1",
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
        const p = f.coarseGeometry.getAttribute("position");
        p.setY(3, p.getY(3) + 0.01);
      }
      if (kind === "index") f.geometry.index!.setX(0, 3);
      if (kind === "draw") f.geometry.setDrawRange(3, 6);
      expect(() => groundGrassBlades(f.request)).toThrow();
      expect(getterCalls).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("keeps source arrays unchanged on budget deferral and rejects ordinary placement projection", () => {
    const f = fixture();
    let consumed = 0;
    try {
      const before = structuredClone(f.request.data);
      f.request.workBudget = 1;
      expect(groundGrassBlades(f.request)).toMatchObject({
        status: "defer",
        reason: "work_budget",
      });
      expect(f.request.data).toEqual(before);
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

  it("revalidates the borrowed canonical endpoint after a suspended stream check", () => {
    const f = fixture();
    try {
      const steps = groundGrassBladeSteps(f.request);
      for (;;) {
        const next = steps.next();
        if (next.done) throw new Error("Expected geometry suspension");
        if (next.value === "geometry_vertex") break;
      }
      const normal = f.geometry.getAttribute("normal");
      normal.setX(8, normal.getX(8) + 0.01);
      expect(() => {
        while (!steps.next().done) {
          /* drain the same continuation */
        }
      }).toThrow();
      expect(f.geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("binds roots and visibility as separate read-only storage with actual fifteen-vertex addresses", () => {
    const f = fixture(),
      base = new MeshStandardNodeMaterial();
    let material: MeshStandardNodeMaterial | undefined;
    try {
      const basePosition = attribute("position", "vec3");
      base.positionNode = basePosition;
      const roots = Float32Array.from({ length: 84 }, (_, i) => i / 1000);
      for (const wrong of [
        createGroundedGrassMeadowAuthoredMaterial,
        createGroundedGrassMeadowFootprintArchMaterial,
      ])
        expect(() =>
          wrong(base, f.geometry, f.coarseGeometry, roots, 2),
        ).toThrow();
      expect(() =>
        createGroundedGrassMeadowSweptBladeMaterial(
          base,
          f.geometry,
          f.coarseGeometry,
          new Float32Array(42 * 129),
          129,
        ),
      ).toThrow("batch");
      expect(f.geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      f.geometry.setAttribute(
        "instanceOffset",
        new THREE.InstancedBufferAttribute(new Float32Array(6), 3),
      );
      expect(() =>
        createGroundedGrassMeadowSweptBladeMaterial(
          base,
          f.geometry,
          f.coarseGeometry,
          roots,
          2,
          new Uint32Array([0, ALL]),
        ),
      ).toThrow("visibility");
      expect(f.geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      expect(f.geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
        false,
      );
      const mask = new Uint32Array([ALL, ALL ^ 1]);
      material = createGroundedGrassMeadowSweptBladeMaterial(
        base,
        f.geometry,
        f.coarseGeometry,
        roots,
        2,
        mask,
      );
      expect(material.userData.grassMeadowSweptBladeGrounding).toBe(
        GRASS_MEADOW_SWEPT_BLADE_GROUNDING,
      );
      expect(GRASS_MEADOW_SWEPT_BLADE_GROUNDING.endpointId).toBe(
        GRASS_MEADOW_SWEPT_BLADE.id,
      );
      expect(material.userData).not.toHaveProperty(
        "grassMeadowFootprintArchGrounding",
      );
      expect(material.userData).not.toHaveProperty(
        "grassMeadowAuthoredGrounding",
      );
      const root = f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
        visibility = f.geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
      expect(root).toBeInstanceOf(StorageBufferAttribute);
      expect(root.array).toBe(roots);
      expect(root.itemSize).toBe(2);
      expect(visibility).toBeInstanceOf(StorageBufferAttribute);
      expect(visibility.array).toBe(mask);
      if (!(material.positionNode instanceof THREE.Node))
        throw new Error("Missing actual position graph");
      const visited = new Set<Node>(),
        reads: Node[] = [];
      const visit = (node: Node) => {
        if (visited.has(node)) return;
        visited.add(node);
        if (node.type === "StorageArrayElementNode") reads.push(node);
        for (const child of node.getChildren()) visit(child);
      };
      visit(material.positionNode);
      expect(reads).toHaveLength(2);
      const indices = reads.map((node) => {
        const index: unknown = Reflect.get(node, "indexNode");
        if (!(index instanceof THREE.Node))
          throw new Error("Missing actual storage index");
        return index;
      });
      for (let instance = 0; instance < 2; instance++)
        for (let vertex = 0; vertex < 315; vertex++)
          expect(
            indices
              .map((index) => address(index, instance, vertex))
              .sort((a, b) => a - b),
          ).toEqual(
            [instance, instance * 21 + Math.floor(vertex / 15)].sort(
              (a, b) => a - b,
            ),
          );
      expect(() =>
        createGroundedGrassMeadowSweptBladeMaterial(
          base,
          f.geometry,
          f.coarseGeometry,
          roots,
          2,
          mask,
        ),
      ).toThrow();
      expect(base.positionNode).toBe(basePosition);
    } finally {
      material?.dispose();
      base.dispose();
      f.dispose();
    }
  });
});
