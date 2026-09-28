import { afterEach, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import {
  getDuelArenaGradeHeight,
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
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
// textures; this fixture initializes only the actual floor-builder prerequisites.
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
});
