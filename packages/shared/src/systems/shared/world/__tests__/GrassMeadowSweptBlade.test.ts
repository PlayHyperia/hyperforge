import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  createClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import type { GrassMeadowAuthoredBlade } from "../GrassMeadowAuthoredShape";
import {
  assertGrassMeadowSweptBladeEndpoint,
  createMeadowSweptBladeBuffers,
  getMeadowSweptBladeWindFactor,
  GRASS_MEADOW_SWEPT_BLADE as R,
} from "../GrassMeadowSweptBlade";

// Real seeded generator and real Three buffers. These CPU contracts do not
// admit a renderer, placement, visual result or production performance.
function fixture(quartic = true) {
  const blades: GrassMeadowAuthoredBlade[] = [];
  const shape = {
    ...FINE_GRASS_MEADOW_FIELD_SHAPE,
    ...(quartic
      ? { BLADE_WIDTH_BEZIER_CONTROL_POINTS: [0.25, 2.3, 1.3, 0, 0] as const }
      : {}),
  };
  const coarse = createClumpGeometry(21, 3, shape, undefined, (blade) =>
    blades.push(blade),
  );
  const buffers = createMeadowSweptBladeBuffers(coarse, blades, shape);
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
    blades,
    shape,
    buffers,
    geometry,
    dispose() {
      geometry.dispose();
      coarse.dispose();
    },
  };
}

function sample(local: number) {
  const row =
    local < 7
      ? local === 6
        ? 6
        : Math.floor(local / 2) * 2
      : R.fineSamples[local - 7][0];
  const side =
    local < 7
      ? local === 6
        ? 0
        : (local % 2) * 2 - 1
      : R.fineSamples[local - 7][1] * 2 - 1;
  return { row, side, t: Math.sin(((row / 6) * Math.PI) / 2) };
}

// Independent de Casteljau evaluation, rather than the implementation's
// expanded polynomial, and finite-difference tangents including tip limits.
function bezier(controls: readonly number[], t: number) {
  const values = [...controls];
  for (let remaining = values.length - 1; remaining > 0; remaining--)
    for (let i = 0; i < remaining; i++)
      values[i] = values[i] * (1 - t) + values[i + 1] * t;
  return values[0];
}

function independentSurface(value: ReturnType<typeof fixture>, blade: number) {
  const p = value.coarse.getAttribute("position"),
    lo = new THREE.Vector3().fromBufferAttribute(p, blade * 7),
    hi = new THREE.Vector3().fromBufferAttribute(p, blade * 7 + 1),
    span = lo.distanceTo(hi),
    axis = hi.clone().sub(lo).normalize(),
    root = lo.clone().add(hi).multiplyScalar(0.5),
    b = value.blades[blade];
  return {
    axis,
    point(t: number, side: number) {
      return root
        .clone()
        .add(
          new THREE.Vector3(
            b.curveX * t * t,
            b.height * bezier([0, 0.95, 0.95], t),
            b.curveZ * t * t,
          ),
        )
        .addScaledVector(
          axis,
          (span / 0.25) * 0.5 * bezier([0.25, 1.55, 1.05, 0.15, 0], t) * side,
        );
    },
  };
}

