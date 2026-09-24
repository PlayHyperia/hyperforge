import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  GRASS_MEADOW_REFINEMENT,
  getGrassBladeLayout,
  getGrassBladeWindFactor,
} from "../GrassBladeLayout";
import {
  createClumpGeometry,
  createMeadowDetailClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";

// Actual generated buffers and CPU mathematics; not native motion, grounding,
// material interpolation or measured GPU-cost acceptance.
const PAIRS = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [6, 6],
  [0, 2],
  [1, 2],
  [1, 3],
  [2, 4],
  [3, 4],
  [3, 5],
  [4, 6],
  [5, 6],
];
const PARENTS = [
  [0, 1, 2],
  [1, 3, 2],
  [2, 3, 4],
  [3, 5, 4],
  [4, 5, 6],
];
const UV = [
  [0, 0],
  [1, 0],
  [0, 1 / 3],
  [1, 1 / 3],
  [0, 2 / 3],
  [1, 2 / 3],
  [0.5, 1],
];
const point = (g: THREE.BufferGeometry, i: number) =>
  new THREE.Vector3().fromBufferAttribute(g.getAttribute("position"), i);
const area = (
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
function withTemplate(
  test: (r: ReturnType<typeof createMeadowDetailClumpGeometry>) => void,
) {
  const r = createMeadowDetailClumpGeometry();
  try {
    test(r);
  } finally {
    r.geometry.dispose();
    r.coarseGeometry.dispose();
  }
}

describe("bounded meadow longitudinal refinement template", () => {
  it("keeps all actual refined triangles nondegenerate and facing their authored normals", () => {
    withTemplate(({ geometry }) => {
      const index = geometry.index!;
      const normal = geometry.getAttribute("normal");
      for (let i = 0; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        const a = point(geometry, ids[0]);
        const cross = point(geometry, ids[1])
          .sub(a)
          .cross(point(geometry, ids[2]).sub(a));
        expect(cross.length()).toBeGreaterThan(1e-7);
        const expected = ids.reduce(
          (sum, id) =>
            sum.add(new THREE.Vector3().fromBufferAttribute(normal, id)),
          new THREE.Vector3(),
        );
        expect(cross.normalize().dot(expected.normalize())).toBeGreaterThan(
          0.85,
        );
      }
    });
  });
  it("freezes explicit addressing and does not admit this template into the live worker", () => {
    const r = GRASS_MEADOW_REFINEMENT;
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.parentPairs).toEqual(PAIRS);
    expect(r.parentPairs.every(Object.isFrozen)).toBe(true);
    expect(r.fineSamples.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(r.indices)).toBe(true);
    expect(r.verticesPerBlade).toBe(15);
    expect(r.trianglesPerBlade).toBe(15);
    expect(() =>
      Reflect.apply(getGrassBladeLayout, undefined, [0, r.id]),
    ).toThrow("Invalid grass blade layout");
    expect(
      getGrassBladeLayout(0, "fine-meadow-ribbon-v1").verticesPerClump,
    ).toBe(147);
  });
  it("partitions all five original triangles with matching winding and shared edges", () => {
    const coords = PAIRS.map(([a, b]) => [
      (UV[a][0] + UV[b][0]) / 2,
      (UV[a][1] + UV[b][1]) / 2,
    ]);
    const indices = GRASS_MEADOW_REFINEMENT.indices;
    const edges = new Map<string, number[]>();
    for (let parent = 0; parent < 5; parent++) {
      const [a, b, c] = PARENTS[parent].map((i) => UV[i]);
      let sum = 0;
      for (let child = 0; child < 3; child++) {
        const ids = indices.slice(
          parent * 9 + child * 3,
          parent * 9 + child * 3 + 3,
        );
        const triangleArea = area(
          coords[ids[0]],
          coords[ids[1]],
          coords[ids[2]],
        );
        expect(triangleArea).toBeGreaterThan(0);
        sum += triangleArea;
        for (const i of ids)
          expect(
            Math.min(
              area(a, b, coords[i]),
              area(b, c, coords[i]),
              area(c, a, coords[i]),
            ),
          ).toBeGreaterThanOrEqual(-1e-16);
        for (let e = 0; e < 3; e++) {
          const from = ids[e],
            to = ids[(e + 1) % 3],
            key = [Math.min(from, to), Math.max(from, to)].join(":");
          const directions = edges.get(key) ?? [];
          directions.push(Math.sign(to - from));
          edges.set(key, directions);
        }
      }
      expect(sum).toBeCloseTo(area(a, b, c), 14);
    }
    expect([...edges.values()].filter((e) => e.length === 1)).toHaveLength(13);
    for (const e of edges.values()) {
      expect(e.length).toBeLessThanOrEqual(2);
      if (e.length === 2) expect(e[0] + e[1]).toBe(0);
    }
    expect(edges.get("0:1")).toHaveLength(1);
  });
  it("keeps original vertices exact, rooted UV interpolation and only three vertex streams", () => {
    withTemplate(({ geometry, coarseGeometry, coarseVertexPairs }) => {
      expect(Object.keys(geometry.attributes).sort()).toEqual([
        "normal",
        "position",
        "uv",
      ]);
      expect(geometry.getAttribute("position").count).toBe(315);
      expect(geometry.index?.count).toBe(945);
      expect(coarseVertexPairs).toBeInstanceOf(Uint32Array);
      expect(coarseVertexPairs.length).toBe(630);
      for (const name of ["position", "normal", "uv"]) {
        const fine = geometry.getAttribute(name),
          coarse = coarseGeometry.getAttribute(name),
          s = fine.itemSize;
        expect(Array.from(fine.array).every(Number.isFinite)).toBe(true);
        for (let b = 0; b < 21; b++)
          expect(
            Array.from(fine.array.slice(b * 15 * s, (b * 15 + 7) * s)),
          ).toEqual(Array.from(coarse.array.slice(b * 7 * s, (b + 1) * 7 * s)));
      }
      const cu = coarseGeometry.getAttribute("uv"),
        fu = geometry.getAttribute("uv");
      for (let b = 0; b < 21; b++)
        for (let v = 0; v < 15; v++) {
          const [a, c] = PAIRS[v].map((i) => b * 7 + i);
          expect(
            Array.from(
              coarseVertexPairs.slice((b * 15 + v) * 2, (b * 15 + v + 1) * 2),
            ),
          ).toEqual([a, c]);
          expect(fu.getX(b * 15 + v)).toBe(
            Math.fround((cu.getX(a) + cu.getX(c)) * 0.5),
          );
          expect(fu.getY(b * 15 + v)).toBe(
            Math.fround((cu.getY(a) + cu.getY(c)) * 0.5),
          );
        }
      expect(fu.getX(13)).toBe(0.25);
      expect(fu.getX(14)).toBe(0.75);
    });
  });
  it("uses authored curve samples and reduces centerline chord error fourfold", () => {
    withTemplate(({ geometry, coarseGeometry }) => {
      const stations = [
        [0, 1],
        [7, 9],
        [2, 3],
        [10, 12],
        [4, 5],
        [13, 14],
        [6, 6],
      ];
      for (let b = 0; b < 21; b++) {
        const root = point(coarseGeometry, b * 7)
            .add(point(coarseGeometry, b * 7 + 1))
            .multiplyScalar(0.5),
          tip = point(coarseGeometry, b * 7 + 6);
        const curve = (t: number) =>
          new THREE.Vector3(
            root.x + (tip.x - root.x) * (0.7 * t + 0.3 * t * t),
            (tip.y * (1.52 * t - 0.57 * t * t)) / 0.95,
            root.z + (tip.z - root.z) * (0.7 * t + 0.3 * t * t),
          );
        const centers = stations.map(([a, c]) =>
          point(geometry, b * 15 + a)
            .add(point(geometry, b * 15 + c))
            .multiplyScalar(0.5),
        );
        for (let i = 0; i < 7; i++)
          expect(centers[i].distanceTo(curve(i / 6))).toBeLessThan(2e-7);
        let coarseError = 0,
          fineError = 0;
        for (let i = 0; i < 6; i++) {
          fineError = Math.max(
            fineError,
            centers[i]
              .clone()
              .lerp(centers[i + 1], 0.5)
              .distanceTo(curve((i + 0.5) / 6)),
          );
          if (i % 2 === 0)
            coarseError = Math.max(
              coarseError,
              centers[i]
                .clone()
                .lerp(centers[i + 2], 0.5)
                .distanceTo(curve((i + 1) / 6)),
            );
        }
        expect(coarseError).toBeGreaterThan(1e-4);
        expect(fineError).toBeLessThan(coarseError * 0.251 + 2e-7);
      }
    });
  });
  it.each([-1, 0, 1])(
    "preserves coarse endpoint mathematics under nonlinear wind %s and unequal roots",
    (wind) => {
      withTemplate(({ geometry, coarseGeometry, coarseVertexPairs }) => {
        const uv = coarseGeometry.getAttribute("uv"),
          fineUv = geometry.getAttribute("uv");
        const tilt = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0.3, 1, -0.2).normalize(),
        );
        const deform = (p: THREE.Vector3, t: number, u: number) => {
          const flex = getGrassBladeWindFactor(
            t,
            p.y,
            1.3,
            "fine-meadow-ribbon-v1",
          );
          return p
            .clone()
            .multiplyScalar(1.3)
            .add(new THREE.Vector3(wind * 0.16 * flex, 0, wind * 0.07 * flex))
            .applyQuaternion(tilt)
            .add(new THREE.Vector3(0, -0.03 * (1 - u) + 0.05 * u, 0));
        };
        let naiveError = 0;
        for (let b = 0; b < 21; b++)
          for (let local = 7; local < 15; local++) {
            const v = b * 15 + local,
              a = coarseVertexPairs[v * 2],
              c = coarseVertexPairs[v * 2 + 1];
            const expected = deform(
              point(coarseGeometry, a),
              uv.getY(a),
              uv.getX(a),
            ).lerp(
              deform(point(coarseGeometry, c), uv.getY(c), uv.getX(c)),
              0.5,
            );
            const finalRoot = deform(point(coarseGeometry, a), uv.getY(a), 0)
              .lerp(deform(point(coarseGeometry, c), uv.getY(c), 0), 0.5)
              .add(new THREE.Vector3(0, 0.08 * fineUv.getX(v), 0));
            expect(finalRoot.distanceTo(expected)).toBeLessThan(1e-14);
            const naive = deform(
              point(coarseGeometry, a).lerp(point(coarseGeometry, c), 0.5),
              (uv.getY(a) + uv.getY(c)) * 0.5,
              fineUv.getX(v),
            );
            naiveError = Math.max(naiveError, naive.distanceTo(expected));
          }
        if (wind !== 0) expect(naiveError).toBeGreaterThan(0.001);
      });
    },
  );
  it("creates independent deterministic templates without changing retained generation", () => {
    withTemplate((a) =>
      withTemplate((b) => {
        for (const name of ["position", "normal", "uv"]) {
          expect(a.geometry.getAttribute(name).array).not.toBe(
            b.geometry.getAttribute(name).array,
          );
          expect(a.geometry.getAttribute(name).array).toEqual(
            b.geometry.getAttribute(name).array,
          );
        }
        expect(a.geometry.index?.array).toEqual(b.geometry.index?.array);
        const direct = createClumpGeometry(
          21,
          3,
          FINE_GRASS_MEADOW_FIELD_SHAPE,
        );
        try {
          for (const name of ["position", "normal", "uv"])
            expect(a.coarseGeometry.getAttribute(name).array).toEqual(
              direct.getAttribute(name).array,
            );
          expect(a.coarseGeometry.index?.array).toEqual(direct.index?.array);
        } finally {
          direct.dispose();
        }
      }),
    );
  });
});
