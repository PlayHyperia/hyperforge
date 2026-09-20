import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  collectStreamingBankPavilionReadiness,
  collectStreamingBankPavilionsReadiness,
  collectStreamingSceneReadinessEvidence,
} from "../../../../../client/src/lib/streamingSceneDiagnostics";
import {
  getAdmittedCompactBankPavilion,
  getAdmittedCompactBankPavilions,
} from "../../../index.client";
import {
  BANK_PAVILION_POSTS,
  OPEN_WORKSHOP_POSTS,
  createOpenWorkshop,
} from "@hyperforge/procgen/building";
import * as THREE from "../../../extras/three/three";
import { World } from "../../../core/World";
import { DataManager } from "../../../data/DataManager";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import type { CompactServiceCourtsManifest } from "../../../types/world/world-types";
import { loadPhysX } from "../../../physics/PhysXManager";
import { TerrainSystem } from "../../shared/world/TerrainSystem";
import {
  COMPACT_BANK_PAVILION,
  COMPACT_SERVICE_COURT,
  COMPACT_SERVICE_COURT_LEGACY_FIXTURE,
  groundCompactServiceCourt,
  isCompactBankCourt,
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
  delete ALL_WORLD_AREAS.court_visual_test_bindings;
  DataManager["worldConfig"] = saved.config;
  DataManager["worldTerrainProfile"] = saved.profile;
  DataManager["worldContentIdentity"] = saved.identity;
});

