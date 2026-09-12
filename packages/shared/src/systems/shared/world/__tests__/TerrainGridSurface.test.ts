import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  RetainedTerrainSurface,
  type TerrainGridSample,
  type TerrainGridTriangle,
  type TerrainGridBounds,
} from "../TerrainGridSurface";
import {
  projectGrassAnchors,
  type GrassAnchorData,
} from "../GrassTerrainProjection";
import { gridGeometry } from "./terrain-grid.fixture";

const sample = (): TerrainGridSample => ({
  height: 0,
  nx: 0,
  ny: 1,
  nz: 0,
  faceIndex: 0,
});

describe("retained Float32 terrain triangle contact", () => {
  it.each([
    [2, 100],
    [16, 100],
    [64, 100],
    [256, 0.03125],
  ])(
    "resumes allocation-free original triangle traversal at every Float32 boundary r=%s size=%s",
    (resolution, size) => {
      const geometry = gridGeometry(
        size,
        resolution,
        (x, z) => 20 + Math.sin(x) + Math.cos(z),
      );
      const surface = new RetainedTerrainSurface(
        1,
        "cursor",
        350,
        250,
        size,
        resolution,
        geometry,
      );
      const p = geometry.getAttribute("position"),
        index = geometry.getIndex()!;
      try {
        const half = size / 2,
          m = Math.floor(resolution / 2);
        const x = p.getX(m),
          z = p.getZ(m * resolution);
        const boxes: TerrainGridBounds[] = [
          { minX: -half, maxX: half, minZ: -half, maxZ: half },
          { minX: x, maxX: x, minZ: z, maxZ: z },
          {
            minX: x - size * 1e-9,
            maxX: x - size * 1e-9,
            minZ: -half,
            maxZ: half,
          },
          {
            minX: x + size * 1e-9,
            maxX: x + size * 1e-9,
            minZ: -half,
            maxZ: half,
          },
          { minX: -half, maxX: -half, minZ: -half, maxZ: -half },
          { minX: half, maxX: half, minZ: half, maxZ: half },
          { minX: -size, maxX: size, minZ: -size, maxZ: size },
          { minX: -size, maxX: -half - size / 100, minZ: -half, maxZ: half },
        ];
        for (const bounds of boxes) {
          const expected: TerrainGridTriangle[] = [];
          const receipt = surface.visitTrianglesInBounds(
            bounds,
            (...triangle) => expected.push(triangle),
            1_000_000,
          );
          expect(receipt.exhausted).toBe(false);
          const cursor = surface.createTriangleCursor(bounds),
            out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          let count = 0;
          while (cursor.next(out)) {
            expect(out).toEqual(expected[count++]);
            for (let corner = 0; corner < 3; corner++) {
              const vertex = index.getX(out[9] * 3 + corner);
              expect(out[corner * 3]).toBe(p.getX(vertex));
              expect(out[corner * 3 + 1]).toBe(p.getY(vertex));
              expect(out[corner * 3 + 2]).toBe(p.getZ(vertex));
            }
          }
          expect(count).toBe(receipt.visited);
          const last = [...out];
          expect(cursor.next(out)).toBe(false);
          expect(out).toEqual(last);
        }
        expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        geometry.dispose();
      }
    },
  );

  it("keeps independent paused cursors and rejects invalid bounds without modifying output/geometry", () => {
    const geometry = gridGeometry(100, 16, () => 20);
    const surface = new RetainedTerrainSurface(
      1,
      "cursor",
      0,
      0,
      100,
      16,
      geometry,
    );
    try {
      const bounds = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
      const a = surface.createTriangleCursor(bounds),
        b = surface.createTriangleCursor(bounds);
      const out: TerrainGridTriangle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        before = geometry.getAttribute("position").array.slice();
      for (let face = 0; face < 27; face++) {
        expect(a.next(out)).toBe(true);
        expect(out[9]).toBe(face);
      }
      expect(b.next(out)).toBe(true);
      expect(out[9]).toBe(0);
      expect(a.next(out)).toBe(true);
      expect(out[9]).toBe(27);
      expect(geometry.getAttribute("position").array).toEqual(before);
      for (const invalid of [
        { ...bounds, minX: NaN },
        { ...bounds, minZ: Infinity },
        { ...bounds, minX: 51 },
      ])
        expect(() => surface.createTriangleCursor(invalid)).toThrow(
          "Invalid retained",
        );
    } finally {
      geometry.dispose();
    }
  });

  it.each([4, 16, 64])(
    "matches real mesh ray hits across both triangle halves, vertices and boundaries at resolution %s",
    (resolution) => {
      const geometry = gridGeometry(
        100,
        resolution,
        (x, z) => 25 + Math.sin(x * 0.17) + Math.cos(z * 0.11) + x * z * 0.002,
      );
      const surface = new RetainedTerrainSurface(
        1,
        "fixture",
        450,
        450,
        100,
        resolution,
        geometry,
      );
      const material = new THREE.MeshBasicMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      const ray = new THREE.Raycaster();
      const out = sample();
      let tested = 0;
      try {
        const step = Math.max(1, Math.floor(resolution / 8));
        for (let z = 0; z < resolution - 1; z += step)
          for (let x = 0; x < resolution - 1; x += step) {
            const p = geometry.getAttribute("position");
            const a = z * resolution + x;
            for (const [u, v] of [
              [0.1, 0.2],
              [0.8, 0.7],
              [0, 0],
              [1, 1],
            ]) {
              const lx = p.getX(a) + (p.getX(a + 1) - p.getX(a)) * u;
              const lz = p.getZ(a) + (p.getZ(a + resolution) - p.getZ(a)) * v;
              expect(surface.sample(lx, lz, out)).toBe(true);
              ray.set(
                new THREE.Vector3(lx, 100, lz),
                new THREE.Vector3(0, -1, 0),
              );
              const hits = ray.intersectObject(mesh);
              expect(hits.length).toBeGreaterThan(0);
              expect(out.height).toBeCloseTo(hits[0].point.y, 10);
              if (u !== v) {
                expect(out.faceIndex).toBe(hits[0].faceIndex);
                expect(out.nx).toBeCloseTo(hits[0].face!.normal.x, 10);
                expect(out.ny).toBeCloseTo(hits[0].face!.normal.y, 10);
                expect(out.nz).toBeCloseTo(hits[0].face!.normal.z, 10);
              }
              tested++;
            }
          }
        expect(tested).toBe(4 * Math.ceil((resolution - 1) / step) ** 2);
        expect(surface.sample(50.01, 0, out)).toBe(false);
        expect(surface.sample(NaN, 0, out)).toBe(false);
      } finally {
        geometry.dispose();
        material.dispose();
      }
    },
  );

  it("reproduces archived compact-v1 probe08 face20 and corrects its 74.249mm gap", () => {
    // Retained probe08 triangle data, deliberately independent of the evolving
    // compact-v2 manifest. These are actual rendered Float32 vertex heights.
    const geometry = gridGeometry(100, 16, () => 22);
    const p = geometry.getAttribute("position");
    p.setY(10, 22.144079208374023);
    p.setY(11, 22.140716552734375);
    p.setY(26, 22.243621826171875);
    const surface = new RetainedTerrainSurface(
      60,
      "archived-compact-v1-probe08",
      450,
      450,
      100,
      16,
      geometry,
    );
    const original: GrassAnchorData = {
      count: 1,
      offsets: new Float32Array([
        22.07981300354004, 22.232837677001953, -48.845394134521484,
      ]),
      rotScaleHash: new Float32Array([1, 1, 0.5]),
      groundColors: new Float32Array([0.1, 0.2, 0.3]),
      grassTints: new Float32Array([1, 1, 1, 0.5]),
      groundNormals: new Float32Array([
        0.04902935028076172, 0.9976301789283752, -0.04827174171805382,
      ]),
    };
    try {
      const out = sample();
      expect(
        surface.sample(original.offsets[0], original.offsets[2], out),
      ).toBe(true);
      expect(out.faceIndex).toBe(20);
      expect(out.height).toBeCloseTo(22.158588696783227, 10);
      expect(original.offsets[1] - out.height).toBeCloseTo(
        0.0742489802187265,
        10,
      );
      const projected = projectGrassAnchors(
        original,
        surface,
        () => 16,
        () => false,
      );
      expect(Math.abs(projected.offsets[1] - out.height)).toBeLessThan(1e-6);
      expect(projected.grounding.computedHeights[0]).toBe(original.offsets[1]);
      expect(projected.grounding.ecologicalNormals).toEqual(
        original.groundNormals,
      );
      expect(projected.groundNormals).not.toEqual(original.groundNormals);
      expect(original.offsets[1]).toBe(22.232837677001953);
    } finally {
      geometry.dispose();
    }
  });

  it("rechecks elevated water and exclusions on projected anchors and compacts every attribute without changing inputs", () => {
    const geometry = gridGeometry(8, 4, (x) => 25 + x);
    const surface = new RetainedTerrainSurface(
      1,
      "fixture",
      350,
      320,
      8,
      4,
      geometry,
    );
    const data: GrassAnchorData = {
      count: 4,
      offsets: new Float32Array([-3, 30, 0, -1, 30, 0, 1, 30, 0, 3, 30, 0]),
      rotScaleHash: Float32Array.from({ length: 12 }, (_, i) => i),
      groundColors: Float32Array.from({ length: 12 }, (_, i) => i + 20),
      grassTints: Float32Array.from({ length: 16 }, (_, i) => i + 40),
      groundNormals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    };
    const before = structuredClone(data);
    try {
      const result = projectGrassAnchors(
        data,
        surface,
        () => 24,
        (x) => x === 353,
      );
      expect(result.count).toBe(1);
      expect(Array.from(result.offsets)).toEqual([1, 26, 0]);
      expect(result.rotScaleHash).toEqual(data.rotScaleHash.slice(6, 9));
      expect(result.groundColors).toEqual(data.groundColors.slice(6, 9));
      expect(result.grassTints).toEqual(data.grassTints.slice(8, 12));
      expect(result.groundNormals.length).toBe(3);
      expect(result.grounding.computedHeights).toEqual(new Float32Array([30]));
      expect(data).toEqual(before);
      expect(
        projectGrassAnchors(
          data,
          surface,
          () => 31,
          () => false,
        ).count,
      ).toBe(0);
    } finally {
      geometry.dispose();
    }
  });
});
