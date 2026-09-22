import * as THREE from "three";

export interface RootedFlowerGeometryOptions {
  /** Authored root-to-pollen height in metres, inclusive range 0.12–0.8. */
  height?: number;
}

type Point = readonly [number, number, number];

const STEM_SIDES = 10;
const STEM_SEGMENTS = 5;
const PETAL_ROWS = [0.16, 0.36, 0.59, 0.81, 0.95] as const;
const PETAL_COLUMNS = [-1, -0.5, 0, 0.5, 1] as const;
const LEAF_ROWS = [0.24, 0.53, 0.8] as const;
const LEAF_COLUMNS = [-1, 0, 1] as const;

/**
 * One rooted meadow daisy: a curved tapered stem, two attached lance leaves,
 * a shallow pollen head and ten individually cupped cream petals.
 *
 * Returns exclusively owned, indexed geometry: 362 vertices / 584 triangles.
 * Thin petal/leaf laminae require a DoubleSide material; no material or texture
 * is created here. Shared attachment vertices prevent cracks at the stem/head.
 * flowerHeight = [authored Y, requested height], without clamping authored Y.
 * flowerPetal = [actual attachment hinge XYZ, flex weight]; non-petals have
 * zero weight. The root ring and its cap lie exactly on Y=0.
 * Bounds cover this static mesh only, NOT future wind deformation.
 */
