import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { BuildingGenerator, createRng } from "./BuildingGenerator";
import { getRecipe } from "./recipes";
import { createGabledRoof } from "./GabledRoof";
import type { BuildingLayout, BuildingRecipe } from "./types";

const generators: BuildingGenerator[] = [];
const geometries = new Set<THREE.BufferGeometry>();
const materials = new Set<THREE.Material>();
afterEach(() => {
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const generator of generators) generator.dispose();
  generators.length = 0;
  geometries.clear();
  materials.clear();
});
function generator() {
  const g = new BuildingGenerator();
  generators.push(g);
  return g;
}
function layout(g: BuildingGenerator): BuildingLayout {
  const recipe: BuildingRecipe = {
    ...getRecipe("bank")!,
    widthRange: [2, 2],
    depthRange: [2, 2],
    floors: 1,
    floorsRange: [1, 1],
    footprintStyle: "default",
    carveChance: 0,
    frontSide: "south",
    roomSpanRange: [2, 2],
    minRoomArea: 4,
    entranceCount: 1,
    entranceArchChance: 0,
    patioDoorChance: 0,
    foundationStepsRange: [2, 2],
    hasBasement: false,
  };
  return g.generateLayout(recipe, createRng("compact-lodge-gable-test"));
}
function inspect(root: THREE.Object3D) {
  const digest = createHash("sha256");
  let triangles = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      if (!generators.some((g) => g["uberMaterial"] === material))
        materials.add(material);
    }
    digest.update(object.name);
    const geometry = object.geometry;
    triangles +=
      (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
    for (const [name, a] of Object.entries(geometry.attributes)) {
      expect(a.count, name).toBe(geometry.getAttribute("position").count);
      const array =
        a instanceof THREE.InterleavedBufferAttribute ? a.data.array : a.array;
      expect([...array].every(Number.isFinite), name).toBe(true);
      digest.update(name);
      digest.update(
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      );
    }
    if (geometry.index)
      digest.update(new Uint8Array(geometry.index.array.buffer));
  });
  return { triangles, hash: digest.digest("hex") };
}

