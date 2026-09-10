import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import {
  DUEL_ARENA_FLOOR_CENTER_OFFSET,
  DUEL_ARENA_FLOOR_THICKNESS,
  getDuelArenaGradeHeight,
} from "../../../data/arena-grading";
import {
  HOSPITAL_CENTER_X,
  HOSPITAL_CENTER_Z,
  HOSPITAL_LENGTH,
  HOSPITAL_WIDTH,
} from "../../../data/arena-layout";
import {
  getDuelArenaConfig,
  type DuelArenaConfig,
} from "../../../data/duel-manifest";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import {
  createDuelFloorMaterial,
  DuelArenaVisualsSystem,
} from "../DuelArenaVisualsSystem";

type ConstructionAccess = {
  arenaCfg: DuelArenaConfig;
  arenaGroup: THREE.Group;
  arenaFloorMat: MeshStandardNodeMaterial;
  createSharedMaterials(): void;
  createArenaFloors(): void;
  createHospitalFloor(): void;
  createLobbyFloor(): void;
};

function expectFloorDepth(material: MeshStandardNodeMaterial) {
  expect(material.polygonOffset).toBe(true);
  expect(material.polygonOffsetUnits).toBe(-1);
  expect(material.polygonOffsetFactor).toBe(0);
  expect(material.depthTest).toBe(true);
  expect(material.depthWrite).toBe(true);
  expect(material.depthFunc).toBe(THREE.LessEqualDepth);
  expect(material.transparent).toBe(false);
  expect(material.depthNode).toBeNull();
  expect(material.positionNode).toBeNull();
}

