import type {
  WorldArea,
  RoadPathPoint,
  WorldConfigManifest,
} from "../../../types/world/world-types";
import {
  isCompactSculptProfile,
  type WorldTerrainProfile,
} from "./WorldTerrainProfile";
import type { DuelArenaConfig } from "../../../data/duel-manifest";
import {
  createDuelArenaFloorZones,
  getDuelArenaGradeHeight,
} from "../../../data/arena-grading";
import {
  COMPACT_PREPARATION_LODGE,
  getCompactPreparationLodgeFootprint,
} from "./CompactPreparationLodge";
import { validateCompactServiceCourtBindings } from "./CompactServiceCourt";

/** Surface-mask paths only: no meshes, colliders, height grading or agent routing. */
export type CompactIslandPath = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  width: number;
  /** Explicit worn shoulders share one bounded field with terrain and grass. */
  blendWidth?: number;
  maxInfluence?: number;
  path: readonly Readonly<RoadPathPoint>[];
  length: number;
  /** Candidate-only paint capsules beneath specific opaque stone aprons. */
  platformEntries?: readonly Readonly<{
    floorId: string;
    endpoint: "start" | "end";
    from: Point;
    to: Point;
    supportRadius: number;
    /** Interior-to-stone samples; only this terminal neighbourhood is reshaped. */
    approach: readonly Point[];
    /** Replaced route samples plus the former straight stone-entry stub. */
    previousApproach: readonly Point[];
  }>[];
}>;

export const COMPACT_PATH_BLEND_WIDTH = 0.5;
// Also clears the actual256 road mask's bilinear footprint, not only the
// analytical width+blend. This is tested against the admitted layout/mask.
const CLEARANCE = 0.75;
type Point = Readonly<{ x: number; z: number }>;
type Bounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

/** Runtime callers pass admitted architecture explicitly. Omitting this argument
 * retains the historical v6 enclosed-bank path fixture, not an implicit global.
 */
export type CompactPathArchitecture = Readonly<
  Pick<
    WorldConfigManifest,
    "compactPreparationLodge" | "compactBankPavilion" | "compactServiceCourts"
  >
>;

/** Exact segment distance, also used to qualify the entire path width at water. */
export function compactPathSegmentDistance(
  p: Point,
  a: Point,
  b: Point,
): number {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSquared),
        );
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