export function createRootedFlowerGeometry(
  options: RootedFlowerGeometryOptions = {},
): THREE.BufferGeometry {
  const height = options.height === undefined ? 0.38 : options.height;
  if (!Number.isFinite(height) || height < 0.12 || height > 0.8) {
    throw new RangeError(
      "Rooted flower height must be finite and within 0.12–0.8 metres",
    );
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const heights: number[] = [];
  const petals: number[] = [];
  const indices: number[] = [];
  // Color(hex) converts these authored sRGB colors into Three's linear space.
  const stemBase = new THREE.Color(0x466840);
  const stemTip = new THREE.Color(0x789052);
  const leafEdge = new THREE.Color(0x52753e);
  const leafRib = new THREE.Color(0x829b54);
  const petalBase = new THREE.Color(0xe6ddba);
  const petalTip = new THREE.Color(0xf6f0de);
  const pollenEdge = new THREE.Color(0xc89c40);
  const pollenCrown = new THREE.Color(0xe0b957);
  const noHinge: Point = [0, 0, 0];

  const vertex = (
    point: Point,
    color: THREE.Color,
    u: number,
    v: number,
    hinge: Point = noHinge,
    weight = 0,
  ): number => {
    const id = positions.length / 3;
    positions.push(...point);
    colors.push(color.r, color.g, color.b);
    uvs.push(u, v);
    heights.push(point[1], height);
    petals.push(...hinge, weight);
    return id;
  };
  const pointAt = (id: number): Point => [
    positions[id * 3],
    positions[id * 3 + 1],
    positions[id * 3 + 2],
  ];
  const joinRings = (lower: readonly number[], upper: readonly number[]) => {
    for (let side = 0; side < STEM_SIDES; side++) {
      const next = (side + 1) % STEM_SIDES;
      indices.push(
        lower[side],
        upper[side],
        lower[next],
        lower[next],
        upper[side],
        upper[next],
      );
    }
  };
  const stemCenter = (t: number): Point => [
    height * (0.02 * t + 0.023 * Math.sin(Math.PI * t)),
    height * 0.96 * t,
    height * (-0.015 * t + 0.011 * Math.sin(Math.PI * 2 * t)),
  ];

  const stemRings: number[][] = [];
  for (let ring = 0; ring <= STEM_SEGMENTS; ring++) {
    const t = ring / STEM_SEGMENTS;
    const center = stemCenter(t);
    const radius = height * (0.0055 - 0.0017 * t);
    const color = stemBase.clone().lerp(stemTip, t);
    const ids: number[] = [];
    for (let side = 0; side < STEM_SIDES; side++) {
      const angle = (side / STEM_SIDES) * Math.PI * 2;
      ids.push(
        vertex(
          [
            center[0] + Math.cos(angle) * radius,
            center[1],
            center[2] + Math.sin(angle) * radius,
          ],
          color,
          side / STEM_SIDES,
          t,
        ),
      );
    }
    stemRings.push(ids);
    if (ring > 0) joinRings(stemRings[ring - 1], ids);
  }
  const root = vertex([0, 0, 0], stemBase, 0.5, 0.5);
  for (let side = 0; side < STEM_SIDES; side++) {
    indices.push(
      root,
      stemRings[0][side],
      stemRings[0][(side + 1) % STEM_SIDES],
    );
  }

  const headCenter = stemCenter(1);
  const headRing = (
    radius: number,
    y: number,
    color: THREE.Color,
    hinges: boolean,
  ) => {
    const ids: number[] = [];
    for (let side = 0; side < STEM_SIDES; side++) {
      const angle = (side / STEM_SIDES) * Math.PI * 2;
      const point: Point = [
        headCenter[0] + Math.cos(angle) * radius * height,
        y * height,
        headCenter[2] + Math.sin(angle) * radius * height,
      ];
      ids.push(
        vertex(
          point,
          color,
          0.5 + Math.cos(angle) * 0.5,
          0.5 + Math.sin(angle) * 0.5,
          hinges ? point : noHinge,
        ),
      );
    }
    return ids;
  };
  const attachments = headRing(0.022, 0.985, pollenEdge, true);
  const crown = headRing(0.014, 0.996, pollenCrown, false);
  joinRings(stemRings[STEM_SEGMENTS], attachments);
  joinRings(attachments, crown);
  const top = vertex(
    [headCenter[0], height, headCenter[2]],
    pollenCrown,
    0.5,
    0.5,
  );
  for (let side = 0; side < STEM_SIDES; side++) {
    indices.push(crown[side], top, crown[(side + 1) % STEM_SIDES]);
  }

  // A single shared root fans into nonzero-width rows; the final row fans to
  // one tip. Never emit collapsed-width grid quads at either end.
  const lamina = (
    rootId: number,
    rows: readonly number[],
    columns: readonly number[],
    sample: (t: number, across: number) => Point,
    colorAt: (t: number, across: number) => THREE.Color,
    petal: boolean,
  ) => {
    const hinge = pointAt(rootId);
    const rowIds = rows.map((t) =>
      columns.map((across) =>
        vertex(
          sample(t, across),
          colorAt(t, across),
          (across + 1) / 2,
          t,
          petal ? hinge : noHinge,
          petal ? t * t : 0,
        ),
      ),
    );
    for (let column = 0; column < columns.length - 1; column++) {
      indices.push(rootId, rowIds[0][column + 1], rowIds[0][column]);
    }
    for (let row = 0; row < rowIds.length - 1; row++) {
      for (let column = 0; column < columns.length - 1; column++) {
        const a = rowIds[row][column],
          b = rowIds[row][column + 1];
        const c = rowIds[row + 1][column],
          d = rowIds[row + 1][column + 1];
        indices.push(a, b, c, b, d, c);
      }
    }
    const tip = vertex(
      sample(1, 0),
      colorAt(1, 0),
      0.5,
      1,
      petal ? hinge : noHinge,
      petal ? 1 : 0,
    );
    const last = rowIds[rowIds.length - 1];
    for (let column = 0; column < columns.length - 1; column++) {
      indices.push(last[column], last[column + 1], tip);
    }
  };

  for (let petal = 0; petal < STEM_SIDES; petal++) {
    const hinge = pointAt(attachments[petal]);
    const angle = (petal / STEM_SIDES) * Math.PI * 2;
    const radialX = Math.cos(angle),
      radialZ = Math.sin(angle);
    const length = height * 0.069 * (1 + 0.055 * Math.sin(petal * 2.3));
    const width = height * 0.018 * (1 + 0.04 * Math.cos(petal * 1.7));
    const curl = Math.sin(petal * 1.9) * height * 0.003;
    lamina(
      attachments[petal],
      PETAL_ROWS,
      PETAL_COLUMNS,
      (t, across) => {
        const arch = Math.sin(Math.PI * t);
        const lateral =
          across * width * arch ** 0.7 * (0.8 + 0.2 * t) + curl * arch;
        const cup = height * 0.009 * arch * across * across;
        const roll = height * 0.0015 * Math.sin(petal * 1.3) * across * arch;
        return [
          hinge[0] + radialX * length * t - radialZ * lateral,
          hinge[1] -
            height * (0.034 * arch * (1 - 0.2 * t) + 0.006 * t) +
            cup +
            roll,
          hinge[2] + radialZ * length * t + radialX * lateral,
        ];
      },
      (t) => petalBase.clone().lerp(petalTip, 0.25 + t * 0.75),
      true,
    );
  }

  for (const [ring, side, length, width] of [
    [2, 3, 0.19, 0.021],
    [3, 8, 0.16, 0.0175],
  ] as const) {
    const rootId = stemRings[ring][side];
    const hinge = pointAt(rootId);
    const angle = (side / STEM_SIDES) * Math.PI * 2;
    const radialX = Math.cos(angle),
      radialZ = Math.sin(angle);
    lamina(
      rootId,
      LEAF_ROWS,
      LEAF_COLUMNS,
      (t, across) => {
        const arch = Math.sin(Math.PI * t);
        const lateral = across * height * width * arch ** 0.85;
        return [
          hinge[0] + radialX * height * length * t - radialZ * lateral,
          hinge[1] +
            height *
              (0.085 * t -
                0.052 * t * t +
                0.006 * arch * (1 - across * across)),
          hinge[2] + radialZ * height * length * t + radialX * lateral,
        ];
      },
      (t, across) =>
        leafEdge
          .clone()
          .lerp(leafRib, (1 - Math.abs(across)) * Math.sin(Math.PI * t) * 0.7),
      false,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.name = "RootedMeadowDaisy";
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "flowerHeight",
    new THREE.Float32BufferAttribute(heights, 2),
  );
  geometry.setAttribute(
    "flowerPetal",
    new THREE.Float32BufferAttribute(petals, 4),
  );
  // Native r186 WebGPU widens unnormalized Uint16 indices on first upload,
  // replacing the owned array. Author its actual GPU representation directly.
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
