import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import northernHabitat from "../../../../data/compact-pond-northern-habitat-v1.json";
import inlandHabitat from "../../../../data/compact-pond-inland-habitat-v1.json";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { getDuelArenaConfig } from "../../../../data/duel-manifest";
import { GATHERING_CONSTANTS } from "../../../../constants/GatheringConstants";
import { ResourceEntity } from "../../../../entities/world/ResourceEntity";
import { createResourceID } from "../../../../utils/IdentifierUtils";
import { EntityManager } from "../../entities/EntityManager";
import { ResourceSystem } from "../../entities/ResourceSystem";
import { CollisionFlag } from "../../movement/CollisionFlags";
import { worldToTile } from "../../movement/TileSystem";
import type { FlatZone } from "../../../../types/world/terrain";
import type { CompactPondDocksManifest } from "../../../../types/world/world-types";
import { getCompactPondDockSupportBounds } from "../DockDefinition";
import { createCompactTerrainColorOperations } from "../CompactTerrainPalette";
import { TerrainSystem } from "../TerrainSystem";
import { resolveRadialPondTerrainHeight } from "../RadialPondTerrainProfile";
import {
  COMPACT_WORLD_TERRAIN_PROFILE,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
  validateWorldTerrainProfile,
} from "../WorldTerrainProfile";
import {
  COMPACT_POND_MODELS,
  COMPACT_POND_ROOT_SUPPORT,
  createCompactPondDressing,
  type CompactPondModel,
  type CompactPondPlacement,
} from "../CompactPondDressing";
import { CompactPondDressingVisuals } from "../CompactPondDressingVisuals";
import { createCompactServicePlanting } from "../CompactServiceCourt";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import {
  compactPathSegmentDistance,
  createCompactIslandPaths,
} from "../CompactIslandPaths";

class PondDressingServerWorld extends World {
  override get isServer(): boolean {
    return true;
  }
}

// Each tuple pins the old and candidate offsets. All remaining recipe fields
// retain the historical hash below; the approved northwest drift is separate.
const pocketMassing: readonly {
  readonly group: "northern-quiet-pocket" | "southeast-sedge-pocket";
  readonly offsets: readonly (readonly [
    previousTangent: number,
    previousBankOffset: number,
    tangent: number,
    bankOffset: number,
  ])[];
}[] = [
  {
    group: "northern-quiet-pocket",
    offsets: [
      [-1.5, 0.9, -1.45, 0.35],
      [0.85, 1.25, 0.35, 0.7],
      [-0.1, 2, -0.35, 1.05],
      [-0.8, 0.18, -1.35, 0.18],
      [0.1, 0.25, -0.25, 0.55],
      [1, 0.15, 0.95, 0.25],
    ],
  },
  {
    group: "southeast-sedge-pocket",
    offsets: [
      [-1.7, 1.8, -1.65, 0.55],
      [1.5, 2, 0.85, 0.9],
      [0.1, 2.8, 0.2, 1.4],
      [-1.25, 0.22, -1.65, 0.18],
      [-0.35, 0.32, -0.6, 0.55],
      [0.6, 0.18, 0.3, 0.95],
      [1.6, 0.42, 1.55, 0.3],
      [-0.6, 2.5, -1, 0.9],
    ],
  },
] as const;

// Separate the larger crown trial from the earlier fourteen offset changes.
// These before values reconstruct the admitted pre-trial recipe, not a newly
// inferred baseline. Only two northern roots move, 0.30 m toward the water.
const pocketCrowns: readonly {
  readonly group: "northern-quiet-pocket" | "southeast-sedge-pocket";
  readonly scales: readonly (readonly [before: number, after: number])[];
}[] = [
  {
    group: "northern-quiet-pocket",
    scales: [
      [0.66, 1.05],
      [0.78, 1.2],
      [0.68, 1.05],
      [0.85, 1.1],
      [0.72, 0.75],
      [0.93, 1.25],
    ],
  },
  {
    group: "southeast-sedge-pocket",
    scales: [
      [0.7, 0.9],
      [0.6, 0.75],
      [0.74, 0.9],
      [0.82, 1.05],
      [1, 1.2],
      [0.71, 0.65],
      [0.87, 0.95],
      [0.65, 0.8],
    ],
  },
] as const;
const waterwardRoots = [
  { index: 3, before: 0.7, after: 0.4 },
  { index: 4, before: 1.05, after: 0.75 },
] as const;

// Historical fixtures remain the original five assets. The additive selected
// habitat is exercised separately; it must not broaden default load ownership.
// Exercise alternate authored recipes through the real factory, restoring the
// imported data even when a historical/negative assertion fails.
function withInlandRecipe<T>(recipe: typeof inlandHabitat, run: () => T): T {
  const saved = structuredClone(inlandHabitat.groups);
  inlandHabitat.groups.splice(
    0,
    inlandHabitat.groups.length,
    ...structuredClone(recipe.groups),
  );
  try {
    return run();
  } finally {
    inlandHabitat.groups.splice(0, inlandHabitat.groups.length, ...saved);
  }
}

const models: CompactPondModel[] = ["boulder", "stone", "fern", "bush", "reed"];
function canonicalGeometry(model: CompactPondModel) {
  const bytes = readFileSync(
    new URL(
      "../../../../../../server/world/assets/vegetation/compact-pond-v1/" +
        COMPACT_POND_MODELS[model].file,
      import.meta.url,
    ),
  );
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString()) as {
    nodes: {
      mesh: number;
      matrix?: number[];
      scale?: number[];
      translation?: number[];
      rotation?: number[];
    }[];
    meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    accessors: {
      bufferView: number;
      byteOffset?: number;
      componentType: number;
      count: number;
      type: string;
    }[];
    bufferViews: { buffer: number; byteOffset?: number; byteStride?: number }[];
  };
  // These exact canonical exports have one identity-transformed mesh. Refuse
  // to treat a future different hierarchy as if raw accessor data were world data.
  expect(gltf.nodes).toHaveLength(1);
  expect(gltf.nodes[0].mesh).toBe(0);
  for (const key of ["matrix", "scale", "translation", "rotation"] as const)
    expect(gltf.nodes[0][key]).toBeUndefined();
  expect(gltf.meshes).toHaveLength(1);
  expect(gltf.meshes[0].primitives).toHaveLength(1);
  const accessor =
      gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION],
    view = gltf.bufferViews[accessor.bufferView];
  expect(accessor.componentType).toBe(5126);
  expect(accessor.type).toBe("VEC3");
  expect(view.buffer).toBe(0);
  const start =
      28 + length + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
    stride = view.byteStride ?? 12;
  const positions = new Float32Array(accessor.count * 3);
  for (let i = 0; i < accessor.count; i++)
    for (let axis = 0; axis < 3; axis++)
      positions[i * 3 + axis] = bytes.readFloatLE(
        start + i * stride + axis * 4,
      );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}
function grid(
  height: number | ((x: number, z: number) => number),
  centerX = 0,
  resolution = 2,
  size = 20,
) {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [],
    indices: number[] = [];
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const px = Math.fround(-size / 2 + (x * size) / (resolution - 1)),
        pz = Math.fround(-size / 2 + (z * size) / (resolution - 1));
      positions.push(
        px,
        typeof height === "number" ? height : height(px + centerX, pz),
        pz,
      );
      if (x < resolution - 1 && z < resolution - 1) {
        const a = z * resolution + x;
        indices.push(
          a,
          a + resolution,
          a + 1,
          a + 1,
          a + resolution,
          a + resolution + 1,
        );
      }
    }
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  return {
    geometry,
    surface: new RetainedTerrainSurface(
      1,
      "fixture",
      centerX,
      0,
      size,
      resolution,
      geometry,
    ),
  };
}
function placements(): readonly CompactPondPlacement[] {
  return models.map((model, i) => ({
    id: model,
    model,
    x: i,
    z: 0,
    scale: 1,
    yaw: Math.PI / 2,
    burial: 0.04,
  }));
}

