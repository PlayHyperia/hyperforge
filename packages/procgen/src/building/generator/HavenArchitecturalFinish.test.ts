import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { BuildingGenerator, createRng } from "./BuildingGenerator";
import { createGabledRoof } from "./GabledRoof";
import {
  createHavenLodgeFinish,
  createHavenMember,
} from "./HavenArchitecturalFinish";
import {
  BANK_PAVILION_POSTS,
  BANK_PAVILION_RECIPE,
  createOpenWorkshop,
} from "./OpenWorkshop";
import { getRecipe } from "./recipes";
import {
  CELL_SIZE,
  DOOR_HEIGHT,
  DOOR_WIDTH,
  WINDOW_HEIGHT,
  WINDOW_SILL_HEIGHT,
  WINDOW_WIDTH,
} from "./constants";
import type { BuildingGeneratorOptions, BuildingRecipe } from "./types";

const geometryLeases = new Set<THREE.BufferGeometry>();
const generators: BuildingGenerator[] = [];
const materials = new Set<THREE.Material>();
afterEach(() => {
  for (const geometry of geometryLeases) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const generator of generators)
    generator.dispose({ clearGeometryCache: false });
  geometryLeases.clear();
  materials.clear();
  generators.length = 0;
});
function own<T extends THREE.BufferGeometry>(geometry: T): T {
  geometryLeases.add(geometry);
  return geometry;
}
function digest(geometry: THREE.BufferGeometry): string {
  const hash = createHash("sha256");
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const array =
      attribute instanceof THREE.InterleavedBufferAttribute
        ? attribute.data.array
        : attribute.array;
    hash
      .update(name)
      .update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  if (geometry.index) {
    const a = geometry.index.array;
    hash.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }
  return hash.digest("hex");
}
/** Preserve the historical primitive prefix oracle as additive badges grow a batch. */
function cornersOf(
  geometry: THREE.BufferGeometry,
  start: number,
  count: number,
) {
  expect(geometry.index).toBeNull();
  const result = own(new THREE.BufferGeometry());
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (!(attribute instanceof THREE.BufferAttribute))
      throw new Error("Expected ordinary generated geometry attributes");
    result.setAttribute(
      name,
      new THREE.BufferAttribute(
        attribute.array.slice(
          start * attribute.itemSize,
          (start + count) * attribute.itemSize,
        ),
        attribute.itemSize,
        attribute.normalized,
      ),
    );
  }
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}
function meshMetrics(root: THREE.Object3D) {
  let triangles = 0,
    bytes = 0;
  const roles: string[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    roles.push(object.name);
    own(object.geometry);
    triangles +=
      (object.geometry.index?.count ??
        object.geometry.getAttribute("position").count) / 3;
    for (const attribute of Object.values(object.geometry.attributes)) {
      if (attribute instanceof THREE.InterleavedBufferAttribute)
        bytes += attribute.data.array.byteLength;
      else if (attribute instanceof THREE.BufferAttribute)
        bytes += attribute.array.byteLength;
      else throw new Error("Unexpected generated geometry attribute");
    }
    bytes += object.geometry.index?.array.byteLength ?? 0;
  });
  return { triangles, bytes, roles };
}
function fixture() {
  const generator = new BuildingGenerator();
  generators.push(generator);
  // Independent copy of the admitted original layout recipe, not new finish data.
  const recipe: BuildingRecipe = {
    ...getRecipe("bank")!,
    label: "Bank",
    widthRange: [2, 2],
    depthRange: [2, 2],
    floors: 1,
    floorsRange: [1, 1],
    entranceCount: 1,
    archBias: 0.8,
    extraConnectionChance: 0.4,
    entranceArchChance: 0,
    roomSpanRange: [2, 2],
    minRoomArea: 4,
    minUpperFloorCells: 3,
    minUpperFloorShrinkCells: 2,
    windowChance: 0.35,
    patioDoorChance: 0,
    patioDoorCountRange: [1, 1],
    footprintStyle: "default",
    foyerDepthRange: [1, 2],
    foyerWidthRange: [1, 2],
    excludeFoyerFromUpper: true,
    upperInsetRange: [1, 2],
    upperCarveChance: 0.1,
    frontSide: "south",
    wallMaterial: "stone",
    foundationStepsRange: [2, 2],
    hasBasement: false,
    basementChance: 0.8,
    basementLevels: 1,
    basementCoverage: 0.7,
    carveChance: 0,
  };
  const layout = generator.generateLayout(
    recipe,
    createRng("compact-bank-lodge01:360,318:8x8:south"),
  );
  const originalLayout = structuredClone(layout);
  const options: BuildingGeneratorOptions = {
    seed: "compact-bank-lodge01:360,318:8x8:south",
    cachedLayout: layout,
    roofStyle: "gable",
    includeProps: false,
    enableInteriorLighting: false,
  };
  const baseline = generator.generate("bank", options)!;
  const candidate = generator.generate("bank", {
    ...options,
    architecturalFinish: "haven-v1",
  })!;
  baseline.mesh.updateMatrixWorld(true);
  candidate.mesh.updateMatrixWorld(true);
  return { generator, layout, originalLayout, options, baseline, candidate };
}
function mesh(root: THREE.Object3D, name: string): THREE.Mesh {
  const object = root.getObjectByName(name);
  if (!(object instanceof THREE.Mesh))
    throw new Error(`Missing actual ${name} mesh`);
  return object;
}
function assertSolid(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute("position"),
    n = geometry.getAttribute("normal"),
    uv = geometry.getAttribute("uv"),
    index = geometry.index;
  const count = index?.count ?? p.count;
  const edges = new Map<string, number>();
  let volume = 0;
  const pointKey = (i: number) =>
    [p.getX(i), p.getY(i), p.getZ(i)].map((v) => Math.round(v * 1e5)).join(",");
  for (let corner = 0; corner < count; corner += 3) {
    const ids = [0, 1, 2].map(
      (offset) => index?.getX(corner + offset) ?? corner + offset,
    );
    const vertices = ids.map((id) =>
      new THREE.Vector3().fromBufferAttribute(p, id),
    );
    const face = vertices[1]
      .clone()
      .sub(vertices[0])
      .cross(vertices[2].clone().sub(vertices[0]));
    expect(face.length()).toBeGreaterThan(1e-8);
    for (const id of ids) {
      const normal = new THREE.Vector3().fromBufferAttribute(n, id);
      expect(normal.length()).toBeCloseTo(1, 5);
      expect(face.clone().normalize().dot(normal)).toBeGreaterThan(0.9999);
    }
    const tex = ids.map((id) => new THREE.Vector2(uv.getX(id), uv.getY(id)));
    expect(
      Math.abs(tex[1].sub(tex[0]).cross(tex[2].sub(tex[0]))),
    ).toBeGreaterThan(1e-9);
    volume += vertices[0].dot(vertices[1].clone().cross(vertices[2])) / 6;
    for (let edge = 0; edge < 3; edge++) {
      const key = [pointKey(ids[edge]), pointKey(ids[(edge + 1) % 3])]
        .sort()
        .join("/");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect(volume).toBeGreaterThan(0);
  expect([...edges.values()].every((n) => n === 2)).toBe(true);
  for (const attribute of Object.values(geometry.attributes)) {
    expect(attribute.count).toBe(p.count);
    const array =
      attribute instanceof THREE.InterleavedBufferAttribute
        ? attribute.data.array
        : attribute.array;
    expect([...array].every(Number.isFinite)).toBe(true);
  }
}

describe("opt-in Haven architectural geometry", () => {
  it("retains the recorded pre-pavilion smithy buffers and explicit-default identity", () => {
    const feet = [
      { bottom: -0.12, top: 0.25 },
      { bottom: -0.08, top: 0.24 },
      { bottom: -0.1, top: 0.22 },
      { bottom: -0.07, top: 0.23 },
    ];
    // Captured before editing OpenWorkshop.ts (source SHA256
    // dec7fdb1c09e04b931fd186509181cf8b6591d2622a18d8a68a56fb41d0c994a).
    // This is a historical output oracle, not only two calls to new code.
    const hashes = {
      original: [
        "5e6d33910f3f6f1166e8c58637bb75da590232ca3500e83f975f4ec51e105bc4",
        "46f8aa4f1f19e9336f5e607548193e66fefb50fd6421c9d8b1a69040991c0f93",
        "66115636f1e361d8f03c8154fe13d7d223ac5a7fbd071eb26ba5aa21cfcadd92",
      ],
      "haven-v1": [
        "f2f736ffa714b04aca3c29adcbc0738fe18b353367e74e6be60e16fca1ce2cad",
        "4c287519b3c1060e8ed404d659efe6f2c9ec182fbad64bb86e5ea3f0067b5489",
        "66115636f1e361d8f03c8154fe13d7d223ac5a7fbd071eb26ba5aa21cfcadd92",
      ],
    };
    for (const architecturalFinish of [undefined, "haven-v1"] as const) {
      const geometry = createOpenWorkshop(feet, { architecturalFinish });
      const explicit = createOpenWorkshop(feet, {
        architecturalFinish,
        recipe: "smithy-v1",
      });
      try {
        for (const [index, role] of (
          ["timber", "roof", "footings"] as const
        ).entries()) {
          expect(digest(geometry[role])).toBe(
            hashes[architecturalFinish ?? "original"][index],
          );
          expect(digest(explicit[role])).toBe(digest(geometry[role]));
          expect(explicit[role].boundingBox).toEqual(
            geometry[role].boundingBox,
          );
          expect(explicit[role].boundingSphere).toEqual(
            geometry[role].boundingSphere,
          );
          expect(explicit[role].index).toEqual(geometry[role].index);
          for (const name of Object.keys(geometry[role].attributes)) {
            expect(explicit[role].getAttribute(name).itemSize).toBe(
              geometry[role].getAttribute(name).itemSize,
            );
            expect(explicit[role].getAttribute(name).array).toEqual(
              geometry[role].getAttribute(name).array,
            );
          }
        }
        expect(geometry.timber.boundingBox!.min.toArray()).toEqual([
          -5.486606597900391, 0.1850000023841858, -3.450000047683716,
        ]);
        expect(geometry.timber.boundingBox!.max.toArray()).toEqual([
          5.486606597900391, 5.418362617492676, 3.450000047683716,
        ]);
        expect(geometry.roof.boundingBox!.min.toArray()).toEqual([
          -5.449999809265137, 2.9996471405029297, -3.450000047683716,
        ]);
        expect(geometry.roof.boundingBox!.max.toArray()).toEqual([
          5.449999809265137, 5.606143474578857, 3.450000047683716,
        ]);
      } finally {
        geometry.dispose();
        explicit.dispose();
      }
    }
  });

  it("creates the fixed bank pavilion with deterministic finite outward geometry, metric UVs and bounded three-batch cost", () => {
    expect(BANK_PAVILION_RECIPE).toEqual({
      id: "bank-pavilion-v1",
      width: 8,
      depth: 8,
      eaveHeight: 3.2,
      pitchDegrees: 30,
      posts: [
        { x: -3.5, z: -3.5 },
        { x: 3.5, z: -3.5 },
        { x: -3.5, z: 3.5 },
        { x: 3.5, z: 3.5 },
      ],
    });
    expect(Object.isFrozen(BANK_PAVILION_RECIPE)).toBe(true);
    expect(Object.isFrozen(BANK_PAVILION_POSTS)).toBe(true);
    expect(BANK_PAVILION_POSTS.every(Object.isFrozen)).toBe(true);
    const feet = BANK_PAVILION_POSTS.map(() =>
      Object.freeze({ bottom: -0.08, top: 0.22 }),
    );
    Object.freeze(feet);
    const first = createOpenWorkshop(feet, {
      recipe: "bank-pavilion-v1",
      architecturalFinish: "haven-v1",
    });
    const repeated = createOpenWorkshop(feet, {
      recipe: "bank-pavilion-v1",
      architecturalFinish: "haven-v1",
    });
    try {
      expect(Object.keys(first).sort()).toEqual([
        "dispose",
        "footings",
        "roof",
        "timber",
      ]);
      const bounds = new THREE.Box3();
      let triangles = 0,
        bytes = 0;
      for (const role of ["timber", "roof", "footings"] as const) {
        const geometry = first[role];
        expect(geometry).not.toBe(repeated[role]);
        expect(digest(geometry)).toBe(digest(repeated[role]));
        bounds.union(geometry.boundingBox!);
        const p = geometry.getAttribute("position"),
          n = geometry.getAttribute("normal"),
          uv = geometry.getAttribute("uv"),
          index = geometry.index;
        const count = index?.count ?? p.count;
        triangles += count / 3;
        for (const attribute of Object.values(geometry.attributes)) {
          expect(attribute.count).toBe(p.count);
          expect([...attribute.array].every(Number.isFinite)).toBe(true);
          bytes += attribute.array.byteLength;
        }
        bytes += index?.array.byteLength ?? 0;
        for (let corner = 0; corner < count; corner += 3) {
          const ids = [0, 1, 2].map(
            (offset) => index?.getX(corner + offset) ?? corner + offset,
          );
          const points = ids.map((id) =>
            new THREE.Vector3().fromBufferAttribute(p, id),
          );
          const face = points[1]
            .clone()
            .sub(points[0])
            .cross(points[2].clone().sub(points[0]));
          expect(
            face.lengthSq(),
            `${role}/${corner} degenerate`,
          ).toBeGreaterThan(1e-12);
          face.normalize();
          for (const id of ids) {
            const normal = new THREE.Vector3().fromBufferAttribute(n, id);
            expect(normal.length()).toBeCloseTo(1, 5);
            expect(
              normal.dot(face),
              `${role}/${corner} winding`,
            ).toBeGreaterThan(0.99999);
          }
          const tex = ids.map(
            (id) => new THREE.Vector2(uv.getX(id), uv.getY(id)),
          );
          expect(
            Math.abs(tex[1].sub(tex[0]).cross(tex[2].sub(tex[0]))),
            `${role}/${corner} collapsed UV`,
          ).toBeGreaterThan(1e-9);
        }
      }
      expect(triangles).toBe(1492);
      expect(triangles).toBeLessThanOrEqual(1500);
      expect(bytes).toBe(247200);
      expect(bounds.min.x).toBeGreaterThanOrEqual(-4.5);
      expect(bounds.max.x).toBeLessThanOrEqual(4.5);
      expect(bounds.min.z).toBeCloseTo(-4.45, 5);
      expect(bounds.max.z).toBeCloseTo(4.45, 5);
      expect(bounds.min.y).toBeCloseTo(-0.08, 6);
      expect(bounds.max.y).toBeCloseTo(
        3.2 + 4 * Math.tan(Math.PI / 6) + 0.18,
        5,
      );
      process.stdout.write(
        `${JSON.stringify({ bankPavilion: { triangles, bytes, min: bounds.min.toArray(), max: bounds.max.toArray(), hashes: Object.fromEntries((["timber", "roof", "footings"] as const).map((role) => [role, digest(first[role])])) } })}\n`,
      );
    } finally {
      first.dispose();
      repeated.dispose();
    }
  });

  it("changes only the eight bank brace labels against recorded pre-change physical buffers", () => {
    // Captured from OpenWorkshop.ts SHA256
    // ded191864a7917f95a59fd11cba6640aedb334f0392a3d0e762084eb99cf489a,
    // before this label-only edit (bank-pavilion-art02/before-geometry.json).
    const snapshots = [
      {
        finish: undefined,
        physical:
          "6a5375f93fafcbfb8dc371be8c95b534bd7544660664045b0838f512d9a3e4f3",
        oldTimber:
          "7305aa55bab22193d0caa527896d163ca27933db6701fbb6c2438c78a408cfb1",
        roof: "0dfed6788a12d32c026b1ab503c71bad3f12b1edb77d99ab2fcee454999aeddc",
        timberTriangles: 1052,
        timberMaxY: 5.497343063354492,
        timberRadius: 6.325747771019566,
      },
      {
        finish: "haven-v1" as const,
        physical:
          "05776a639b18c1c24274b02acae39eabf6bb4e0fa3ba7167d4cb3a0b97360a25",
        oldTimber:
          "ac79b468995e0c45a3068d21395f6802a7fb4d688e30a26f5b4247f900f17619",
        roof: "31fc880a9f697975c179c39d30938f1f9a3192f4943ce3abc6ce3d929bdf62b9",
        timberTriangles: 1148,
        timberMaxY: 5.49734354019165,
        timberRadius: 6.317848284304528,
      },
    ];
    // An eight-sided capped extrusion has 16 side + 12 end triangles.
    const memberCorners = (16 + 12) * 3;
    for (const snapshot of snapshots) {
      const geometry = createOpenWorkshop(
        BANK_PAVILION_POSTS.map(() => ({ bottom: -0.08, top: 0.22 })),
        { recipe: "bank-pavilion-v1", architecturalFinish: snapshot.finish },
      );
      const originalTimber = cornersOf(
        geometry.timber,
        0,
        snapshot.timberTriangles * 3,
      );
      const originalFootings = cornersOf(geometry.footings, 0, 112 * 3);
      const physical = originalTimber.clone();
      const legacy = originalTimber.clone();
      try {
        physical.deleteAttribute("courtRoof");
        expect(digest(physical)).toBe(snapshot.physical);
        expect(digest(geometry.roof)).toBe(snapshot.roof);
        expect(digest(originalFootings)).toBe(
          "98b29909ee38e8ff51e06c662af1d3a7ecea9736a764a799c5bd4546ede3a4d4",
        );
        const p = originalTimber.getAttribute("position");
        const mask = originalTimber.getAttribute("courtRoof");
        expect(geometry.timber.index).toBeNull();
        expect(p.count / 3).toBe(snapshot.timberTriangles);
        const restoredLabels = new Float32Array(p.count).fill(1);
        restoredLabels.fill(0, 0, 12 * memberCorners);
        legacy.setAttribute(
          "courtRoof",
          new THREE.BufferAttribute(restoredLabels, 1),
        );
        // Restoring exactly the old member labels recovers the complete old
        // digest, including positions, normals, UVs, colors and topology.
        expect(digest(legacy)).toBe(snapshot.oldTimber);
        let permanentTriangles = 0,
          changedCorners = 0;
        for (let corner = 0; corner < p.count; corner += 3) {
          const member = Math.floor(corner / memberCorners);
          const permanent = member < 12 && member % 3 === 0;
          for (let j = 0; j < 3; j++) {
            expect(mask.getX(corner + j)).toBe(permanent ? 0 : 1);
            if (mask.getX(corner + j) !== restoredLabels[corner + j])
              changedCorners++;
          }
          if (permanent) {
            permanentTriangles++;
            const post = BANK_PAVILION_POSTS[member / 3];
            for (let j = 0; j < 3; j++) {
              expect(Math.abs(p.getX(corner + j) - post.x)).toBeLessThanOrEqual(
                0.120001,
              );
              expect(Math.abs(p.getZ(corner + j) - post.z)).toBeLessThanOrEqual(
                0.120001,
              );
            }
          }
        }
        expect(permanentTriangles).toBe(4 * 28);
        expect(changedCorners).toBe(8 * memberCorners);
        expect(geometry.timber.boundingBox!.min.toArray()).toEqual([
          -4.494999885559082, 0.1850000023841858, -4.449999809265137,
        ]);
        expect(geometry.timber.boundingBox!.max.toArray()).toEqual([
          4.494999885559082,
          snapshot.timberMaxY,
          4.449999809265137,
        ]);
        expect(geometry.timber.boundingSphere!.radius).toBe(
          snapshot.timberRadius,
        );
      } finally {
        physical.dispose();
        legacy.dispose();
        geometry.dispose();
      }
    }
  });

  it("attaches two closed south-post key badges inside the existing blocked tiles and keeps them visible under cutaway", () => {
    const geometry = createOpenWorkshop(
      BANK_PAVILION_POSTS.map(() => ({ bottom: -0.08, top: 0.22 })),
      { recipe: "bank-pavilion-v1", architecturalFinish: "haven-v1" },
    );
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    materials.add(material);
    const ray = new THREE.Raycaster();
    const metrics: Record<
      string,
      { triangles: number; bytes: number; sha256: string }
    > = {};
    try {
      // The old complete timber, including the brace visibility fix, is exact.
      expect(digest(cornersOf(geometry.timber, 0, 1148 * 3))).toBe(
        "af7df3be4367f748b17fcc2d64efd9c25acdd2ed08553cf1afa585fa66e36061",
      );
      for (const role of ["timber", "roof", "footings"] as const) {
        const g = geometry[role];
        metrics[role] = {
          triangles: g.getAttribute("position").count / 3,
          bytes: Object.values(g.attributes).reduce(
            (sum, a) => sum + a.array.byteLength,
            0,
          ),
          sha256: digest(g),
        };
      }
      expect(metrics.timber.triangles).toBe(1148 + 56);
      expect(metrics.roof.triangles).toBe(40);
      expect(metrics.footings.triangles).toBe(112 + 136);
      const bounds: {
        post: { x: number; z: number };
        min: number[];
        max: number[];
      }[] = [];
      for (const [i, post] of BANK_PAVILION_POSTS.filter(
        (p) => p.z > 0,
      ).entries()) {
        const plaque = cornersOf(geometry.timber, (1148 + i * 28) * 3, 28 * 3);
        const bow = cornersOf(geometry.footings, (112 + i * 68) * 3, 48 * 3);
        const shaft = cornersOf(
          geometry.footings,
          (112 + i * 68 + 48) * 3,
          20 * 3,
        );
        const badgeBounds = new THREE.Box3();
        for (const part of [plaque, bow, shaft]) {
          assertSolid(part);
          badgeBounds.union(part.boundingBox!);
          const p = part.getAttribute("position");
          for (let v = 0; v < p.count; v++) {
            // Actual admitted placement is (350, 320), rotation zero. Every
            // new collision vertex stays in its already occupied 1m post tile.
            expect(Math.floor(350 + p.getX(v))).toBe(Math.floor(350 + post.x));
            expect(Math.floor(320 + p.getZ(v))).toBe(Math.floor(320 + post.z));
            expect(p.getY(v)).toBeGreaterThanOrEqual(1.4);
            expect(p.getY(v)).toBeLessThanOrEqual(2.1);
          }
        }
        expect([...plaque.getAttribute("courtRoof").array]).toEqual(
          Array(28 * 3).fill(0),
        );
        expect(geometry.footings.getAttribute("courtRoof")).toBeUndefined();
        expect(plaque.boundingBox!.min.z).toBeLessThan(post.z + 0.12);
        expect(plaque.boundingBox!.max.z).toBeGreaterThan(post.z + 0.12);
        expect(bow.boundingBox!.min.z).toBeLessThan(plaque.boundingBox!.max.z);
        expect(shaft.boundingBox!.min.z).toBeLessThan(
          plaque.boundingBox!.max.z,
        );
        expect(badgeBounds.getSize(new THREE.Vector3()).x).toBeCloseTo(0.52, 6);
        expect(badgeBounds.getSize(new THREE.Vector3()).y).toBeCloseTo(0.66, 6);
        const boardMesh = new THREE.Mesh(plaque, material);
        const key = new THREE.Group();
        key.add(new THREE.Mesh(bow, material), new THREE.Mesh(shaft, material));
        key.updateMatrixWorld(true);
        boardMesh.updateMatrixWorld(true);
        for (const [x, y] of [
          [post.x + 0.08, 1.9],
          [post.x + 0.07, 1.625],
        ]) {
          ray.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
          ray.far = 2;
          const reliefHits = ray.intersectObject(key, true);
          const boardHits = ray.intersectObject(boardMesh);
          expect(reliefHits.length).toBeGreaterThan(0);
          expect(boardHits.length).toBeGreaterThan(0);
          expect(reliefHits[0].point.z).toBeCloseTo(post.z + 0.216, 6);
          expect(reliefHits[0].distance).toBeLessThan(boardHits[0].distance);
        }
        // The bow's central hole is real geometry, with the wood visible behind.
        ray.set(new THREE.Vector3(post.x, 1.9, 5), new THREE.Vector3(0, 0, -1));
        expect(ray.intersectObject(key, true)).toHaveLength(0);
        expect(ray.intersectObject(boardMesh).length).toBeGreaterThan(0);
        bounds.push({
          post,
          min: badgeBounds.min.toArray(),
          max: badgeBounds.max.toArray(),
        });
      }
      const mask = geometry.timber.getAttribute("courtRoof");
      expect([...mask.array].filter((v) => v === 0).length / 3).toBe(112 + 56);
      process.stdout.write(
        `${JSON.stringify({
          bankPostBadges: {
            metrics,
            bounds,
            addedTriangles: 192,
            extraBatches: 0,
            blockedTiles: [
              [346, 323],
              [353, 323],
            ],
          },
        })}\n`,
      );
    } finally {
      geometry.dispose();
    }
  });

  it("leaves all bank sides and gable apertures open with no floor, labels only actual upper structure and keeps four exact footings", () => {
    const feet = BANK_PAVILION_POSTS.map(() => ({ bottom: -0.08, top: 0.22 }));
    const geometry = createOpenWorkshop(feet, {
      recipe: "bank-pavilion-v1",
      architecturalFinish: "haven-v1",
    });
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const group = new THREE.Group();
    for (const role of ["timber", "roof", "footings"] as const)
      group.add(new THREE.Mesh(geometry[role], material));
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    try {
      let clearRays = 0;
      for (const axis of ["x", "z"] as const)
        for (const sign of [-1, 1])
          for (let along = -3; along <= 3; along += 0.25)
            for (let y = 0.25; y <= 2.35; y += 0.3) {
              const origin = new THREE.Vector3(),
                direction = new THREE.Vector3();
              origin[axis] = sign * 5;
              origin[axis === "x" ? "z" : "x"] = along;
              origin.y = y;
              direction[axis] = -sign;
              ray.set(origin, direction);
              ray.far = 10;
              expect(
                ray.intersectObject(group, true),
                `${axis}/${sign}/${along}/${y}`,
              ).toHaveLength(0);
              clearRays++;
            }
      expect(clearRays).toBe(800);
      for (const x of [-1.5, 1.5]) {
        // At |x|=1.5 the diagonal strut crosses y≈3.983 and the upper
        // rafter crosses y≈4.483. Probe the real aperture between them,
        // not the solid diagonal framing at the original y=4.05 probe.
        ray.set(new THREE.Vector3(x, 4.25, -5), new THREE.Vector3(0, 0, 1));
        ray.far = 10;
        expect(ray.intersectObject(group, true)).toHaveLength(0);
      }
      ray.set(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0));
      ray.far = 2;
      expect(ray.intersectObject(group, true)).toHaveLength(0);
      for (const post of BANK_PAVILION_POSTS) {
        ray.set(
          new THREE.Vector3(post.x, 1, post.z),
          new THREE.Vector3(0, -1, 0),
        );
        ray.far = 2;
        const hit = ray.intersectObject(group.children[2])[0];
        expect(hit.point.y).toBeCloseTo(0.22, 6);
      }
      const mask = geometry.timber.getAttribute("courtRoof"),
        p = geometry.timber.getAttribute("position");
      // The newly fading brace corners dip below the old 2.7m heuristic.
      // A shortest-arc quaternion can project BOTH section axes onto Y, so
      // evaluate the authored octagonal section, not a planar-radius estimate.
      const half = 0.07,
        bevel = 0.14 * 0.09;
      const section = [
        [-half + bevel, -half],
        [half - bevel, -half],
        [half, -half + bevel],
        [half, half - bevel],
        [half - bevel, half],
        [-half + bevel, half],
        [-half, half - bevel],
        [-half, -half + bevel],
      ];
      const braceOffsets = [
        [0.72, 0.62, 0],
        [-0.72, 0.62, 0],
        [0, 0.62, 0.72],
        [0, 0.62, -0.72],
      ].flatMap((axis) => {
        const orientation = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(...axis).normalize(),
        );
        return section.map(
          ([x, y]) => new THREE.Vector3(x, y, 0).applyQuaternion(orientation).y,
        );
      });
      const lowestBraceY =
        3.2 + 0.5 * Math.tan(Math.PI / 6) - 0.75 + Math.min(...braceOffsets);
      const values = new Set<number>();
      for (let i = 0; i < p.count; i++) {
        const value = mask.getX(i);
        values.add(value);
        if (value === 1)
          expect(p.getY(i)).toBeGreaterThanOrEqual(lowestBraceY - 1e-6);
        if (p.getY(i) < lowestBraceY - 1e-6) expect(value).toBe(0);
      }
      expect([...values].sort()).toEqual([0, 1]);
    } finally {
      geometry.dispose();
      material.dispose();
    }
  });

  it("owns each bank geometry independently, disposes once and rejects unknown recipes or unsupported feet", () => {
    const feet = BANK_PAVILION_POSTS.map(() => ({ bottom: -0.08, top: 0.22 }));
    const a = createOpenWorkshop(feet, { recipe: "bank-pavilion-v1" });
    const b = createOpenWorkshop(feet, { recipe: "bank-pavilion-v1" });
    const counts = new Map<THREE.BufferGeometry, number>();
    for (const result of [a, b])
      for (const role of ["timber", "roof", "footings"] as const) {
        const g = result[role];
        counts.set(g, 0);
        g.addEventListener("dispose", () => counts.set(g, counts.get(g)! + 1));
      }
    try {
      const hash = digest(b.timber);
      a.timber.getAttribute("position").setX(0, 100);
      expect(digest(b.timber)).toBe(hash);
      a.dispose();
      a.dispose();
      expect([a.timber, a.roof, a.footings].map((g) => counts.get(g))).toEqual([
        1, 1, 1,
      ]);
      expect([b.timber, b.roof, b.footings].map((g) => counts.get(g))).toEqual([
        0, 0, 0,
      ]);
      // @ts-expect-error Runtime content can supply unsupported recipe IDs.
      expect(() => createOpenWorkshop(feet, { recipe: "unknown" })).toThrow();
      for (const invalid of [
        feet.slice(1),
        [...feet, feet[0]],
        feet.map((f, i) => (i === 0 ? { bottom: NaN, top: f.top } : f)),
        feet.map((f, i) => (i === 0 ? { bottom: -1.01, top: f.top } : f)),
        feet.map((f, i) => (i === 0 ? { bottom: f.bottom, top: 1.01 } : f)),
      ])
        expect(() =>
          createOpenWorkshop(invalid, { recipe: "bank-pavilion-v1" }),
        ).toThrow();
    } finally {
      a.dispose();
      b.dispose();
    }
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("maps member grain along its actual metre length for vertical, horizontal and pitched members", () => {
    for (const [start, end, normal] of [
      [
        [4.128, 0.74, -3.82],
        [4.128, 3.64, -3.82],
        [1, 0, 0],
      ],
      [
        [-3.94, 3.69, 4.128],
        [3.94, 3.69, 4.128],
        [0, 0, 1],
      ],
      [
        [0, 6.2, -4.39],
        [4.45, 3.43, -4.39],
        [0, 0, 1],
      ],
    ]) {
      const a = new THREE.Vector3(...start),
        b = new THREE.Vector3(...end),
        axis = b.clone().sub(a).normalize();
      const geometry = own(
        createHavenMember(a, b, 0.18, 0.04, new THREE.Vector3(...normal)),
      );
      const p = geometry.getAttribute("position"),
        n = geometry.getAttribute("normal"),
        uv = geometry.getAttribute("uv"),
        roles = geometry.getAttribute("uv2");
      let sides = 0;
      for (let i = 0; i < p.count; i++) {
        expect(roles.getX(i)).toBe(1);
        const faceNormal = new THREE.Vector3().fromBufferAttribute(n, i);
        if (Math.abs(faceNormal.dot(axis)) > 0.5) continue;
        expect(uv.getX(i)).toBeCloseTo(
          new THREE.Vector3().fromBufferAttribute(p, i).sub(a).dot(axis),
          5,
        );
        sides++;
      }
      expect(sides).toBe(48);
    }
  });
  it("preserves the actual layout, floor, door/window trim, role count and complete support envelope", () => {
    const { layout, originalLayout, baseline, candidate, generator, options } =
      fixture();
    const oldMetrics = meshMetrics(baseline.mesh),
      metrics = meshMetrics(candidate.mesh);
    expect(oldMetrics).toEqual({
      triangles: 1332,
      bytes: 172016,
      roles: ["floors", "walls", "roof", "windowFrames", "doorFrames"],
    });
    expect(metrics.roles).toEqual(oldMetrics.roles);
    expect(metrics.triangles).toBeLessThanOrEqual(2400);
    expect(metrics.triangles).toBeGreaterThan(oldMetrics.triangles);
    expect(metrics.triangles).toBe(2232);
    expect(metrics.bytes).toBe(262064);
    for (const role of ["floors", "windowFrames", "doorFrames"])
      expect(digest(mesh(candidate.mesh, role).geometry), role).toBe(
        digest(mesh(baseline.mesh, role).geometry),
      );
    const oldBounds = new THREE.Box3().setFromObject(baseline.mesh);
    const bounds = new THREE.Box3().setFromObject(candidate.mesh);
    process.stdout.write(
      `${JSON.stringify({
        havenLodge: metrics,
        perRole: Object.fromEntries(
          metrics.roles.map((role) => [
            role,
            meshMetrics(mesh(candidate.mesh, role)),
          ]),
        ),
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
      })}\n`,
    );
    expect(oldBounds.clone().expandByScalar(1e-6).containsBox(bounds)).toBe(
      true,
    );
    expect(bounds.min.y).toBe(oldBounds.min.y);
    expect(bounds.max.y).toBe(oldBounds.max.y);
    expect(candidate.layout).toBe(layout);
    expect(candidate.layout).toEqual(baseline.layout);
    expect(layout).toEqual(originalLayout);
    expect(candidate.propPlacements).toEqual({});
    expect(candidate.stats.props).toBe(0);
    const repeated = generator.generate("bank", options)!;
    meshMetrics(repeated.mesh);
    for (const role of metrics.roles)
      expect(digest(mesh(repeated.mesh, role).geometry)).toBe(
        digest(mesh(baseline.mesh, role).geometry),
      );
  });

  it("retains winding-aligned finite flat normals on every final legacy and Haven face after cleanup and welding", () => {
    const { baseline, candidate } = fixture();
    for (const result of [baseline, candidate]) {
      meshMetrics(result.mesh);
      let faces = 0;
      for (const child of result.mesh.children) {
        if (!(child instanceof THREE.Mesh))
          throw new Error("Unexpected building role");
        const geometry = child.geometry,
          p = geometry.getAttribute("position"),
          n = geometry.getAttribute("normal"),
          index = geometry.index,
          count = index?.count ?? p.count;
        for (let corner = 0; corner < count; corner += 3) {
          const ids = [0, 1, 2].map(
            (i) => index?.getX(corner + i) ?? corner + i,
          );
          const points = ids.map((i) =>
            new THREE.Vector3().fromBufferAttribute(p, i),
          );
          const face = points[1]
            .clone()
            .sub(points[0])
            .cross(points[2].clone().sub(points[0]));
          expect(
            face.lengthSq(),
            `${child.name} face ${corner / 3}`,
          ).toBeGreaterThan(1e-12);
          face.normalize();
          for (const id of ids) {
            const normal = new THREE.Vector3().fromBufferAttribute(n, id);
            expect(normal.toArray().every(Number.isFinite)).toBe(true);
            expect(normal.length()).toBeCloseTo(1, 5);
            expect(
              normal.dot(face),
              `${child.name} face ${corner / 3}`,
            ).toBeGreaterThan(0.99999);
          }
          faces++;
        }
      }
      expect(faces).toBe(result === baseline ? 1332 : 2232);
    }
  });

  it("retains every original doorway/window ray and entrance-step surface through a dense real-mesh sweep", () => {
    const { layout, baseline, candidate } = fixture();
    meshMetrics(baseline.mesh);
    meshMetrics(candidate.mesh);
    const ray = new THREE.Raycaster();
    ray.layers.enableAll();
    ray.far = 2;
    let queries = 0;
    const compare = () => {
      const before = ray.intersectObject(baseline.mesh, true),
        after = ray.intersectObject(candidate.mesh, true);
      expect(
        after.map((h) => h.distance),
        `ray ${queries} ${ray.ray.origin.toArray()}`,
      ).toEqual(before.map((h) => h.distance));
      queries++;
    };
    for (const [key, opening] of layout.floorPlans[0].externalOpenings) {
      const [col, row, side] = key.split(","),
        alongX = side === "north" || side === "south",
        sign = side === "north" || side === "west" ? -1 : 1,
        center = ((alongX ? Number(col) : Number(row)) + 0.5) * CELL_SIZE - 4,
        width = opening === "window" ? WINDOW_WIDTH : DOOR_WIDTH,
        bottom = 0.6 + (opening === "window" ? WINDOW_SILL_HEIGHT : 0),
        top = bottom + (opening === "window" ? WINDOW_HEIGHT : DOOR_HEIGHT);
      for (let u = 0; u <= 20; u++)
        for (let v = 1; v < 20; v++) {
          const along = center - width / 2 + (u * width) / 20,
            y = bottom + (v * (top - bottom)) / 20;
          ray.ray.set(
            new THREE.Vector3(
              alongX ? along : sign * 5,
              y,
              alongX ? sign * 5 : along,
            ),
            new THREE.Vector3(alongX ? 0 : -sign, 0, alongX ? -sign : 0),
          );
          compare();
        }
      if (opening === "door")
        for (let u = -9; u <= 9; u++)
          for (let v = 0; v <= 24; v++) {
            const along = center + u / 10,
              across = sign * (4.15 + v / 10);
            ray.ray.set(
              new THREE.Vector3(
                alongX ? along : across,
                0.9,
                alongX ? across : along,
              ),
              new THREE.Vector3(0, -1, 0),
            );
            compare();
          }
    }
    expect(queries).toBeGreaterThan(1500);
  });

  it("keeps all new members closed, outward-facing, finite and nondegenerate without collapsed UVs", () => {
    const { layout, baseline, candidate } = fixture();
    meshMetrics(baseline.mesh);
    meshMetrics(candidate.mesh);
    const members = createHavenLodgeFinish(layout);
    for (const member of members) {
      own(member);
      assertSolid(member);
      member.computeBoundingBox();
      expect(member.boundingBox!.min.x).toBeGreaterThanOrEqual(-4.15);
      expect(member.boundingBox!.max.x).toBeLessThanOrEqual(4.15);
      expect(member.boundingBox!.min.z).toBeGreaterThanOrEqual(-4.15);
      expect(member.boundingBox!.max.z).toBeLessThanOrEqual(4.15);
      expect(member.boundingBox!.min.y).toBeGreaterThanOrEqual(0.599999);
    }
    for (const openEnds of [false, true]) {
      const roof = createGabledRoof(
        openEnds ? 10 : 8,
        openEnds ? 6 : 8,
        openEnds ? 3.2 : 3.8,
        "stone",
        {
          openEnds,
          pitchDegrees: openEnds ? 24 : 32,
          architecturalFinish: "haven-v1",
        },
      );
      for (const geometry of [...roof.roofs, ...roof.walls]) {
        own(geometry);
        assertSolid(geometry);
      }
      for (const geometry of roof.roofs) {
        geometry.computeBoundingBox();
        expect(geometry.boundingBox!.min.z).toBeCloseTo(
          openEnds ? -3.45 : -4.45,
          5,
        );
      }
    }
  });

  it("preserves smithy feet/permanent-post vertices and admits all new upper work through the existing cutaway attribute", () => {
    const feet = [
      { bottom: -0.12, top: 0.25 },
      { bottom: -0.08, top: 0.24 },
      { bottom: -0.1, top: 0.22 },
      { bottom: -0.07, top: 0.23 },
    ];
    const baseline = createOpenWorkshop(feet),
      candidate = createOpenWorkshop(feet, { architecturalFinish: "haven-v1" });
    try {
      expect(digest(candidate.footings)).toBe(digest(baseline.footings));
      const permanent = (geometry: THREE.BufferGeometry) => {
        const mask = geometry.getAttribute("courtRoof"),
          p = geometry.getAttribute("position"),
          n = geometry.getAttribute("normal"),
          uv = geometry.getAttribute("uv"),
          color = geometry.getAttribute("color"),
          roles = geometry.getAttribute("uv2");
        const data: number[] = [];
        for (let i = 0; i < p.count; i++)
          if (mask.getX(i) === 0)
            data.push(
              p.getX(i),
              p.getY(i),
              p.getZ(i),
              n.getX(i),
              n.getY(i),
              n.getZ(i),
              uv.getX(i),
              uv.getY(i),
              color.getX(i),
              color.getY(i),
              color.getZ(i),
              roles.getX(i),
              roles.getY(i),
            );
        return data;
      };
      expect(permanent(candidate.timber)).toEqual(permanent(baseline.timber));
      expect(permanent(candidate.timber).length).toBeGreaterThan(0);
      const group = new THREE.Group(),
        material = new THREE.MeshBasicMaterial();
      materials.add(material);
      for (const role of ["timber", "roof", "footings"] as const) {
        const m = new THREE.Mesh(candidate[role], material);
        m.name = role;
        group.add(m);
      }
      const metrics = meshMetrics(group);
      expect(metrics.triangles).toBe(1300);
      expect(metrics.triangles).toBeLessThanOrEqual(1500);
      expect(metrics.bytes).toBe(216576);
      process.stdout.write(
        `${JSON.stringify({
          havenSmithy: metrics,
          perRole: Object.fromEntries(
            metrics.roles.map((role) => [role, meshMetrics(mesh(group, role))]),
          ),
        })}\n`,
      );
      const mask = candidate.timber.getAttribute("courtRoof"),
        p = candidate.timber.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        expect([0, 1]).toContain(mask.getX(i));
        if (mask.getX(i) === 1) expect(p.getY(i)).toBeGreaterThan(2.8);
      }
      const rawBounds = new THREE.Box3();
      for (const role of ["timber", "roof", "footings"] as const)
        rawBounds.union(baseline[role].boundingBox!);
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      process.stdout.write(
        `${JSON.stringify({ smithyMin: bounds.min.toArray(), smithyMax: bounds.max.toArray() })}\n`,
      );
      expect(
        rawBounds
          .expandByScalar(1e-6)
          .containsBox(new THREE.Box3().setFromObject(group)),
      ).toBe(true);
      const ray = new THREE.Raycaster(
        new THREE.Vector3(-2, 4.1, -4),
        new THREE.Vector3(0, 0, 1),
        0,
        8,
      );
      expect(ray.intersectObject(group, true)).toHaveLength(0);
      ray.ray.origin.x = 2;
      expect(ray.intersectObject(group, true)).toHaveLength(0);
    } finally {
      baseline.dispose();
      candidate.dispose();
      for (const geometry of [
        candidate.timber,
        candidate.roof,
        candidate.footings,
      ])
        geometryLeases.delete(geometry);
    }
  });

  it("rejects unknown or unsupported finish options and malformed primitive dimensions before geometry allocation", () => {
    const { generator, options, baseline, candidate } = fixture();
    meshMetrics(baseline.mesh);
    meshMetrics(candidate.mesh);
    for (const patch of [
      { architecturalFinish: "unknown" },
      { roofStyle: "flat" },
      { includeRoof: false },
      { includeProps: true },
      { cachedLayout: { ...options.cachedLayout, foundationSteps: 0 } },
    ])
      expect(() =>
        generator.generate("bank", {
          ...options,
          architecturalFinish: "haven-v1",
          ...patch,
        } as BuildingGeneratorOptions),
      ).toThrow("Haven finish");
    expect(() =>
      // @ts-expect-error Deliberately invalid external recipe content.
      createGabledRoof(8, 8, 3.8, "stone", { architecturalFinish: "bad" }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error Deliberately invalid external recipe content.
      createOpenWorkshop([], { architecturalFinish: "bad" }),
    ).toThrow();
    for (const width of [NaN, Infinity, 0, -1])
      expect(() =>
        createHavenMember(
          new THREE.Vector3(),
          new THREE.Vector3(0, 1, 0),
          width,
          0.1,
          new THREE.Vector3(0, 0, 1),
        ),
      ).toThrow();
    expect(() =>
      createHavenMember(
        new THREE.Vector3(),
        new THREE.Vector3(0, 1, 0),
        0.1,
        0.1,
        new THREE.Vector3(0, 1, 0),
      ),
    ).toThrow();
    const overBudget = structuredClone(options.cachedLayout!);
    overBudget.floorPlans[0].externalOpenings = new Map([
      ["0,0,north", "door"],
      ["1,0,north", "door"],
      ["0,1,south", "door"],
      ["1,1,south", "door"],
      ["0,0,west", "door"],
      ["0,1,west", "door"],
      ["1,0,east", "door"],
      ["1,1,east", "door"],
    ]);
    expect(() =>
      generator.generate("bank", {
        ...options,
        cachedLayout: overBudget,
        architecturalFinish: "haven-v1",
      }),
    ).toThrow("2400-triangle");
  });
});
