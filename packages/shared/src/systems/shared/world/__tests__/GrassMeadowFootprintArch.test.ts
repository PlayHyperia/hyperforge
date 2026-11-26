import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  createClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import type { GrassMeadowAuthoredBlade } from "../GrassMeadowAuthoredShape";
import {
  assertGrassMeadowFootprintArchEndpoint,
  createMeadowFootprintArchBuffers,
  getMeadowFootprintArchWindFactor,
  GRASS_MEADOW_FOOTPRINT_ARCH as R,
  type GrassMeadowFootprintArchSourceShape,
} from "../GrassMeadowFootprintArch";

const widthControls = [0.25, 2.3, 1.3, 0, 0] as const;
const B = (t: number) =>
  t * (2 * R.controlHeight + t * (R.tipHeight - 2 * R.controlHeight));

// Actual seeded factory + Three buffers, no renderer or mocked source owner.
// Width selection is explicit; this does not change the default field recipe.
function fixture(bezier = false) {
  const blades: GrassMeadowAuthoredBlade[] = [];
  const shape = {
    ...FINE_GRASS_MEADOW_FIELD_SHAPE,
    ...(bezier ? { BLADE_WIDTH_BEZIER_CONTROL_POINTS: widthControls } : {}),
  };
  const coarse = createClumpGeometry(21, 3, shape, undefined, (blade) =>
    blades.push(blade),
  );
  const buffers = createMeadowFootprintArchBuffers(coarse, blades, shape);
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
  geometry.userData[R.metadataKey] = buffers.recipe;
  return {
    coarse,
    geometry,
    blades,
    shape,
    buffers,
    dispose() {
      coarse.dispose();
      geometry.dispose();
    },
  };
}

/** Independent central-difference pullbacks within each original face's
 * affine UV extension, with h fixed. Incident areas weight covectors, not
 * normalized face normals. Extrapolating that one face at its boundary is
 * deliberate; no differentiability across a crease is asserted. */
function finiteDifferenceNormals(value: ReturnType<typeof fixture>) {
  const coarseUv = value.coarse.getAttribute("uv"),
    coarseP = value.coarse.getAttribute("position"),
    fineUv = value.geometry.getAttribute("uv"),
    coarseIndex = value.coarse.index!,
    fineIndex = value.geometry.index!;
  const result = Array.from({ length: 315 }, () => new THREE.Vector3());
  let sampledFaces = 0;
  for (let blade = 0; blade < 21; blade++) {
    const faces = Array.from({ length: 5 }, (_, face) => {
      const ids = [0, 1, 2].map((k) =>
        coarseIndex.getX(blade * 15 + face * 3 + k),
      );
      const uv = ids.map(
        (i) => new THREE.Vector2(coarseUv.getX(i), coarseUv.getY(i)),
      );
      const edge1 = uv[1].clone().sub(uv[0]),
        edge2 = uv[2].clone().sub(uv[0]);
      const determinant = edge1.cross(edge2);
      const bary = (u: number, t: number) => {
        const offset = new THREE.Vector2(u, t).sub(uv[0]),
          v = offset.cross(edge2) / determinant,
          w = edge1.cross(offset) / determinant;
        return [1 - v - w, v, w];
      };
      const point = (u: number, t: number) => {
        const weights = bary(u, t),
          p = new THREE.Vector3();
        for (let k = 0; k < 3; k++)
          p.addScaledVector(
            new THREE.Vector3(coarseP.getX(ids[k]), 0, coarseP.getZ(ids[k])),
            weights[k],
          );
        p.y = value.blades[blade].height * B(t);
        return p;
      };
      return { bary, point };
    });
    for (let triangle = 0; triangle < 15; triangle++) {
      const ids = [0, 1, 2].map((k) =>
        fineIndex.getX(blade * 45 + triangle * 3 + k),
      );
      const uv = ids.map(
        (i) => new THREE.Vector2(fineUv.getX(i), fineUv.getY(i)),
      );
      const center = uv
        .reduce((sum, p) => sum.add(p), new THREE.Vector2())
        .divideScalar(3);
      const selected = faces.filter(
        (face) => Math.min(...face.bary(center.x, center.y)) > 1e-7,
      );
      expect(selected).toHaveLength(1);
      const area = uv[1].clone().sub(uv[0]).cross(uv[2].clone().sub(uv[0])) / 2;
      for (const i of ids) {
        const u = fineUv.getX(i),
          t = fineUv.getY(i),
          eps = 1e-6,
          { point } = selected[0];
        const pu = point(u + eps, t)
          .sub(point(u - eps, t))
          .divideScalar(2 * eps);
        const pt = point(u, t + eps)
          .sub(point(u, t - eps))
          .divideScalar(2 * eps);
        const covector = pu.cross(pt);
        expect(covector.length()).toBeGreaterThan(1e-10);
        result[i].addScaledVector(covector, area);
        sampledFaces++;
      }
    }
  }
  expect(sampledFaces).toBe(945);
  return result.map((normal) => normal.normalize());
}

