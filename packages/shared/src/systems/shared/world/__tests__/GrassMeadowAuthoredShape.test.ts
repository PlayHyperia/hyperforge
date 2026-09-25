import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import {
  createClumpGeometry,
  createMeadowAuthoredClumpGeometry,
  createMeadowDetailClumpGeometry,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
} from "../GrassVisualManager";
import {
  assertGrassMeadowAuthoredEndpoint,
  createMeadowAuthoredShapeGeometry,
  GRASS_MEADOW_AUTHORED_SHAPE,
  sampleGrassMeadowAuthoredBlade,
  type GrassMeadowAuthoredBlade,
} from "../GrassMeadowAuthoredShape";
import {
  getGrassBladeWindFactor,
  FINE_GRASS_HEIGHT_FLEX_RESPONSE,
} from "../GrassBladeLayout";

// Real generated Three buffers and numerical derivatives. No renderer, terrain
// owner or device is mocked; native material/clearance/art gates remain separate.
function withFixture(
  action: (
    value: ReturnType<typeof createMeadowAuthoredClumpGeometry>,
    blades: GrassMeadowAuthoredBlade[],
  ) => void,
) {
  const value = createMeadowAuthoredClumpGeometry();
  const blades: GrassMeadowAuthoredBlade[] = [];
  const source = createClumpGeometry(
    21,
    3,
    FINE_GRASS_MEADOW_FIELD_SHAPE,
    undefined,
    (blade) => blades.push(blade),
  );
  try {
    for (const name of ["position", "normal", "uv"])
      expect(value.coarseGeometry.getAttribute(name).array).toEqual(
        source.getAttribute(name).array,
      );
    action(value, blades);
  } finally {
    source.dispose();
    value.geometry.dispose();
    value.coarseGeometry.dispose();
  }
}
const point = (geometry: THREE.BufferGeometry, vertex: number) =>
  new THREE.Vector3().fromBufferAttribute(
    geometry.getAttribute("position"),
    vertex,
  );
function triangleArea(geometry: THREE.BufferGeometry) {
  const index = geometry.index!;
  let sum = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = point(geometry, index.getX(i)),
      b = point(geometry, index.getX(i + 1)),
      c = point(geometry, index.getX(i + 2));
    sum += b.sub(a).cross(c.sub(a)).length() * 0.5;
  }
  return sum;
}

/** Native29's actual deterministic placement recipe and fixed camera poses.
 * This CPU binary union is not MSAA, shading, wind or observed GPU coverage. */
function coveragePatch() {
  let seed = 0x6d656164;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const original = Array.from({ length: 81 }, (_, i) => ({
    x: ((i % 9) - 4) * 0.5 + (random() - 0.5) * 0.12,
    z: (Math.floor(i / 9) - 4) * 0.5 + (random() - 0.5) * 0.12,
    yaw: random() * Math.PI * 2,
    scale: 0.7 + random() * 0.6,
    hash: random(),
  }));
  original[40].x = 0;
  original[40].z = 0;
  const added = (dx: number, dz: number) =>
    original.map((row, i) => ({
      ...row,
      x:
        row.x +
        dx * (i % 9 === 0 ? 1 : i % 9 === 8 ? -1 : row.hash < 0.5 ? -1 : 1),
      z:
        row.z +
        dz *
          (Math.floor(i / 9) === 0
            ? 1
            : Math.floor(i / 9) === 8
              ? -1
              : row.hash < 0.25 || row.hash > 0.75
                ? -1
                : 1),
    }));
  return [
    ...original,
    ...added(0.125, 0.125),
    ...added(0.125, 0),
    ...added(0, 0.125),
  ].map((row) => ({
    x: Math.fround(row.x),
    z: Math.fround(row.z),
    yaw: Math.fround(row.yaw),
    scale: Math.fround(row.scale),
  }));
}

