import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { BuildingGenerator, createRng } from "./BuildingGenerator";
import { createGabledRoof } from "./GabledRoof";
import {
  createHavenLodgeFinish,
  createHavenMember,
} from "./HavenArchitecturalFinish";
import { createOpenWorkshop } from "./OpenWorkshop";
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
    for (const attribute of Object.values(object.geometry.attributes))
      bytes +=
        attribute instanceof THREE.InterleavedBufferAttribute
          ? attribute.data.array.byteLength
          : attribute.array.byteLength;
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
    const tex = ids.map((id) =>
      new THREE.Vector2().fromBufferAttribute(uv, id),
    );
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
      createGabledRoof(8, 8, 3.8, "stone", { architecturalFinish: "bad" } as {
        architecturalFinish: "haven-v1";
      }),
    ).toThrow();
    expect(() =>
      createOpenWorkshop([], { architecturalFinish: "bad" } as {
        architecturalFinish: "haven-v1";
      }),
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