describe("explicit footprint-locked meadow arch", () => {
  it.each([false, true])(
    "regenerates the real coarse source and all endpoint streams (Bezier %s)",
    (bezier) => {
      const value = fixture(bezier);
      try {
        const { coarse, geometry, blades, shape, buffers } = value;
        const coarseBefore = coarse.getAttribute("position").array.slice();
        const again = createMeadowFootprintArchBuffers(coarse, blades, shape);
        for (const name of [
          "positions",
          "normals",
          "uv",
          "indices",
          "coarseVertexPairs",
        ] as const) {
          expect(again[name]).toEqual(buffers[name]);
          expect(again[name]).not.toBe(buffers[name]);
        }
        expect(geometry.getAttribute("position").count).toBe(315);
        expect(geometry.index!.count).toBe(945);
        expect(buffers.coarseVertexPairs).toHaveLength(630);
        expect(coarse.getAttribute("position").array).toEqual(coarseBefore);
        expect(Object.isFrozen(buffers.recipe)).toBe(true);
        expect(Object.isFrozen(buffers.recipe.blades)).toBe(true);
        expect(Object.isFrozen(buffers.recipe.sourceShape)).toBe(true);
        if (bezier)
          expect(
            Object.isFrozen(
              buffers.recipe.sourceShape.BLADE_WIDTH_BEZIER_CONTROL_POINTS,
            ),
          ).toBe(true);
        expect(() =>
          assertGrassMeadowFootprintArchEndpoint(geometry, coarse),
        ).not.toThrow();
        const clone = geometry.clone();
        try {
          clone.setAttribute(
            "unrelatedOwnedStorage",
            new THREE.BufferAttribute(new Float32Array(4), 4),
          );
          expect(() =>
            assertGrassMeadowFootprintArchEndpoint(clone, coarse),
          ).not.toThrow();
        } finally {
          clone.dispose();
        }
      } finally {
        value.dispose();
      }
    },
  );

  it("preserves exact root/XZ footprint, barycentric UV, canonical topology and fixed height provenance", () => {
    const value = fixture(true);
    try {
      const { buffers, coarse, blades } = value;
      const p = coarse.getAttribute("position"),
        uv = coarse.getAttribute("uv");
      for (let vertex = 0; vertex < 315; vertex++) {
        const [a, b] = Array.from(
          buffers.coarseVertexPairs.subarray(vertex * 2, vertex * 2 + 2),
        );
        expect(buffers.positions[vertex * 3]).toBe(
          Math.fround((p.getX(a) + p.getX(b)) / 2),
        );
        expect(buffers.positions[vertex * 3 + 2]).toBe(
          Math.fround((p.getZ(a) + p.getZ(b)) / 2),
        );
        expect(buffers.uv[vertex * 2]).toBe(
          Math.fround((uv.getX(a) + uv.getX(b)) / 2),
        );
        expect(buffers.uv[vertex * 2 + 1]).toBe(
          Math.fround((uv.getY(a) + uv.getY(b)) / 2),
        );
        expect(buffers.positions[vertex * 3 + 1]).toBe(
          Math.fround(
            blades[Math.floor(vertex / 15)].height *
              B(buffers.uv[vertex * 2 + 1]),
          ),
        );
      }
      for (let blade = 0; blade < 21; blade++) {
        for (let root = 0; root < 2; root++) {
          const vertex = blade * 15 + root,
            parent = blade * 7 + root;
          expect(
            Array.from(buffers.positions.subarray(vertex * 3, vertex * 3 + 3)),
          ).toEqual([p.getX(parent), p.getY(parent), p.getZ(parent)]);
        }
        expect(
          Array.from(buffers.indices.subarray(blade * 45, blade * 45 + 45)),
        ).toEqual(R.indices.map((i) => i + blade * 15));
      }
      expect(B(0.7)).toBeCloseTo(0.95, 14);
      expect(B(1)).toBeLessThan(B(2 / 3));
    } finally {
      value.dispose();
    }
  });

  it.each([false, true])(
    "matches independent face finite differences including roots/tips/creases (Bezier %s)",
    (bezier) => {
      const value = fixture(bezier);
      try {
        const expected = finiteDifferenceNormals(value),
          normal = value.geometry.getAttribute("normal");
        let maxError = 0;
        for (let i = 0; i < normal.count; i++) {
          const actual = new THREE.Vector3().fromBufferAttribute(normal, i);
          expect(Math.abs(actual.length() - 1)).toBeLessThan(6e-8);
          maxError = Math.max(maxError, actual.distanceTo(expected[i]));
        }
        expect(maxError).toBeLessThan(2e-6);
      } finally {
        value.dispose();
      }
    },
  );

  it.each(["position", "normal", "uv"])(
    "rejects changed endpoint %s",
    (name) => {
      const value = fixture(true);
      try {
        const stream = value.geometry.getAttribute(name);
        stream.setX(8, stream.getX(8) + 0.001);
        expect(() =>
          assertGrassMeadowFootprintArchEndpoint(value.geometry, value.coarse),
        ).toThrow();
      } finally {
        value.dispose();
      }
    },
  );

  it.each([
    "id",
    "blade",
    "shape",
    "width",
    "topology",
    "coarse",
    "coarse-normal",
    "coarse-uv",
    "coarse-index",
    "missing",
    "layout",
  ])("rejects forged %s provenance or source", (change) => {
    const value = fixture(true);
    try {
      const recipe = structuredClone(value.buffers.recipe);
      value.geometry.userData[R.metadataKey] = recipe;
      if (change === "id")
        Reflect.set(recipe, "id", "meadow-authored-silhouette-v1");
      if (change === "blade")
        Reflect.set(recipe.blades[0], "height", recipe.blades[0].height * 1.01);
      if (change === "shape")
        Reflect.set(recipe.sourceShape, "BLADE_CONTROL_HEIGHT", 0.74);
      if (change === "width")
        Reflect.set(
          recipe.sourceShape,
          "BLADE_WIDTH_BEZIER_CONTROL_POINTS",
          [0.25, 2.2, 1.3, 0, 0],
        );
      if (change === "topology") value.geometry.index!.setX(0, 20);
      if (change === "coarse") value.coarse.getAttribute("position").setX(4, 0);
      if (change === "coarse-normal")
        value.coarse.getAttribute("normal").setY(4, NaN);
      if (change === "coarse-uv") value.coarse.getAttribute("uv").setX(4, 0.25);
      if (change === "coarse-index") value.coarse.index!.setX(4, 5);
      if (change === "missing") delete value.geometry.userData[R.metadataKey];
      if (change === "layout")
        value.geometry.setAttribute(
          "position",
          new THREE.InstancedBufferAttribute(value.buffers.positions, 3),
        );
      expect(() =>
        assertGrassMeadowFootprintArchEndpoint(value.geometry, value.coarse),
      ).toThrow();
    } finally {
      value.dispose();
    }
  });

  it("rejects invalid controls and a Float32-collapsed root direction without mutating coarse buffers", () => {
    const value = fixture();
    try {
      const before = value.coarse.getAttribute("position").array.slice();
      const invalid: GrassMeadowFootprintArchSourceShape = {
        ...value.shape,
        BLADE_WIDTH_BEZIER_CONTROL_POINTS: [0.25, NaN, 1.3, 0, 0],
      };
      expect(() =>
        createMeadowFootprintArchBuffers(value.coarse, value.blades, invalid),
      ).toThrow();
      const narrowBlades: GrassMeadowAuthoredBlade[] = [];
      const narrowShape = { ...value.shape, BLADE_WIDTH_RATIO: 1e-10 };
      const narrow = createClumpGeometry(
        21,
        3,
        narrowShape,
        undefined,
        (blade) => narrowBlades.push(blade),
      );
      try {
        expect(narrowBlades.every((blade) => blade.width > 0)).toBe(true);
        expect(() =>
          createMeadowFootprintArchBuffers(narrow, narrowBlades, narrowShape),
        ).toThrow("Degenerate footprint root-width direction");
      } finally {
        narrow.dispose();
      }
      expect(value.coarse.getAttribute("position").array).toEqual(before);
    } finally {
      value.dispose();
    }
  });

  it("bounds peak-normalized wind for all rows, scales and heights with exact root zero", () => {
    for (const h of [0.12, 0.46, 0.86, 1.2])
      for (const scale of [0.7, 1, 1.3]) {
        const amplitude = Math.min(1, (scale * h) / R.maximumHeight);
        for (let i = 0; i <= 1000; i++) {
          const t = i / 1000,
            factor = getMeadowFootprintArchWindFactor(t, h * B(t), scale);
          expect(Number.isFinite(factor)).toBe(true);
          expect(factor).toBeGreaterThanOrEqual(0);
          expect(factor).toBeLessThanOrEqual(1);
          expect(factor).toBeCloseTo(
            amplitude * (B(t) / R.peakHeight) ** 2,
            13,
          );
        }
        expect(getMeadowFootprintArchWindFactor(0, 0, scale)).toBe(0);
        expect(
          getMeadowFootprintArchWindFactor(0.7, h * B(0.7), scale),
        ).toBeCloseTo(amplitude, 13);
      }
    for (const input of [
      [NaN, 1, 1],
      [1.1, 1, 1],
      [0.5, -1, 1],
      [0.5, 1, 0],
    ])
      expect(() =>
        getMeadowFootprintArchWindFactor(
          ...(input as [number, number, number]),
        ),
      ).toThrow();
  });
});