describe("actual duel floor material depth bias", () => {
  it("biases only actual arena/hospital floor owners without moving surfaces or changing shadow policy", () => {
    const world = new World();
    const system = new DuelArenaVisualsSystem(world);
    const build = system as unknown as ConstructionAccess;
    const hospitalGeometry = new THREE.BoxGeometry(
      HOSPITAL_WIDTH,
      DUEL_ARENA_FLOOR_THICKNESS,
      HOSPITAL_LENGTH,
    );
    try {
      build.arenaCfg = getDuelArenaConfig();
      build.arenaGroup = new THREE.Group();
      world.stage.scene.add(build.arenaGroup);
      build.createSharedMaterials();
      build.createArenaFloors();
      build.createHospitalFloor();
      const floors = build.arenaGroup.children.filter(
        (mesh): mesh is THREE.Mesh =>
          mesh instanceof THREE.Mesh &&
          (mesh.name.startsWith("ArenaFloor_") ||
            mesh.name === "HospitalFloor"),
      );
      expect(floors).toHaveLength(build.arenaCfg.arenaCount + 1);
      for (const floor of floors) {
        expectFloorDepth(floor.material as MeshStandardNodeMaterial);
        expect(floor.position.y).toBe(
          getDuelArenaGradeHeight() + DUEL_ARENA_FLOOR_CENTER_OFFSET,
        );
        expect(floor.quaternion.toArray()).toEqual([0, 0, 0, 1]);
        expect(floor.scale.toArray()).toEqual([1, 1, 1]);
        expect(floor.renderOrder).toBe(0);
        expect(floor.castShadow).toBe(false);
        expect(floor.receiveShadow).toBe(floor.name.startsWith("ArenaFloor_"));
        if (floor.name.startsWith("ArenaFloor_")) {
          expect(floor.material).toBe(build.arenaFloorMat);
        } else {
          expect(floor.position.x).toBe(HOSPITAL_CENTER_X);
          expect(floor.position.z).toBe(HOSPITAL_CENTER_Z);
          expect(floor.geometry.index!.array).toEqual(
            hospitalGeometry.index!.array,
          );
          for (const key of ["position", "normal", "uv"])
            expect(floor.geometry.attributes[key].array).toEqual(
              hospitalGeometry.attributes[key].array,
            );
        }
      }
      // The red cross is nearer geometry, not another biased floor surface.
      const nonFloors = build.arenaGroup.children.filter(
        (mesh): mesh is THREE.Mesh =>
          mesh instanceof THREE.Mesh && !floors.includes(mesh),
      );
      expect(nonFloors).toHaveLength(2);
      for (const mesh of nonFloors)
        expect((mesh.material as THREE.Material).polygonOffset).toBe(false);
    } finally {
      hospitalGeometry.dispose();
      system.destroy();
      world.destroy();
    }
  });

  it("uses the same actual factory for textured lobby floors without altering texture/material response", () => {
    const texture = new THREE.DataTexture(
      new Uint8Array([180, 150, 100, 255]),
      1,
      1,
    );
    const floor = createDuelFloorMaterial({ color: 0xa08060, map: texture });
    const ordinary = new MeshStandardNodeMaterial({
      color: 0xa08060,
      map: texture,
    });
    try {
      expectFloorDepth(floor);
      expect(floor.map).toBe(texture);
      expect(floor.color).toEqual(ordinary.color);
      expect(floor.roughness).toBe(ordinary.roughness);
      expect(floor.metalness).toBe(ordinary.metalness);
      expect(floor.side).toBe(ordinary.side);
      expect(floor.opacity).toBe(ordinary.opacity);
      expect(ordinary.polygonOffset).toBe(false);
      // CPU scope: verify the real canvas-backed lobby constructor delegates to
      // this tested material factory. Actual canvas/mesh/GPU output is the live
      // paired spatial probe, not a mocked DOM or renderer in this test.
      const lobbyConstructor = (
        DuelArenaVisualsSystem.prototype as unknown as ConstructionAccess
      ).createLobbyFloor.toString();
      expect(lobbyConstructor).toContain("createDuelFloorMaterial({");
      expect(lobbyConstructor).toContain("map: tileTexture");
    } finally {
      floor.dispose();
      ordinary.dispose();
      texture.dispose();
    }
  });

  it("reproduces the retained distant-camera precision tie and resolves it with one fixed depth unit", () => {
    // Exact probe10 camera/height receipt. This is real Three projection plus
    // nominal 24-bit/Float32 quantization, not GPU depth readback or a guarantee
    // for every device/camera. The paired WebGPU capture is still required.
    const poses = [
      {
        kind: "wide",
        position: [350, 335.0693015230977, 433],
        quaternion: [-0.6680262558537308, 0, 0, 0.744137703311723],
        fov: 62,
      },
      {
        kind: "near",
        position: [427.5, 101.41930152309769, 407],
        quaternion: [
          -0.318374804085661, 0.3592430251442899, 0.13187516177015784,
          0.8672893834912836,
        ],
        fov: 52,
      },
    ];
    const floorY = 28.839301523097685;
    const unit = 2 ** -24;
    const material = createDuelFloorMaterial();
    try {
      for (const pose of poses) {
        const camera = new THREE.PerspectiveCamera(
          pose.fov,
          1280 / 720,
          0.2,
          10000,
        );
        camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
        camera.position.fromArray(pose.position);
        camera.quaternion.fromArray(pose.quaternion);
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        let samples = 0;
        let unBiasedTies = 0;
        for (let x = 331; x <= 359; x += 0.5) {
          for (let z = 364.5; z <= 387.5; z += 0.5) {
            const floor = new THREE.Vector3(x, floorY, z).project(camera).z;
            const terrain = new THREE.Vector3(x, floorY - 0.02, z).project(
              camera,
            ).z;
            expect(floor).toBeLessThan(terrain);
            if (Math.fround(floor) === Math.fround(terrain)) unBiasedTies++;
            expect(
              Math.fround(floor + material.polygonOffsetUnits * unit),
            ).toBeLessThan(Math.fround(terrain));
            samples++;
          }
        }
        expect(samples).toBe(2679);
        if (pose.kind === "wide") expect(unBiasedTies).toBe(798);
        else expect(unBiasedTies).toBe(0);
      }
    } finally {
      material.dispose();
    }
  });
});