function projectedUnion(
  geometry: THREE.BufferGeometry,
  rows: ReturnType<typeof coveragePatch>,
  camera: THREE.PerspectiveCamera,
  width: number,
) {
  const height = (width * 9) / 16,
    occupied = new Uint8Array(width * height);
  const position = geometry.getAttribute("position"),
    index = geometry.index!;
  const projected = new Float64Array(position.count * 2),
    point = new THREE.Vector3();
  for (const row of rows) {
    const c = Math.cos(row.yaw),
      s = Math.sin(row.yaw);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i) * row.scale,
        z = position.getZ(i) * row.scale;
      point
        .set(
          x * c - z * s + row.x,
          position.getY(i) * row.scale,
          x * s + z * c + row.z,
        )
        .project(camera);
      if (!(
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.z > 0 &&
        point.z < 1 &&
        Math.abs(point.x) < 1 &&
        Math.abs(point.y) < 1
      ))
        throw new Error("Coverage geometry escaped fixed common camera");
      projected[i * 2] = ((point.x + 1) * width) / 2;
      projected[i * 2 + 1] = ((1 - point.y) * height) / 2;
    }
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i) * 2,
        b = index.getX(i + 1) * 2,
        c = index.getX(i + 2) * 2;
      const vertices = [a, b, c];
      const minY = Math.max(
        0,
        Math.ceil(
          Math.min(projected[a + 1], projected[b + 1], projected[c + 1]) - 0.5,
        ),
      );
      const maxY = Math.min(
        height - 1,
        Math.floor(
          Math.max(projected[a + 1], projected[b + 1], projected[c + 1]) - 0.5,
        ),
      );
      for (let y = minY; y <= maxY; y++) {
        const at = y + 0.5;
        let left = Infinity,
          right = -Infinity;
        for (let edge = 0; edge < 3; edge++) {
          const u = vertices[edge],
            v = vertices[(edge + 1) % 3];
          const uy = projected[u + 1],
            vy = projected[v + 1];
          if (at < Math.min(uy, vy) || at >= Math.max(uy, vy)) continue;
          const x =
            projected[u] +
            ((at - uy) * (projected[v] - projected[u])) / (vy - uy);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
        if (left <= right) {
          const first = Math.max(0, Math.ceil(left - 0.5)),
            last = Math.min(width - 1, Math.floor(right - 0.5));
          if (first <= last)
            occupied.fill(1, y * width + first, y * width + last + 1);
        }
      }
    }
  }
  return occupied.reduce((total, value) => total + value, 0);
}