/** Conservative rectangular keep-out: rounded path caps stay outside too. */
export function compactPathIntersectsBounds(
  a: Point,
  b: Point,
  bounds: Bounds,
  padding: number,
): boolean {
  let enter = 0,
    leave = 1;
  for (const [start, delta, minimum, maximum] of [
    [a.x, b.x - a.x, bounds.minX - padding, bounds.maxX + padding],
    [a.z, b.z - a.z, bounds.minZ - padding, bounds.maxZ + padding],
  ]) {
    if (delta === 0) {
      if (start < minimum || start > maximum) return false;
    } else {
      const first = (minimum - start) / delta,
        last = (maximum - start) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

/**
 * A small authored circulation pattern, positioned by admitted station/pond/floor
 * manifests. Two rounds of corner cutting preserve endpoints and produce curved
 * paths; resampling bounds segment length without moving the authored subjects.
 * Lobby north/south endpoints share an ID because its existing walkable stone
 * platform connects them. The selected meadow extends its terminal paint under
 * the opaque stone aprons; baseline profiles keep their original clearances.
 */
export function createCompactIslandPaths(
  profile: WorldTerrainProfile,
  areas: Readonly<Record<string, WorldArea>>,
  arena: DuelArenaConfig,
  getHeightAt: (x: number, z: number) => number,
  architecture?: CompactPathArchitecture,
): readonly CompactIslandPath[] {
  if (!isCompactSculptProfile(profile)) return Object.freeze([]);
  const serviceCourts = architecture?.compactServiceCourts;
  validateCompactServiceCourtBindings(serviceCourts, areas);
  const primaryBank = serviceCourts?.courts.find(
    (court) => court.layoutId === serviceCourts.primaryBankId,
  );
  if (
    serviceCourts &&
    (!primaryBank ||
      architecture?.compactBankPavilion ||
      architecture?.compactPreparationLodge)
  )
    throw new Error(
      "Compact paths require an explicit unambiguous primary bank owner",
    );
  const haven = areas.central_haven,
    pondArea = areas.haven_pond;
  const station = (type: string): Point => {
    const rows =
      primaryBank && type === "bank"
        ? Object.values(areas)
            .flatMap((area) => area.stations ?? [])
            .filter(
              (row) =>
                row.id === primaryBank.stationIds[0] && row.type === type,
            )
        : haven?.stations?.filter((row) => row.type === type);
    if (rows?.length !== 1)
      throw new Error(
        "Compact path requires one admitted Haven station: " + type,
      );
    return rows[0].position;
  };
  const pond = pondArea?.waterBodies?.[0];
  if (!pond || pondArea.waterBodies?.length !== 1)
    throw new Error("Compact paths require the admitted Haven pond");
  const bank = station("bank"),
    furnace = station("furnace"),
    anvil = station("anvil"),
    range = station("range"),
    altar = station("altar");
  const npc = (id: string): Point => {
    const rows =
      primaryBank && id === "bank_clerk"
        ? Object.values(areas)
            .flatMap((area) => area.npcs ?? [])
            .filter((row) => row.id === primaryBank.npcIds[0])
        : haven?.npcs?.filter((row) => row.id === id);
    if (rows?.length !== 1)
      throw new Error(
        "Compact clearing requires one admitted Haven NPC: " + id,
      );
    return rows[0].position;
  };
  const clerk = npc("bank_clerk"),
    shopkeeper = npc("shopkeeper"),
    supplier = npc("crafting_supplier");
  const floors = createDuelArenaFloorZones(
    arena,
    getDuelArenaGradeHeight(areas),
  );
  const lobby = floors.find((floor) => floor.id === "duel_lobby_floor");
  if (!lobby) throw new Error("Compact paths require the admitted lobby floor");
  const exclusions = floors.map((floor) => ({
    minX: floor.centerX - floor.width / 2,
    maxX: floor.centerX + floor.width / 2,
    minZ: floor.centerZ - floor.depth / 2,
    maxZ: floor.centerZ + floor.depth / 2,
  }));
  const bankCourt = profile.id === "compact-duel-island-v6";
  const bankPavilion = primaryBank ?? architecture?.compactBankPavilion;
  if (bankPavilion && architecture?.compactPreparationLodge)
    throw new Error("Compact paths require one bank architecture owner");
  if (bankPavilion && bankPavilion.terrainProfileId !== profile.id)
    throw new Error(
      "Compact bank path profile does not match its architecture",
    );
  const meadowPaths = bankCourt && profile.southernMeadow !== undefined;
  // The steps meet the forecourt; dirt must not pass through the enclosed
  // building. Include the roof overhang as a conservative wall/floor keep-out.
  const lodge =
    architecture === undefined
      ? bankCourt
        ? COMPACT_PREPARATION_LODGE
        : undefined
      : architecture.compactPreparationLodge;
  if (bankCourt && lodge)
    exclusions.push(getCompactPreparationLodgeFootprint(lodge, false));
  const waters = Object.values(areas).flatMap((area) => area.waterBodies ?? []);
  const front: Point = { x: bank.x, z: bank.z + 3 };
  const workshop: Point = {
    x: (furnace.x + anvil.x) / 2,
    z: (furnace.z + anvil.z) / 2 - 3,
  };
  const shoreDirection = {
    x: front.x - pond.centerX,
    z: front.z - pond.centerZ,
  };
  const shoreDistance = Math.hypot(shoreDirection.x, shoreDirection.z);
  if (shoreDistance === 0)
    throw new Error("Bank approach cannot be at the pond center");
  const shoreRadius =
    pond.radius + 1.8 / 2 + COMPACT_PATH_BLEND_WIDTH + CLEARANCE;
  const shore: Point = {
    x: pond.centerX + (shoreDirection.x / shoreDistance) * shoreRadius,
    z: pond.centerZ + (shoreDirection.z / shoreDistance) * shoreRadius,
  };
  const northLobby: Point = {
    x: lobby.centerX,
    z:
      lobby.centerZ -
      lobby.depth / 2 -
      2.2 / 2 -
      COMPACT_PATH_BLEND_WIDTH -
      CLEARANCE,
  };
  const southLobby: Point = {
    x: lobby.centerX,
    z:
      lobby.centerZ +
      lobby.depth / 2 +
      2.2 / 2 +
      COMPACT_PATH_BLEND_WIDTH +
      CLEARANCE,
  };
  const arenaApproach: Point = {
    x: arena.baseX + arena.arenaWidth / 2,
    z: arena.baseZ - 2.2 / 2 - COMPACT_PATH_BLEND_WIDTH - CLEARANCE,
  };
  const definitions: Array<{
    id: string;
    fromId: string;
    toId: string;
    width: number;
    blendWidth?: number;
    maxInfluence?: number;
    points: Point[];
    clearing?: boolean;
    wear?: boolean;
  }> = [
    {
      id: "pond-bank",
      fromId: pond.id,
      toId: "bank-forecourt",
      width: meadowPaths ? 0.65 : bankCourt ? 1.1 : 1.8,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.6 : 0.85 } : {}),
      points: bankPavilion
        ? [
            shore,
            { x: bankPavilion.position.x, z: bankPavilion.position.z - 6 },
            { x: bankPavilion.position.x, z: bankPavilion.position.z - 1.5 },
            front,
          ]
        : [shore, { x: front.x - 1, z: (shore.z + front.z) / 2 }, front],
    },
    {
      id: "bank-workshop",
      fromId: "bank-forecourt",
      toId: "workshop-forecourt",
      width: meadowPaths ? 0.75 : bankCourt ? 1.1 : 1.8,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.65 : 0.85 } : {}),
      points: [
        front,
        ...(bankCourt
          ? [
              { x: front.x - 7, z: front.z },
              { x: front.x - 7, z: workshop.z - 3 },
            ]
          : [
              { x: front.x, z: front.z + 5 },
              { x: workshop.x + 4, z: workshop.z - 1 },
            ]),
        workshop,
      ],
    },
    {
      id: "bank-range",
      fromId: "bank-forecourt",
      toId: "range-forecourt",
      width: meadowPaths ? 0.65 : bankCourt ? 0.9 : 1.5,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.45 : 0.8 } : {}),
      points: [
        front,
        { x: range.x + 5, z: front.z },
        { x: range.x + (meadowPaths ? 1.5 : 2.5), z: range.z },
      ],
    },
    {
      id: "bank-altar",
      fromId: "bank-forecourt",
      toId: "altar-forecourt",
      width: meadowPaths ? 0.65 : bankCourt ? 0.9 : 1.5,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.45 : 0.8 } : {}),
      points: [
        front,
        ...(bankPavilion
          ? [
              { x: bankPavilion.position.x, z: bankPavilion.position.z },
              { x: bankPavilion.position.x, z: bankPavilion.position.z - 5 },
              { x: altar.x, z: bankPavilion.position.z - 7 },
            ]
          : [{ x: altar.x, z: front.z - 3 }]),
        { x: altar.x, z: altar.z + (meadowPaths ? 1.25 : 3) },
      ],
    },
    {
      id: "bank-lobby",
      fromId: "bank-forecourt",
      toId: "duel-lobby",
      width: meadowPaths ? 0.9 : bankCourt ? 1.4 : 2.2,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.85 : 0.9 } : {}),
      points: [
        front,
        ...(bankPavilion
          ? [
              // Open south passage between the actual pavilion posts. Do not
              // preserve the obsolete detour around the retired lodge walls.
              { x: bankPavilion.position.x, z: bankPavilion.position.z + 2 },
              { x: bankPavilion.position.x, z: bankPavilion.position.z + 8 },
              {
                x: bankPavilion.position.x + 3,
                z: bankPavilion.position.z + 13,
              },
              { x: front.x + 9, z: front.z + 15 },
              { x: front.x + 19, z: front.z + 16 },
              { x: front.x + 26, z: northLobby.z - 13 },
            ]
          : bankCourt
            ? [
                // Share the western forecourt, then wrap south of the lodge.
                // The eastern gap is occupied by the real general tree's crown.
                { x: front.x - 7, z: front.z },
                { x: front.x - 7, z: front.z + 6 },
                { x: front.x - 5.5, z: front.z + 10.5 },
                { x: front.x - 4.6, z: front.z + 12.5 },
                { x: front.x - 3.5, z: front.z + 14.2 },
                { x: front.x + 1, z: front.z + 15 },
                { x: front.x + 9, z: front.z + 15 },
                { x: front.x + 19, z: front.z + 16 },
                { x: front.x + 26, z: northLobby.z - 13 },
              ]
            : [{ x: front.x + 8, z: front.z + 8 }]),
        ...(!bankCourt
          ? [{ x: (front.x + northLobby.x) / 2 + 3, z: northLobby.z - 13 }]
          : []),
        northLobby,
      ],
    },
    {
      id: "lobby-arena",
      fromId: "duel-lobby",
      toId: "arena-approach",
      width: bankCourt ? 1.4 : 2.2,
      ...(bankCourt ? { blendWidth: 0.9 } : {}),
      points: [
        southLobby,
        { x: (southLobby.x + arenaApproach.x) / 2, z: arenaApproach.z },
        arenaApproach,
      ],
    },
    // Surface-only forecourts. These IDs describe paint provenance, not route
    // edges or service ownership. They never grant remote banking or navigation.
    // Baseline cores redistribute their previous radius into broader shoulders.
    // The selected meadow retains its narrow service cores and reduces the
    // surrounding smooth shoulder. Centerlines and traversable terrain stay
    // put; the two unequal activity patches below retain their own support.
    // Lower wear can admit grass in the shoulder, with acceptance-dependent
    // rotation RNG retained; unchanged candidate budgets do not imply equal cost.
    {
      id: "bank-apron",
      clearing: true,
      fromId: "bank-forecourt",
      toId: "bank-forecourt",
      width: bankPavilion ? 0.8 : meadowPaths ? 1 : bankCourt ? 1.8 : 4,
      ...(bankCourt
        ? { blendWidth: bankPavilion ? 0.95 : meadowPaths ? 0.6 : 1.6 }
        : {}),
      points: bankPavilion
        ? [
            { x: bank.x - 0.25, z: bank.z + 0.65 },
            { x: bank.x + 0.15, z: bank.z + 1.6 },
            {
              x: bankPavilion.position.x - 0.55,
              z: bankPavilion.position.z + 0.35,
            },
            { x: bankPavilion.position.x, z: bankPavilion.position.z },
          ]
        : [
            { x: bank.x - 2, z: bank.z + (bankCourt ? 1 : 2) },
            { x: bank.x + 2, z: bank.z + (bankCourt ? 1.5 : 2.5) },
          ],
    },
    {
      id: "bank-clerk-approach",
      clearing: true,
      fromId: "bank-forecourt",
      toId: "bank_clerk",
      width: bankPavilion ? 0.65 : meadowPaths ? 0.7 : bankCourt ? 1.1 : 3,
      ...(bankCourt
        ? { blendWidth: bankPavilion ? 0.85 : meadowPaths ? 0.45 : 1.45 }
        : {}),
      points: bankPavilion
        ? [
            { x: bankPavilion.position.x, z: bankPavilion.position.z },
            {
              x: bankPavilion.position.x + 0.65,
              z: bankPavilion.position.z + 0.55,
            },
            { x: clerk.x - 1, z: clerk.z },
          ]
        : [
            { x: bank.x + 2, z: bank.z + (bankCourt ? 1.5 : 2.5) },
            // Stay west of the real tree's all-LOD crown, including the mask halo.
            bankCourt
              ? { x: clerk.x - 2, z: clerk.z - 3 }
              : { x: clerk.x - 2, z: clerk.z },
          ],
    },
    {
      id: "bank-shopkeeper-approach",
      clearing: true,
      fromId: "bank-forecourt",
      toId: "shopkeeper",
      width: meadowPaths ? 0.65 : bankCourt ? 0.9 : 2.5,
      ...(bankCourt ? { blendWidth: meadowPaths ? 0.45 : 1.3 } : {}),
      points: [
        { x: bank.x - 2, z: bank.z + (bankCourt ? 1 : 2) },
        {
          x: shopkeeper.x - (bankCourt ? 1.5 : 0),
          z: shopkeeper.z - (bankCourt ? 2 : 1),
        },
      ],
    },
    {
      id: "workshop-apron",
      clearing: true,
      fromId: "workshop-forecourt",
      toId: "workshop-forecourt",
      width: bankCourt ? 1.2 : 3.5,
      ...(bankCourt ? { blendWidth: 1.65 } : {}),
      points: [
        { x: furnace.x - 0.25, z: furnace.z - 1.25 },
        { x: anvil.x + 1, z: anvil.z - 1.75 },
      ],
    },
    {
      id: "workshop-supplier-approach",
      clearing: true,
      fromId: "workshop-forecourt",
      toId: "crafting_supplier",
      width: bankCourt ? 0.9 : 2.5,
      ...(bankCourt ? { blendWidth: 1.3 } : {}),
      points: [workshop, { x: supplier.x - 0.5, z: supplier.z + 0.5 }],
    },
  ];
  if (bankCourt) {
    // Wear spreads unevenly around activity, rather than expanding the entire
    // full-clear capsule. These connected skirts cannot cross the 0.8 grass
    // exclusion gate, even where they overlap. Existing service cores stay put.
    definitions.push(
      {
        id: "workshop-south",
        wear: true,
        fromId: "workshop-forecourt",
        toId: "workshop-forecourt",
        width: 0.65,
        blendWidth: 1.5,
        maxInfluence: 0.6,
        points: [
          { x: furnace.x - 0.8, z: furnace.z + 0.15 },
          { x: furnace.x + 1.2, z: furnace.z + 1.05 },
          { x: anvil.x + 0.6, z: anvil.z + 0.4 },
          { x: anvil.x + 0.7, z: anvil.z - 0.65 },
        ],
      },
      {
        id: "workshop-west",
        wear: true,
        fromId: "workshop-forecourt",
        toId: "workshop-forecourt",
        width: 0.7,
        blendWidth: 1.25,
        maxInfluence: 0.55,
        points: [
          { x: furnace.x - 0.2, z: furnace.z - 0.75 },
          { x: furnace.x - 1.5, z: furnace.z - 1.7 },
          { x: furnace.x - 1.75, z: furnace.z - 2.9 },
          { x: workshop.x - 0.35, z: workshop.z - 0.35 },
        ],
      },
      {
        id: "supplier-north",
        wear: true,
        fromId: "workshop-forecourt",
        toId: "crafting_supplier",
        width: 0.45,
        blendWidth: 1.4,
        maxInfluence: 0.5,
        points: [
          { x: workshop.x + 0.5, z: workshop.z - 0.5 },
          { x: supplier.x + 0.4, z: supplier.z + 0.1 },
          { x: supplier.x + 0.7, z: supplier.z - 1 },
        ],
      },
    );
  }
  const buildPath = (definition: (typeof definitions)[number]) => {
    let points = definition.points;
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z)))
      throw new Error("Compact path requires finite anchors: " + definition.id);
    for (let pass = 0; pass < 2; pass++) {
      const smooth: Point[] = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i];
        smooth.push(
          { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 },
          { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 },
        );
      }
      smooth.push(points[points.length - 1]);
      points = smooth;
    }
    const sampled: Point[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
      if (sampled.length + steps > 256)
        throw new Error("Compact path point bound exceeded");
      for (let j = 1; j <= steps; j++)
        sampled.push({
          x: a.x + ((b.x - a.x) * j) / steps,
          z: a.z + ((b.z - a.z) * j) / steps,
        });
    }
    let length = 0;
    const blendWidth = definition.blendWidth ?? COMPACT_PATH_BLEND_WIDTH;
    const maxInfluence = definition.maxInfluence ?? 1;
    if (
      !Number.isFinite(blendWidth) ||
      blendWidth < 0 ||
      blendWidth > 1024 ||
      !Number.isFinite(maxInfluence) ||
      maxInfluence < 0 ||
      maxInfluence > 1
    )
      throw new Error("Invalid compact path surface profile: " + definition.id);
    const padding = definition.width / 2 + blendWidth;
    for (let i = 1; i < sampled.length; i++) {
      const a = sampled[i - 1],
        b = sampled[i];
      if (
        exclusions.some((bounds) =>
          compactPathIntersectsBounds(a, b, bounds, padding),
        )
      )
        throw new Error(
          "Compact path would paint an authored floor: " + definition.id,
        );
      if (
        waters.some(
          (body) =>
            compactPathSegmentDistance(
              { x: body.centerX, z: body.centerZ },
              a,
              b,
            ) <=
            body.radius + padding,
        )
      )
        throw new Error("Compact path would paint water: " + definition.id);
      length += Math.hypot(b.x - a.x, b.z - a.z);
    }
    const path = sampled.map((point) => {
      const y = getHeightAt(point.x, point.z);
      const bounds = profile.bounds;
      if (
        ![point.x, point.z, y].every(Number.isFinite) ||
        y <= profile.water.threshold ||
        point.x - padding < bounds.minX ||
        point.x + padding > bounds.maxX ||
        point.z - padding < bounds.minZ ||
        point.z + padding > bounds.maxZ
      )
        throw new Error(
          "Compact path leaves dry admitted terrain: " + definition.id,
        );
      return Object.freeze({ ...point, y });
    });
    return Object.freeze({
      id:
        (definition.wear
          ? "compact-wear-"
          : definition.clearing
            ? "compact-clearing-"
            : "compact-path-") + definition.id,
      fromId: definition.fromId,
      toId: definition.toId,
      width: definition.width,
      ...(definition.blendWidth === undefined
        ? {}
        : { blendWidth: definition.blendWidth }),
      ...(definition.maxInfluence === undefined
        ? {}
        : { maxInfluence: definition.maxInfluence }),
      path: Object.freeze(path),
      length,
    });
  };
  const paths: CompactIslandPath[] = definitions.map(buildPath);
  if (meadowPaths) {
    // Wear follows short, unequal portions of the actual curved route. A
    // tapered lateral offset joins each skirt back into its core instead of
    // drawing a second parallel path. Existing MAX union keeps partial wear
    // below the grass-exclusion threshold, including skirt intersections.
    // These skirts retain their original support while the smooth route
    // shoulders narrow. Capsule containment and the full bilinear mask
    // footprint are independently tested on the unchanged authored lattice.
    const skirts = [
      {
        route: "pond-bank",
        id: "pond-bank-east",
        start: 0.14,
        end: 0.43,
        side: 1,
        offset: 0.43,
        width: 1.2,
        blendWidth: 0.3,
        maxInfluence: 0.62,
      },
      {
        route: "pond-bank",
        id: "pond-bank-west",
        start: 0.57,
        end: 0.81,
        side: -1,
        offset: 0.41,
        width: 1.2,
        blendWidth: 0.3,
        maxInfluence: 0.58,
      },
      {
        route: "bank-lobby",
        id: "bank-lobby-outer",
        start: 0.28,
        end: 0.49,
        side: -1,
        offset: 0.61,
        width: 1.2,
        blendWidth: 0.3,
        maxInfluence: 0.64,
      },
      {
        route: "bank-lobby",
        id: "bank-lobby-inner",
        start: 0.64,
        end: 0.79,
        side: 1,
        offset: 0.59,
        width: 1.2,
        blendWidth: 0.3,
        maxInfluence: 0.6,
      },
    ];
    for (const skirt of skirts) {
      const route = paths.find(
        (value) => value.id === "compact-path-" + skirt.route,
      );
      if (!route || route.length <= 0)
        throw new Error("Wear requires its admitted route: " + skirt.route);
      const points: Point[] = [];
      for (let sample = 0; sample <= 12; sample++) {
        const t = sample / 12;
        const distance =
          route.length * (skirt.start + (skirt.end - skirt.start) * t);
        let travelled = 0;
        for (let index = 1; index < route.path.length; index++) {
          const a = route.path[index - 1],
            b = route.path[index];
          const dx = b.x - a.x,
            dz = b.z - a.z,
            length = Math.hypot(dx, dz);
          if (
            length > 0 &&
            (travelled + length >= distance || index === route.path.length - 1)
          ) {
            const along = Math.min(1, (distance - travelled) / length);
            const offset = skirt.side * skirt.offset * Math.sin(Math.PI * t);
            points.push({
              x: a.x + dx * along - (dz / length) * offset,
              z: a.z + dz * along + (dx / length) * offset,
            });
            break;
          }
          travelled += length;
        }
      }
      paths.push(
        buildPath({
          id: skirt.id,
          wear: true,
          fromId: route.fromId,
          toId: route.toId,
          width: skirt.width,
          blendWidth: skirt.blendWidth,
          maxInfluence: skirt.maxInfluence,
          points,
        }),
      );
    }
    // Rework only the terminal neighbourhood, after sampling the unchanged
    // route and wear skirts. A straight stub added to a finished curve leaves
    // a visible hook: start tangent follows the retained route, arrival tangent
    // follows the platform normal, with the turn spread over ten metres.
    // The arena's actual stone mesh is one metre narrower/shorter than its
    // grading zone (DuelArenaVisualsSystem.createArenaFloors); lobby stone uses
    // its full zone. Neither grading nor the existing closed fence is changed.
    const arenaFloor = floors.find(
      (floor) => floor.id === "duel_arena_floor_1",
    );
    if (!arenaFloor)
      throw new Error("Compact meadow paths require the first arena floor");
    const underlap = 0.5;
    const entries = [
      {
        pathId: "compact-path-bank-lobby",
        floor: lobby,
        endpoint: "end" as const,
        to: { x: lobby.centerX, z: lobby.centerZ - lobby.depth / 2 + underlap },
      },
      {
        pathId: "compact-path-lobby-arena",
        floor: lobby,
        endpoint: "start" as const,
        to: { x: lobby.centerX, z: lobby.centerZ + lobby.depth / 2 - underlap },
      },
      {
        pathId: "compact-path-lobby-arena",
        floor: arenaFloor,
        endpoint: "end" as const,
        to: {
          x: arenaFloor.centerX,
          z: arenaFloor.centerZ - (arenaFloor.depth - 1) / 2 + underlap,
        },
      },
    ];
    for (const entry of entries) {
      const index = paths.findIndex((path) => path.id === entry.pathId);
      const route = paths[index];
      if (!route)
        throw new Error("Missing compact platform approach: " + entry.pathId);
      // Work interior-to-stone for either end; the other terminal and all
      // points outside this ten-metre neighbourhood retain their exact bytes.
      const oriented =
        entry.endpoint === "start" ? [...route.path].reverse() : route.path;
      let splice = oriented.length - 1;
      let removedLength = 0;
      while (splice > 1 && removedLength < 10) {
        removedLength += Math.hypot(
          oriented[splice].x - oriented[splice - 1].x,
          oriented[splice].z - oriented[splice - 1].z,
        );
        splice--;
      }
      const from = oriented[splice],
        previous = oriented[splice - 1];
      const to = entry.to;
      const chord = Math.hypot(to.x - from.x, to.z - from.z);
      const tangentLength = Math.hypot(
        from.x - previous.x,
        from.z - previous.z,
      );
      const firstHandle = chord * 0.45;
      const lastHandle = Math.min(4, chord * 0.35);
      const normalZ = entry.endpoint === "start" ? -1 : 1;
      const c1 = {
        x: from.x + ((from.x - previous.x) / tangentLength) * firstHandle,
        z: from.z + ((from.z - previous.z) / tangentLength) * firstHandle,
      };
      const c2 = { x: to.x, z: to.z - normalZ * lastHandle };
      // Control-polygon length bounds the curve length and every sampled
      // segment. No unbounded recursion or per-frame curve evaluation.
      const steps = Math.ceil(
        (firstHandle + Math.hypot(c2.x - c1.x, c2.z - c1.z) + lastHandle) /
          0.75,
      );
      const padding =
        route.width / 2 + (route.blendWidth ?? COMPACT_PATH_BLEND_WIDTH);
      if (
        !Number.isFinite(chord) ||
        chord <= 0 ||
        tangentLength <= 0 ||
        splice + 1 + steps > 256
      )
        throw new Error("Invalid compact platform entry: " + entry.pathId);
      const approach: Readonly<RoadPathPoint>[] = [from];
      let length = 0;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps,
          s = 1 - t;
        const x =
          s ** 3 * from.x +
          3 * s * s * t * c1.x +
          3 * s * t * t * c2.x +
          t ** 3 * to.x;
        const z =
          s ** 3 * from.z +
          3 * s * s * t * c1.z +
          3 * s * t * t * c2.z +
          t ** 3 * to.z;
        const a = approach[approach.length - 1];
        const b = { x, z };
        // Admission permits exactly the destination floor, not a blanket
        // exception. Check every entire curved-segment capsule, not its chord.
        if (
          exclusions.some(
            (bounds, exclusion) =>
              floors[exclusion]?.id !== entry.floor.id &&
              compactPathIntersectsBounds(a, b, bounds, padding),
          )
        )
          throw new Error("Invalid compact platform entry: " + entry.pathId);
        if (
          waters.some(
            (body) =>
              compactPathSegmentDistance(
                { x: body.centerX, z: body.centerZ },
                a,
                b,
              ) <=
              body.radius + padding,
          )
        )
          throw new Error(
            "Compact platform entry would paint water: " + entry.pathId,
          );
        const y = getHeightAt(x, z);
        if (
          ![x, z, y].every(Number.isFinite) ||
          y <= profile.water.threshold ||
          x - padding < profile.bounds.minX ||
          x + padding > profile.bounds.maxX ||
          z - padding < profile.bounds.minZ ||
          z + padding > profile.bounds.maxZ
        )
          throw new Error(
            "Compact platform entry leaves dry admitted terrain: " +
              entry.pathId,
          );
        approach.push(Object.freeze({ x, y, z }));
        length += Math.hypot(x - a.x, z - a.z);
      }
      const joined = [...oriented.slice(0, splice), ...approach];
      paths[index] = Object.freeze({
        ...route,
        path: Object.freeze(
          entry.endpoint === "start" ? joined.reverse() : joined,
        ),
        length: route.length - removedLength + length,
        platformEntries: Object.freeze([
          ...(route.platformEntries ?? []),
          Object.freeze({
            floorId: entry.floor.id,
            endpoint: entry.endpoint,
            from: Object.freeze({ x: from.x, z: from.z }),
            to: Object.freeze({ ...to }),
            supportRadius: padding,
            approach: Object.freeze(
              approach.map(({ x, z }) => Object.freeze({ x, z })),
            ),
            previousApproach: Object.freeze([
              ...oriented
                .slice(splice)
                .map(({ x, z }) => Object.freeze({ x, z })),
              Object.freeze({ ...to }),
            ]),
          }),
        ]),
      });
      // A shallow, wider-worn arrival blends into the last 2.5 m of the core.
      // Its support is contained in those exact curve capsules (same radius),
      // so it adds no footprint or floor exception. MAX stays below the grass
      // exclusion threshold; it cannot make another fully cleared route.
      let shoulderStart = approach.length - 1;
      let shoulderLength = 0;
      while (shoulderStart > 0 && shoulderLength < 2.5) {
        shoulderLength += Math.hypot(
          approach[shoulderStart].x - approach[shoulderStart - 1].x,
          approach[shoulderStart].z - approach[shoulderStart - 1].z,
        );
        shoulderStart--;
      }
      paths.push(
        Object.freeze({
          id: `compact-wear-${entry.pathId.slice("compact-path-".length)}-${entry.endpoint}-arrival`,
          fromId: route.fromId,
          toId: route.toId,
          width: 2.2,
          blendWidth: padding - 1.1,
          maxInfluence: 0.76,
          path: Object.freeze(approach.slice(shoulderStart)),
          length: shoulderLength,
        }),
      );
    }
  }
  if (bankPavilion) {
    // The open bank has no opaque floor. Two unequal, joined wear patches
    // follow service activity and the existing south arrival, not the roof's
    // rectangle. MAX union never accumulates these partial skirts into a new
    // full-clear core. Actual grass acceptance still depends on local ecology;
    // a sub-threshold field is not a promise of surviving grass or lower cost.
    const center = bankPavilion.position;
    for (const wear of [
      {
        id: "bank-service",
        width: 0.45,
        blendWidth: 1.1,
        maxInfluence: 0.48,
        points: [
          { x: center.x - 0.45, z: center.z + 0.6 },
          { x: center.x - 1.2, z: center.z + 1.25 },
          { x: center.x - 0.55, z: center.z + 1.65 },
        ],
      },
      {
        id: "bank-south-arrival",
        width: 0.5,
        blendWidth: 1.15,
        maxInfluence: 0.5,
        points: [
          { x: center.x, z: center.z + 1 },
          { x: center.x + 0.6, z: center.z + 2.4 },
          { x: center.x + 0.2, z: center.z + 4 },
        ],
      },
    ])
      paths.push(
        buildPath({
          ...wear,
          wear: true,
          fromId: "bank-forecourt",
          toId: "bank-forecourt",
        }),
      );
  } else if (meadowPaths) {
    // Two unequal activity patches, not another continuous halo. Anchor them
    // to the admitted bank clearings, retain their cores and contain every wear
    // capsule inside its previous support. Five controls keep the network
    // below its 600-segment bound after the shared smoothing/resampling step.
    for (const wear of [
      {
        id: "bank-clerk-outer",
        clearing: "bank-clerk-approach",
        previousWidth: 1.1,
        previousBlend: 1.45,
        start: 0.3,
        end: 0.85,
        offset: -0.85,
        peak: 0.62,
      },
      {
        id: "bank-apron-inner",
        clearing: "bank-apron",
        previousWidth: 1.8,
        previousBlend: 1.6,
        start: 0.5,
        end: 0.96,
        offset: -1.4,
        peak: 0.55,
      },
    ]) {
      const clearing = paths.find(
        (path) => path.id === "compact-clearing-" + wear.clearing,
      )!;
      const a = clearing.path[0],
        b = clearing.path[clearing.path.length - 1];
      const dx = b.x - a.x,
        dz = b.z - a.z,
        length = Math.hypot(dx, dz);
      if (!(length > 0))
        throw new Error("Bank wear requires its admitted clearing");
      const path = buildPath({
        id: wear.id,
        wear: true,
        fromId: clearing.fromId,
        toId: clearing.toId,
        width: 0.7,
        blendWidth: 0.4,
        maxInfluence: wear.peak,
        points: Array.from({ length: 5 }, (_, index) => {
          const t = index / 4;
          const along = wear.start + (wear.end - wear.start) * t;
          const offset = wear.offset * Math.sin(Math.PI * t);
          return {
            x: a.x + dx * along - (dz / length) * offset,
            z: a.z + dz * along + (dx / length) * offset,
          };
        }),
      });
      // Distance to a convex capsule is convex along a segment, so checking
      // both endpoints plus the complete wear radius bounds its whole area.
      for (const point of path.path)
        if (
          compactPathSegmentDistance(point, a, b) + 0.75 >
          wear.previousWidth / 2 + wear.previousBlend
        )
          throw new Error("Bank wear exceeds its previous clearing support");
      paths.push(path);
    }
  }
  return Object.freeze(paths);
}
