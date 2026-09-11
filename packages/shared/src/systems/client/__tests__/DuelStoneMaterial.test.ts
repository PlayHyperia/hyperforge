import { describe, expect, it } from "vitest";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { World } from "../../../core/World";
import { getDuelArenaConfig } from "../../../data/duel-manifest";
import { getDuelArenaGradeHeight } from "../../../data/arena-grading";
import { DuelArenaVisualsSystem } from "../DuelArenaVisualsSystem";
import {
  applyDuelStoneSurface,
  DUEL_STONE_SURFACE,
} from "../DuelStoneMaterial";

type Construction = {
  arenaCfg: ReturnType<typeof getDuelArenaConfig>;
  arenaGroup: THREE.Group;
  arenaFloorMat: MeshStandardNodeMaterial;
  createSharedMaterials(): void;
  createArenaFloors(): void;
  createLobbyFloor(): void;
  createHospitalFloor(): void;
};

describe("actual shared campus stone owners", () => {
  it("creates all three real floor meshes with one material and unchanged support geometry", () => {
    const world = new World();
    const system = new DuelArenaVisualsSystem(world);
    const build = system as unknown as Construction;
    try {
      build.arenaCfg = getDuelArenaConfig();
      build.arenaGroup = new THREE.Group();
      world.stage.scene.add(build.arenaGroup);
      build.createSharedMaterials();
      build.createArenaFloors();
      build.createLobbyFloor();
      build.createHospitalFloor();
      const floors = build.arenaGroup.children.filter(
        (node): node is THREE.Mesh =>
          node instanceof THREE.Mesh &&
          /^(ArenaFloor_|LobbyFloor$|HospitalFloor$)/.test(node.name),
      );
      expect(floors).toHaveLength(3);
      for (const floor of floors) {
        expect(floor.material).toBe(build.arenaFloorMat);
        expect(floor.receiveShadow).toBe(true);
        expect(floor.position.y).toBe(getDuelArenaGradeHeight() + 0.27);
        floor.geometry.computeBoundingBox();
        expect(floor.geometry.boundingBox!.max.y).toBeCloseTo(0.15, 7);
        expect(floor.scale.toArray()).toEqual([1, 1, 1]);
        expect(floor.geometry.getAttribute("position").count).toBe(24);
      }
      const material = build.arenaFloorMat;
      expect(material.userData.duelStoneSurface).toEqual(DUEL_STONE_SURFACE);
      expect(material.map).toBeNull();
      expect(material.normalMap).toBeNull();
      expect(material.positionNode).toBeNull();
      expect(material.depthNode).toBeNull();
      expect(material.colorNode).not.toBeNull();
      expect(material.roughnessNode).not.toBeNull();
      expect(material.normalNode).not.toBeNull();
      expect(material.polygonOffsetUnits).toBe(-1);
      let disposals = 0;
      material.addEventListener("dispose", () => disposals++);
      system.destroy();
      expect(disposals).toBe(1);
    } finally {
      system.destroy();
      world.destroy();
    }
  });

  it("changes only surface response, never displacement, opacity, or render ordering", () => {
    const material = new MeshStandardNodeMaterial();
    const snapshot = [
      material.side,
      material.opacity,
      material.transparent,
      material.depthWrite,
      material.depthTest,
    ];
    try {
      expect(applyDuelStoneSurface(material)).toBe(material);
      expect([
        material.side,
        material.opacity,
        material.transparent,
        material.depthWrite,
        material.depthTest,
      ]).toEqual(snapshot);
      expect(material.metalness).toBe(0);
      expect(material.positionNode).toBeNull();
      expect(DUEL_STONE_SURFACE.textureCount).toBe(0);
      expect(DUEL_STONE_SURFACE.reliefMeters).toBeLessThan(0.01);
      expect(DUEL_STONE_SURFACE.detailFadeEnd).toBeGreaterThan(
        DUEL_STONE_SURFACE.detailFadeStart,
      );
    } finally {
      material.dispose();
    }
  });
});
