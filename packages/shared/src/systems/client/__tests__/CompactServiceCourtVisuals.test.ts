import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { collectStreamingBankPavilionReadiness } from "../../../../../client/src/lib/streamingSceneDiagnostics";
import { getAdmittedCompactBankPavilion } from "../../../index.client";
import {
  BANK_PAVILION_POSTS,
  OPEN_WORKSHOP_POSTS,
  createOpenWorkshop,
} from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { loadPhysX } from "../../../physics/PhysXManager";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import {
  COMPACT_BANK_PAVILION,
  COMPACT_SERVICE_COURT,
  COMPACT_SERVICE_COURT_LEGACY_FIXTURE,
  groundCompactServiceCourt,
} from "../../shared/world/CompactServiceCourt";
import {
  COMPACT_SERVICE_COURT_SYSTEM,
  CompactServiceCourtSystem,
} from "../../shared/world/CompactServiceCourtSystem";
import {
  COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
  CompactServiceCourtVisualsSystem,
  createCompactServiceCourtVisual,
  registerCompactServiceCourtVisuals,
} from "../CompactServiceCourtVisualsSystem";

const saved = {
  config: DataManager["worldConfig"],
  profile: DataManager["worldTerrainProfile"],
  identity: DataManager["worldContentIdentity"],
};
const worlds: World[] = [];
const cleanup: Array<() => void> = [];
beforeAll(async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await loadPhysX();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  for (const world of worlds.splice(0)) world.destroy();
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
});

async function fixture(
  smithy: boolean,
  bank: boolean,
  startOwner = true,
  withPhysics = true,
) {
  const config = structuredClone(saved.config!);
  delete config.compactPreparationLodge;
  delete config.compactServiceCourt;
  delete config.compactServicePlanting;
  delete config.compactBankPavilion;
  if (smithy)
    config.compactServiceCourt = structuredClone(COMPACT_SERVICE_COURT);
  if (bank) config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
  DataManager["worldContentIdentity"] = null;
  DataManager.setWorldConfig(config);
  const world = new World();
  worlds.push(world);
  if (withPhysics) await world.physics.init();
  else {
    // Mirrors the production streaming viewport's removal of the constructor's
    // default Physics system before lifecycle initialization.
    const physics = world.systemsByName.get("physics");
    world.systems = world.systems.filter((system) => system !== physics);
    world.systemsByName.delete("physics");
    delete (world as unknown as Record<string, unknown>).physics;
  }
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  const ground = terrain as unknown as {
    loadWaterBodiesFromManifest(): void;
    loadFlatZonesFromManifest(): void;
  };
  ground.loadWaterBodiesFromManifest();
  ground.loadFlatZonesFromManifest();
  registerCompactServiceCourtVisuals(world);
  const owner = world.getSystem<CompactServiceCourtSystem>(
    COMPACT_SERVICE_COURT_SYSTEM,
  )!;
  const visual = world.getSystem<CompactServiceCourtVisualsSystem>(
    COMPACT_SERVICE_COURT_VISUAL_SYSTEM,
  )!;
  if (startOwner) {
    await owner.init();
    await owner.start();
  }
  await visual.init({});
  return { world, owner, visual };
}