describe("opt-in compact gabled building geometry", () => {
  it("creates closed outward-facing solids with bounded cost and complete attributes", () => {
    const result = createGabledRoof(8, 8, 3.8, "stone");
    let triangles = 0;
    for (const g of [...result.roofs, ...result.walls]) {
      geometries.add(g);
      const p = g.getAttribute("position"),
        n = g.getAttribute("normal"),
        index = g.index!;
      const edges = new Map<string, number>();
      const key = (i: number) =>
        [p.getX(i), p.getY(i), p.getZ(i)]
          .map((v) => Math.round(v * 1e5))
          .join(",");
      let volume = 0;
      for (let i = 0; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        const vertices = ids.map((j) =>
          new THREE.Vector3().fromBufferAttribute(p, j),
        );
        const uv = g.getAttribute("uv");
        const u = ids.map((j) =>
          new THREE.Vector2().fromBufferAttribute(uv, j),
        );
        expect(
          Math.abs(u[1].clone().sub(u[0]).cross(u[2].clone().sub(u[0]))),
        ).toBeGreaterThan(1e-8);
        const normal = vertices[1]
          .clone()
          .sub(vertices[0])
          .cross(vertices[2].clone().sub(vertices[0]));
        expect(normal.length()).toBeGreaterThan(1e-7);
        expect(
          normal.dot(new THREE.Vector3().fromBufferAttribute(n, ids[0])),
        ).toBeGreaterThan(0);
        volume += vertices[0].dot(vertices[1].clone().cross(vertices[2])) / 6;
        for (let e = 0; e < 3; e++) {
          const edge = [key(ids[e]), key(ids[(e + 1) % 3])].sort().join("|");
          edges.set(edge, (edges.get(edge) ?? 0) + 1);
        }
      }
      expect(volume).toBeGreaterThan(0);
      expect([...edges.values()].every((count) => count === 2)).toBe(true);
      for (const name of ["position", "normal", "uv", "uv2", "color"])
        expect(g.getAttribute(name).count).toBe(p.count);
      triangles += index.count / 3;
    }
    expect(triangles).toBeLessThanOrEqual(128);
    const roof = result.roofs[0];
    roof.computeBoundingBox();
    expect(roof.boundingBox!.min.x).toBeCloseTo(-4.45, 5);
    expect(roof.boundingBox!.max.z).toBeCloseTo(4.45, 5);
    expect(roof.boundingBox!.max.y).toBeCloseTo(
      3.8 + 4 * Math.tan((Math.PI * 32) / 180) + 0.18,
      5,
    );
  });
  it("keeps slope texture density in meters rather than stretching an XZ projection", () => {
    const result = createGabledRoof(8, 8, 3.8, "stone");
    [...result.roofs, ...result.walls].forEach((g) => geometries.add(g));
    const p = result.roofs[0].getAttribute("position"),
      n = result.roofs[0].getAttribute("normal"),
      uv = result.roofs[0].getAttribute("uv");
    const ratio = new Set<number>();
    for (let i = 0; i < p.count; i++)
      if (Math.abs(p.getX(i)) > 1 && Math.abs(n.getY(i)) > 0.5)
        ratio.add(Math.round((uv.getY(i) / Math.abs(p.getX(i))) * 1e5));
    expect(ratio.size).toBe(1);
  });
  it("closes each gable against the roof underside while overlapping the rectangular wall below", () => {
    const result = createGabledRoof(8, 8, 3.8, "stone");
    [...result.roofs, ...result.walls].forEach((g) => geometries.add(g));
    const material = new THREE.MeshBasicMaterial();
    materials.add(material);
    const roof = new THREE.Mesh(result.roofs[0], material);
    for (const [index, z] of [
      [0, -4],
      [4, 4],
    ]) {
      const gable = new THREE.Mesh(result.walls[index], material);
      gable.geometry.computeBoundingBox();
      expect(gable.geometry.boundingBox!.min.y).toBeCloseTo(3.78, 5);
      for (const x of [-3.99, -2, 0, 2, 3.99]) {
        const top = new THREE.Raycaster(
          new THREE.Vector3(x, 10, z),
          new THREE.Vector3(0, -1, 0),
        ).intersectObject(gable)[0];
        const underside = new THREE.Raycaster(
          new THREE.Vector3(x, 1, z),
          new THREE.Vector3(0, 1, 0),
        ).intersectObject(roof)[0];
        expect(top).toBeDefined();
        expect(underside).toBeDefined();
        expect(top.point.y).toBeCloseTo(underside.point.y, 5);
      }
    }
  });
  it("merges the actual building with its gable intact and no implicit furniture or layout mutation", () => {
    const g = generator(),
      plan = layout(g),
      before = structuredClone(plan);
    const result = g.generate("bank", {
      seed: "compact-lodge-test",
      cachedLayout: plan,
      roofStyle: "gable",
      includeProps: false,
      enableInteriorLighting: false,
    })!;
    const metrics = inspect(result.mesh);
    expect(result.mesh.getObjectByName("walls")).toBeDefined();
    expect(result.mesh.getObjectByName("roof")).toBeDefined();
    expect(metrics.triangles).toBeGreaterThan(500);
    expect(metrics.triangles).toBeLessThan(3000);
    expect(new THREE.Box3().setFromObject(result.mesh).max.y).toBeGreaterThan(
      6.4,
    );
    expect(result.propPlacements).toEqual({});
    expect(result.stats.props).toBe(0);
    expect(plan).toEqual(before);
    expect(result.layout).toBe(plan);
  });
  it("preserves the default flat-roof generation byte-for-byte when defaults are explicit", () => {
    const g = generator(),
      plan = layout(g);
    const a = g.generate("bank", {
      seed: "default-stability",
      cachedLayout: structuredClone(plan),
    })!;
    const b = g.generate("bank", {
      seed: "default-stability",
      cachedLayout: structuredClone(plan),
      roofStyle: "flat",
      includeProps: true,
    })!;
    expect(inspect(a.mesh)).toEqual(inspect(b.mesh));
    expect(a.stats).toEqual(b.stats);
    expect(a.propPlacements).toEqual(b.propPlacements);
    expect(a.stats.props).toBeGreaterThan(0);
  });
  it("rejects unsupported irregular, upper-floor and box-LOD combinations", () => {
    const g = generator(),
      plan = layout(g);
    expect(() =>
      g.generate("bank", {
        cachedLayout: plan,
        roofStyle: "gable",
        generateLODs: true,
      }),
    ).toThrow("silhouette");
    const irregular = structuredClone(plan);
    irregular.floorPlans[0].footprint[0][0] = false;
    expect(() =>
      g.generate("bank", { cachedLayout: irregular, roofStyle: "gable" }),
    ).toThrow("rectangular");
    expect(() =>
      g.generate("bank", {
        cachedLayout: { ...plan, floors: 2 },
        roofStyle: "gable",
      }),
    ).toThrow("rectangular");
    expect(() => createGabledRoof(NaN, 8, 3.8, "stone")).toThrow("finite");
    expect(() => createGabledRoof(10000, 8, 3.8, "stone")).toThrow("finite");
    expect(() => createGabledRoof(8, 8, Number.MAX_VALUE, "stone")).toThrow(
      "finite",
    );
    expect(() => createGabledRoof(8, 8, 3.8, "toString" as "stone")).toThrow(
      "finite",
    );
    expect(() =>
      g.generate("bank", {
        cachedLayout: { ...plan, foundationSteps: NaN },
        roofStyle: "gable",
      }),
    ).toThrow("rectangular");
  });
});