describe("bounded pond dressing", () => {
  it("admits only the explicit inland habitat, grounds canonical assets and preserves open dock/access arcs", async () => {
    await DataManager.getInstance().initialize();
    const candidate = JSON.parse(
      readFileSync(
        new URL(
          "../__fixtures__/inland-pond-basin-candidate.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      flatZone: FlatZone;
      waterBody: {
        id: string;
        centerX: number;
        centerZ: number;
        radius: number;
        surfaceY: number;
      };
    };
    if (process.env.ASSETS_DIR !== undefined) {
      expect(process.env.ASSETS_DIR.trim().length).toBeGreaterThan(0);
      const selectedAreas = Object.values(
        DataManager.getInstance().getAllWorldAreas(),
      );
      const zones = selectedAreas
        .flatMap((area) => area.flatZones ?? [])
        .filter((zone) => zone.id === "haven_pond_floor");
      const bodies = selectedAreas
        .flatMap((area) => area.waterBodies ?? [])
        .filter((body) => body.id === "haven_pond_water");
      expect(zones).toHaveLength(1);
      expect(bodies).toHaveLength(1);
      const selectedZone = zones[0];
      if (
        typeof selectedZone.height !== "number" ||
        !Number.isFinite(selectedZone.height)
      )
        throw new Error(
          "Selected pond floor requires a finite authored height",
        );
      candidate.flatZone = {
        ...structuredClone(selectedZone),
        height: selectedZone.height,
      };
      candidate.waterBody = structuredClone(bodies[0]);
    }
    const docks: CompactPondDocksManifest = {
      schemaVersion: 1,
      layoutId: "compact-pond-docks-v1",
      terrainProfileId: "compact-duel-island-v6",
      waterBodyId: candidate.waterBody.id,
      docks: [
        {
          id: "haven-fishing-landing",
          x: 390,
          z: 424.5,
          rotation: 90,
          recipeId: "haven-fishing-landing-v1",
        },
        {
          id: "haven-reed-jetty",
          x: 433,
          z: 415.5,
          rotation: 270,
          recipeId: "haven-reed-jetty-v1",
        },
      ],
    };
    const world = new PondDressingServerWorld();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    await terrain.init();
    terrain["loadFlatZonesFromManifest"]();
    terrain.unregisterFlatZone("haven_pond_floor");
    terrain.registerFlatZone(candidate.flatZone);
    const original = DataManager.getInstance().getAllWorldAreas();
    const areas = {
      ...original,
      haven_pond: {
        ...original.haven_pond,
        flatZones: [candidate.flatZone],
        waterBodies: [candidate.waterBody],
      },
    };
    const height = (x: number, z: number) =>
      terrain.getResourceGroundHeight(x, z);
    let owner: CompactPondDressingVisuals | undefined;
    const geometries: THREE.BufferGeometry[] = [];
    const material = new THREE.MeshStandardNodeMaterial();
    try {
      const profile = terrain.getWorldTerrainProfile();
      expect(() => createCompactPondDressing(profile, areas, height)).toThrow(
        "dimensions",
      );
      const rows = createCompactPondDressing(profile, areas, height, docks);
      expect(rows).toHaveLength(34);
      expect(rows.every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(rows)).toBe(true);
      expect(rows).toEqual(
        createCompactPondDressing(profile, areas, height, docks),
      );
      const currentRecipe = structuredClone(inlandHabitat);
      expect(
        currentRecipe.groups.map(({ id, placements }) => [
          id,
          placements.length,
        ]),
      ).toEqual([
        ["northwest-cutbank", 10],
        ["northern-quiet-pocket", 12],
        ["southeast-sedge-pocket", 12],
      ]);
      const northern = currentRecipe.groups[1],
        southeast = currentRecipe.groups[2];
      expect([northern.placements[4][0], southeast.placements[4][0]]).toEqual([
        "fern",
        "fern",
      ]);
      expect(northern.placements.slice(8)).toEqual([
        ["sorrel", -0.95, 0.25, 0.7, 16],
        ["sorrel", 0, 0.3, 0.8, 142],
        ["sorrel", 0.65, 0.42, 0.65, 252],
        ["fern", -0.65, 0.55, 0.65, 341],
      ]);
      expect(southeast.placements.slice(10)).toEqual([
        ["sorrel", -1.35, 0.6, 0.7, 317],
        ["sorrel", 0.65, 0.78, 0.6, 54],
      ]);
      // Explicit native182-era28 fixture. Historical crown/massing proofs
      // remain about that recipe; all current owner/access checks below use34.
      const historicalRecipe = structuredClone(currentRecipe);
      historicalRecipe.groups[1].placements.splice(8);
      historicalRecipe.groups[2].placements.splice(10);
      historicalRecipe.groups[1].placements[4][0] = "bush";
      historicalRecipe.groups[2].placements[4][0] = "bush";
      const historicalRows = withInlandRecipe(historicalRecipe, () =>
        createCompactPondDressing(profile, areas, height, docks),
      );
      expect(historicalRows).toHaveLength(28);
      for (const kind of [
        "empty-group",
        "thirteenth-placement",
        "duplicate-group",
      ] as const) {
        const invalid = structuredClone(currentRecipe);
        if (kind === "empty-group") invalid.groups[1].placements.length = 0;
        else if (kind === "thirteenth-placement")
          invalid.groups[1].placements.push([
            ...invalid.groups[1].placements[11],
          ]);
        else invalid.groups[2].id = invalid.groups[1].id;
        expect(
          () =>
            withInlandRecipe(invalid, () =>
              createCompactPondDressing(profile, areas, height, docks),
            ),
          kind,
        ).toThrow();
      }
      expect(inlandHabitat).toEqual(currentRecipe);
      const { previousCrownRows, changedScales, waterwardMoves, movedPlants } =
        withInlandRecipe(historicalRecipe, () => {
          for (const pocket of pocketCrowns) {
            const group = inlandHabitat.groups.find(
              (entry) => entry.id === pocket.group,
            )!;
            expect(group.placements.slice(2).map((row) => row[3])).toEqual(
              pocket.scales.map(([, after]) => after),
            );
          }
          const northernPocket = inlandHabitat.groups.find(
            (group) => group.id === "northern-quiet-pocket",
          )!;
          for (const shift of waterwardRoots)
            expect(northernPocket.placements[shift.index][2]).toBe(shift.after);
          let previousCrownRows: readonly CompactPondPlacement[];
          try {
            for (const pocket of pocketCrowns) {
              const group = inlandHabitat.groups.find(
                (entry) => entry.id === pocket.group,
              )!;
              pocket.scales.forEach(([before], index) => {
                group.placements[index + 2][3] = before;
              });
            }
            for (const shift of waterwardRoots)
              northernPocket.placements[shift.index][2] = shift.before;
            previousCrownRows = createCompactPondDressing(
              profile,
              areas,
              height,
              docks,
            );
          } finally {
            inlandHabitat.groups.forEach((group, index) =>
              group.placements.forEach((row, placementIndex) => {
                row.splice(
                  0,
                  row.length,
                  ...historicalRecipe.groups[index].placements[placementIndex],
                );
              }),
            );
          }
          expect(inlandHabitat).toEqual(historicalRecipe);
          let changedScales = 0;
          let waterwardMoves = 0;
          historicalRows.forEach((row, index) => {
            const before = previousCrownRows[index];
            const { x, z, scale, ...metadata } = row;
            const {
              x: oldX,
              z: oldZ,
              scale: oldScale,
              ...oldMetadata
            } = before;
            expect(metadata).toEqual(oldMetadata);
            if (scale !== oldScale) changedScales++;
            const moved = waterwardRoots.some(
              (shift) =>
                row.id === `inland_pond_northern-quiet-pocket_${shift.index}`,
            );
            if (moved) {
              waterwardMoves++;
              expect(Math.hypot(x - oldX, z - oldZ)).toBeCloseTo(0.3, 12);
              expect(x).toBeLessThan(oldX);
              expect(z).toBeGreaterThan(oldZ);
              expect(Math.hypot(x - 410, z - 415)).toBeCloseTo(
                Math.hypot(oldX - 410, oldZ - 415) - 0.3,
                12,
              );
            } else expect([x, z]).toEqual([oldX, oldZ]);
            if (
              row.model === "boulder" ||
              row.model === "stone" ||
              row.id.startsWith("inland_pond_northwest-cutbank_")
            )
              expect(row).toEqual(before);
          });
          expect(changedScales).toBe(14);
          expect(waterwardMoves).toBe(2);
          // Reconstruct only the fourteen previous pocket offsets before checking
          // the original recipe pin, separately reversing the new crown scales.
          // No model/yaw/order/rock change is hidden by the historical reconstruction.
          const fixedRecipe = inlandHabitat.groups.map((group) => ({
            id: group.id,
            bearing: group.bearing,
            placements: group.placements.map((row, index) => {
              const beforeScale = pocketCrowns.find(
                (pocket) => pocket.group === group.id,
              )?.scales[index - 2]?.[0];
              const historicalRow = [...row];
              if (beforeScale !== undefined) historicalRow[3] = beforeScale;
              if (group.id === "northwest-cutbank" && index >= 3)
                return [
                  historicalRow[0],
                  null,
                  null,
                  ...historicalRow.slice(3),
                ];
              const offset = pocketMassing.find(
                (pocket) => pocket.group === group.id,
              )?.offsets[index - 2];
              return offset
                ? [
                    historicalRow[0],
                    offset[0],
                    offset[1],
                    ...historicalRow.slice(3),
                  ]
                : historicalRow;
            }),
          }));
          expect(
            createHash("sha256")
              .update(JSON.stringify(fixedRecipe))
              .digest("hex"),
          ).toBe(
            "1ae7f001918b560a0751905b4ab49d338c1e27d1a7b9f58044cc59ee935cc68d",
          );
          const northwest = inlandHabitat.groups[0];
          expect(northwest.id).toBe("northwest-cutbank");
          expect(
            northwest.placements.slice(3).map((row) => row.slice(1, 3)),
          ).toEqual([
            [-2.55, 0.65],
            [-0.9, 0.9],
            [1.8, 0.65],
            [0.35, 1.15],
            [-3.4, 0.2],
            [2.6, 0.2],
            [3.2, 0.85],
          ]);
          expect(
            historicalRows.filter(
              (row) => row.model === "boulder" || row.model === "stone",
            ),
          ).toHaveLength(7);
          expect(new Set(historicalRows.map((row) => row.model)).size).toBe(6);
          for (const pocket of pocketMassing) {
            const group = inlandHabitat.groups.find(
              (entry) => entry.id === pocket.group,
            )!;
            expect(
              group.placements.slice(2).map((row) => row.slice(1, 3)),
            ).toEqual(
              pocket.offsets.map((offset, index) => [
                offset[2],
                pocket.group === "northern-quiet-pocket"
                  ? (waterwardRoots.find((shift) => shift.index === index + 2)
                      ?.after ?? offset[3])
                  : offset[3],
              ]),
            );
          }
          let previousPocketRows: readonly CompactPondPlacement[];
          try {
            for (const pocket of pocketMassing) {
              const group = inlandHabitat.groups.find(
                (entry) => entry.id === pocket.group,
              )!;
              pocket.offsets.forEach(([tangent, bankOffset], index) => {
                group.placements[index + 2][1] = tangent;
                group.placements[index + 2][2] = bankOffset;
              });
            }
            previousPocketRows = createCompactPondDressing(
              profile,
              areas,
              height,
              docks,
            );
          } finally {
            for (const pocket of pocketMassing) {
              const group = inlandHabitat.groups.find(
                (entry) => entry.id === pocket.group,
              )!;
              const current = historicalRecipe.groups.find(
                (entry) => entry.id === pocket.group,
              )!;
              pocket.offsets.forEach((_, index) => {
                group.placements[index + 2][1] =
                  current.placements[index + 2][1];
                group.placements[index + 2][2] =
                  current.placements[index + 2][2];
              });
            }
          }
          let movedPlants = 0;
          historicalRows.forEach((row, index) => {
            const before = previousPocketRows[index];
            const moved = pocketMassing.some((pocket) =>
              pocket.offsets.some(
                (_, index) =>
                  row.id === `inland_pond_${pocket.group}_${index + 2}`,
              ),
            );
            if (!moved) expect(row).toEqual(before);
            else {
              movedPlants++;
              const { x, z, ...metadata } = row;
              const { x: oldX, z: oldZ, ...oldMetadata } = before;
              expect(metadata).toEqual(oldMetadata);
              expect(Math.hypot(x - oldX, z - oldZ)).toBeGreaterThan(0.05);
            }
          });
          expect(movedPlants).toBe(14);
          const previousOffsets = [
            [-1.7, 0.75],
            [-0.55, 1.4],
            [0.8, 0.95],
            [0.1, 2.2],
            [-0.9, 0.18],
            [0.65, 0.24],
            [-1, 2.3],
          ];
          const currentOffsets = northwest.placements
            .slice(3)
            .map((row) => [row[1], row[2]]);
          let previousRows: readonly CompactPondPlacement[];
          // Exercise both inputs through the real owner recipe. Restore the actual
          // imported authoring data even on failure; this does not mock grounding.
          try {
            previousOffsets.forEach(([tangent, bankOffset], index) => {
              northwest.placements[index + 3][1] = tangent;
              northwest.placements[index + 3][2] = bankOffset;
            });
            previousRows = createCompactPondDressing(
              profile,
              areas,
              height,
              docks,
            );
          } finally {
            currentOffsets.forEach(([tangent, bankOffset], index) => {
              northwest.placements[index + 3][1] = tangent;
              northwest.placements[index + 3][2] = bankOffset;
            });
          }
          historicalRows.forEach((row, index) => {
            const previous = previousRows[index];
            if (index < 3 || index >= 10) expect(row).toEqual(previous);
            else {
              const { x, z, ...metadata } = row;
              const { x: oldX, z: oldZ, ...oldMetadata } = previous;
              expect(metadata).toEqual(oldMetadata);
              expect(Math.hypot(x - oldX, z - oldZ)).toBeGreaterThan(0.1);
            }
          });
          const driftSpan = Math.hypot(
            historicalRows[7].x - historicalRows[9].x,
            historicalRows[7].z - historicalRows[9].z,
          );
          expect(driftSpan).toBeGreaterThan(6);
          expect(driftSpan).toBeLessThan(8);
          // Wider tangents are not admitted for rocks or unrelated bank pockets.
          for (const row of [
            northwest.placements[0],
            inlandHabitat.groups[1].placements[2],
          ]) {
            const original = row[1];
            try {
              row[1] = -3;
              expect(() =>
                createCompactPondDressing(profile, areas, height, docks),
              ).toThrow("placement");
            } finally {
              row[1] = original;
            }
          }
          const drift = northwest.plantDrift!;
          const originalSpan = drift.tangentMax;
          try {
            drift.tangentMax = originalSpan + 0.01;
            expect(() =>
              createCompactPondDressing(profile, areas, height, docks),
            ).toThrow("plant drift");
          } finally {
            drift.tangentMax = originalSpan;
          }
          return {
            previousCrownRows,
            changedScales,
            waterwardMoves,
            movedPlants,
          };
        });
      expect(inlandHabitat).toEqual(currentRecipe);
      const previousById = new Map(historicalRows.map((row) => [row.id, row]));
      const replacements = new Set([
        "inland_pond_northern-quiet-pocket_4",
        "inland_pond_southeast-sedge-pocket_4",
      ]);
      const additions = rows.filter((row) => !previousById.has(row.id));
      expect(additions).toHaveLength(6);
      const containedCrowns: { id: string; minimumInset: number }[] = [];
      for (const row of rows) {
        const previous = previousById.get(row.id);
        if (previous) {
          if (replacements.has(row.id)) {
            expect(previous.model).toBe("bush");
            expect(row.model).toBe("fern");
            expect({ ...row, model: previous.model }).toEqual(previous);
          } else expect(row).toEqual(previous);
        }
        if (!previous || replacements.has(row.id)) {
          const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
          const minimumInset = Math.max(
            ...historicalRows
              .filter(
                (before) =>
                  before.model !== "boulder" && before.model !== "stone",
              )
              .map(
                (before) =>
                  COMPACT_POND_MODELS[before.model].radius * before.scale -
                  Math.hypot(row.x - before.x, row.z - before.z) -
                  radius,
              ),
          );
          // A complete new canopy circle inside one previous canopy is a
          // conservative sufficient proof; no sampled union approximation.
          expect(
            minimumInset,
            row.id + " previous28 canopy containment",
          ).toBeGreaterThanOrEqual(-1e-12);
          containedCrowns.push({ id: row.id, minimumInset });
        }
      }
      expect(containedCrowns).toHaveLength(8);
      expect(
        rows.filter((row) => row.model === "boulder" || row.model === "stone"),
      ).toEqual(
        historicalRows.filter(
          (row) => row.model === "boulder" || row.model === "stone",
        ),
      );
      expect(
        rows.filter((row) =>
          row.id.startsWith("inland_pond_northwest-cutbank_"),
        ),
      ).toEqual(historicalRows.slice(0, 10));
      const bounds = docks.docks.map(getCompactPondDockSupportBounds);
      const occupiedDegrees = new Set<number>();
      for (const row of rows) {
        const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
        for (const box of bounds) {
          const x = Math.max(box.minX, Math.min(box.maxX, row.x));
          const z = Math.max(box.minZ, Math.min(box.maxZ, row.z));
          expect(Math.hypot(row.x - x, row.z - z)).toBeGreaterThan(
            radius + 1.25,
          );
        }
        expect(Math.hypot(row.x - 387, row.z - 419)).toBeGreaterThan(
          radius + 1.5,
        );
        if (row.model === "boulder" || row.model === "stone") {
          for (let i = 0; i < 64; i++) {
            const angle = (i * Math.PI) / 32;
            expect(
              height(
                row.x + Math.cos(angle) * radius,
                row.z + Math.sin(angle) * radius,
              ),
            ).toBeLessThan(candidate.waterBody.surfaceY - 0.04);
          }
        } else
          expect(height(row.x, row.z)).toBeGreaterThan(
            candidate.waterBody.surfaceY,
          );
        const bearing = Math.atan2(row.z - 415, row.x - 410);
        const spread = Math.asin(radius / Math.hypot(row.x - 410, row.z - 415));
        for (let degree = 0; degree < 360; degree++) {
          const delta = Math.atan2(
            Math.sin((degree * Math.PI) / 180 - bearing),
            Math.cos((degree * Math.PI) / 180 - bearing),
          );
          if (Math.abs(delta) <= spread) occupiedDegrees.add(degree);
        }
      }
      // Three deliberate pockets leave the majority of shoreline unplanted;
      // this is not yet a claim of 14 live navigable fishing reservations.
      expect(occupiedDegrees.size).toBeLessThan(70);
      const servicePlanting = createCompactServicePlanting(
        DataManager.getWorldConfig()!.compactServicePlanting,
      );
      expect(servicePlanting).toHaveLength(24);
      expect(rows.length + servicePlanting.length).toBe(58);
      owner = new CompactPondDressingVisuals(new THREE.Group(), rows);
      for (const model of Object.keys(
        COMPACT_POND_MODELS,
      ) as CompactPondModel[]) {
        const geometry = canonicalGeometry(model);
        geometries.push(geometry);
        owner.install(model, new THREE.Mesh(geometry, material));
      }
      const ground = grid((x, z) => height(x, z + 415), 410, 141, 70);
      geometries.push(ground.geometry);
      const surface = new RetainedTerrainSurface(
        1,
        "inland-habitat-cpu",
        410,
        415,
        70,
        141,
        ground.geometry,
      );
      owner.update(0.25, () => surface);
      expect(owner.getReceipt()).toMatchObject({
        ready: true,
        visible: 34,
        instances: 34,
      });
      const assetReceipt = owner.getReceipt().assets;
      expect(assetReceipt).toHaveLength(6);
      for (const row of rows) {
        if (row.model === "boulder" || row.model === "stone") continue;
        const support = assetReceipt.find(
          (asset) => asset.model === row.model,
        )!.support;
        expect(support.mode).toBe("root-slice");
        expect(support.selectedVertices).toBeGreaterThan(0);
        expect(support.bounds).not.toBeNull();
        const root = support.bounds!;
        for (const x of [root.min[0], root.max[0]])
          for (const z of [root.min[2], root.max[2]]) {
            const worldX =
              row.x +
              (Math.cos(row.yaw) * x + Math.sin(row.yaw) * z) * row.scale;
            const worldZ =
              row.z +
              (-Math.sin(row.yaw) * x + Math.cos(row.yaw) * z) * row.scale;
            expect(
              height(worldX, worldZ),
              `${row.id} root footprint`,
            ).toBeGreaterThan(candidate.waterBody.surfaceY);
          }
      }
      // These checks use the selected manifest's actual route and resource
      // owners. The historical no-docks fixture remains a geometry regression,
      // not an implicit replacement for current fourteen-spot access evidence.
      const config = DataManager.getWorldConfig()!;
      if (process.env.ASSETS_DIR !== undefined) {
        // These detached studies have different physical shorelines. Admit
        // their actual bytes, not a folder name or an optimistic common count.
        // Missing docks in a selected fixture must not bypass these checks.
        const areasSource = readFileSync(
          `${process.env.ASSETS_DIR}/manifests/world-areas.json`,
          "utf8",
        );
        const selectedAreasSHA256 = createHash("sha256")
          .update(areasSource)
          .digest("hex");
        const v9AreasSHA256 =
          "fdda05c65a178f3cf6dc9eec5187711c251f77b7ff2c0659f0ccce29fa254e7f";
        const v10AreasSHA256 =
          "438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3";
        expect([v9AreasSHA256, v10AreasSHA256]).toContain(selectedAreasSHA256);
        const v10 = selectedAreasSHA256 === v10AreasSHA256;
        const selectedConfigSHA256 = createHash("sha256")
          .update(
            readFileSync(
              `${process.env.ASSETS_DIR}/manifests/world-config.json`,
            ),
          )
          .digest("hex");
        expect(selectedConfigSHA256).toBe(
          "60f98f5e300db1eb58902723d4f9a5859db4b3a75fc78ec81e1b3673832ac254",
        );
        expect(candidate.flatZone.radialPond!.bankSectors![2].innerRadius).toBe(
          v10 ? 18.5 : 14.8,
        );
        if (v10) {
          // Reversing this one literal must recover the exact v9 manifest:
          // no other physical/layout delta is hidden by the v10 admission.
          const physicalDelta = '"innerRadius": 18.5';
          expect(areasSource.split(physicalDelta)).toHaveLength(2);
          expect(
            createHash("sha256")
              .update(areasSource.replace(physicalDelta, '"innerRadius": 14.8'))
              .digest("hex"),
          ).toBe(v9AreasSHA256);
        }
        const crownGolden = v10
          ? {
              clearApproaches: 197,
              before:
                "46dfbfaf3d537e0c7ea999124bf17ca701f37ce4fef1ebc518d423ac260ff2b7",
              after:
                "7649050a59cbeb2637aa5e0395f0a7e1dbe030204ab4885a104fb11a2ae6b09a",
            }
          : {
              clearApproaches: 198,
              before:
                "02d812b2f7e171958664a365f9193193df85fde92e820e913e41167832605349",
              after:
                "837f952dc0cc9b733a4d7cfa32eeaba342670bb9e8f3af8bd61aaf7ba6a8d874",
            };
        expect(config.compactPondDocks).toEqual(docks);
        const paths = createCompactIslandPaths(
          profile,
          areas,
          getDuelArenaConfig(),
          height,
          config,
        );
        const protectedIds = [
          "compact-path-pond-bank",
          "compact-clearing-bank-apron",
          "compact-clearing-bank-clerk-approach",
          "compact-clearing-bank-shopkeeper-approach",
        ];
        for (const id of protectedIds) {
          const matches = paths.filter((path) => path.id === id);
          expect(matches, id).toHaveLength(1);
          const path = matches[0];
          expect(path.path.length).toBeGreaterThan(1);
          for (const row of rows)
            for (let index = 1; index < path.path.length; index++)
              expect(
                compactPathSegmentDistance(
                  row,
                  path.path[index - 1],
                  path.path[index],
                ),
                `${row.id} full canopy versus ${id}`,
              ).toBeGreaterThan(
                COMPACT_POND_MODELS[row.model].radius * row.scale +
                  path.width / 2 +
                  (path.blendWidth ?? 0.5),
              );
        }
        const guides = areas.haven_pond.npcs.filter(
          (npc) => npc.id === "fisherman_pete",
        );
        expect(guides).toHaveLength(1);
        for (const row of rows)
          expect(
            Math.hypot(
              row.x - guides[0].position.x,
              row.z - guides[0].position.z,
            ),
          ).toBeGreaterThan(
            COMPACT_POND_MODELS[row.model].radius * row.scale + 1.5,
          );

        terrain["loadWaterBodiesFromManifest"]();
        terrain["generateTile"](4, 4, false);
        terrain["bakeWalkabilityFlags"](4, 4);
        world.register("entity-manager", EntityManager);
        const resources = world.register(
          "resource",
          ResourceSystem,
        ) as ResourceSystem;
        await resources.init();
        const pond = areas.haven_pond;
        expect(pond.fishing).toMatchObject({
          enabled: true,
          waterBodyId: candidate.waterBody.id,
          spotCount: 14,
        });
        const body = terrain
          .getWaterBodyRegistry()
          .getAllBodies()
          .find((entry) => entry.id === candidate.waterBody.id);
        if (!body)
          throw new Error("Selected pond requires its actual water owner");
        const binding = {
          body: Object.freeze({ ...body }),
          bounds: Object.freeze({ ...pond.bounds }),
        };
        const ledgers = () => ({
          resources: [...resources["resources"].keys()],
          registrations: [...resources["terrainResourceRegistrations"].keys()],
          bindings: [...resources["boundFishingResources"].keys()],
          spawns: [...resources["boundFishingSpawns"].keys()],
          pending: [...resources["pendingFishingAreas"].keys()],
          stats: resources.getResourceEcologyStats(),
        });
        const ledgerBeforeQuery = ledgers();
        const pool = resources["getBoundFishingSpawnCandidates"](
          pond,
          binding,
          terrain,
        );
        const repeatedPool = resources["getBoundFishingSpawnCandidates"](
          pond,
          binding,
          terrain,
        );
        expect(repeatedPool).toEqual(pool);
        expect(repeatedPool).not.toBe(pool);
        expect(ledgers()).toEqual(ledgerBeforeQuery);
        // The actual pre-shuffle production query, not a lucky allocation of
        // fourteen spots. Preserve the complete ordered, deduplicated pool.
        const admittedPool = v10
          ? [
              [391.5, 418.5],
              [393.5, 413.5],
              [392.5, 423.5],
              [394.5, 426.5],
              [397.5, 409.5],
              [398.5, 428.5],
              [402.5, 404.5],
              [406.5, 401.5],
              [402.5, 430.5],
              [406.5, 431.5],
              [408.5, 399.5],
              [410.5, 430.5],
              [412.5, 398.5],
              [414.5, 429.5],
              [416.5, 399.5],
              [418.5, 429.5],
              [420.5, 401.5],
              [422.5, 428.5],
              [423.5, 403.5],
              [425.5, 426.5],
              [426.5, 405.5],
              [429.5, 409.5],
              [429.5, 422.5],
              [431.5, 412.5],
              [431.5, 416.5],
            ]
          : [
              [391.5, 418.5],
              [393.5, 413.5],
              [392.5, 423.5],
              [394.5, 426.5],
              [397.5, 409.5],
              [398.5, 428.5],
              [402.5, 404.5],
              [406.5, 401.5],
              [402.5, 430.5],
              [406.5, 431.5],
              [408.5, 399.5],
              [410.5, 427.5],
              [412.5, 398.5],
              [414.5, 427.5],
              [416.5, 399.5],
              [417.5, 429.5],
              [420.5, 401.5],
              [421.5, 428.5],
              [423.5, 403.5],
              [424.5, 426.5],
              [426.5, 405.5],
              [427.5, 424.5],
              [429.5, 409.5],
              [431.5, 412.5],
              [431.5, 416.5],
              [430.5, 420.5],
            ];
        expect(pool.map(({ x, z }) => [x, z])).toEqual(admittedPool);
        const placementHash = (value: unknown) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex");
        expect(placementHash(previousCrownRows)).toBe(crownGolden.before);
        expect(placementHash(historicalRows)).toBe(crownGolden.after);
        const approaches = (
          point: { x: number; z: number },
          planting: readonly CompactPondPlacement[],
        ) => {
          const tile = worldToTile(point.x, point.z);
          const range = GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE;
          const dryTiles: [number, number][] = [];
          const clearTiles: [number, number][] = [];
          let minimumClearMargin = Infinity;
          for (
            let x = tile.x - Math.ceil(range);
            x <= tile.x + Math.ceil(range);
            x++
          )
            for (
              let z = tile.z - Math.ceil(range);
              z <= tile.z + Math.ceil(range);
              z++
            ) {
              const px = x + 0.5;
              const pz = z + 0.5;
              if (
                Math.hypot(px - point.x, pz - point.z) > range ||
                !terrain.hasBakedWalkabilityAt(px, pz) ||
                !world.collision.isWalkable(x, z) ||
                world.collision.hasFlags(
                  x,
                  z,
                  CollisionFlag.WATER |
                    CollisionFlag.DOCK |
                    CollisionFlag.BRIDGE |
                    CollisionFlag.BLOCKED,
                ) ||
                height(px, pz) < body.surfaceY
              )
                continue;
              dryTiles.push([x, z]);
              const margin = Math.min(
                ...planting.map(
                  (row) =>
                    Math.hypot(px - row.x, pz - row.z) -
                    COMPACT_POND_MODELS[row.model].radius * row.scale -
                    0.35,
                ),
              );
              if (margin > 0) {
                clearTiles.push([x, z]);
                minimumClearMargin = Math.min(minimumClearMargin, margin);
              }
            }
          return { dryTiles, clearTiles, minimumClearMargin };
        };
        const allApproaches = pool.map((point) => {
          const before = approaches(point, previousCrownRows);
          const historical = approaches(point, historicalRows);
          expect(historical.dryTiles).toEqual(before.dryTiles);
          expect(historical.clearTiles).toEqual(before.clearTiles);
          const after = approaches(point, rows);
          expect(after.dryTiles).toEqual(historical.dryTiles);
          expect(
            after.clearTiles,
            `${point.x},${point.z} complete current34 pool`,
          ).toEqual(historical.clearTiles);
          expect(after.clearTiles.length).toBeGreaterThan(0);
          expect(after.minimumClearMargin).toBeGreaterThan(0);
          return { point, before, historical, after };
        });
        expect(allApproaches).toHaveLength(admittedPool.length);
        expect(
          allApproaches.reduce(
            (sum, entry) => sum + entry.after.clearTiles.length,
            0,
          ),
        ).toBe(crownGolden.clearApproaches);
        expect(
          Math.min(
            ...allApproaches.map(
              (entry) => entry.historical.minimumClearMargin,
            ),
          ),
        ).toBeCloseTo(0.04318228473613872, 12);
        // Both previously rejected candidates still have the same large crowns.
        // The full-pool oracle must catch their losses even if random selection
        // omits this spot. Do not move or remove the fishing resource to pass.
        for (const rejected of [
          { offsets: [0.7, 1.05], clear: 2, lost: [[419, 397]] },
          {
            offsets: [1, 1.35],
            clear: 1,
            lost: [
              [418, 396],
              [419, 397],
            ],
          },
        ]) {
          const rejectedRows = withInlandRecipe(historicalRecipe, () => {
            const northernPocket = inlandHabitat.groups.find(
              (group) => group.id === "northern-quiet-pocket",
            )!;
            waterwardRoots.forEach((shift, index) => {
              northernPocket.placements[shift.index][2] =
                rejected.offsets[index];
            });
            return createCompactPondDressing(profile, areas, height, docks);
          });
          const point = pool.find(
            (entry) => entry.x === 416.5 && entry.z === 399.5,
          )!;
          const before = approaches(point, previousCrownRows);
          const after = approaches(point, rejectedRows);
          expect(after.dryTiles).toEqual(before.dryTiles);
          expect(after.clearTiles).toHaveLength(rejected.clear);
          expect(
            before.clearTiles.filter(
              ([x, z]) =>
                !after.clearTiles.some(([nx, nz]) => x === nx && z === nz),
            ),
          ).toEqual(rejected.lost);
        }
        expect(inlandHabitat).toEqual(currentRecipe);
        const spawning = resources["spawnDynamicFishingSpots"](pond.id, pond);
        expect(resources["terrainResourceRegistrations"].size).toBe(14);
        const reserved = resources["getBoundFishingSpawnCandidates"](
          pond,
          binding,
          terrain,
        );
        expect(reserved).toHaveLength(admittedPool.length - 14);
        await spawning;
        expect(
          resources["getBoundFishingSpawnCandidates"](pond, binding, terrain),
        ).toEqual(reserved);
        const fish = [...resources["resources"].values()];
        expect(fish).toHaveLength(14);
        for (const spot of fish) {
          expect(
            pool.some(
              (point) =>
                point.x === spot.position.x && point.z === spot.position.z,
            ),
          ).toBe(true);
          expect(
            reserved.some(
              (point) =>
                point.x === spot.position.x && point.z === spot.position.z,
            ),
          ).toBe(false);
        }
        const families = fish.map((spot) =>
          resources["resourceVariants"].get(createResourceID(spot.id)),
        );
        expect(new Set(families)).toEqual(
          new Set([
            "fishing_spot_net",
            "fishing_spot_bait",
            "fishing_spot_fly",
            "fishing_spot_harpoon",
            "fishing_spot_cage",
            "fishing_spot_monkfish",
            "fishing_spot_shark",
          ]),
        );
        for (const family of new Set(families))
          expect(families.filter((entry) => entry === family)).toHaveLength(2);
        const approachEvidence: {
          id: string;
          x: number;
          z: number;
          dryApproaches: number;
          clearApproaches: number;
        }[] = [];
        for (const spot of fish) {
          expect(world.entities.get(spot.id)).toBeInstanceOf(ResourceEntity);
          const tile = worldToTile(spot.position.x, spot.position.z);
          expect(
            world.collision.hasFlags(tile.x, tile.z, CollisionFlag.WATER),
          ).toBe(true);
          expect(height(spot.position.x, spot.position.z)).toBeLessThan(
            candidate.waterBody.surfaceY,
          );
          expect(spot.position.y).toBe(candidate.waterBody.surfaceY);
          const range = GATHERING_CONSTANTS.FISHING_INTERACTION_RANGE;
          let dryApproaches = 0;
          let clearApproaches = 0;
          for (
            let x = tile.x - Math.ceil(range);
            x <= tile.x + Math.ceil(range);
            x++
          )
            for (
              let z = tile.z - Math.ceil(range);
              z <= tile.z + Math.ceil(range);
              z++
            ) {
              const point = { x: x + 0.5, z: z + 0.5 };
              if (
                Math.hypot(
                  point.x - spot.position.x,
                  point.z - spot.position.z,
                ) > range ||
                !terrain.hasBakedWalkabilityAt(point.x, point.z) ||
                !world.collision.isWalkable(x, z) ||
                world.collision.hasFlags(
                  x,
                  z,
                  CollisionFlag.WATER |
                    CollisionFlag.DOCK |
                    CollisionFlag.BRIDGE |
                    CollisionFlag.BLOCKED,
                ) ||
                height(point.x, point.z) < candidate.waterBody.surfaceY
              )
                continue;
              dryApproaches++;
              // The complete admitted GLB canopy circle, not just the root,
              // must leave a 0.35 m standing footprint on a real dry tile.
              if (
                rows.every(
                  (row) =>
                    Math.hypot(point.x - row.x, point.z - row.z) >
                    COMPACT_POND_MODELS[row.model].radius * row.scale + 0.35,
                )
              )
                clearApproaches++;
            }
          expect(dryApproaches, `${spot.id} dry approach`).toBeGreaterThan(0);
          expect(
            clearApproaches,
            `${spot.id} canopy-clear approach`,
          ).toBeGreaterThan(0);
          approachEvidence.push({
            id: spot.id,
            x: spot.position.x,
            z: spot.position.z,
            dryApproaches,
            clearApproaches,
          });
        }
        console.info(
          "inland-plant-massing-clearances",
          JSON.stringify({
            historical28Massing: { movedPlants, changedScales, waterwardMoves },
            current34CanopyContainment: containedCrowns,
            historical28PlacementSHA256: placementHash(historicalRows),
            current34PlacementSHA256: placementHash(rows),
            selectedAreasSHA256,
            selectedConfigSHA256,
            allocationPool: allApproaches.map(({ point, before, after }) => ({
              x: point.x,
              z: point.z,
              dryTiles: after.dryTiles.length,
              clearTiles: after.clearTiles.length,
              beforeSHA256: placementHash(before.clearTiles),
              afterSHA256: placementHash(after.clearTiles),
              minimumClearMargin: after.minimumClearMargin,
            })),
            pondInstances: rows.length,
            serviceInstances: servicePlanting.length,
            models: assetReceipt.length,
            docks: docks.docks.length,
            dockClearance: 1.25,
            guideClearance: 1.5,
            standingRadius: 0.35,
            protectedPaths: protectedIds,
            fishing: approachEvidence,
            scope:
              "Actual CPU terrain/resource/canonical-GLB clearance; not live angler routing or native visual acceptance",
          }),
        );
      }
      const versions = owner.group.children.map(
        (child) => (child as THREE.InstancedMesh).instanceMatrix.version,
      );
      owner.update(0.25, () => surface);
      expect(
        owner.group.children.map(
          (child) => (child as THREE.InstancedMesh).instanceMatrix.version,
        ),
      ).toEqual(versions);
      const obstructed = structuredClone(docks);
      Object.assign(obstructed.docks[0], { x: 394, z: 401.5 });
      expect(() =>
        createCompactPondDressing(profile, areas, height, obstructed),
      ).toThrow("clearance");
      const missing = {
        ...areas,
        haven_pond: { ...areas.haven_pond, flatZones: [] },
      };
      expect(() =>
        createCompactPondDressing(profile, missing, height, docks),
      ).toThrow("shaped basin");

      const ops = createCompactTerrainColorOperations();
      const bank = ops.pondBankField(candidate.flatZone, candidate.waterBody)!;
      const profileWithMeadow = validateWorldTerrainProfile({
        ...profile,
        southernMeadow: {
          schemaVersion: 1,
          minX: 304,
          maxX: 500,
          minZ: 345,
          maxZ: 535,
          featherX: 24,
          featherZ: 24,
          northHeight: 26.8,
          southHeight: 25.3,
          crossFall: 1,
          rollAmplitude: 0.65,
          rollWavelength: 100,
        },
      });
      const macro = ops.macroField(
        profileWithMeadow,
        undefined,
        "composition-v1",
        bank,
      )!;
      // The inland study now deliberately covers the eastern sedge shelf and
      // both southern turf banks; the higher northwest cutbank stays exposed.
      expect(macro.pondContactGround).toHaveLength(3);
      expect(
        candidate.flatZone.radialPond!.bankComposition!.sectors.map(
          (sector) => sector.surface,
        ),
      ).toEqual(["cutbank", "sedge-shelf", "dry-turf", "dry-turf"]);
      for (const contact of macro.pondContactGround!) {
        expect(
          Math.hypot(contact.startX - 410, contact.startZ - 415),
        ).toBeLessThan(30);
        expect(
          Math.hypot(contact.startX - 343, contact.startZ - 302),
        ).toBeGreaterThan(90);
      }
      expect(ops.pondContactSoil(338.9, 297.6, 0.5, macro)).toBe(0);
      expect(
        ops.macroField(profileWithMeadow, undefined, "composition-v1", null)!
          .pondContactGround,
      ).toEqual([]);
      const old = ops.macroField(profileWithMeadow)!;
      expect(old.pondContactGround![0].startX).toBe(338.9);
      expect(ops.pondContactSoil(338.9, 297.6, 0.5, old)).toBeGreaterThan(0);
      // Workers serialize the actual self-contained factory; new contact data
      // must survive that boundary without external imported recipe closures.
      const emitted = new Function(
        `return (${createCompactTerrainColorOperations.toString()})()`,
      )() as ReturnType<typeof createCompactTerrainColorOperations>;
      expect(
        emitted.macroField(
          profileWithMeadow,
          undefined,
          "composition-v1",
          bank,
        ),
      ).toEqual(macro);
    } finally {
      owner?.destroy();
      geometries.forEach((geometry) => geometry.dispose());
      material.dispose();
      world.destroy();
    }
  });

  it("joins the candidate asymmetric bank with unequal contact groups while retaining exact historical admission and safe rock footprints", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: {
        ...original.radialPond!,
        bankSectors: [
          {
            bearing: (-133 * Math.PI) / 180,
            halfWidth: (40 * Math.PI) / 180,
            innerRadius: 6.25,
            innerHeight: 27.84,
          },
          {
            bearing: (-27 * Math.PI) / 180,
            halfWidth: (24 * Math.PI) / 180,
            innerRadius: 6.55,
            innerHeight: 28.08,
          },
        ],
      },
    };
    const candidateAreas = {
      ...areas,
      haven_pond: { ...areas.haven_pond, flatZones: [bank] },
    };
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    // Real shared resolver, with a surrounding level bank outside its support.
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    const rows = createCompactPondDressing(profile, candidateAreas, height);
    const { southernMeadow: _candidate, ...historicalProfile } = profile;
    const legacy = createCompactPondDressing(
      historicalProfile,
      candidateAreas,
      height,
    );
    expect(rows).toHaveLength(32);
    expect(rows.map((p) => [p.id, p.model])).toEqual(
      legacy.map((p) => [p.id, p.model]),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
    expect(rows).toEqual(
      createCompactPondDressing(profile, candidateAreas, height),
    );
    expect(createCompactPondDressing(profile, areas, height)).toEqual(legacy);
    expect(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        candidateAreas,
        height,
      ),
    ).toEqual(legacy);
    const pond = areas.haven_pond.waterBodies![0];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        old = legacy[i];
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(row.z + radius).toBeLessThan(pond.centerZ);
      if (row.model === "boulder" || row.model === "stone") {
        // Test the disk's perimeter as well as the production interior lattice.
        for (let a = 0; a < Math.PI * 2; a += 0.01) {
          const x = row.x + radius * Math.cos(a),
            z = row.z + radius * Math.sin(a);
          expect(Math.hypot(x - pond.centerX, z - pond.centerZ)).toBeLessThan(
            pond.radius,
          );
          expect(height(x, z)).toBeLessThan(pond.surfaceY - 0.04);
        }
      } else {
        expect(
          Math.hypot(row.x - pond.centerX, row.z - pond.centerZ),
        ).toBeLessThan(Math.hypot(old.x - pond.centerX, old.z - pond.centerZ));
        expect(height(row.x, row.z)).toBeGreaterThan(pond.surfaceY);
      }
    }
    // A smaller north link prevents three equally weighted decorated pockets.
    expect(rows[15].scale).toBeLessThan(rows[0].scale);
    expect(rows[15].scale).toBeLessThan(rows[24].scale);
  });

  it("admits the authored northern habitat only for shaped banks, preserving rocks, eastern composition and all southern clearance", async () => {
    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const sectors = [
      {
        bearing: -2.321287905152458,
        halfWidth: 0.6981317007977318,
        innerRadius: 6,
        innerHeight: 27.98,
        outerRadius: 8.2,
        outerHeight: 28.55,
      },
      {
        bearing: -0.47123889803846897,
        halfWidth: 0.41887902047863906,
        innerRadius: 6.55,
        innerHeight: 28.08,
      },
      { bearing: 0.7, halfWidth: 0.55, innerRadius: 6.4, innerHeight: 27.86 },
      {
        bearing: -1.5533430342749532,
        halfWidth: 0.8726646259971648,
        innerRadius: 7.1,
        innerHeight: 27.86,
        outerRadius: 8.7,
        outerHeight: 27.99,
      },
    ];
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: { ...original.radialPond!, bankSectors: sectors },
    };
    const withSectors = (
      bankSectors: NonNullable<FlatZone["radialPond"]>["bankSectors"],
    ) => ({
      ...areas,
      haven_pond: {
        ...areas.haven_pond,
        flatZones: [
          { ...bank, radialPond: { ...bank.radialPond!, bankSectors } },
        ],
      },
    });
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    // Both layouts use the same actual height function: this isolates the
    // composition selector from the separate terrain-shape change.
    const legacySectors = sectors.map(
      ({ bearing, halfWidth, innerRadius, innerHeight }) => ({
        bearing,
        halfWidth,
        innerRadius,
        innerHeight,
      }),
    );
    const legacy = createCompactPondDressing(
      profile,
      withSectors(legacySectors),
      height,
    );
    const rows = createCompactPondDressing(
      profile,
      withSectors(sectors),
      height,
    );
    expect(rows).toHaveLength(40);
    expect(legacy).toHaveLength(32);
    expect(rows).toEqual(
      createCompactPondDressing(profile, withSectors(sectors), height),
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
    expect(rows.filter((row) => row.model === "boulder")).toHaveLength(4);
    expect(rows.filter((row) => row.model === "stone")).toHaveLength(6);
    expect(rows.filter((row) => row.model === "fern")).toHaveLength(8);
    expect(rows.filter((row) => row.model === "bush")).toHaveLength(3);
    expect(rows.filter((row) => row.model === "reed")).toHaveLength(15);
    expect(rows.filter((row) => row.model === "sorrel")).toHaveLength(4);
    expect(new Set(rows.map((row) => row.id)).size).toBe(40);
    const replacements = new Map(
      northernHabitat.replacements.map((row) => [row.index, row]),
    );
    const pond = areas.haven_pond.waterBodies![0];
    rows.forEach((row, index) => {
      const { x, z, ...metadata } = row;
      if (index < 32 && !replacements.has(index)) {
        const { x: oldX, z: oldZ, ...oldMetadata } = legacy[index];
        expect(metadata).toEqual(oldMetadata);
        if (index < 15 || index >= 24) expect(row).toEqual(legacy[index]);
        else {
          // The old multi-knot northward rock relocation is unchanged. New
          // habitat data cannot alter these models, scales, yaw or burial.
          expect(Math.hypot(x - oldX, z - oldZ)).toBeGreaterThan(1);
          const bearing =
            (Math.atan2(z - pond.centerZ, x - pond.centerX) * 180) / Math.PI;
          expect(bearing).toBeGreaterThan(-100);
          expect(bearing).toBeLessThan(-75);
        }
      } else {
        const authored =
          replacements.get(index) ?? northernHabitat.additions[index - 32];
        expect(metadata).toEqual({
          id: `haven_pond_${authored.model}_${index}`,
          model: authored.model,
          scale: authored.scale,
          yaw: (authored.yaw * Math.PI) / 180,
          burial: 0.04,
        });
        expect(["boulder", "stone"]).not.toContain(row.model);
      }
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(z + radius).toBeLessThan(pond.centerZ);
      if (row.model === "boulder" || row.model === "stone") {
        for (let step = 0; step < 128; step++) {
          const angle = (step * Math.PI) / 64;
          const px = x + radius * Math.cos(angle),
            pz = z + radius * Math.sin(angle);
          expect(Math.hypot(px - pond.centerX, pz - pond.centerZ)).toBeLessThan(
            pond.radius,
          );
          expect(height(px, pz)).toBeLessThan(pond.surfaceY - 0.04);
        }
      } else expect(height(x, z)).toBeGreaterThan(pond.surfaceY);
    });
    // Same owner, existing service placements and unchanged hard instance cap.
    // This is canonical asset/root ownership proof, not a visual or GPU test.
    const service = createCompactServicePlanting(
      DataManager.getWorldConfig()!.compactServicePlanting,
    );
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      ...rows,
      ...service,
    ]);
    const selectedModels = [...models, "sorrel" as const];
    const geometries = selectedModels.map(canonicalGeometry);
    const material = new THREE.MeshStandardNodeMaterial();
    const ground = grid(3, 0, 256, 1000);
    try {
      selectedModels.forEach((model, index) =>
        owner.install(model, new THREE.Mesh(geometries[index], material)),
      );
      owner.update(0.25, () => ground.surface);
      expect(owner.getReceipt()).toMatchObject({
        ready: true,
        instances: 64,
        visible: 64,
      });
      expect(owner.group.children).toHaveLength(6);
      expect(
        owner
          .getReceipt()
          .assets.map((asset) => [asset.model, asset.instances]),
      ).toEqual([
        ["boulder", 4],
        ["stone", 6],
        ["fern", 12],
        ["bush", 23],
        ["reed", 15],
        ["sorrel", 4],
      ]);
      expect(
        () =>
          new CompactPondDressingVisuals(new THREE.Group(), [
            ...rows,
            ...service,
            { ...rows[0], id: "over-budget" },
          ]),
      ).toThrow("budget");
      const versions = owner.group.children.map(
        (mesh) => (mesh as THREE.InstancedMesh).instanceMatrix.version,
      );
      owner.update(0.25, () => ground.surface);
      expect(
        owner.group.children.map(
          (mesh) => (mesh as THREE.InstancedMesh).instanceMatrix.version,
        ),
      ).toEqual(versions);
    } finally {
      owner.destroy();
      geometries.forEach((geometry) => geometry.dispose());
      material.dispose();
      ground.geometry.dispose();
    }
    const { southernMeadow: _selected, ...historicalProfile } = profile;
    expect(
      createCompactPondDressing(
        historicalProfile,
        withSectors(sectors),
        height,
      ),
    ).toEqual(
      createCompactPondDressing(
        historicalProfile,
        withSectors(legacySectors),
        height,
      ),
    );
    expect(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        withSectors(sectors),
        height,
      ),
    ).toEqual(
      createCompactPondDressing(
        { ...profile, id: "unselected" },
        withSectors(legacySectors),
        height,
      ),
    );
  });

  it("composes two unequal shelf islands while preserving every plant model, scale and yaw and leaving the cut face open", async () => {
    // These are the pre-composition asset/scale/yaw budgets, not values read
    // back from the edited authoring data. Placement may change; assets and
    // visual cost may not be silently traded for a fuller-looking shoreline.
    expect(
      northernHabitat.replacements.map(({ index, model, scale, yaw }) => [
        index,
        model,
        scale,
        yaw,
      ]),
    ).toEqual([
      [5, "fern", 1.05, 17],
      [6, "fern", 0.95, 125],
      [7, "fern", 1.1, 240],
      [8, "fern", 0.9, 73],
      [9, "bush", 0.38, 27],
      [10, "reed", 1.15, 27],
      [11, "reed", 1, 121],
      [12, "reed", 1.2, 232],
      [13, "reed", 1.05, 67],
      [14, "reed", 0.95, 178],
      [18, "fern", 0.95, 112],
      [19, "fern", 0.8, 267],
      [20, "bush", 0.4, 211],
      [21, "reed", 1, 300],
      [22, "reed", 1.12, 57],
      [23, "reed", 0.85, 213],
    ]);
    expect(
      northernHabitat.additions.map(({ model, scale, yaw }) => [
        model,
        scale,
        yaw,
      ]),
    ).toEqual([
      ["reed", 1.08, 198],
      ["reed", 1.18, 14],
      ["reed", 1.08, 141],
      ["reed", 0.92, 247],
      ["sorrel", 0.85, 44],
      ["sorrel", 1, 176],
      ["sorrel", 0.92, 291],
      ["sorrel", 0.8, 97],
    ]);
    const authored = [
      ...northernHabitat.replacements,
      ...northernHabitat.additions,
    ];
    const reeds = authored.filter((row) => row.model === "reed");
    expect(reeds).toHaveLength(12);
    const westIsland = reeds.filter((row) => row.bearing === 249);
    const northIsland = reeds.filter((row) => row.bearing === 272);
    expect([westIsland.length, northIsland.length]).toEqual([7, 5]);
    for (const island of [westIsland, northIsland]) {
      // At least one metre of near-to-far layering replaces the picket row;
      // retain an intentionally uneven spacing, not a second concentric band.
      expect(
        Math.max(...island.map((row) => row.bankOffset)) -
          Math.min(...island.map((row) => row.bankOffset)),
      ).toBeGreaterThan(0.95);
      expect(new Set(island.map((row) => row.bankOffset)).size).toBe(
        island.length,
      );
    }

    await DataManager.getInstance().initialize();
    const areas = DataManager.getInstance().getAllWorldAreas();
    const original = areas.haven_pond.flatZones!.find(
      (zone) => zone.radialPond,
    )!;
    const bank: FlatZone = {
      ...original,
      height: original.height!,
      radialPond: {
        ...original.radialPond!,
        bankSectors: [
          {
            bearing: (-133 * Math.PI) / 180,
            halfWidth: (30 * Math.PI) / 180,
            innerRadius: 6.3,
            innerHeight: 27.95,
            outerRadius: 7.6,
            outerHeight: 28.64,
          },
          {
            bearing: (-27 * Math.PI) / 180,
            halfWidth: (24 * Math.PI) / 180,
            innerRadius: 6.55,
            innerHeight: 28.08,
          },
          {
            bearing: 0.7,
            halfWidth: 0.55,
            innerRadius: 6.4,
            innerHeight: 27.86,
          },
          {
            bearing: (-96 * Math.PI) / 180,
            halfWidth: (44 * Math.PI) / 180,
            innerRadius: 6.9,
            innerHeight: 27.86,
            outerRadius: 8.85,
            outerHeight: 28.22,
          },
        ],
      },
    };
    const profile = validateWorldTerrainProfile({
      ...DataManager.getWorldConfig()!.terrainProfile,
      southernMeadow: {
        schemaVersion: 1,
        minX: 304,
        maxX: 500,
        minZ: 345,
        maxZ: 535,
        featherX: 24,
        featherZ: 24,
        northHeight: 26.8,
        southHeight: 25.3,
        crossFall: 1,
        rollAmplitude: 0.65,
        rollWavelength: 100,
      },
    });
    const height = (x: number, z: number) =>
      resolveRadialPondTerrainHeight(bank, x, z, () => 28.08) ?? 28.08;
    const pond = areas.haven_pond.waterBodies![0];
    const rows = createCompactPondDressing(
      profile,
      { ...areas, haven_pond: { ...areas.haven_pond, flatZones: [bank] } },
      height,
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const radius = COMPACT_POND_MODELS[row.model].radius * row.scale;
      expect(row.z + radius).toBeLessThan(pond.centerZ);
      if (row.model !== "stone" && row.model !== "boulder")
        expect(height(row.x, row.z)).toBeGreaterThan(pond.surfaceY);
    }
    const selectedReeds = rows.filter(
      (row, index) => row.model === "reed" && (index < 24 || index >= 32),
    );
    expect(selectedReeds).toHaveLength(12);
    for (const row of selectedReeds) {
      const angle =
        ((Math.atan2(row.z - pond.centerZ, row.x - pond.centerX) * 180) /
          Math.PI +
          360) %
        360;
      expect(angle).toBeGreaterThan(240);
      expect(angle).toBeLessThan(280);
    }
    // Actual shared radial-height placement only. Parent native fixture owns
    // retained triangles, full roots, PhysX, routes and final visual acceptance.
  });

  it("pins the additive sorrel source, roots and source material ownership without admitting it into historical layouts", () => {
    const bytes = readFileSync(
      new URL(
        "../../../../../../server/world/assets/vegetation/compact-pond-v1/pond_sorrel.glb",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "2f887028b517ad2e6ea3c75665dc4790c59a0ae66ea41ff6185e5b5375777d22",
    );
    expect(northernHabitat.sorrel.sourceSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(northernHabitat.sorrel).toMatchObject({
      file: "pond_sorrel.glb",
      radius: 0.539,
      triangles: 1629,
      license: "CC0-1.0",
      source: "https://polyhaven.com/a/shrub_sorrel_01",
    });
    const geometry = canonicalGeometry("sorrel");
    const map = new THREE.DataTexture(
      new Uint8Array([120, 150, 70, 255]),
      1,
      1,
    );
    const material = new THREE.MeshStandardNodeMaterial({
      map,
      normalMap: map,
      aoMap: map,
      roughnessMap: map,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const historical = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      { ...placements()[2], id: "sorrel", model: "sorrel" },
    ]);
    let borrowedDisposals = 0;
    [geometry, map, material].forEach((resource) =>
      resource.addEventListener("dispose", () => borrowedDisposals++),
    );
    try {
      expect(
        historical.getReceipt().assets.map((asset) => asset.model),
      ).toEqual(models);
      expect(() =>
        historical.install("sorrel", new THREE.Mesh(geometry, material)),
      ).toThrow("no admitted placements");
      expect(historical.group.children).toHaveLength(0);
      owner.install("sorrel", new THREE.Mesh(geometry, material));
      const receipt = owner
        .getReceipt()
        .assets.find((asset) => asset.model === "sorrel")!;
      expect(receipt.support.mode).toBe("root-slice");
      expect(receipt.support.selectedVertices).toBe(129);
      const root = receipt.support.bounds!,
        full = receipt.support.fullGeometryBounds!;
      expect(root.max[1]).toBeLessThanOrEqual(full.min[1] + 0.05);
      expect(root.max[0] - root.min[0]).toBeLessThan(0.3);
      expect(root.max[2] - root.min[2]).toBeLessThan(0.3);
      expect(full.max[0] - full.min[0]).toBeGreaterThan(1);
      const mesh = owner.group.children[0] as THREE.InstancedMesh;
      const cloned = mesh.material as THREE.MeshStandardNodeMaterial;
      expect(mesh.geometry).toBe(geometry);
      expect(cloned).not.toBe(material);
      for (const key of ["map", "normalMap", "aoMap", "roughnessMap"] as const)
        expect(cloned[key]).toBe(map);
      expect(cloned.alphaTest).toBe(0.5);
      expect(cloned.side).toBe(THREE.DoubleSide);
      expect(mesh.castShadow).toBe(false);
      owner.destroy();
      expect(borrowedDisposals).toBe(0);
    } finally {
      historical.destroy();
      owner.destroy();
      geometry.dispose();
      material.dispose();
      map.dispose();
    }
  });

  it("derives canonical fern/bush/reed lower central support without mistaking their low drooping leaves for roots", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const material = new THREE.MeshStandardNodeMaterial(),
      geometries = models.map(canonicalGeometry);
    try {
      models.forEach((model, index) =>
        owner.install(model, new THREE.Mesh(geometries[index], material)),
      );
      const assets = owner.getReceipt().assets;
      for (const asset of assets) {
        const root = ["fern", "bush", "reed"].includes(asset.model);
        expect(asset.support.mode).toBe(root ? "root-slice" : "full-footprint");
        const box = asset.support.bounds!,
          full = asset.support.fullGeometryBounds!;
        if (!root) {
          expect(box).toEqual(full);
          continue;
        }
        expect(asset.support.rootSlice).toEqual(COMPACT_POND_ROOT_SUPPORT);
        expect(asset.support.selectedVertices).toBe(
          ({ fern: 31, bush: 6, reed: 184 } as Record<string, number>)[
            asset.model
          ],
        );
        expect(box.max[0] - box.min[0]).toBeLessThan(0.2);
        expect(box.max[2] - box.min[2]).toBeLessThan(0.36);
        expect(box.max[1]).toBeLessThanOrEqual(full.min[1] + 0.05);
        expect(
          (box.max[0] - box.min[0]) * (box.max[2] - box.min[2]),
        ).toBeLessThan(
          (full.max[0] - full.min[0]) * (full.max[2] - full.min[2]) * 0.1,
        );
        const positions =
          geometries[models.indexOf(asset.model)].getAttribute("position");
        let expectedCount = 0;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i),
            y = positions.getY(i),
            z = positions.getZ(i);
          if (y <= full.min[1] + 0.05 && Math.hypot(x, z) <= 0.18) {
            expectedCount++;
            expect(x).toBeGreaterThanOrEqual(box.min[0]);
            expect(x).toBeLessThanOrEqual(box.max[0]);
            expect(z).toBeGreaterThanOrEqual(box.min[2]);
            expect(z).toBeLessThanOrEqual(box.max[2]);
          }
        }
        expect(expectedCount).toBe(asset.support.selectedVertices);
      }
    } finally {
      owner.destroy();
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
    }
  });

  it("keeps roots on their actual slope while the crown overhangs lower terrain, retaining full culling bounds", () => {
    const p = { ...placements()[2], x: 0, z: 0, yaw: 0, scale: 1.05 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [p]);
    const material = new THREE.MeshStandardNodeMaterial();
    const root = new THREE.BoxGeometry(0.08, 0.04, 0.08).translate(
      0.02,
      0.02,
      0.01,
    );
    const crown = new THREE.BoxGeometry(0.9, 0.2, 0.9).translate(0, 0.4, 0);
    const source = new THREE.Group();
    source.add(new THREE.Mesh(root, material), new THREE.Mesh(crown, material));
    const ground = grid((x, z) => 3 + x * 0.5 + z * 0.25, 0, 9, 2);
    try {
      owner.install("fern", source);
      owner.update(0.25, () => ground.surface);
      const receipt = owner
          .getReceipt()
          .assets.find((asset) => asset.model === "fern")!,
        box = receipt.support.bounds!;
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        matrix = new THREE.Matrix4();
      mesh.getMatrixAt(0, matrix);
      const expected =
        3 +
        box.min[0] * p.scale * 0.5 +
        box.min[2] * p.scale * 0.25 -
        p.burial -
        box.min[1] * p.scale;
      expect(matrix.elements[13]).toBeCloseTo(expected, 6);
      const crownMinimum = 3 - 0.45 * p.scale * 0.75 - p.burial;
      expect(matrix.elements[13] - crownMinimum).toBeGreaterThan(0.3);
      const crownMesh = owner.group.children[1] as THREE.InstancedMesh;
      expect(
        crownMesh.boundingBox!.max.x - crownMesh.boundingBox!.min.x,
      ).toBeCloseTo(0.9 * p.scale, 5);
      expect(crownMesh.boundingBox!.max.y).toBeGreaterThan(3.4);
    } finally {
      owner.destroy();
      root.dispose();
      crown.dispose();
      ground.geometry.dispose();
      material.dispose();
    }
  });

  it("rejects unsupported hanging crowns instead of inventing a plant root footprint", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(
      0.5,
      0.2,
      0,
    );
    const material = new THREE.MeshStandardNodeMaterial();
    try {
      expect(() =>
        owner.install("fern", new THREE.Mesh(geometry, material)),
      ).toThrow("root-slice");
      expect(owner.group.children).toHaveLength(0);
    } finally {
      owner.destroy();
      geometry.dispose();
      material.dispose();
    }
  });
  it("places the complete authored kit around actual admitted terrain, with rocks in existing water and the south approach open", async () => {
    await DataManager.getInstance().initialize();
    const world = new World();
    const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
    try {
      await terrain.init();
      (
        terrain as unknown as { loadFlatZonesFromManifest(): void }
      ).loadFlatZonesFromManifest();
      const areas = DataManager.getInstance().getAllWorldAreas();
      const result = createCompactPondDressing(
        SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
        areas,
        (x, z) => terrain.getResourceGroundHeight(x, z),
      );
      expect(result).toHaveLength(32);
      // Genuine canonical geometry in one owner: court planting must not add
      // model loads, material clones or draw batches beside the original pond.
      const combined = [
        ...result,
        ...createCompactServicePlanting(
          DataManager.getWorldConfig()!.compactServicePlanting,
        ),
      ];
      expect(combined).toHaveLength(56);
      const owner = new CompactPondDressingVisuals(new THREE.Group(), combined);
      const geometries = models.map(canonicalGeometry);
      const texture = new THREE.DataTexture(
        new Uint8Array([110, 150, 80, 255]),
        1,
        1,
      );
      const material = new THREE.MeshStandardNodeMaterial({
        map: texture,
        alphaTest: 0.5,
      });
      const ground = grid(3, 0, 256, 1000);
      let borrowedDisposals = 0;
      for (const borrowed of [...geometries, material, texture])
        borrowed.addEventListener("dispose", () => borrowedDisposals++);
      try {
        models.forEach((model, i) =>
          owner.install(model, new THREE.Mesh(geometries[i], material)),
        );
        owner.update(0.25, () => ground.surface);
        expect(owner.group.children).toHaveLength(5);
        expect(owner.getReceipt()).toMatchObject({
          ready: true,
          instances: 56,
          visible: 56,
        });
        const bush = owner.group.children[
          models.indexOf("bush")
        ] as THREE.InstancedMesh;
        expect(bush.count).toBe(23);
        expect(
          (owner.group.children[models.indexOf("fern")] as THREE.InstancedMesh)
            .count,
        ).toBe(12);
        expect(bush.geometry).toBe(geometries[models.indexOf("bush")]);
        expect((bush.material as THREE.MeshStandardNodeMaterial).map).toBe(
          texture,
        );
        expect(bush.instanceMatrix.array.byteLength).toBe(23 * 64);
        const versions = owner.group.children.map(
          (o) => (o as THREE.InstancedMesh).instanceMatrix.version,
        );
        for (let i = 0; i < 40; i++) owner.update(0.25, () => ground.surface);
        expect(
          owner.group.children.map(
            (o) => (o as THREE.InstancedMesh).instanceMatrix.version,
          ),
        ).toEqual(versions);
        expect(
          owner.getReceipt().assets.every((a) => a.paletteMaterials === 1),
        ).toBe(true);
        owner.destroy();
        owner.destroy();
        expect(borrowedDisposals).toBe(0);
      } finally {
        owner.destroy();
        for (const geometry of geometries) geometry.dispose();
        ground.geometry.dispose();
        material.dispose();
        texture.dispose();
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toEqual(
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          (x, z) => terrain.getResourceGroundHeight(x, z),
        ),
      );
      expect(
        Object.fromEntries(
          models.map((model) => [
            model,
            result.filter((p) => p.model === model).length,
          ]),
        ),
      ).toEqual({ boulder: 4, stone: 6, fern: 8, bush: 3, reed: 11 });
      const pond = areas.haven_pond.waterBodies![0];
      for (const p of result) {
        const radius = COMPACT_POND_MODELS[p.model].radius * p.scale;
        expect(p.z + radius).toBeLessThan(pond.centerZ);
        if (p.model === "boulder" || p.model === "stone") {
          for (let angle = 0; angle < Math.PI * 2; angle += 0.03) {
            const x = p.x + Math.cos(angle) * radius,
              z = p.z + Math.sin(angle) * radius;
            expect(Math.hypot(x - pond.centerX, z - pond.centerZ)).toBeLessThan(
              pond.radius,
            );
            expect(terrain.getResourceGroundHeight(x, z)).toBeLessThan(
              pond.surfaceY - 0.04,
            );
          }
        }
      }
      expect(
        createCompactPondDressing(COMPACT_WORLD_TERRAIN_PROFILE, {}, () => 0),
      ).toEqual([]);
      expect(() =>
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          areas,
          () => 999,
        ),
      ).toThrow("underwater");
      expect(() =>
        createCompactPondDressing(
          SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE,
          {},
          () => 0,
        ),
      ).toThrow("Haven pond");
    } finally {
      terrain.destroy();
    }
  });

  it("preserves every real mesh/material group, texture and transform; grounds against exact triangles and releases only owned instances", () => {
    const parent = new THREE.Group();
    const owner = new CompactPondDressingVisuals(parent, placements());
    const texture = new THREE.DataTexture(
      new Uint8Array([100, 120, 140, 255]),
      1,
      1,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshStandardNodeMaterial({
      map: texture,
      normalMap: texture,
      roughnessMap: texture,
      metalnessMap: texture,
      aoMap: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    let borrowedDisposals = 0,
      instanceDisposals = 0,
      paletteDisposals = 0;
    const paletteMaterials = new Set<THREE.MeshStandardNodeMaterial>();
    for (const resource of [texture, material, geometry])
      resource.addEventListener("dispose", () => borrowedDisposals++);
    const source = new THREE.Group();
    source.position.set(0.1, 0.1, 0.1);
    const first = new THREE.Mesh(geometry, [
      material,
      material,
      material,
      material,
      material,
      material,
    ]);
    const second = new THREE.Mesh(geometry, material);
    second.position.set(0.1, 0, 0);
    source.add(first, second);
    const originalMaps = [material.map, material.alphaTest, material.side];
    for (const model of models) owner.install(model, source);
    expect(owner.group.children).toHaveLength(10);
    for (const child of owner.group.children) {
      const mesh = child as THREE.InstancedMesh;
      mesh.addEventListener("dispose", () => instanceDisposals++);
      expect(mesh.geometry).toBe(geometry);
      for (const palette of (Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) as THREE.MeshStandardNodeMaterial[]) {
        expect(palette).not.toBe(material);
        expect(palette).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
        expect(palette.colorNode).toHaveProperty("isNode", true);
        expect(palette.map).toBe(texture);
        expect(palette.normalMap).toBe(texture);
        expect(palette.roughnessMap).toBe(texture);
        expect(palette.metalnessMap).toBe(texture);
        expect(palette.aoMap).toBe(texture);
        expect(palette.alphaTest).toBe(0.5);
        expect(palette.side).toBe(THREE.DoubleSide);
        if (!paletteMaterials.has(palette))
          palette.addEventListener("dispose", () => paletteDisposals++);
        paletteMaterials.add(palette);
      }
      expect(mesh.count).toBe(0);
    }
    expect(paletteMaterials.size).toBe(5);
    expect(material.colorNode).toBeNull();
    const a = grid(3),
      b = grid(7);
    try {
      owner.update(0.25, () => a.surface);
      expect(owner.getReceipt()).toMatchObject({
        ready: true,
        visible: 5,
        instances: 5,
      });
      const actual = new THREE.Matrix4(),
        expected = new THREE.Matrix4();
      const placement = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 2.96, 0),
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.PI / 2,
        ),
        new THREE.Vector3(1, 1, 1),
      );
      (owner.group.children[1] as THREE.InstancedMesh).getMatrixAt(0, actual);
      expected.multiplyMatrices(placement, second.matrixWorld);
      actual.elements.forEach((value, i) =>
        expect(value).toBeCloseTo(expected.elements[i], 6),
      );
      const version = (owner.group.children[0] as THREE.InstancedMesh)
        .instanceMatrix.version;
      owner.update(0.25, () => a.surface);
      expect(
        (owner.group.children[0] as THREE.InstancedMesh).instanceMatrix.version,
      ).toBe(version);
      owner.update(0.25, () => null);
      expect(owner.getReceipt()).toMatchObject({ ready: false, visible: 0 });
      owner.update(0.25, () => b.surface);
      (owner.group.children[0] as THREE.InstancedMesh).getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(7.06);
      expect([material.map, material.alphaTest, material.side]).toEqual(
        originalMaps,
      );
      owner.destroy();
      owner.destroy();
      expect(instanceDisposals).toBe(10);
      expect(paletteDisposals).toBe(5);
      expect(borrowedDisposals).toBe(0);
      expect(parent.children).toHaveLength(0);
      owner.install("boulder", source); // A late loader result cannot resurrect the owner.
      owner.update(0.25, () => a.surface);
      expect(parent.children).toHaveLength(0);
      expect(owner.getReceipt().ready).toBe(false);
    } finally {
      owner.destroy();
      a.geometry.dispose();
      b.geometry.dispose();
      texture.dispose();
      material.dispose();
      geometry.dispose();
    }
  });

  it("grounds the entire conservative footprint at the exact triangle minimum, including an interior low grid vertex", () => {
    const placement = { ...placements()[0], x: 0, z: 0, yaw: 0 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      placement,
    ]);
    const geometry = new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0);
    const material = new THREE.MeshStandardNodeMaterial();
    const surface = grid(
      (x, z) =>
        Math.abs(x - 0.25) < 0.01 && Math.abs(z - 0.25) < 0.01 ? 1 : 3,
      0,
      9,
      2,
    );
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      owner.update(0.25, () => surface.surface);
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        actual = new THREE.Matrix4();
      expect(mesh.count).toBe(1);
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(0.96, 6);
      const sample = { height: 0, nx: 0, ny: 1, nz: 0, faceIndex: 0 };
      expect(surface.surface.sample(0, 0, sample)).toBe(true);
      expect(sample.height).toBe(3); // Pivot-only anchoring would float by 2 m.
      for (let x = -0.5; x <= 0.5; x += 0.025)
        for (let z = -0.5; z <= 0.5; z += 0.025) {
          expect(surface.surface.sample(x, z, sample)).toBe(true);
          expect(actual.elements[13]).toBeLessThanOrEqual(
            sample.height - placement.burial + 1e-6,
          );
        }
      const receipt = owner
        .getReceipt()
        .assets.find((a) => a.model === "boulder")!;
      expect(receipt.sampleQueries).toBeGreaterThan(10);
      expect(receipt.sampleQueries).toBeLessThanOrEqual(4096);
      const version = mesh.instanceMatrix.version;
      owner.update(0.25, () => surface.surface);
      expect(mesh.instanceMatrix.version).toBe(version);
    } finally {
      owner.destroy();
      surface.geometry.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("tracks neighbor surface revisions across a footprint and hides the instance if any footprint surface disappears", () => {
    const placement = { ...placements()[0], x: 0, z: 0, yaw: 0 };
    const owner = new CompactPondDressingVisuals(new THREE.Group(), [
      placement,
    ]);
    const geometry = new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0),
      material = new THREE.MeshStandardNodeMaterial();
    const left = grid(4, -10),
      right = grid(4, 10),
      lowerRight = grid(2, 10);
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        actual = new THREE.Matrix4();
      owner.update(0.25, (x) => (x <= 0 ? left.surface : right.surface));
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(3.96, 6);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : lowerRight.surface));
      mesh.getMatrixAt(0, actual);
      expect(actual.elements[13]).toBeCloseTo(1.96, 6);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : null));
      expect(mesh.count).toBe(0);
      owner.update(0.25, (x) => (x <= 0 ? left.surface : right.surface));
      expect(mesh.count).toBe(1);
    } finally {
      owner.destroy();
      left.geometry.dispose();
      right.geometry.dispose();
      lowerRight.geometry.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("bounds complete 32-instance footprint installs on the highest admitted terrain resolution without new textures or repeated uploads", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({
      ...placements()[0],
      id: `budget_${i}`,
      x: 0,
      z: 0,
      scale: 1.25,
      yaw: Math.PI / 4,
    }));
    const owner = new CompactPondDressingVisuals(new THREE.Group(), rows);
    const geometry = new THREE.SphereGeometry(0.88, 16, 12)
        .scale(1, 0.7, 1)
        .translate(0, 0.616, 0),
      material = new THREE.MeshStandardNodeMaterial();
    const ground = grid((x, z) => 5 + x * 0.2 + z * 0.1, 0, 256, 100);
    try {
      owner.install("boulder", new THREE.Mesh(geometry, material));
      let lookups = 0;
      owner.update(0.25, () => {
        lookups++;
        return ground.surface;
      });
      const receipt = owner
        .getReceipt()
        .assets.find((a) => a.model === "boulder")!;
      expect(receipt.visible).toBe(32);
      expect(lookups).toBe(32 * 9);
      expect(receipt.sampleQueries).toBeLessThan(32 * 1024);
      expect(receipt.paletteMaterials).toBe(1);
      const mesh = owner.group.children[0] as THREE.InstancedMesh,
        version = mesh.instanceMatrix.version;
      for (let i = 0; i < 40; i++) owner.update(0.25, () => ground.surface);
      expect(mesh.instanceMatrix.version).toBe(version);
      expect(owner.group.children).toHaveLength(1);
    } finally {
      owner.destroy();
      ground.geometry.dispose();
      geometry.dispose();
      material.dispose();
    }
  });

  it("rejects malformed/out-of-envelope assets before attaching any partial model", () => {
    const owner = new CompactPondDressingVisuals(
      new THREE.Group(),
      placements(),
    );
    const geometry = new THREE.BoxGeometry(4, 4, 4),
      material = new THREE.MeshStandardNodeMaterial();
    try {
      expect(() =>
        owner.install("boulder", new THREE.Mesh(geometry, material)),
      ).toThrow("bounds");
      expect(owner.group.children).toHaveLength(0);
      expect(
        () =>
          new CompactPondDressingVisuals(new THREE.Group(), [
            ...placements(),
            ...placements(),
          ]),
      ).toThrow("identities");
    } finally {
      owner.destroy();
      geometry.dispose();
      material.dispose();
    }
  });
});