async function fixture(
  smithy: boolean,
  bank: boolean,
  startOwner = true,
  withPhysics = true,
  plural = false,
) {
  const config = structuredClone(saved.config!);
  delete config.compactPreparationLodge;
  delete config.compactServiceCourt;
  delete config.compactServicePlanting;
  delete config.compactBankPavilion;
  delete config.compactServiceCourts;
  if (smithy)
    config.compactServiceCourt = structuredClone(COMPACT_SERVICE_COURT);
  if (bank) config.compactBankPavilion = structuredClone(COMPACT_BANK_PAVILION);
  if (plural) {
    const layout: CompactServiceCourtsManifest = {
      schemaVersion: 1,
      layoutId: "compact-service-courts-v1",
      terrainProfileId: "compact-duel-island-v6",
      primaryBankId: "visual_bank_primary",
      courts: [
        ["visual_bank_primary", 350, 320],
        ["visual_bank_east", 370, 320],
        ["visual_bank_south", 370, 340],
        ["visual_smithy", 336.5, 337.5],
      ].map(([id, x, z], i) => ({
        schemaVersion: 2,
        layoutId: String(id),
        terrainProfileId: "compact-duel-island-v6",
        position: { x: Number(x), z: Number(z) },
        rotation: 0,
        recipeId:
          i < 3 ? "open-timber-bank-haven-v2" : "open-timber-smithy-haven-v3",
        stationIds:
          i < 3 ? [`${id}_station`] : [`${id}_anvil`, `${id}_furnace`],
        npcIds: i === 0 ? ["visual_primary_clerk"] : [],
      })),
    };
    expect(ALL_WORLD_AREAS.court_visual_test_bindings).toBeUndefined();
    ALL_WORLD_AREAS.court_visual_test_bindings = {
      id: "court_visual_test_bindings",
      name: "Explicit court visual fixture",
      description:
        "Real station/NPC records without additional terrain modifiers",
      difficultyLevel: 0,
      biomeType: "plains",
      safeZone: true,
      bounds: { minX: 325, maxX: 380, minZ: 310, maxZ: 350 },
      resources: [],
      mobSpawns: [],
      npcs: layout.courts.flatMap((court) =>
        court.npcIds.map((id) => ({
          id,
          type: "bank" as const,
          position: { ...court.position, y: 0 },
        })),
      ),
      stations: layout.courts.flatMap((court) =>
        court.stationIds.map((id, i) => ({
          id,
          type: isCompactBankCourt(court)
            ? ("bank" as const)
            : i === 0
              ? ("anvil" as const)
              : ("furnace" as const),
          position: { ...court.position, y: 0 },
        })),
      ),
    };
    delete config.compactServiceCourt;
    delete config.compactBankPavilion;
    config.compactServiceCourts = layout;
  }
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
  it("qualifies every actual bank with explicit primary ordering and rejects an outlier failure despite a ready primary", async () => {
    const { world, owner, visual } = await fixture(
      false,
      false,
      true,
      true,
      true,
    );
    visual.start();
    // Manifest ordering deliberately differs from primary ordering. Every
    // retained owner still has exactly the same descriptor/position/bindings.
    const config = DataManager.getWorldConfig()!;
    const layout = config.compactServiceCourts!;
    DataManager["worldContentIdentity"] = null;
    DataManager.setWorldConfig({
      ...config,
      compactServiceCourts: {
        ...layout,
        courts: [
          layout.courts[2],
          layout.courts[3],
          layout.courts[0],
          layout.courts[1],
        ],
      },
    });
    const admitted = getAdmittedCompactBankPavilions();
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(admitted.every(Object.isFrozen)).toBe(true);
    expect(admitted.map((d) => d.layoutId)).toEqual([
      "visual_bank_primary",
      "visual_bank_south",
      "visual_bank_east",
    ]);
    const ready = collectStreamingBankPavilionsReadiness(world, admitted);
    expect(ready.ready).toBe(true);
    expect(ready.reasons).toEqual([]);
    expect(ready.pavilions.map((r) => r.descriptor?.layoutId)).toEqual(
      admitted.map((d) => d.layoutId),
    );
    expect(ready.pavilions.every((r) => r.ready && r.physicsRequired)).toBe(
      true,
    );
    const aggregate = () => collectStreamingSceneReadinessEvidence(world, {});
    const complete = aggregate();
    expect(complete.bankPavilionReady).toBe(true);
    expect(complete.bankPavilions).toEqual(ready);
    expect(complete.bankPavilion.descriptor?.layoutId).toBe(
      layout.primaryBankId,
    );
    // This CPU fixture has no rendered arena, stream contestants or graphics.
    // Bank readiness does not manufacture full-stream acceptance.
    expect(complete.ready).toBe(false);

    const outlier = owner["resources"].find(
      (r) => r.record.descriptor.layoutId === "visual_bank_east",
    )!;
    outlier.body!.deactivate();
    expect(
      collectStreamingBankPavilionReadiness(world, admitted[0]).ready,
    ).toBe(true);
    const missingPhysical = collectStreamingBankPavilionsReadiness(
      world,
      admitted,
    );
    expect(missingPhysical.ready).toBe(false);
    expect(
      missingPhysical.pavilions.find(
        (r) => r.descriptor?.layoutId === "visual_bank_east",
      )?.reasons,
    ).toContain("owner_physics_mismatch");
    expect(aggregate().bankPavilionReady).toBe(false);
    outlier.body!.activate(world);
    expect(collectStreamingBankPavilionsReadiness(world, admitted).ready).toBe(
      true,
    );

    const outlierIndex = visual["visuals"].findIndex(
      (r) => r.root.name === "visual_bank_south",
    );
    const removed = visual["visuals"].splice(outlierIndex, 1)[0];
    removed.dispose();
    expect(removed.root.parent).toBeNull();
    expect(
      collectStreamingBankPavilionReadiness(world, admitted[0]).ready,
    ).toBe(true);
    const missingVisual = collectStreamingBankPavilionsReadiness(
      world,
      admitted,
    );
    expect(missingVisual.ready).toBe(false);
    expect(
      missingVisual.pavilions.find(
        (r) => r.descriptor?.layoutId === "visual_bank_south",
      )?.reasons,
    ).toEqual(["visual_count_mismatch"]);
    const incomplete = aggregate();
    expect(incomplete.bankPavilion.ready).toBe(true);
    expect(incomplete.bankPavilionReady).toBe(false);
    expect(incomplete.bankPavilions).toEqual(missingVisual);
    expect(incomplete.ready).toBe(false);
  });

  it("rejects duplicate, sparse and oversized admission arrays without accepting the ready primary alone", async () => {
    const { world, visual } = await fixture(false, false, true, true, true);
    visual.start();
    const admitted = getAdmittedCompactBankPavilions();
    expect(collectStreamingBankPavilionsReadiness(world, admitted).ready).toBe(
      true,
    );
    expect(
      collectStreamingBankPavilionsReadiness(world, [...admitted, admitted[0]]),
    ).toMatchObject({
      ready: false,
      reasons: ["duplicate_bank_identity"],
    });
    const sparse = [...admitted];
    delete sparse[1];
    for (const invalid of [
      sparse,
      Array.from({ length: 9 }, () => admitted[0]),
      null,
    ])
      expect(collectStreamingBankPavilionsReadiness(world, invalid)).toEqual({
        configured: true,
        ready: false,
        pavilions: [],
        reasons: ["descriptors_invalid"],
      });
    expect(
      collectStreamingBankPavilionReadiness(world, admitted[0]).ready,
    ).toBe(true);
  });

  it("renders three banks and one smithy with independent real geometry, cutaway uniforms and disposal", async () => {
    const { world, owner, visual } = await fixture(
      false,
      false,
      true,
      true,
      true,
    );
    visual.start();
    visual.start();
    const records = owner.getCourts();
    const leases = visual["visuals"];
    expect(records).toHaveLength(4);
    expect(visual.getAllDiagnostics().map((row) => row.layoutId)).toEqual(
      records.map((r) => r.descriptor.layoutId),
    );
    expect(visual.getDiagnostics()).toBeNull();
    const geometries = new Set<THREE.BufferGeometry>();
    const materialOwners = new Set<THREE.Material>();
    const disposalCounts: number[] = [];
    for (const [i, record] of records.entries()) {
      const lease = leases[i];
      const bank = isCompactBankCourt(record.descriptor);
      expect(lease.root.name).toBe(record.descriptor.layoutId);
      expect(lease.root.position.toArray()).toEqual([
        record.position.x,
        record.position.y,
        record.position.z,
      ]);
      expect(lease.root.parent).toBe(world.stage.scene);
      expect(lease.root.children).toHaveLength(3);
      expect(lease.triangles).toBe(bank ? 1492 : 1300);
      expect(lease.geometryBytes).toBe(bank ? 247200 : 216576);
      for (const child of lease.root.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
        expect(geometries.has(mesh.geometry)).toBe(false);
        expect(materialOwners.has(mesh.material)).toBe(false);
        geometries.add(mesh.geometry);
        materialOwners.add(mesh.material);
        const g = disposalCounts.push(0) - 1,
          m = disposalCounts.push(0) - 1;
        mesh.geometry.addEventListener("dispose", () => disposalCounts[g]++);
        mesh.material.addEventListener("dispose", () => disposalCounts[m]++);
        const bounds = mesh.geometry.boundingBox!;
        expect(
          Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        ).toBeLessThan(bank ? 5 : 6);
        expect(
          Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)),
        ).toBeLessThan(bank ? 5 : 4);
      }
    }
    expect(geometries.size).toBe(12);
    expect(materialOwners.size).toBe(12);
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 1000);
    const first = records[0].position;
    camera.position.set(first.x, first.y + 1.7, first.z);
    camera.lookAt(first.x, first.y + 1.7, first.z + 10);
    camera.updateMatrixWorld(true);
    for (let frame = 0; frame <= 40; frame++)
      for (const lease of leases) lease.cutaway.update(camera, frame * 16);
    expect(leases.map((lease) => lease.cutaway.desired)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(leases[0].cutaway.value).toBe(1);
    expect(leases.slice(1).map((lease) => lease.cutaway.value)).toEqual([
      0, 0, 0,
    ]);
    expect(
      new Set(
        leases.map(
          (lease) =>
            (
              lease.root.children[1] as THREE.Mesh<
                THREE.BufferGeometry,
                THREE.MeshStandardNodeMaterial
              >
            ).material.maskNode,
        ),
      ).size,
    ).toBe(4);
    visual.destroy();
    visual.destroy();
    expect(disposalCounts).toEqual(Array(24).fill(1));
    expect(leases.every((lease) => lease.root.parent === null)).toBe(true);
    expect(owner.getAllDiagnostics().map((row) => row.physicsShapes)).toEqual([
      3, 3, 3, 3,
    ]);
  });

  it("rechecks real plural station ownership before rendering and rolls back a later scene attachment", async () => {
    const { world, owner, visual } = await fixture(
      false,
      false,
      true,
      true,
      true,
    );
    const area = ALL_WORLD_AREAS.court_visual_test_bindings;
    const stations = area.stations!;
    const before = world.stage.scene.children.slice();
    area.stations = stations.slice(1);
    try {
      expect(() => visual.start()).toThrow(/station binding/);
      expect(visual.getAllDiagnostics()).toEqual([]);
      expect(world.stage.scene.children).toEqual(before);
    } finally {
      area.stations = stations;
    }
    const counts: number[] = [];
    const rejectThird = (event: THREE.Object3DEventMap["childadded"]) => {
      if (!event.child.name.startsWith("visual_")) return;
      for (const child of event.child.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
        const g = counts.push(0) - 1,
          m = counts.push(0) - 1;
        mesh.geometry.addEventListener("dispose", () => counts[g]++);
        mesh.material.addEventListener("dispose", () => counts[m]++);
      }
      if (event.child.name === "visual_bank_south")
        throw new Error("Rejected third actual court attachment");
    };
    world.stage.scene.addEventListener("childadded", rejectThird);
    try {
      expect(() => visual.start()).toThrow(/third actual court/);
    } finally {
      world.stage.scene.removeEventListener("childadded", rejectThird);
    }
    expect(counts).toEqual(Array(18).fill(1));
    expect(world.stage.scene.children).toEqual(before);
    expect(visual.getAllDiagnostics()).toEqual([]);
    expect(visual.isStarted()).toBe(false);
    expect(owner.getCourts()).toHaveLength(4);
    visual.start();
    expect(visual.getAllDiagnostics()).toHaveLength(4);
  });

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