describe("explicit sine-sampled continuous meadow sweep", () => {
  it.each([false, true])(
    "regenerates exact owned buffers and clone-compatible provenance (quartic %s)",
    (quartic) => {
      const value = fixture(quartic);
      try {
        const { coarse, geometry, blades, shape, buffers } = value;
        const original = coarse.getAttribute("position").array.slice();
        const again = createMeadowSweptBladeBuffers(coarse, blades, shape);
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
        expect(coarse.getAttribute("position").array).toEqual(original);
        expect(buffers.positions).toHaveLength(945);
        expect(buffers.indices).toHaveLength(945);
        expect(buffers.coarseVertexPairs).toHaveLength(630);
        expect(Object.isFrozen(buffers.recipe)).toBe(true);
        expect(Object.isFrozen(buffers.recipe.blades)).toBe(true);
        expect(Object.isFrozen(buffers.recipe.blades[0])).toBe(true);
        expect(Object.isFrozen(buffers.recipe.sourceShape)).toBe(true);
        expect(buffers.recipe.blades).not.toBe(blades);
        expect(buffers.recipe.sourceShape).not.toBe(shape);
        expect(buffers.recipe.samplePolicy).toBe("tip-weighted-sine-v1");
        expect(buffers.recipe.materialUvPolicy).toBe(
          "coarse-parent-barycentric-v1",
        );
        expect(() =>
          assertGrassMeadowSweptBladeEndpoint(geometry, coarse),
        ).not.toThrow();
        const clone = geometry.clone();
        try {
          clone.setAttribute(
            "unrelatedOwnedStorage",
            new THREE.BufferAttribute(new Float32Array(4), 4),
          );
          expect(() =>
            assertGrassMeadowSweptBladeEndpoint(clone, coarse),
          ).not.toThrow();
        } finally {
          clone.dispose();
        }
      } finally {
        value.dispose();
      }
    },
  );

  it.each([false, true])(
    "retains roots, parent UV and topology while sweeping full XYZ (quartic %s)",
    (quartic) => {
      const value = fixture(quartic);
      try {
        const { buffers, coarse } = value,
          p = coarse.getAttribute("position"),
          cu = coarse.getAttribute("uv");
        let changedXZ = 0;
        for (let blade = 0; blade < 21; blade++) {
          const surface = independentSurface(value, blade);
          for (let local = 0; local < 15; local++) {
            const vertex = blade * 15 + local,
              [a, b] = R.parentPairs[local].map((i) => blade * 7 + i),
              { t, side } = sample(local);
            expect(
              Array.from(
                buffers.coarseVertexPairs.subarray(vertex * 2, vertex * 2 + 2),
              ),
            ).toEqual([a, b]);
            expect(buffers.uv[vertex * 2]).toBe(
              Math.fround((cu.getX(a) + cu.getX(b)) / 2),
            );
            expect(buffers.uv[vertex * 2 + 1]).toBe(
              Math.fround((cu.getY(a) + cu.getY(b)) / 2),
            );
            const point = new THREE.Vector3().fromArray(
              buffers.positions,
              vertex * 3,
            );
            expect(point.distanceTo(surface.point(t, side))).toBeLessThan(8e-8);
            if (local < 2) {
              for (let k = 0; k < 3; k++)
                expect(
                  Object.is(
                    buffers.positions[vertex * 3 + k],
                    p.array[(blade * 7 + local) * 3 + k],
                  ),
                ).toBe(true);
            } else if (
              Math.abs(point.x - (p.getX(a) + p.getX(b)) / 2) +
                Math.abs(point.z - (p.getZ(a) + p.getZ(b)) / 2) >
              1e-6
            )
              changedXZ++;
          }
          expect(
            Array.from(buffers.indices.subarray(blade * 45, blade * 45 + 45)),
          ).toEqual(R.indices.map((i) => blade * 15 + i));
          expect(buffers.uv[(blade * 15 + 13) * 2]).toBe(0.25);
          expect(buffers.uv[(blade * 15 + 14) * 2]).toBe(0.75);
        }
        expect(changedXZ).toBeGreaterThan(200);
        expect(buffers.uv[2 * 2 + 1]).toBe(Math.fround(1 / 3));
        expect(sample(2).t).toBeCloseTo(0.5, 14);
        expect(buffers.uv[4 * 2 + 1]).toBe(Math.fround(2 / 3));
        expect(sample(4).t).toBeCloseTo(Math.sqrt(3) / 2, 14);
      } finally {
        value.dispose();
      }
    },
  );

  it.each([false, true])(
    "has finite tangent-correct normals and positive face winding (quartic %s)",
    (quartic) => {
      const value = fixture(quartic);
      try {
        const { positions, normals, indices } = value.buffers;
        for (let blade = 0; blade < 21; blade++) {
          const surface = independentSurface(value, blade);
          for (let local = 0; local < 15; local++) {
            const { t, side } = sample(local),
              eps = 1e-6,
              tangent = surface
                .point(Math.min(1, t + eps), side)
                .sub(surface.point(Math.max(0, t - eps), side)),
              expected = surface.axis.clone().cross(tangent).normalize(),
              actual = new THREE.Vector3().fromArray(
                normals,
                (blade * 15 + local) * 3,
              );
            expect(actual.length()).toBeCloseTo(1, 6);
            expect(actual.dot(expected)).toBeGreaterThan(1 - 1e-7);
          }
        }
        for (let triangle = 0; triangle < indices.length; triangle += 3) {
          const ids = Array.from(indices.subarray(triangle, triangle + 3)),
            [a, b, c] = ids.map((i) =>
              new THREE.Vector3().fromArray(positions, i * 3),
            ),
            cross = b.sub(a).cross(c.sub(a)),
            normal = ids.reduce(
              (sum, i) =>
                sum.add(new THREE.Vector3().fromArray(normals, i * 3)),
              new THREE.Vector3(),
            );
          expect(cross.length()).toBeGreaterThan(1e-8);
          expect(cross.dot(normal)).toBeGreaterThan(0);
        }
      } finally {
        value.dispose();
      }
    },
  );

  it("uses canonical-to-sine wind mapping only for this endpoint", () => {
    for (const canonical of [
      0,
      1e-8,
      Math.fround(1 / 6),
      Math.fround(1 / 3),
      0.5,
      Math.fround(2 / 3),
      Math.fround(5 / 6),
      1,
    ]) {
      const t = Math.sin((canonical * Math.PI) / 2),
        height = bezier([0, 0.95, 0.95], t);
      for (const authoredHeight of [0.12, 0.38, 0.86])
        for (const scale of [0.3, 1, 1.7]) {
          const sourceY = authoredHeight * height,
            expected =
              Math.min(1, (sourceY * scale) / (Math.max(height, 1e-5) * 0.86)) *
              (height / 0.95) ** 2,
            actual = getMeadowSweptBladeWindFactor(canonical, sourceY, scale);
          expect(actual).toBeCloseTo(expected, 13);
          expect(actual).toBeGreaterThanOrEqual(0);
          expect(actual).toBeLessThanOrEqual(1);
        }
    }
    expect(getMeadowSweptBladeWindFactor(0, 0, 1)).toBe(0);
    expect(getMeadowSweptBladeWindFactor(1, 0.95 * 0.86, 1)).toBe(1);
    expect(getMeadowSweptBladeWindFactor(1, 0, 1)).toBe(0);
  });

  it.each([
    [-0.1, 0.3, 1],
    [1.1, 0.3, 1],
    [NaN, 0.3, 1],
    [0.5, -0.1, 1],
    [0.5, Infinity, 1],
    [0.5, 0.3, 0],
    [0.5, 0.3, -1],
    [0.5, 0.3, NaN],
    [0.5, 0.3, Infinity],
  ])("rejects malformed wind inputs %s %s %s", (t, y, s) => {
    expect(() => getMeadowSweptBladeWindFactor(t, y, s)).toThrow(
      "Invalid swept blade wind input",
    );
  });

  it.each(["position", "normal", "uv"])(
    "rejects changed fine %s without mutation",
    (name) => {
      const value = fixture();
      try {
        const array = value.geometry.getAttribute(name).array;
        array[17] += 0.001;
        const before = array.slice();
        expect(() =>
          assertGrassMeadowSweptBladeEndpoint(value.geometry, value.coarse),
        ).toThrow();
        expect(array).toEqual(before);
      } finally {
        value.dispose();
      }
    },
  );

  it.each(["position", "normal", "uv", "index"])(
    "rejects changed coarse %s",
    (name) => {
      const value = fixture();
      try {
        const array =
          name === "index"
            ? value.coarse.index!.array
            : value.coarse.getAttribute(name).array;
        array[2] += name === "index" ? 1 : 0.01;
        expect(() =>
          assertGrassMeadowSweptBladeEndpoint(value.geometry, value.coarse),
        ).toThrow();
      } finally {
        value.dispose();
      }
    },
  );

  it.each(["id", "samplePolicy", "materialUvPolicy"])(
    "rejects forged %s provenance",
    (field) => {
      const value = fixture();
      try {
        value.geometry.userData[R.metadataKey] = {
          ...value.buffers.recipe,
          [field]: "other-endpoint",
        };
        expect(() =>
          assertGrassMeadowSweptBladeEndpoint(value.geometry, value.coarse),
        ).toThrow("Missing swept blade provenance");
      } finally {
        value.dispose();
      }
    },
  );

  it("rejects mismatched authored parameters and missing width provenance", () => {
    const value = fixture();
    try {
      const changed = value.blades.map((b, i) =>
        i === 0 ? { ...b, height: b.height * 1.01 } : b,
      );
      expect(() =>
        createMeadowSweptBladeBuffers(value.coarse, changed, value.shape),
      ).toThrow();
      expect(() =>
        createMeadowSweptBladeBuffers(
          value.coarse,
          value.blades,
          FINE_GRASS_MEADOW_FIELD_SHAPE,
        ),
      ).toThrow();
      expect(() =>
        createMeadowSweptBladeBuffers(
          value.coarse,
          value.blades.slice(1),
          value.shape,
        ),
      ).toThrow();
      expect(() =>
        assertGrassMeadowSweptBladeEndpoint(value.coarse, value.coarse),
      ).toThrow("Distinct");
    } finally {
      value.dispose();
    }
  });

  it("rejects neutral sine UV and altered topology", () => {
    const value = fixture();
    try {
      const uv = value.geometry.getAttribute("uv");
      uv.setY(2, sample(2).t);
      expect(() =>
        assertGrassMeadowSweptBladeEndpoint(value.geometry, value.coarse),
      ).toThrow("Changed swept blade uv");
      uv.setY(2, Math.fround(1 / 3));
      value.geometry.index!.setX(0, 1);
      expect(() =>
        assertGrassMeadowSweptBladeEndpoint(value.geometry, value.coarse),
      ).toThrow("Changed swept blade topology");
    } finally {
      value.dispose();
    }
  });

  it.each([
    "groups",
    "partial",
    "morph",
    "instanced",
    "normalized",
    "wrongLength",
    "nan",
    "missing",
  ])("rejects unsupported endpoint %s", (mode) => {
    const value = fixture();
    try {
      const { geometry } = value;
      if (mode === "groups") geometry.addGroup(0, 3, 0);
      if (mode === "partial") geometry.setDrawRange(0, 3);
      if (mode === "morph")
        geometry.morphAttributes.position = [geometry.getAttribute("position")];
      if (mode === "instanced")
        geometry.setAttribute(
          "position",
          new THREE.InstancedBufferAttribute(
            value.buffers.positions.slice(),
            3,
          ),
        );
      if (mode === "normalized")
        geometry.getAttribute("normal").normalized = true;
      if (mode === "wrongLength")
        geometry.setAttribute(
          "uv",
          new THREE.BufferAttribute(new Float32Array(628), 2),
        );
      if (mode === "nan") geometry.getAttribute("normal").setX(0, NaN);
      if (mode === "missing") delete geometry.userData[R.metadataKey];
      expect(() =>
        assertGrassMeadowSweptBladeEndpoint(geometry, value.coarse),
      ).toThrow();
    } finally {
      value.dispose();
    }
  });
});
