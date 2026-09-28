import { describe, expect, it } from "vitest";
import THREE, { MeshStandardNodeMaterial } from "../../../extras/three/three";
import { World } from "../../../core/World";
import { getDuelArenaConfig } from "../../../data/duel-manifest";
import { getDuelArenaGradeHeight } from "../../../data/arena-grading";
import { DuelArenaVisualsSystem } from "../DuelArenaVisualsSystem";
import {
  applyDuelStoneSurface,
  createDuelStoneLayout,
  DUEL_STONE_SURFACE,
} from "../DuelStoneMaterial";

type Construction = {
  arenaCfg: ReturnType<typeof getDuelArenaConfig>;
  arenaGroup: THREE.Group;
  arenaFloorMat: MeshStandardNodeMaterial;
  createSharedMaterials(): void;
  createArenaFloors(): void;
  createLobbyFloor(): void;
};

const numericLayoutOperations = {
  add: (a: number, b: number) => a + b,
  sub: (a: number, b: number) => a - b,
  mul: (a: number, b: number) => a * b,
  div: (a: number, b: number) => a / b,
  floor: Math.floor,
  fract: (a: number) => a - Math.floor(a),
  min: Math.min,
};

describe("world-space stone layout arithmetic (not GPU or visual proof)", () => {
  const c = DUEL_STONE_SURFACE;
  const sample = (x: number, z: number, grain = 0) =>
    createDuelStoneLayout(numericLayoutOperations, x, z, grain);

  it("uses human-scale, bounded varied courses at positive and negative world positions", () => {
    const widths = new Set<number>();
    for (let row = -20; row <= 20; row++) {
      const z = (row + 0.5) * c.blockLength;
      const result = sample(0, z);
      expect(result).toEqual(sample(0, z));
      expect(result.row).toBe(row);
      expect(result.width).toBeGreaterThanOrEqual(0.558 - 1e-12);
      expect(result.width).toBeLessThanOrEqual(0.682 + 1e-12);
      expect(result.offset).toBeGreaterThanOrEqual(-0.1);
      expect(result.offset).toBeLessThan(0.6);
      widths.add(result.width);
      const center = sample((3.5 - result.offset) * result.width, z);
      expect(center.column).toBe(3);
      expect(center.edge).toBeCloseTo(c.blockLength / 2, 10);
    }
    expect(widths.size).toBeGreaterThan(35);
    expect(c.blockWidth).toBe(0.62);
    expect(c.blockLength).toBe(0.38);
    expect(c.jointWidth * 2).toBe(0.01);
    expect(c.reliefMeters).toBe(0.0035);
    expect(c.jointWidth + c.bevelWidth + c.grainWarpMeters / 2).toBeLessThan(
      c.blockLength / 10,
    );
  });

  it("shares every vertical seam across neighbors without per-stone offsets or gaps", () => {
    const epsilon = 1e-7;
    for (const row of [-17, -1, 0, 1, 19]) {
      for (const grain of [-0.5, 0, 0.5]) {
        const warp = grain * c.grainWarpMeters;
        const z = (row + 0.5) * c.blockLength - warp * 0.5;
        const course = sample(0, z, grain);
        for (let column = -3; column <= 3; column++) {
          const seam = (column - course.offset) * course.width - warp;
          const left = sample(seam - epsilon, z, grain);
          const right = sample(seam + epsilon, z, grain);
          expect(left.column).toBe(column - 1);
          expect(right.column).toBe(column);
          expect(left.row).toBe(row);
          expect(right.row).toBe(row);
          expect(left.edge).toBeCloseTo(epsilon, 10);
          expect(right.edge).toBeCloseTo(epsilon, 10);
          expect(sample(seam, z, grain).edge).toBeCloseTo(0, 10);
        }
      }
    }
  });

  it("joins differently sized courses on the same continuous horizontal boundary", () => {
    const epsilon = 1e-7;
    for (const row of [-12, -1, 0, 1, 12]) {
      for (const grain of [-0.5, 0.17, 0.5]) {
        const seam = row * c.blockLength - grain * c.grainWarpMeters * 0.5;
        for (const x of [-13.2, -0.03, 0, 0.83, 14.7]) {
          const below = sample(x, seam - epsilon, grain);
          const above = sample(x, seam + epsilon, grain);
          expect(below.row).toBe(row - 1);
          expect(above.row).toBe(row);
          expect(below.edge).toBeGreaterThanOrEqual(0);
          expect(above.edge).toBeGreaterThanOrEqual(0);
          expect(below.edge).toBeLessThan(epsilon * 1.01);
          expect(above.edge).toBeLessThan(epsilon * 1.01);
          expect(sample(x, seam, grain).edge).toBeCloseTo(0, 10);
        }
      }
    }
  });
});

describe("actual shared campus stone owners", () => {
  it("creates only arena and lobby floors with one material and unchanged support geometry", () => {
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
      const floors = build.arenaGroup.children.filter(
        (node): node is THREE.Mesh =>
          node instanceof THREE.Mesh &&
          /^(ArenaFloor_|LobbyFloor$)/.test(node.name),
      );
      expect(floors.map((floor) => floor.name)).toEqual([
        "ArenaFloor_1",
        "LobbyFloor",
      ]);
      for (const name of [
        "HospitalFloor",
        "RecoveryInlayRing",
        "RecoveryInlayDiamond",
      ])
        expect(build.arenaGroup.getObjectByName(name)).toBeUndefined();
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
