import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import {
  getDuelArenaGradeHeight,
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
  DUEL_ARENA_FLOOR_GROUND_OFFSET,
} from "../../../data/arena-grading";
import {
  getDuelArenaConfig,
  type DuelArenaConfig,
} from "../../../data/duel-manifest";
import {
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_LENGTH,
  LOBBY_WIDTH,
} from "../../../data/arena-layout";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { DuelArenaVisualsSystem } from "../DuelArenaVisualsSystem";

// Exercise the real construction methods on a real World/system. No mocked
// systems, renderer or physics. Full start also builds unrelated canvas lobby
// textures; this fixture initializes only the actual architecture prerequisites.
type ConstructionAccess = {
  arenaCfg: DuelArenaConfig;
  arenaGroup: THREE.Group;
  arenaFloorMat: MeshStandardNodeMaterial;
  createSharedMaterials(): void;
  createArenaFloors(): void;
  createLobbyFloor(): void;
  buildFenceInstances(): void;
  buildPillarInstances(): void;
};

describe("Duel arena floor shadow receivers", () => {
  const owned: DuelArenaVisualsSystem[] = [];
  afterEach(() => {
    for (const system of owned.splice(0)) system.destroy();
  });

  function construct() {
    const world = new World();
    const system = new DuelArenaVisualsSystem(world);
    owned.push(system);
    const build = system as unknown as ConstructionAccess;
    build.arenaCfg = getDuelArenaConfig();
    build.arenaGroup = new THREE.Group();
    world.stage.scene.add(build.arenaGroup);
    build.createSharedMaterials();
    return { world, system, build, cfg: build.arenaCfg };
  }

  it("creates every actual arena floor as receiver-only with unchanged surface data", () => {
    const { build, cfg } = construct();
    const material = build.arenaFloorMat;
    const colorNode = material.colorNode;
    const roughnessNode = material.roughnessNode;
    const materialState = [
      material.side,
      material.opacity,
      material.transparent,
      material.metalness,
      material.depthWrite,
    ];
    build.createArenaFloors();
    const floors = build.arenaGroup.children as THREE.Mesh[];
    expect(floors).toHaveLength(cfg.arenaCount);
    expect(floors.map((floor) => floor.name)).toEqual(["ArenaFloor_1"]);
    for (let id = 2; id <= 6; id++) {
      expect(
        build.arenaGroup.getObjectByName(`ArenaFloor_${id}`),
      ).toBeUndefined();
    }
    const expected = new THREE.BoxGeometry(
      cfg.arenaWidth - 1,
      0.3,
      cfg.arenaLength - 1,
    );
    try {
      for (const [index, floor] of floors.entries()) {
        expect(floor).toBeInstanceOf(THREE.Mesh);
        expect(floor.name).toBe(`ArenaFloor_${index + 1}`);
        expect(floor.receiveShadow).toBe(true);
        expect(floor.castShadow).toBe(false);
        expect(floor.geometry).toBe(floors[0].geometry);
        expect(floor.material).toBe(material);
        expect(floor.geometry.index!.array).toEqual(expected.index!.array);
        for (const key of ["position", "normal", "uv"]) {
          expect(floor.geometry.attributes[key].array).toEqual(
            expected.attributes[key].array,
          );
        }
        const col = index % cfg.columns;
        const row = Math.floor(index / cfg.columns);
        expect(floor.position.toArray()).toEqual([
          cfg.baseX +
            col * (cfg.arenaWidth + cfg.arenaGap) +
            cfg.arenaWidth / 2,
          getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_CENTER_OFFSET,
          cfg.baseZ +
            row * (cfg.arenaLength + cfg.arenaGap) +
            cfg.arenaLength / 2,
        ]);
        expect(floor.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(floor.scale.toArray()).toEqual([1, 1, 1]);
        expect(floor.layers.mask).toBe((1 << 2) | 1);
        expect(floor.userData).toEqual({
          type: "arena-floor",
          walkable: true,
          arenaId: index + 1,
        });
      }
      expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
      expect(material.colorNode).toBe(colorNode);
      expect(material.roughnessNode).toBe(roughnessNode);
      expect(colorNode).not.toBeNull();
      expect(roughnessNode).not.toBeNull();
      expect([
        material.side,
        material.opacity,
        material.transparent,
        material.metalness,
        material.depthWrite,
      ]).toEqual(materialState);
    } finally {
      expected.dispose();
    }
  });

  it("does not alter other real arena meshes and disposes the shared floor resources once", () => {
    const { world, system, build } = construct();
    build.buildFenceInstances();
    build.createLobbyFloor();
    const existing = build.arenaGroup.children.map((mesh) => ({
      mesh,
      cast: mesh.castShadow,
      receive: mesh.receiveShadow,
    }));
    const lobby = build.arenaGroup.getObjectByName("LobbyFloor")!;
    expect(lobby.receiveShadow).toBe(true);
    expect(lobby.castShadow).toBe(false);
    const unrelated = new THREE.Object3D();
    world.stage.scene.add(unrelated);
    build.createArenaFloors();
    for (const { mesh, cast, receive } of existing) {
      expect(mesh.castShadow).toBe(cast);
      expect(mesh.receiveShadow).toBe(receive);
    }
    const floor = build.arenaGroup.getObjectByName(
      "ArenaFloor_1",
    ) as THREE.Mesh;
    let geometryDisposals = 0;
    let materialDisposals = 0;
    floor.geometry.addEventListener("dispose", () => geometryDisposals++);
    build.arenaFloorMat.addEventListener("dispose", () => materialDisposals++);
    system.destroy();
    owned.splice(owned.indexOf(system), 1);
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(1);
    expect(world.stage.scene.children).toEqual([unrelated]);
  });

  it("retains only arena and lobby pillar owners, with no recovery floor or inlay", () => {
    const { build, cfg } = construct();
    build.createArenaFloors();
    build.createLobbyFloor();
    build.buildPillarInstances();
    for (const name of [
      "HospitalFloor",
      "RecoveryInlayRing",
      "RecoveryInlayDiamond",
    ]) {
      expect(build.arenaGroup.getObjectByName(name)).toBeUndefined();
    }
    const pillars = build.arenaGroup.children.filter(
      (mesh): mesh is THREE.InstancedMesh =>
        mesh instanceof THREE.InstancedMesh,
    );
    expect(pillars).toHaveLength(3);
    const expectedPositions: number[][] = [];
    for (let a = 0; a < cfg.arenaCount; a++) {
      const x = cfg.baseX + (a % cfg.columns) * (cfg.arenaWidth + cfg.arenaGap);
      const z =
        cfg.baseZ +
        Math.floor(a / cfg.columns) * (cfg.arenaLength + cfg.arenaGap);
      expectedPositions.push(
        [x, z],
        [x + cfg.arenaWidth, z],
        [x, z + cfg.arenaLength],
        [x + cfg.arenaWidth, z + cfg.arenaLength],
      );
    }
    const halfWidth = LOBBY_WIDTH / 2 - 0.25;
    const halfLength = LOBBY_LENGTH / 2 - 0.25;
    expectedPositions.push(
      [LOBBY_CENTER_X - halfWidth, LOBBY_CENTER_Z - halfLength],
      [LOBBY_CENTER_X + halfWidth, LOBBY_CENTER_Z - halfLength],
      [LOBBY_CENTER_X - halfWidth, LOBBY_CENTER_Z + halfLength],
      [LOBBY_CENTER_X + halfWidth, LOBBY_CENTER_Z + halfLength],
    );
    expect(expectedPositions).toHaveLength(8);
    const matrix = new THREE.Matrix4();
    for (const mesh of pillars) {
      expect(mesh.count).toBe(expectedPositions.length);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(false);
      expect(mesh.layers.mask).toBe(1 << 1);
      for (const [index, expected] of expectedPositions.entries()) {
        mesh.getMatrixAt(index, matrix);
        expect([matrix.elements[12], matrix.elements[14]]).toEqual(expected);
      }
    }
  });

  it("keeps seven enclosure batches inside the old boxes with closed, outward, finite geometry", () => {
    const { build, cfg } = construct();
    build.buildFenceInstances();
    build.buildPillarInstances();
    const meshes = build.arenaGroup.children as THREE.InstancedMesh[];
    expect(meshes).toHaveLength(7);
    expect(meshes.map((mesh) => mesh.count)).toEqual([48, 48, 6, 6, 8, 8, 8]);
    const dimensions: [number, number, number][] = [
      [0.2, 1.5, 0.2],
      [0.26, 0.06, 0.26],
      [cfg.arenaWidth, 0.08, 0.08],
      [0.08, 0.08, cfg.arenaLength],
      [0.5, 0.1, 0.5],
      [0.35, 2, 0.35],
      [0.45, 0.12, 0.45],
    ];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const face = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let totalTriangles = 0;
    for (const [meshIndex, mesh] of meshes.entries()) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(Array.isArray(mesh.material)).toBe(false);
      expect(mesh.layers.mask).toBe(1 << 1);
      expect(mesh.castShadow).toBe(meshIndex !== 1);
      expect(mesh.receiveShadow).toBe(false);
      const geometry = mesh.geometry;
      expect(geometry.groups).toEqual([]);
      const positions = geometry.getAttribute("position");
      const normals = geometry.getAttribute("normal");
      const uv = geometry.getAttribute("uv");
      const index = geometry.getIndex()!;
      expect(positions.count).toBe(48);
      expect(normals.count).toBe(48);
      expect(uv.count).toBe(48);
      expect(index.count).toBe(84);
      totalTriangles += (mesh.count * index.count) / 3;
      for (const attribute of [positions, normals, uv]) {
        expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const half = new THREE.Vector3(...dimensions[meshIndex]).multiplyScalar(
        0.5,
      );
      const bounds = geometry.boundingBox!;
      for (const axis of ["x", "y", "z"] as const) {
        expect(bounds.min[axis]).toBeCloseTo(-half[axis], 6);
        expect(bounds.max[axis]).toBeCloseTo(half[axis], 6);
      }
      expect(Number.isFinite(geometry.boundingSphere!.radius)).toBe(true);
      for (let i = 0; i < positions.count; i++) {
        a.fromBufferAttribute(positions, i);
        for (const axis of ["x", "y", "z"] as const) {
          expect(Math.abs(a[axis])).toBeLessThanOrEqual(half[axis] + 1e-6);
        }
        expect(normal.fromBufferAttribute(normals, i).length()).toBeCloseTo(
          1,
          6,
        );
      }
      // Weld only for the topology oracle: hard-edge vertices intentionally
      // duplicate positions, but every geometric edge must close twice.
      const pointKey = (i: number) =>
        [positions.getX(i), positions.getY(i), positions.getZ(i)]
          .map((value) => value.toFixed(6))
          .join(",");
      const edges = new Map<string, number>();
      for (let i = 0; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        for (const id of ids) {
          expect(Number.isInteger(id) && id >= 0 && id < positions.count).toBe(
            true,
          );
        }
        a.fromBufferAttribute(positions, ids[0]);
        b.fromBufferAttribute(positions, ids[1]);
        c.fromBufferAttribute(positions, ids[2]);
        face.subVectors(b, a).cross(edge.subVectors(c, a));
        expect(face.lengthSq()).toBeGreaterThan(1e-12);
        face.normalize();
        for (const id of ids) {
          expect(
            face.dot(normal.fromBufferAttribute(normals, id)),
          ).toBeGreaterThan(0.99999);
        }
        for (let j = 0; j < 3; j++) {
          const key = [pointKey(ids[j]), pointKey(ids[(j + 1) % 3])]
            .sort()
            .join("|");
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      expect([...edges.values()].every((count) => count === 2)).toBe(true);
    }
    expect(totalTriangles).toBe(3696);
    expect(
      totalTriangles - meshes.reduce((sum, mesh) => sum + mesh.count * 12, 0),
    ).toBe(2112);
  });

  it("retains every enclosure transform and continuous rail and cap contacts", () => {
    const { build, cfg } = construct();
    build.buildFenceInstances();
    build.buildPillarInstances();
    const [posts, caps, railsX, railsZ, bases, shafts, capitals] = build
      .arenaGroup.children as THREE.InstancedMesh[];
    const ground = getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_GROUND_OFFSET;
    const actual = new THREE.Matrix4();
    const expected = new THREE.Matrix4();
    function translation(
      mesh: THREE.InstancedMesh,
      index: number,
      x: number,
      y: number,
      z: number,
    ) {
      mesh.getMatrixAt(index, actual);
      expected.makeTranslation(x, y, z);
      // Instanced matrices are Float32, including their authoritative grade Y.
      expect(actual.elements).toEqual(
        Array.from(new Float32Array(expected.elements)),
      );
    }
    let postIndex = 0;
    let railIndex = 0;
    const pillarPositions: [number, number][] = [];
    for (let arena = 0; arena < cfg.arenaCount; arena++) {
      const x =
        cfg.baseX + (arena % cfg.columns) * (cfg.arenaWidth + cfg.arenaGap);
      const z =
        cfg.baseZ +
        Math.floor(arena / cfg.columns) * (cfg.arenaLength + cfg.arenaGap);
      for (const [startX, startZ, length, axis] of [
        [x, z, cfg.arenaWidth, "x"],
        [x, z + cfg.arenaLength, cfg.arenaWidth, "x"],
        [x, z, cfg.arenaLength, "z"],
        [x + cfg.arenaWidth, z, cfg.arenaLength, "z"],
      ] as const) {
        const count = Math.max(2, Math.floor(length / 2) + 1);
        for (let i = 0; i < count; i++) {
          const offset = i * (length / (count - 1));
          const px = startX + (axis === "x" ? offset : 0);
          const pz = startZ + (axis === "z" ? offset : 0);
          translation(posts, postIndex, px, ground + 0.75, pz);
          translation(caps, postIndex++, px, ground + 1.53, pz);
        }
      }
      for (const height of [0.3, 0.75, 1.2]) {
        for (const side of [0, 1]) {
          translation(
            railsX,
            railIndex,
            x + cfg.arenaWidth / 2,
            ground + height,
            z + side * cfg.arenaLength,
          );
          translation(
            railsZ,
            railIndex++,
            x + side * cfg.arenaWidth,
            ground + height,
            z + cfg.arenaLength / 2,
          );
        }
      }
      pillarPositions.push(
        [x, z],
        [x + cfg.arenaWidth, z],
        [x, z + cfg.arenaLength],
        [x + cfg.arenaWidth, z + cfg.arenaLength],
      );
    }
    const halfWidth = LOBBY_WIDTH / 2 - 0.25;
    const halfLength = LOBBY_LENGTH / 2 - 0.25;
    pillarPositions.push(
      [LOBBY_CENTER_X - halfWidth, LOBBY_CENTER_Z - halfLength],
      [LOBBY_CENTER_X + halfWidth, LOBBY_CENTER_Z - halfLength],
      [LOBBY_CENTER_X - halfWidth, LOBBY_CENTER_Z + halfLength],
      [LOBBY_CENTER_X + halfWidth, LOBBY_CENTER_Z + halfLength],
    );
    for (const [i, [x, z]] of pillarPositions.entries()) {
      translation(bases, i, x, ground + 0.05, z);
      translation(shafts, i, x, ground + 1.1, z);
      translation(capitals, i, x, ground + 2.16, z);
    }
    expect(postIndex).toBe(posts.count);
    expect(railIndex).toBe(railsX.count);
    // Actual end centers lie inside the corner posts; no rail ends retract.
    for (const [mesh, axis, length] of [
      [railsX, "x", cfg.arenaWidth],
      [railsZ, "z", cfg.arenaLength],
    ] as const) {
      mesh.geometry.computeBoundingBox();
      expect(mesh.geometry.boundingBox!.min[axis]).toBe(-length / 2);
      expect(mesh.geometry.boundingBox!.max[axis]).toBe(length / 2);
    }
    // Taper stays above the post and capital supports stay centered on shafts.
    for (const [support, cap, scale] of [
      [posts, caps, 0.82],
      [shafts, capitals, 0.82],
    ] as const) {
      support.getMatrixAt(0, actual);
      cap.getMatrixAt(0, expected);
      support.geometry.computeBoundingBox();
      cap.geometry.computeBoundingBox();
      expect(
        actual.elements[13] + support.geometry.boundingBox!.max.y,
      ).toBeCloseTo(expected.elements[13] + cap.geometry.boundingBox!.min.y, 5);
      const p = cap.geometry.getAttribute("position");
      const low = cap.geometry.boundingBox!.min.y;
      const high = cap.geometry.boundingBox!.max.y;
      let lowerWidth = 0;
      let upperWidth = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) === low)
          lowerWidth = Math.max(lowerWidth, Math.abs(p.getX(i)));
        if (p.getY(i) === high)
          upperWidth = Math.max(upperWidth, Math.abs(p.getX(i)));
      }
      expect(upperWidth / lowerWidth).toBeCloseTo(scale, 6);
      expect(lowerWidth).toBeGreaterThan(support.geometry.boundingBox!.max.x);
    }
  });

  it("shares matte stone and timber owners and disposes each enclosure resource once", () => {
    const { build, system } = construct();
    build.buildFenceInstances();
    build.buildPillarInstances();
    const meshes = build.arenaGroup.children as THREE.InstancedMesh<
      THREE.BufferGeometry,
      MeshStandardNodeMaterial
    >[];
    const stone = meshes[0].material;
    const timber = meshes[2].material;
    expect(timber).not.toBe(stone);
    for (const i of [0, 1, 4, 5, 6]) expect(meshes[i].material).toBe(stone);
    expect(meshes[3].material).toBe(timber);
    expect(stone.color.getHex()).toBe(0xaaa18d);
    expect(timber.color.getHex()).toBe(0x756149);
    expect(stone.roughness).toBe(0.9);
    expect(timber.roughness).toBe(0.86);
    for (const material of [stone, timber]) {
      expect(material.metalness).toBe(0);
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
      expect(material.colorNode).toBeNull();
      expect(material.roughnessNode).toBeNull();
      expect(material.map).toBeNull();
    }
    const resources = [...meshes.map((mesh) => mesh.geometry), stone, timber];
    expect(new Set(resources).size).toBe(9);
    const counts = resources.map(() => 0);
    resources.forEach((resource, i) =>
      resource.addEventListener("dispose", () => counts[i]++),
    );
    system.destroy();
    owned.splice(owned.indexOf(system), 1);
    expect(counts).toEqual(resources.map(() => 1));
  });
});