describe("compact service court client geometry and lifecycle (not rendered acceptance)", () => {
  it("does not require pavilion systems for a historical manifest without the descriptor", () => {
    const world = new World();
    worlds.push(world);
    expect(getAdmittedCompactBankPavilion()).toBeNull();
    expect(collectStreamingBankPavilionReadiness(world, undefined)).toEqual({
      configured: false,
      ready: true,
      physicsRequired: false,
      descriptor: null,
      owner: null,
      visual: null,
      reasons: [],
    });
    expect(collectStreamingBankPavilionReadiness(world, null)).toMatchObject({
      configured: true,
      ready: false,
      reasons: [
        "descriptor_invalid",
        "owner_count_mismatch",
        "visual_count_mismatch",
      ],
    });
  });

  it.each([true, false])(
    "qualifies the real bank owner and visual diagnostics, physics=%s",
    async (withPhysics) => {
      const { world, owner, visual } = await fixture(
        false,
        true,
        true,
        withPhysics,
      );
      visual.start();
      expect(owner.getDiagnostics()).toBeNull();
      expect(visual.getDiagnostics()).toBeNull();

      const admitted = getAdmittedCompactBankPavilion();
      expect(admitted).toEqual(COMPACT_BANK_PAVILION);
      expect(Object.isFrozen(admitted)).toBe(true);
      expect(Object.isFrozen(admitted!.position)).toBe(true);
      const readiness = collectStreamingBankPavilionReadiness(world, admitted);
      expect(readiness.ready).toBe(true);
      expect(readiness.reasons).toEqual([]);
      expect(readiness).toMatchObject({
        configured: true,
        physicsRequired: withPhysics,
        descriptor: COMPACT_BANK_PAVILION,
        owner: {
          layoutId: COMPACT_BANK_PAVILION.layoutId,
          blockingTiles: [
            { x: 346, z: 316 },
            { x: 353, z: 316 },
            { x: 346, z: 323 },
            { x: 353, z: 323 },
          ],
          position: { x: 350, z: 320 },
          physicsActor: withPhysics,
          physicsShapes: withPhysics ? 3 : 0,
        },
        visual: {
          layoutId: COMPACT_BANK_PAVILION.layoutId,
          meshes: 3,
          materials: 3,
          triangles: 1492,
          geometryBytes: 247200,
        },
      });

      visual.destroy();
      expect(
        collectStreamingBankPavilionReadiness(world, admitted),
      ).toMatchObject({
        ready: false,
        reasons: ["visual_count_mismatch"],
      });
    },
  );

  it.each([
    COMPACT_SERVICE_COURT_LEGACY_FIXTURE,
    COMPACT_SERVICE_COURT,
    COMPACT_BANK_PAVILION,
  ])(
    "keeps $recipeId geometry and private three-batch material ownership",
    (descriptor) => {
      const bank = descriptor.layoutId === "compact-bank-pavilion-v1";
      const record = groundCompactServiceCourt(
        descriptor,
        bank ? BANK_PAVILION_POSTS : OPEN_WORKSHOP_POSTS,
        () => 28,
      );
      const visual = createCompactServiceCourtVisual(record);
      const reference = createOpenWorkshop(record.feet, {
        ...(bank ? { recipe: "bank-pavilion-v1" as const } : {}),
        architecturalFinish:
          descriptor.recipeId === "open-timber-smithy-v2"
            ? undefined
            : "haven-v1",
      });
      cleanup.push(visual.dispose, reference.dispose);
      expect(visual.root.position.toArray()).toEqual([
        record.position.x,
        record.position.y,
        record.position.z,
      ]);
      expect(visual.root.name).toBe(descriptor.layoutId);
      expect(visual.materialCount).toBe(3);
      expect(visual.triangles).toBeLessThanOrEqual(1500);
      const disposals: number[] = [];
      for (const [i, role] of (
        ["timber", "roof", "footings"] as const
      ).entries()) {
        const mesh = visual.root.children[i] as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.MeshStandardNodeMaterial
        >;
        expect(mesh.name).toBe(
          `${bank ? "compact-bank" : "compact-smithy"}-${role}`,
        );
        expect(mesh.castShadow).toBe(true);
        expect(mesh.receiveShadow).toBe(true);
        expect(mesh.layers.mask).toBe(2);
        expect(mesh.geometry).not.toBe(reference[role]);
        expect(Object.keys(mesh.geometry.attributes)).toEqual(
          Object.keys(reference[role].attributes),
        );
        for (const name of Object.keys(mesh.geometry.attributes))
          expect(mesh.geometry.getAttribute(name).array).toEqual(
            reference[role].getAttribute(name).array,
          );
        expect(mesh.geometry.index?.array ?? null).toEqual(
          reference[role].index?.array ?? null,
        );
        expect(mesh.material.transparent).toBe(false);
        expect(mesh.material.vertexColors).toBe(false);
        if (role !== "footings") {
          expect(mesh.material.maskNode).not.toBeNull();
          expect(mesh.material.maskShadowNode).not.toBeNull();
        }
        const g = disposals.push(0) - 1,
          m = disposals.push(0) - 1;
        mesh.geometry.addEventListener("dispose", () => disposals[g]++);
        mesh.material.addEventListener("dispose", () => disposals[m]++);
      }
      visual.dispose();
      visual.dispose();
      expect(disposals).toEqual([1, 1, 1, 1, 1, 1]);
    },
  );

  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])(
    "renders every real admitted owner, smithy=%s bank=%s, without duplicate starts",
    async (smithy, bank) => {
      const { world, owner, visual } = await fixture(smithy, bank);
      visual.start();
      visual.start();
      const expected = [
        smithy ? COMPACT_SERVICE_COURT.layoutId : null,
        bank ? COMPACT_BANK_PAVILION.layoutId : null,
      ].filter(Boolean);
      expect(visual.getAllDiagnostics().map((r) => r.layoutId)).toEqual(
        expected,
      );
      expect(owner.getCourts().map((r) => r.descriptor.layoutId)).toEqual(
        expected,
      );
      expect(visual.getDiagnostics()?.layoutId ?? null).toBe(
        smithy ? COMPACT_SERVICE_COURT.layoutId : null,
      );
      for (const row of visual.getAllDiagnostics()) {
        expect(row.meshes).toBe(3);
        expect(row.materials).toBe(3);
        expect(
          world.stage.scene.children.filter(
            (root) => root.name === row.layoutId,
          ),
        ).toHaveLength(1);
      }
      expect(Object.isFrozen(visual.getAllDiagnostics())).toBe(true);
      visual.destroy();
      visual.destroy();
      expect(visual.getAllDiagnostics()).toEqual([]);
      expect(visual.getDiagnostics()).toBeNull();
      expect(
        world.stage.scene.children.some((root) =>
          expected.some((layoutId) => root.name === layoutId),
        ),
      ).toBe(false);
      // Releasing client geometry never releases the authoritative physics/footprints.
      expect(owner.getCourts()).toHaveLength(expected.length);
      expect(
        owner
          .getAllDiagnostics()
          .every((r) => r.physicsActor && r.physicsShapes === 3),
      ).toBe(true);
    },
  );

  it("rejects missing admitted owners before attaching any render geometry", async () => {
    const { world, visual } = await fixture(true, true, false);
    const before = world.stage.scene.children.slice();
    expect(
      collectStreamingBankPavilionReadiness(
        world,
        getAdmittedCompactBankPavilion(),
      ),
    ).toMatchObject({
      ready: false,
      reasons: ["owner_count_mismatch", "visual_count_mismatch"],
    });
    expect(() => visual.start()).toThrow(/every admitted collision owner/);
    expect(visual.getAllDiagnostics()).toEqual([]);
    expect(world.stage.scene.children).toEqual(before);
    expect(visual.isStarted()).toBe(false);
  });

  it("rolls back both private render leases if attaching the second real court fails", async () => {
    const { world, owner, visual } = await fixture(true, true);
    const before = world.stage.scene.children.slice();
    const disposals: number[] = [];
    const rejectBank = (event: THREE.Object3DEventMap["childadded"]) => {
      const root = event.child;
      if (!root.name.startsWith("compact-")) return;
      for (const child of root.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
        const g = disposals.push(0) - 1,
          m = disposals.push(0) - 1;
        mesh.geometry.addEventListener("dispose", () => disposals[g]++);
        mesh.material.addEventListener("dispose", () => disposals[m]++);
      }
      if (root.name === COMPACT_BANK_PAVILION.layoutId)
        throw new Error("Rejected actual bank scene attachment");
    };
    world.stage.scene.addEventListener("childadded", rejectBank);
    try {
      expect(() => visual.start()).toThrow(/actual bank scene attachment/);
    } finally {
      world.stage.scene.removeEventListener("childadded", rejectBank);
    }
    expect(disposals).toEqual(Array.from({ length: 12 }, () => 1));
    expect(world.stage.scene.children).toEqual(before);
    expect(visual.getAllDiagnostics()).toEqual([]);
    expect(visual.isStarted()).toBe(false);
    expect(owner.getCourts()).toHaveLength(2);
    visual.start();
    expect(visual.getAllDiagnostics()).toHaveLength(2);
  });
});