describe("explicit authored meadow silhouette endpoint", () => {
  it("uses deterministic actual seeded parameters without changing the old factory", () =>
    withFixture(
      ({ geometry, coarseGeometry, coarseVertexPairs, layout }, blades) => {
        const next = createMeadowAuthoredClumpGeometry();
        try {
          expect(layout.id).toBe("meadow-authored-silhouette-v1");
          expect(geometry.getAttribute("position").count).toBe(315);
          expect(geometry.index!.count).toBe(945);
          expect(coarseGeometry.getAttribute("position").count).toBe(147);
          expect(coarseGeometry.index!.count).toBe(315);
          expect(coarseVertexPairs.length).toBe(630);
          for (const name of ["position", "normal", "uv"]) {
            expect(geometry.getAttribute(name).array).toEqual(
              next.geometry.getAttribute(name).array,
            );
            expect(geometry.getAttribute(name).array).not.toBe(
              next.geometry.getAttribute(name).array,
            );
          }
          expect(geometry.index!.array).toEqual(next.geometry.index!.array);
          expect(blades).toHaveLength(21);
          expect(blades.every((blade) => Object.isFrozen(blade))).toBe(true);
          expect(
            Object.isFrozen(geometry.userData.grassMeadowAuthoredShape),
          ).toBe(true);
          expect(() =>
            assertGrassMeadowAuthoredEndpoint(geometry, coarseGeometry),
          ).not.toThrow();
        } finally {
          next.geometry.dispose();
          next.coarseGeometry.dispose();
        }
      },
    ));

  it("preserves exact root edges, tips and original-station heights but changes the intermediate silhouette", () =>
    withFixture(({ geometry, coarseGeometry }) => {
      const fine = geometry.getAttribute("position"),
        coarse = coarseGeometry.getAttribute("position");
      let moved = 0;
      for (let blade = 0; blade < 21; blade++) {
        for (const local of [0, 1, 6])
          expect(
            Array.from(
              fine.array.slice(
                (blade * 15 + local) * 3,
                (blade * 15 + local + 1) * 3,
              ),
            ),
          ).toEqual(
            Array.from(
              coarse.array.slice(
                (blade * 7 + local) * 3,
                (blade * 7 + local + 1) * 3,
              ),
            ),
          );
        for (let local = 0; local < 7; local++)
          expect(fine.getY(blade * 15 + local)).toBe(
            coarse.getY(blade * 7 + local),
          );
        for (const local of [2, 3, 4, 5])
          if (
            fine.getX(blade * 15 + local) !== coarse.getX(blade * 7 + local) ||
            fine.getZ(blade * 15 + local) !== coarse.getZ(blade * 7 + local)
          )
            moved++;
      }
      expect(moved).toBe(84);
    }));

  it("retains every authored sampled width and Y from the actual six-station source", () =>
    withFixture(({ geometry }, blades) => {
      const source = createClumpGeometry(21, 6, FINE_GRASS_MEADOW_FIELD_SHAPE);
      try {
        for (const blade of blades)
          for (const t of [0, 1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6]) {
            const a = sampleGrassMeadowAuthoredBlade(
              blade,
              t,
              0,
              FINE_GRASS_MEADOW_FIELD_SHAPE,
            );
            const b = sampleGrassMeadowAuthoredBlade(
              blade,
              t,
              1,
              FINE_GRASS_MEADOW_FIELD_SHAPE,
            );
            const sourceRow = blade.index * 13 + Math.round(t * 6) * 2;
            expect(
              new THREE.Vector3(...a.position).distanceTo(
                new THREE.Vector3(...b.position),
              ),
            ).toBeCloseTo(
              point(source, sourceRow).distanceTo(point(source, sourceRow + 1)),
              7,
            );
            expect(Math.fround(a.position[1])).toBe(
              source.getAttribute("position").getY(sourceRow),
            );
          }
        const normal = geometry.getAttribute("normal");
        for (let i = 0; i < normal.count; i++)
          expect(
            new THREE.Vector3().fromBufferAttribute(normal, i).length(),
          ).toBeCloseTo(1, 6);
      } finally {
        source.dispose();
      }
    }));

  it("uses actual surface-derivative normals including off-center twist", () =>
    withFixture((_value, blades) => {
      const epsilon = 1e-6;
      for (const blade of blades)
        for (const t of [0.08, 0.2, 1 / 3, 0.5, 2 / 3, 0.9])
          for (const side of [0.1, 0.5, 0.9]) {
            const sample = (at: number, across: number) =>
              sampleGrassMeadowAuthoredBlade(
                blade,
                at,
                across,
                FINE_GRASS_MEADOW_FIELD_SHAPE,
              );
            const pt = new THREE.Vector3(
              ...sample(t + epsilon, side).position,
            ).sub(new THREE.Vector3(...sample(t - epsilon, side).position));
            const ps = new THREE.Vector3(
              ...sample(t, side + epsilon).position,
            ).sub(new THREE.Vector3(...sample(t, side - epsilon).position));
            const expected = ps.cross(pt).normalize();
            expect(
              expected.distanceTo(new THREE.Vector3(...sample(t, side).normal)),
            ).toBeLessThan(1e-7);
          }
    }));

  it("retains the height-flex parameter contract at stored barycentric UV precision", () =>
    withFixture(({ geometry }, blades) => {
      const position = geometry.getAttribute("position"),
        uv = geometry.getAttribute("uv");
      const { controlHeight, tipHeight, maximumHeight } =
        FINE_GRASS_HEIGHT_FLEX_RESPONSE;
      for (const blade of blades)
        for (let local = 0; local < 15; local++)
          for (const scale of [0.7, 1, 1.3]) {
            const vertex = blade.index * 15 + local,
              t = uv.getY(vertex);
            const curve =
              t * (2 * controlHeight + t * (tipHeight - 2 * controlHeight));
            const expected =
              t === 0
                ? 0
                : Math.min(1, (scale * blade.height) / maximumHeight) *
                  (curve / tipHeight) ** 2;
            expect(
              getGrassBladeWindFactor(
                t,
                position.getY(vertex),
                scale,
                "fine-meadow-ribbon-v1",
              ),
            ).toBeCloseTo(expected, 6);
          }
    }));

  it("has nondegenerate consistently oriented faces and bounded actual area, not a coverage claim", () =>
    withFixture(({ geometry, coarseGeometry }) => {
      const normal = geometry.getAttribute("normal"),
        index = geometry.index!;
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i),
          ib = index.getX(i + 1),
          ic = index.getX(i + 2);
        const a = point(geometry, ia),
          b = point(geometry, ib),
          c = point(geometry, ic);
        const cross = b.sub(a).cross(c.sub(a));
        const mean = new THREE.Vector3()
          .fromBufferAttribute(normal, ia)
          .add(new THREE.Vector3().fromBufferAttribute(normal, ib))
          .add(new THREE.Vector3().fromBufferAttribute(normal, ic));
        expect(cross.length()).toBeGreaterThan(1e-9);
        expect(cross.dot(mean)).toBeGreaterThan(0);
      }
      const ratio = triangleArea(geometry) / triangleArea(coarseGeometry);
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.2);
    }));

  it("strictly validates clones with extra storage but rejects endpoint and source tampering", () =>
    withFixture(({ geometry, coarseGeometry }) => {
      const clone = geometry.clone();
      try {
        clone.setAttribute(
          "privateExtra",
          new THREE.BufferAttribute(new Float32Array([1]), 1),
        );
        expect(() =>
          assertGrassMeadowAuthoredEndpoint(clone, coarseGeometry),
        ).not.toThrow();
        for (const name of ["position", "normal", "uv"]) {
          const values = clone.getAttribute(name).array;
          const old = values[9];
          values[9] = old + 0.125;
          expect(() =>
            assertGrassMeadowAuthoredEndpoint(clone, coarseGeometry),
          ).toThrow();
          values[9] = old;
        }
        const oldIndex = clone.index!.array[1];
        clone.index!.array[1] = oldIndex + 1;
        expect(() =>
          assertGrassMeadowAuthoredEndpoint(clone, coarseGeometry),
        ).toThrow();
        clone.index!.array[1] = oldIndex;
        const old = coarseGeometry.getAttribute("position").array[8];
        coarseGeometry.getAttribute("position").array[8] = old + 0.001;
        expect(() =>
          assertGrassMeadowAuthoredEndpoint(clone, coarseGeometry),
        ).toThrow();
        coarseGeometry.getAttribute("position").array[8] = old;
        // r186 BufferGeometry.clone currently shares userData; make deliberate
        // forged metadata independently instead of mutating the frozen original.
        clone.userData = structuredClone(clone.userData);
        clone.userData.grassMeadowAuthoredShape.blades[0].height += 0.01;
        expect(() =>
          assertGrassMeadowAuthoredEndpoint(clone, coarseGeometry),
        ).toThrow();
      } finally {
        clone.dispose();
      }
    }));

  it("does not relabel the existing conforming endpoint", () => {
    const old = createMeadowDetailClumpGeometry();
    try {
      expect(() =>
        assertGrassMeadowAuthoredEndpoint(old.geometry, old.coarseGeometry),
      ).toThrow("provenance");
    } finally {
      old.geometry.dispose();
      old.coarseGeometry.dispose();
    }
  });

  it(
    "retains binary projected union at both native29 bearings without changing count or framing",
    () =>
      withFixture(({ geometry, coarseGeometry }) => {
        const allRows = coveragePatch();
        const measurements: {
          clumps: number;
          orthogonal: boolean;
          width: number;
          baselinePixels: number;
          candidatePixels: number;
          ratio: number;
          baselineFrameFraction: number;
          candidateFrameFraction: number;
        }[] = [];
        for (const clumps of [81, 324])
          for (const orthogonal of [false, true]) {
            const rows = allRows.slice(0, clumps);
            const camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.02, 100);
            camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
            camera.updateProjectionMatrix();
            camera.position.set(
              6.434293162571412,
              4.13581468096116,
              orthogonal ? -6.43318094900287 : 6.282024225490976,
            );
            camera.lookAt(
              0.07669057532448886,
              0.44840518035794524,
              -0.07557836175594712,
            );
            camera.updateMatrixWorld(true);
            const ratios: number[] = [];
            for (const width of [1280, 2560]) {
              const baselinePixels = projectedUnion(
                coarseGeometry,
                rows,
                camera,
                width,
              );
              const candidatePixels = projectedUnion(
                geometry,
                rows,
                camera,
                width,
              );
              const ratio = candidatePixels / baselinePixels;
              measurements.push({
                clumps,
                orthogonal,
                width,
                baselinePixels,
                candidatePixels,
                ratio,
                baselineFrameFraction:
                  baselinePixels / ((width * width * 9) / 16),
                candidateFrameFraction:
                  candidatePixels / ((width * width * 9) / 16),
              });
              expect(baselinePixels).toBeGreaterThan(1000);
              expect(ratio).toBeGreaterThanOrEqual(0.95);
              ratios.push(ratio);
            }
            expect(Math.abs(ratios[0] - ratios[1])).toBeLessThan(0.015);
          }
        console.info(
          "Authored meadow CPU binary-union preflight (no GPU/art acceptance)",
          JSON.stringify({
            sourceArea: triangleArea(coarseGeometry),
            candidateArea: triangleArea(geometry),
            measurements,
          }),
        );
      }),
    20000,
  );

  it("rejects incomplete or nonfinite actual source parameters and invalid sample coordinates", () =>
    withFixture(({ coarseGeometry }, blades) => {
      expect(() =>
        createMeadowAuthoredShapeGeometry(
          coarseGeometry,
          blades.slice(1),
          FINE_GRASS_MEADOW_FIELD_SHAPE,
        ),
      ).toThrow();
      const corrupt = blades.map((blade) => ({ ...blade }));
      corrupt[0].width = NaN;
      expect(() =>
        createMeadowAuthoredShapeGeometry(
          coarseGeometry,
          corrupt,
          FINE_GRASS_MEADOW_FIELD_SHAPE,
        ),
      ).toThrow();
      for (const t of [-0.1, 1.1, NaN, Infinity])
        expect(() =>
          sampleGrassMeadowAuthoredBlade(
            blades[0],
            t,
            0.5,
            FINE_GRASS_MEADOW_FIELD_SHAPE,
          ),
        ).toThrow();
      expect(GRASS_MEADOW_AUTHORED_SHAPE.id).not.toBe(
        "meadow-longitudinal-refinement-v1",
      );
    }));
});
