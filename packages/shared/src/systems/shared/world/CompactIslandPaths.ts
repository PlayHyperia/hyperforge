import type {
  WorldArea,
  RoadPathPoint,
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

/** Surface-mask paths only: no meshes, colliders, height grading or agent routing. */
export type CompactIslandPath = Readonly<{
  id: string;
  fromId: string;
  toId: string;
  width: number;
  path: readonly Readonly<RoadPathPoint>[];
  length: number;
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
 * platform connects them; dirt deliberately stops outside that platform.
 */
export function createCompactIslandPaths(
  profile: WorldTerrainProfile,
  areas: Readonly<Record<string, WorldArea>>,
  arena: DuelArenaConfig,
  getHeightAt: (x: number, z: number) => number,
): readonly CompactIslandPath[] {
  if (!isCompactSculptProfile(profile)) return Object.freeze([]);
  const haven = areas.central_haven,
    pondArea = areas.haven_pond;
  const station = (type: string): Point => {
    const rows = haven?.stations?.filter((row) => row.type === type);
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
    points: Point[];
  }> = [
    {
      id: "pond-bank",
      fromId: pond.id,
      toId: "bank-forecourt",
      width: 1.8,
      points: [shore, { x: front.x - 1, z: (shore.z + front.z) / 2 }, front],
    },
    {
      id: "bank-workshop",
      fromId: "bank-forecourt",
      toId: "workshop-forecourt",
      width: 1.8,
      points: [
        front,
        { x: front.x, z: front.z + 5 },
        { x: workshop.x + 4, z: workshop.z - 1 },
        workshop,
      ],
    },
    {
      id: "bank-range",
      fromId: "bank-forecourt",
      toId: "range-forecourt",
      width: 1.5,
      points: [
        front,
        { x: range.x + 5, z: front.z },
        { x: range.x + 2.5, z: range.z },
      ],
    },
    {
      id: "bank-altar",
      fromId: "bank-forecourt",
      toId: "altar-forecourt",
      width: 1.5,
      points: [
        front,
        { x: altar.x, z: front.z - 3 },
        { x: altar.x, z: altar.z + 3 },
      ],
    },
    {
      id: "bank-lobby",
      fromId: "bank-forecourt",
      toId: "duel-lobby",
      width: 2.2,
      points: [
        front,
        { x: front.x + 8, z: front.z + 8 },
        { x: (front.x + northLobby.x) / 2 + 3, z: northLobby.z - 13 },
        northLobby,
      ],
    },
    {
      id: "lobby-arena",
      fromId: "duel-lobby",
      toId: "arena-approach",
      width: 2.2,
      points: [
        southLobby,
        { x: (southLobby.x + arenaApproach.x) / 2, z: arenaApproach.z },
        arenaApproach,
      ],
    },
  ];
  return Object.freeze(
    definitions.map((definition) => {
      let points = definition.points;
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
      const padding = definition.width / 2 + COMPACT_PATH_BLEND_WIDTH;
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
        id: "compact-path-" + definition.id,
        fromId: definition.fromId,
        toId: definition.toId,
        width: definition.width,
        path: Object.freeze(path),
        length,
      });
    }),
  );
}
